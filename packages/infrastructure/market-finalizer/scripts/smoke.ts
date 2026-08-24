/**
 * DEVELOPMENT-ONLY live smoke ПОЛНОГО lifecycle V2 (N-004 PART 63).
 *
 * @remarks
 * Первый полный путь CHECKPOINT #1:
 *
 * ```text
 * Gamma Discovery → Coordinator open → Source → Bus → Recorder (запись)
 *   → expiry → FINALIZING (seal: payload заморожен)
 *   → Gamma refresh (fetchMarket/fetchEvent)
 *   → финальный header (LINE 1)
 *   → EXPIRED gzip → .jsonl.gz
 * ```
 *
 * Скрипт выбирает БЛИЖАЙШИЙ подходящий 5m крипто-рынок (следующее окно),
 * пишет его до истечения, затем гоняет `finalizer.runOnce()` до архива.
 * Полный прогон занимает ~8-16 минут реального времени (окно рынка +
 * enrichment). Проверяется: payload-строки заморожены на seal (счётчик
 * строк в момент seal == счётчику в архиве), финальный header несёт
 * finalization-ядро, артефакт — валидный `.jsonl.gz`.
 *
 * Запуск из корня repo (нужен собранный dist: `npm run build`):
 *
 * ```bash
 * npx tsx packages/infrastructure/market-finalizer/scripts/smoke.ts
 * ```
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { createPublicClient } from '@polymarket/client';
import { ConsoleLogger, LogLevel } from '@polymarket/logger';
import { LiveClock } from '@polymarket/time';
import { LiveHighResolutionClock, MessageMetadataGenerator } from '@polymarket/messages';
import { MarketFilter, MarketScorer } from '@polymarket/market-discovery';
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import { PolymarketMarketDiscovery, PolymarketSource } from '@polymarket/polymarket-v2';
import type { PolymarketExternalMessage } from '@polymarket/polymarket-v2';
import { DataRecorder, GzipCompressor, NDJSONFormatter } from '@polymarket/data-collection';
import { ExternalMessageRecorder } from '@polymarket/external-message-recorder';
import { MarketCollectionCoordinator } from '@polymarket/collection-coordinator';
import { MarketFinalizer } from '../src/index.js';

/** Ограничение ожидания enrichment-а в смоуке (5 минут; live-метадата ~1-2 мин). */
const SMOKE_ENRICHMENT_MAX_WAIT_MS = 5 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function main(): Promise<void> {
  const clock = new LiveClock();
  const logger = new ConsoleLogger(clock, LogLevel.INFO);
  logger.info('N-004 smoke started');

  // ── Composition root V2 (полный контур + finalizer) ────────────────────────
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n004-smoke-'));
  const client = createPublicClient();
  const bus = new ExternalMessageBus<PolymarketExternalMessage>();
  const metadataGenerator = new MessageMetadataGenerator({
    clock,
    highResolutionClock: new LiveHighResolutionClock(),
  });
  const source = new PolymarketSource({ client, bus, metadataGenerator, logger });
  const storage = new DataRecorder(
    {
      outputDir,
      sourceSubDir: 'polymarket',
      bufferSize: 50,
      flushIntervalMs: 2_000,
      compression: 'gzip',
      formatVersion: 2,
    },
    new NDJSONFormatter(),
    new GzipCompressor(),
    logger,
  );
  const recorder = new ExternalMessageRecorder({ bus, storage, logger });
  recorder.start();
  const discovery = new PolymarketMarketDiscovery(
    { client, filter: new MarketFilter(), scorer: new MarketScorer(clock), clock, logger },
    {
      filter: {
        minTimeToExpiryHours: 0,
        minSpread: 0,
        minLiquidity: 0,
        maxMarketsToReturn: 5,
        requiredKeywords: ['up or down'],
        anyOfKeywords: ['bitcoin', 'ethereum', 'solana', 'xrp'],
      },
    },
  );
  const coordinator = new MarketCollectionCoordinator(
    { discovery, source, recorder, clock, logger },
    { maxMarkets: 1, minTimeToStartMs: 30_000 },
  );
  const finalizer = new MarketFinalizer(
    { coordinator, recorder, gamma: client, clock, logger },
    { enrichmentRetryMs: 15_000, enrichmentMaxWaitMs: SMOKE_ENRICHMENT_MAX_WAIT_MS },
  );

  let pipelineError: unknown;
  let cleanupError: unknown;
  try {
    // ── 1. DISCOVER + OPEN ближайшего подходящего рынка ──────────────────────
    let opened = 0;
    for (let round = 0; round < 12 && opened === 0; round++) {
      await coordinator.refreshCandidates();
      opened = await coordinator.fillSlots();
      if (opened === 0) {
        logger.info('1. no eligible market yet, retrying in 20s', { round });
        await sleep(20_000);
      }
    }
    if (opened !== 1) {
      throw new Error('No eligible near-expiry market opened within retry budget');
    }
    const [session] = coordinator.listSessions();
    if (session === undefined || session.expiresAt === undefined) {
      throw new Error('Opened session snapshot is incomplete');
    }
    const expiresAtMs = session.expiresAt.toNumber();
    logger.info('2. session opened, recording until expiry', {
      marketId: String(session.marketId),
      question: session.question,
      expiresAt: new Date(expiresAtMs).toISOString(),
      minutesToExpiry: ((expiresAtMs - Date.now()) / 60_000).toFixed(1),
    });

    // ── 2. RECORD до истечения ───────────────────────────────────────────────
    while (Date.now() < expiresAtMs) {
      await sleep(Math.min(15_000, Math.max(1_000, expiresAtMs - Date.now())));
    }

    // ── 3. EXPIRE → FINALIZING (первый runOnce после expiry) ────────────────
    await finalizer.runOnce();
    if (coordinator.getStats().finalizingSessions !== 1) {
      throw new Error('Expired session did not transition to FINALIZING');
    }
    // Датасет заморожен — фиксируем счётчик payload-строк на момент seal
    const date = new Date().toISOString().slice(0, 10);
    const marketDir = path.join(outputDir, date, 'polymarket');
    const jsonl = fs.readdirSync(marketDir).find((f) => f.endsWith('.jsonl'));
    if (jsonl === undefined) {
      throw new Error('Sealed .jsonl not found');
    }
    const sealedPath = path.join(marketDir, jsonl);
    const sealedLineCount = fs
      .readFileSync(sealedPath, 'utf8')
      .trimEnd()
      .split('\n')
      .filter((line) => line.trim().length > 0).length;
    logger.info('3. dataset sealed at expiry', {
      sealedPath,
      sealedLines: sealedLineCount,
      payloadLines: sealedLineCount - 1,
    });

    // ── 4. ENRICH → FINALIZE (гоняем runOnce до архива) ─────────────────────
    const enrichDeadline = Date.now() + SMOKE_ENRICHMENT_MAX_WAIT_MS + 60_000;
    while (finalizer.getStats().archivedTotal === 0 && Date.now() < enrichDeadline) {
      await sleep(10_000);
      await finalizer.runOnce();
    }
    if (finalizer.getStats().archivedTotal !== 1) {
      throw new Error(
        `Market was not archived within smoke budget: ${JSON.stringify(finalizer.getStats())}`,
      );
    }

    // ── 5. Проверка артефакта .jsonl.gz ──────────────────────────────────────
    const gzPath = `${sealedPath}.gz`;
    if (!fs.existsSync(gzPath) || fs.existsSync(sealedPath)) {
      throw new Error(`Expected only gz artifact: gz=${fs.existsSync(gzPath)}`);
    }
    const lines = zlib
      .gunzipSync(fs.readFileSync(gzPath))
      .toString('utf-8')
      .trimEnd()
      .split('\n')
      .filter((line) => line.trim().length > 0);
    // Payload-строки заморожены на seal: архив не получил новых строк
    if (lines.length !== sealedLineCount) {
      throw new Error(`Payload changed after seal: sealed=${sealedLineCount} archived=${lines.length}`);
    }
    const header = JSON.parse(lines[0]!) as Record<string, unknown>;
    const m = header['m'] as Record<string, unknown>;
    const finalization = m['finalization'] as Record<string, unknown> | undefined;
    if (header['formatVersion'] !== 2 || finalization === undefined) {
      throw new Error('Final header lacks formatVersion/finalization');
    }
    logger.info('5. EXPIRED archive verified', {
      gzPath,
      lines: lines.length,
      payloadLines: lines.length - 1,
    });
    logger.info('5. finalization core (m.finalization)', finalization);
    logger.info('5. final header summary', {
      conditionId: m['conditionId'],
      question: m['question'],
      timing: m['timing'],
      crypto: m['crypto'],
      truncated: m['truncated'],
      hasGammaMarket: m['gammaMarket'] !== undefined,
      hasGammaEvent: m['gammaEvent'] !== undefined,
    });
    logger.info('RESULT: stats', {
      finalizer: finalizer.getStats(),
      coordinator: coordinator.getStats(),
      recorder: recorder.getStats(),
    });
  } catch (error) {
    pipelineError = error;
  }

  // ── 6. Shutdown в порядке контура (PART 41) ───────────────────────────────
  const cleanupStep = async (step: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      cleanupError ??= new Error(
        `Cleanup step '${step}' failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      logger.error(`Cleanup step failed: ${step}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  await cleanupStep('finalizer.close', async () => finalizer.close());
  await cleanupStep('coordinator.close', async () => coordinator.close());
  await cleanupStep('source.close', async () => source.close());
  await cleanupStep('bus.drain', async () => {
    await bus.drain();
  });
  await cleanupStep('recorder.close', async () => recorder.close());
  await cleanupStep('bus.close', async () => {
    await bus.close();
  });

  if (pipelineError !== undefined) {
    throw pipelineError;
  }
  if (cleanupError !== undefined) {
    throw cleanupError;
  }
  logger.info('N-004 smoke finished (full lifecycle proven live)');
}

main().catch((error: unknown) => {
  console.error('Smoke failed:', error);
  process.exitCode = 1;
});
