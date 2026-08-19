/**
 * DEVELOPMENT-ONLY live smoke N-003 (PART 41).
 *
 * @remarks
 * Доказывает ПОЛНУЮ автоматическую цепочку V2 против публичных endpoints
 * Polymarket (без credentials, без legacy discovery):
 *
 * ```text
 * @polymarket/client Gamma
 *        ↓ listMarkets / fetchEvent
 * Market Discovery V2 (наша selection policy)
 *        ↓ selected market
 * MarketCollectionCoordinator
 *        ├── ExternalMessageRecorder.registerMarket   (FIRST)
 *        ├── PolymarketSource.subscribeMarket
 *        └── shared RTDS feeds
 *        ↓
 * ExternalMessageBus → ExternalMessageRecorder → DataRecorder → JSONL file
 * ```
 *
 * DISCOVER → SELECT → REGISTER → SUBSCRIBE → RECORD; затем graceful shutdown
 * с проверкой SHUTDOWN-семантики артефактов (incomplete-файл удаляется,
 * архива нет). Реального истечения рынка smoke НЕ ждёт (EXPIRE/ENRICH/
 * FINALIZE — N-004).
 *
 * Это НЕ production daemon: скрипт работает ~40 секунд и завершается.
 *
 * Запуск из корня repo (нужен собранный dist зависимостей: `npm run build`):
 *
 * ```bash
 * npx tsx packages/infrastructure/collection-coordinator/scripts/smoke.ts
 * ```
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createPublicClient } from '@polymarket/client';
import { ConsoleLogger, LogLevel } from '@polymarket/logger';
import { LiveClock } from '@polymarket/time';
import { LiveHighResolutionClock, MessageMetadataGenerator } from '@polymarket/messages';
import { MarketFilter, MarketScorer } from '@polymarket/market-discovery';
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import {
  PolymarketMarketDiscovery,
  PolymarketSource,
} from '@polymarket/polymarket-v2';
import type { PolymarketExternalMessage } from '@polymarket/polymarket-v2';
import { DataRecorder, GzipCompressor, NDJSONFormatter } from '@polymarket/data-collection';
import { ExternalMessageRecorder } from '@polymarket/external-message-recorder';
import { MarketCollectionCoordinator } from '../src/index.js';

/** Длительность сбора данных. */
const COLLECT_MS = 25_000;

async function main(): Promise<void> {
  const clock = new LiveClock();
  const logger = new ConsoleLogger(clock, LogLevel.INFO);
  logger.info('N-003 smoke started');

  // ── Composition root V2 (демонстрация PART 42) ─────────────────────────────
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n003-smoke-'));
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
    { maxMarkets: 1 },
  );

  let pipelineError: unknown;
  let recordedFilePath: string | undefined;
  try {
    // ── 1. DISCOVER: реальный Gamma через официальный SDK ────────────────────
    await coordinator.refreshCandidates();
    const candidates = await discovery.findCandidates();
    logger.info('1. discovery complete', {
      candidates: candidates.length,
      top: candidates.slice(0, 3).map((candidate) => ({
        question: candidate.question,
        expiresAt: new Date(candidate.expiresAt.toNumber()).toISOString(),
      })),
    });
    if (candidates.length === 0) {
      throw new Error('No eligible crypto up-or-down candidates discovered');
    }

    // ── 2-3. SELECT + REGISTER + SUBSCRIBE (транзакция координатора) ─────────
    const opened = await coordinator.fillSlots();
    if (opened !== 1) {
      throw new Error(`Expected to open exactly 1 collection session, opened: ${opened}`);
    }
    const [session] = coordinator.listSessions();
    if (session === undefined || session.state !== 'ACTIVE') {
      throw new Error('Opened session is not ACTIVE');
    }
    // Печать выбранного рынка (FINAL REPORT PART 8)
    const selected = await discovery.prepareSelected(
      candidates.find((candidate) => String(candidate.marketId) === session.marketId) ??
        candidates[0]!,
    );
    logger.info('2. selected market', {
      question: selected.question,
      conditionId: selected.sourceMarketId,
      gammaMarketId: selected.gammaMarketId,
      slug: selected.slug,
      tokenIds: selected.tokenIds,
      outcomes: selected.outcomes.map((outcome) => outcome.label),
      event: selected.event,
      eventStartsAt:
        selected.eventStartsAt !== undefined
          ? new Date(selected.eventStartsAt.toNumber()).toISOString()
          : undefined,
      expiresAt: new Date(selected.expiresAt.toNumber()).toISOString(),
      rtdsFeeds: selected.rtdsFeeds.map((feed) => `${feed.topic}:${feed.symbol}`),
    });
    logger.info('3. session opened', {
      stats: coordinator.getStats(),
    });

    // ── 4. RECORD: сбор данных ────────────────────────────────────────────────
    logger.info('4. collecting', { collectMs: COLLECT_MS });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, COLLECT_MS);
    });

    // ── 5. Живой файл: header + счётчики ДО shutdown ─────────────────────────
    await storage.flush();
    const date = new Date().toISOString().slice(0, 10);
    const marketDir = path.join(outputDir, date, 'polymarket');
    const jsonlFiles = fs.existsSync(marketDir)
      ? fs.readdirSync(marketDir).filter((file) => file.endsWith('.jsonl'))
      : [];
    if (jsonlFiles.length !== 1) {
      throw new Error(`Expected exactly one active .jsonl, found: ${JSON.stringify(jsonlFiles)}`);
    }
    recordedFilePath = path.join(marketDir, jsonlFiles[0]!);
    const lines = fs
      .readFileSync(recordedFilePath, 'utf8')
      .trimEnd()
      .split('\n')
      .filter((line) => line.trim().length > 0);
    const header = JSON.parse(lines[0]!) as Record<string, unknown>;
    if (header['t'] !== 'meta' || header['formatVersion'] !== 2) {
      throw new Error(`Unexpected header shape: ${lines[0]!.slice(0, 200)}`);
    }
    if (header['marketId'] !== selected.sourceMarketId) {
      throw new Error('Header marketId does not match selected conditionId');
    }
    const kindCounts = new Map<string, number>();
    for (const line of lines.slice(1)) {
      const parsed = JSON.parse(line) as { topic?: string; type?: string };
      const kind = `${parsed.topic}/${parsed.type}`;
      kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
    }
    const headerPayload = header['m'] as Record<string, unknown>;
    logger.info('5. live file verified', {
      filePath: recordedFilePath,
      fileLines: lines.length,
      payloadLines: lines.length - 1,
      lineKinds: Object.fromEntries(kindCounts),
    });
    logger.info('5. header core (m)', {
      headerVersion: headerPayload['headerVersion'],
      source: headerPayload['source'],
      conditionId: headerPayload['conditionId'],
      gammaMarketId: headerPayload['gammaMarketId'],
      outcomes: headerPayload['outcomes'],
      event: headerPayload['event'],
      timing: headerPayload['timing'],
      crypto: headerPayload['crypto'],
      rtdsFeeds: headerPayload['rtdsFeeds'],
      hasGammaMarket: headerPayload['gammaMarket'] !== undefined,
      hasGammaEvent: headerPayload['gammaEvent'] !== undefined,
    });
    logger.info('RESULT: recorder stats before shutdown', {
      recorder: recorder.getStats(),
      bus: bus.getStats(),
    });
    if (lines.length < 2) {
      throw new Error('No payload lines recorded — pipeline produced an empty file');
    }
  } catch (error) {
    pipelineError = error;
  }

  // ── 6. Graceful shutdown в порядке контура ─────────────────────────────────
  const cleanupStep = async (step: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      logger.error(`Cleanup step failed: ${step}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  await cleanupStep('coordinator.close', async () => coordinator.close());
  await cleanupStep('source.close', async () => source.close());
  await cleanupStep('bus.drain', async () => {
    const drained = await bus.drain();
    logger.info('6. coordinator and source closed, bus drained', { drainOk: drained.ok });
  });
  await cleanupStep('recorder.close', async () => recorder.close());
  await cleanupStep('bus.close', async () => {
    const closed = await bus.close();
    logger.info('6. recorder and bus closed', { busCloseOk: closed.ok });
  });

  if (pipelineError !== undefined) {
    throw pipelineError;
  }

  // ── 7. SHUTDOWN-семантика артефактов (контракт Recorder) ───────────────────
  // finalizeMarket(SHUTDOWN) удаляет incomplete-файл; архив не создаётся.
  if (recordedFilePath !== undefined) {
    const jsonlExists = fs.existsSync(recordedFilePath);
    const gzExists = fs.existsSync(`${recordedFilePath}.gz`);
    if (jsonlExists || gzExists) {
      throw new Error(
        `SHUTDOWN artifact semantics violated: jsonl=${String(jsonlExists)} gz=${String(gzExists)}`,
      );
    }
    logger.info('7. shutdown artifact semantics verified', {
      incompleteFileDeleted: true,
      noGzipArchive: true,
    });
  }

  logger.info('N-003 smoke finished (process should exit cleanly now)');
}

main().catch((error: unknown) => {
  console.error('Smoke failed:', error);
  process.exitCode = 1;
});
