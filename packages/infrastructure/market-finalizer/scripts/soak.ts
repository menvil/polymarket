/**
 * DEVELOPMENT-ONLY soak-прогон полного V2-контура (N-004 follow-up).
 *
 * @remarks
 * Длительный live-прогон «как production»: несколько рынков параллельно,
 * непрерывные discovery/fill/finalize циклы, наблюдение enrichment-а:
 *
 * - какие рынки открываются и сколько пишут;
 * - как быстро после endDate Gamma публикует priceToBeat/finalPrice
 *   (латентность по каждому архиву — из финального header-а);
 * - доля complete vs timeout при бюджете ожидания 60 минут.
 *
 * Конфигурация через env:
 *
 * - `SOAK_MINUTES` — длительность прогона (default 120);
 * - `SOAK_MAX_MARKETS` — параллельные сессии (default 3);
 * - `SOAK_ENRICH_MAX_MINUTES` — бюджет ожидания enrichment (default 60).
 *
 * Запуск из корня repo (нужен собранный dist: `npm run build`):
 *
 * ```bash
 * SOAK_MINUTES=120 npx tsx packages/infrastructure/market-finalizer/scripts/soak.ts
 * ```
 *
 * SIGINT/SIGTERM завершают прогон досрочно тем же graceful-порядком.
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
import type { PolymarketDiscoveredMarket } from '@polymarket/polymarket-v2';
import { DataRecorder, GzipCompressor, NDJSONFormatter } from '@polymarket/data-collection';
import { ExternalMessageRecorder } from '@polymarket/external-message-recorder';
import { MarketCollectionCoordinator } from '@polymarket/collection-coordinator';
import type { CollectionDiscovery } from '@polymarket/collection-coordinator';
import { MarketFinalizer } from '../src/index.js';

const SOAK_MINUTES = Number(process.env['SOAK_MINUTES'] ?? 120);
const SOAK_MAX_MARKETS = Number(process.env['SOAK_MAX_MARKETS'] ?? 4);
const SOAK_ENRICH_MAX_MINUTES = Number(process.env['SOAK_ENRICH_MAX_MINUTES'] ?? 60);

/** Вид серии по slug (`btc-updown-5m-…`, `eth-updown-15m-…`, часовые и пр.). */
type SeriesKind = '5m' | '15m' | 'other';

function classifySeries(slug: string | null | undefined): SeriesKind {
  if (slug === null || slug === undefined) return 'other';
  if (slug.includes('-5m-')) return '5m';
  if (slug.includes('-15m-')) return '15m';
  return 'other';
}

/**
 * Обёртка discovery для soak-а: перемежает кандидатов по видам серий
 * (5m/15m/часовые round-robin), чтобы слоты занимал МИКС длительностей и
 * пар, а не только ближайшие к истечению 5m-окна (scorer сортирует по
 * expiry). Дополнительно отбрасывает рынки, не успевающие истечь до конца
 * прогона. Композиция уровня dev-скрипта — production selection policy
 * не меняется.
 */
class InterleavingSoakDiscovery implements CollectionDiscovery {
  constructor(
    private readonly _base: CollectionDiscovery,
    private readonly _expiryDeadlineMs: number,
  ) {}

  public refresh(): Promise<void> {
    return this._base.refresh();
  }

  public prepareSelected(
    candidate: PolymarketDiscoveredMarket,
  ): ReturnType<CollectionDiscovery['prepareSelected']> {
    return this._base.prepareSelected(candidate);
  }

  public async findCandidates(): Promise<readonly PolymarketDiscoveredMarket[]> {
    const base = await this._base.findCandidates();
    const eligible = base.filter(
      (candidate) => candidate.expiresAt.toNumber() <= this._expiryDeadlineMs,
    );
    const groups = new Map<SeriesKind, PolymarketDiscoveredMarket[]>();
    for (const candidate of eligible) {
      const kind = classifySeries(candidate.sdkMarket.slug);
      const group = groups.get(kind) ?? [];
      group.push(candidate);
      groups.set(kind, group);
    }
    // Round-robin по видам серий; внутри вида — порядок скорера
    // (expiry asc → liquidity desc), что даёт и разнообразие пар
    const order: SeriesKind[] = ['5m', '15m', 'other'];
    const interleaved: PolymarketDiscoveredMarket[] = [];
    for (let index = 0; interleaved.length < eligible.length; index++) {
      let advanced = false;
      for (const kind of order) {
        const group = groups.get(kind);
        if (group !== undefined && index < group.length) {
          interleaved.push(group[index]!);
          advanced = true;
        }
      }
      if (!advanced) break;
    }
    return interleaved;
  }
}

/** Разобранный итог одного архива (из финального header-а .jsonl.gz). */
interface ArchiveReport {
  readonly file: string;
  readonly question: string;
  readonly payloadLines: number;
  readonly status: string;
  readonly attempts: number;
  /** Минуты от expiresAt до finalizedAt (латентность enrichment-а). */
  readonly enrichLatencyMin: number | null;
  readonly priceToBeat: boolean;
  readonly finalPrice: boolean;
  readonly winning: string | null;
  readonly truncated: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Рекурсивно находит все .jsonl.gz в outputDir. */
function findArchives(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findArchives(full));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl.gz')) {
      out.push(full);
    }
  }
  return out;
}

/** Разбирает финальный header архива в компактный отчёт. */
function parseArchive(file: string): ArchiveReport {
  const lines = zlib
    .gunzipSync(fs.readFileSync(file))
    .toString('utf-8')
    .trimEnd()
    .split('\n')
    .filter((line) => line.trim().length > 0);
  const header = JSON.parse(lines[0]!) as Record<string, unknown>;
  const m = header['m'] as Record<string, unknown>;
  const timing = (m['timing'] ?? {}) as Record<string, unknown>;
  const finalization = (m['finalization'] ?? {}) as Record<string, unknown>;
  const crypto = (finalization['crypto'] ?? {}) as Record<string, unknown>;
  const winning = finalization['winning'] as Record<string, unknown> | undefined;
  const expiresAt = typeof timing['expiresAt'] === 'number' ? timing['expiresAt'] : null;
  const finalizedAt =
    typeof finalization['finalizedAtMs'] === 'number' ? finalization['finalizedAtMs'] : null;
  return {
    file: path.basename(file),
    question: String(m['question'] ?? ''),
    payloadLines: lines.length - 1,
    status: String(finalization['status'] ?? 'MISSING'),
    attempts: Number(finalization['attempts'] ?? 0),
    enrichLatencyMin:
      expiresAt !== null && finalizedAt !== null
        ? Math.round(((finalizedAt - expiresAt) / 60_000) * 10) / 10
        : null,
    priceToBeat: crypto['priceToBeat'] !== undefined,
    finalPrice: crypto['finalPrice'] !== undefined,
    winning: winning !== undefined ? String(winning['label']) : null,
    truncated: m['truncated'],
  };
}

async function main(): Promise<void> {
  const clock = new LiveClock();
  const logger = new ConsoleLogger(clock, LogLevel.INFO);
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n004-soak-'));
  logger.info('N-004 soak started', {
    minutes: SOAK_MINUTES,
    maxMarkets: SOAK_MAX_MARKETS,
    enrichMaxMinutes: SOAK_ENRICH_MAX_MINUTES,
    outputDir,
  });

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
      bufferSize: 200,
      flushIntervalMs: 5_000,
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
        maxMarketsToReturn: SOAK_MAX_MARKETS * 3,
        requiredKeywords: ['up or down'],
        anyOfKeywords: ['bitcoin', 'ethereum', 'solana', 'xrp'],
      },
    },
  );
  // Рынки, не успевающие истечь до конца прогона, не открываем (минус 2 мин запас)
  const soakDeadline = Date.now() + SOAK_MINUTES * 60_000;
  const soakDiscovery = new InterleavingSoakDiscovery(discovery, soakDeadline - 2 * 60_000);
  const coordinator = new MarketCollectionCoordinator(
    { discovery: soakDiscovery, source, recorder, clock, logger },
    { maxMarkets: SOAK_MAX_MARKETS, minTimeToStartMs: 30_000 },
  );
  const finalizer = new MarketFinalizer(
    { coordinator, recorder, gamma: client, clock, logger },
    { enrichmentRetryMs: 30_000, enrichmentMaxWaitMs: SOAK_ENRICH_MAX_MINUTES * 60_000 },
  );

  const deadline = soakDeadline;
  let stopRequested = false;
  const requestStop = (signal: string): void => {
    logger.info('Soak stop requested', { signal });
    stopRequested = true;
  };
  process.on('SIGINT', () => requestStop('SIGINT'));
  process.on('SIGTERM', () => requestStop('SIGTERM'));

  const reported = new Set<string>();
  const reports: ArchiveReport[] = [];
  const reportNewArchives = (): void => {
    for (const file of findArchives(outputDir)) {
      if (reported.has(file)) continue;
      reported.add(file);
      try {
        const report = parseArchive(file);
        reports.push(report);
        logger.info('ARCHIVE', { ...report });
      } catch (error) {
        logger.error('Archive parse failed', {
          file,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  // ── Основные циклы (cadence как у legacy: discovery 30с, слоты/finalize 10с)
  let lastRefreshMs = 0;
  let lastStatusMs = 0;
  while (Date.now() < deadline && !stopRequested) {
    try {
      if (Date.now() - lastRefreshMs >= 30_000) {
        lastRefreshMs = Date.now();
        await coordinator.refreshCandidates();
      }
      await coordinator.fillSlots();
      await finalizer.runOnce();
      reportNewArchives();

      if (Date.now() - lastStatusMs >= 60_000) {
        lastStatusMs = Date.now();
        logger.info('STATUS', {
          minutesLeft: Math.round((deadline - Date.now()) / 60_000),
          coordinator: coordinator.getStats(),
          finalizer: finalizer.getStats(),
          recorder: recorder.getStats(),
        });
      }
    } catch (error) {
      logger.error('Soak loop iteration failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await sleep(10_000);
  }

  // ── Graceful shutdown в порядке контура ────────────────────────────────────
  logger.info('Soak window ended, shutting down', { archivedSoFar: reports.length });
  const cleanupStep = async (step: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
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
  reportNewArchives(); // архивы, созданные finalizer.close()
  await cleanupStep('recorder.close', async () => recorder.close());
  await cleanupStep('bus.close', async () => {
    await bus.close();
  });

  // ── Итоговая сводка ────────────────────────────────────────────────────────
  const complete = reports.filter((r) => r.status === 'complete');
  const timeout = reports.filter((r) => r.status === 'timeout');
  const latencies = complete
    .map((r) => r.enrichLatencyMin)
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  logger.info('SOAK SUMMARY', {
    archives: reports.length,
    complete: complete.length,
    timeout: timeout.length,
    completeLatencyMin:
      latencies.length > 0
        ? {
            min: latencies[0],
            median: latencies[Math.floor(latencies.length / 2)],
            max: latencies[latencies.length - 1],
          }
        : null,
    timeoutMarkets: timeout.map((r) => ({ q: r.question, priceToBeat: r.priceToBeat })),
    totalPayloadLines: reports.reduce((sum, r) => sum + r.payloadLines, 0),
    outputDir,
  });
  logger.info('N-004 soak finished');
}

main().catch((error: unknown) => {
  console.error('Soak failed:', error);
  process.exitCode = 1;
});
