/**
 * DEVELOPMENT-ONLY verification runner — CHECKPOINT #1 (RAW LIVE COLLECTION).
 *
 * @remarks
 * Это НЕ production daemon и НЕ новая application abstraction: тонкая
 * composition поверх уже существующих пакетов контура, доказывающая, что
 * весь raw live collection работает как ОДНА система до semantic boundary:
 *
 * ```text
 * Polymarket CLOB/SDK ──────────────┐
 * Polymarket RTDS ──────────────────┼──► ExternalMessage
 * CCXT Pro (6 бирж, spot) ──────────┘
 *                 ↓
 *      ОДИН ExternalMessageBus<PolymarketExternalMessage | CexExternalMessage>
 *                 ↓
 *      ОДИН ExternalMessageRecorder (обе storage-политики)
 *          ↙                                   ↘
 *   Polymarket market-session            CEX time-window
 *   (DataRecorder, formatVersion 2)      (CexWindowRecorder, 5m окна)
 *          ↓                                   ↓
 *   JSONL → SEAL → Gamma enrichment →    JSONL → flush → gzip
 *   FINALIZED .jsonl.gz                  завершённые .jsonl.gz партиции
 * ```
 *
 * Биржи и пары — подмножество production-конфига legacy-коллектора
 * (`apps/collect-data/cex-config.json`): binance, coinbase, kraken,
 * cryptocom, okx, bybit; restartIntervalMs 15 минут — как в legacy
 * (плановый рестарт транспорта попадает в окно прогона и даёт живое
 * свидетельство restart+recovery). Окно CEX-партиций — production default
 * (5 минут), НЕ уменьшено.
 *
 * Runner ТОЛЬКО композирует и наблюдает: собственных adapters нет,
 * payload не преобразуется, новая observability не строится (счётчики
 * checkpoint-а — локальные подписки на том же bus + счётный logger-wrapper).
 *
 * Режимы (`CHECKPOINT_MODE`):
 * - `full` (default) — полный прогон до полного lifecycle Polymarket
 *   (DISCOVER → … → FINALIZE → ARCHIVE) + завершённые CEX-окна по всем
 *   биржам; затем строгая валидация артефактов;
 * - `short` — restart-верификация: ДВЕ последовательные композиции в одном
 *   процессе (teardown → повторный startup), короткий сбор, лёгкая валидация.
 *
 * Shutdown full-режима — graceful wind-down: перед закрытием контура
 * выполняется `finalizer.drain()` — уже начатые финализации дожидаются
 * официальной резолюции (или полного 60-мин бюджета), опрос Gamma идёт
 * штатным 30-секундным cadence; SIGINT прерывает ожидание (аварийный
 * best-known путь close() сохранён).
 *
 * Env-переменные:
 * - `CHECKPOINT_MODE` — `full` | `short` (default `full`);
 * - `CHECKPOINT_DRAIN` — `0` отключает drain перед shutdown (default on);
 * - `CHECKPOINT_MAX_MINUTES` — дедлайн full-прогона (default 45);
 * - `CHECKPOINT_MIN_MINUTES` — минимальная длительность full-прогона,
 *   гарантирует наблюдение планового CEX-рестарта (default 17);
 * - `CHECKPOINT_SHORT_MINUTES` — длительность каждой short-композиции
 *   (default 2.5);
 * - `CHECKPOINT_OUTPUT_ROOT` — корень изолированного output
 *   (default `data/checkpoint-raw-live`);
 * - `CHECKPOINT_MAX_MARKETS` — параллельные PM-сессии (default 3).
 *
 * Запуск из корня repo (нужен собранный dist: `npm run build`):
 *
 * ```bash
 * npx tsx scripts/checkpoint-raw-live.mts
 * CHECKPOINT_MODE=short npx tsx scripts/checkpoint-raw-live.mts
 * ```
 *
 * Числовые env-переменные валидируются до старта (нефинитное/невалидное
 * значение — ошибка конфигурации, а не молча сломанный прогон).
 *
 * Выход: код 0 — все live-инварианты checkpoint выполнены; код 1 — ошибка
 * конфигурации (сообщение при загрузке модуля); код 2 — verdict
 * FAIL/INCOMPLETE (подробности в `report.json` и консоли) ЛИБО падение
 * самого runner-а до вердикта; код 3 — процесс не завершился сам после
 * shutdown (orphan handles). Forced `process.exit(0)` сознательно НЕ
 * используется.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { createPublicClient } from '@polymarket/client';
import { ConsoleLogger, LogLevel } from '@polymarket/logger';
import type { ILogger } from '@polymarket/logger';
import { LiveClock } from '@polymarket/time';
import { LiveHighResolutionClock, MessageMetadataGenerator } from '@polymarket/messages';
import { MarketFilter, MarketScorer } from '@polymarket/market-discovery';
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import { PolymarketMarketDiscovery, PolymarketSource } from '@polymarket/polymarket-v2';
import type { PolymarketExternalMessage } from '@polymarket/polymarket-v2';
import {
  CexWindowRecorder,
  DataRecorder,
  GzipCompressor,
  NDJSONFormatter,
} from '@polymarket/data-collection';
import { ExternalMessageRecorder } from '@polymarket/external-message-recorder';
import { MarketCollectionCoordinator } from '@polymarket/collection-coordinator';
import { MarketFinalizer } from '@polymarket/market-finalizer';
import { CexSource } from '@polymarket/cex-v2';
import type { CexExternalMessage, CexSourceConfig } from '@polymarket/cex-v2';

// ───────────────────────────── Конфигурация ─────────────────────────────

/** Union сообщений всех raw sources контура на ОДНОМ bus. */
type ContourMessage = PolymarketExternalMessage | CexExternalMessage;

/**
 * CEX-план checkpoint: подмножество production-конфига legacy-коллектора
 * (`apps/collect-data/cex-config.json`), валидность символов подтверждена
 * REST-пробой loadMarkets по каждой бирже (2026-08-25).
 */
const CEX_PLAN: readonly CexSourceConfig[] = [
  {
    exchangeId: 'binance',
    marketType: 'spot',
    symbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT'],
    watchOrderbook: true,
    watchTrades: true,
    orderbookDepth: 10,
    orderbookMethod: 'watch',
    restartIntervalMs: 900_000,
  },
  {
    exchangeId: 'coinbase',
    marketType: 'spot',
    symbols: ['BTC/USD', 'ETH/USD', 'SOL/USD', 'XRP/USD'],
    watchOrderbook: true,
    watchTrades: true,
    orderbookDepth: 10,
    orderbookMethod: 'watch',
    restartIntervalMs: 900_000,
  },
  {
    exchangeId: 'kraken',
    marketType: 'spot',
    symbols: ['BTC/USD', 'ETH/USD', 'SOL/USD', 'BTC/USDT'],
    watchOrderbook: true,
    watchTrades: true,
    orderbookDepth: 10,
    orderbookMethod: 'watch',
    restartIntervalMs: 900_000,
  },
  {
    exchangeId: 'cryptocom',
    marketType: 'spot',
    symbols: ['BTC/USD', 'ETH/USD', 'SOL/USD', 'BTC/USDT'],
    watchOrderbook: true,
    watchTrades: true,
    orderbookDepth: 10,
    orderbookMethod: 'watch',
    restartIntervalMs: 900_000,
  },
  {
    exchangeId: 'okx',
    marketType: 'spot',
    symbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT'],
    watchOrderbook: true,
    watchTrades: true,
    orderbookDepth: 10,
    orderbookMethod: 'watch',
    restartIntervalMs: 900_000,
  },
  {
    exchangeId: 'bybit',
    marketType: 'spot',
    symbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT'],
    watchOrderbook: true,
    watchTrades: true,
    orderbookDepth: 50,
    orderbookMethod: 'watch',
    restartIntervalMs: 900_000,
  },
];

/** Ключи canonical runtime-metadata, которым ЗАПРЕЩЕНО попадать в payload-строки. */
const ENVELOPE_KEYS = [
  'metadata',
  'messageId',
  'sequence',
  'runId',
  'correlationId',
  'causationId',
] as const;

const MODE = process.env['CHECKPOINT_MODE'] === 'short' ? 'short' : 'full';
/** Дренировать pending-финализации перед shutdown (full-режим). Off: `CHECKPOINT_DRAIN=0`. */
const DRAIN_FINALIZATIONS = process.env['CHECKPOINT_DRAIN'] !== '0';
/**
 * Читает числовой env-override с валидацией.
 *
 * @param name - Имя переменной окружения
 * @param fallback - Значение по умолчанию (используется, если переменная
 *   не задана или пуста)
 * @param options - Ограничения: минимум и требование целого
 * @returns Валидное число
 * @throws {Error} Если значение не парсится, нефинитно или вне ограничений
 *
 * @remarks
 * `Number('abc')` даёт `NaN`, который дальше НЕ бросает, а молча ломает
 * прогон: `Date.now() - startedMs < NaN` всегда false (цикл сбора не
 * выполняется ни разу), `maxMarkets: NaN` не даёт координатору открыть ни
 * одной сессии — checkpoint «падает» без внятной причины. Поэтому
 * конфигурация проверяется до старта.
 */
function numericEnv(
  name: string,
  fallback: number,
  options: { readonly min: number; readonly integer?: boolean },
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(raw);
  const invalid =
    !Number.isFinite(parsed) ||
    parsed < options.min ||
    (options.integer === true && !Number.isInteger(parsed));
  if (invalid) {
    throw new Error(
      `Invalid ${name}='${raw}': expected a finite ${options.integer === true ? 'integer' : 'number'} >= ${String(options.min)}`,
    );
  }
  return parsed;
}

const MAX_MINUTES = numericEnv('CHECKPOINT_MAX_MINUTES', 45, { min: 1 });
const MIN_MINUTES = numericEnv('CHECKPOINT_MIN_MINUTES', 17, { min: 0 });
const SHORT_MINUTES = numericEnv('CHECKPOINT_SHORT_MINUTES', 2.5, { min: 0.5 });
const OUTPUT_ROOT = process.env['CHECKPOINT_OUTPUT_ROOT'] ?? path.join('data', 'checkpoint-raw-live');
const MAX_MARKETS = numericEnv('CHECKPOINT_MAX_MARKETS', 3, { min: 1, integer: true });
/** Глубина ring-буфера последних payload-строк (перекрывает freeze-лаг опроса сессий). */
const RING_CAP = 64;

// ─────────────────────── Диагностика процесса ───────────────────────────

/** Глобальные аномалии процесса (unhandled rejections и т.п.). */
const processAnomalies = {
  unhandledRejections: 0,
  uncaughtExceptions: 0,
  samples: [] as string[],
};
process.on('unhandledRejection', (reason) => {
  processAnomalies.unhandledRejections++;
  if (processAnomalies.samples.length < 20) {
    processAnomalies.samples.push(
      `unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`,
    );
  }
  console.error('CHECKPOINT: unhandledRejection observed', reason);
});
process.on('uncaughtException', (error) => {
  processAnomalies.uncaughtExceptions++;
  if (processAnomalies.samples.length < 20) {
    processAnomalies.samples.push(`uncaughtException: ${error.stack ?? error.message}`);
  }
  console.error('CHECKPOINT: uncaughtException observed', error);
});

let stopRequested = false;
process.on('SIGINT', () => {
  console.error('CHECKPOINT: SIGINT — stopping current composition');
  stopRequested = true;
});
process.on('SIGTERM', () => {
  console.error('CHECKPOINT: SIGTERM — stopping current composition');
  stopRequested = true;
});

// ─────────────────────── Счётный logger-wrapper ─────────────────────────

/** Разделяемые счётчики лог-аномалий одной композиции. */
interface LogCounters {
  plannedRestarts: number;
  sessionCompletedRestarts: number;
  sessionFailedRestarts: number;
  cooldowns: number;
  permanentFailures: number;
  errorLogs: number;
  warnLogs: number;
  errorSamples: string[];
}

/** Пустые счётчики новой композиции. */
function emptyLogCounters(): LogCounters {
  return {
    plannedRestarts: 0,
    sessionCompletedRestarts: 0,
    sessionFailedRestarts: 0,
    cooldowns: 0,
    permanentFailures: 0,
    errorLogs: 0,
    warnLogs: 0,
    errorSamples: [],
  };
}

/**
 * ILogger-обёртка: делегирует всё внутреннему логгеру и считает
 * restart/error-события по текстам существующих логов (минимальные
 * checkpoint-счётчики; новый metrics framework не вводится).
 */
class CountingLogger implements ILogger {
  constructor(
    private readonly _inner: ILogger,
    private readonly _counters: LogCounters,
  ) {}

  public trace(message: string, context?: Record<string, unknown>): void {
    this._inner.trace(message, context);
  }

  public debug(message: string, context?: Record<string, unknown>): void {
    this._inner.debug(message, context);
  }

  public info(message: string, context?: Record<string, unknown>): void {
    if (message.startsWith('Planned restart')) this._counters.plannedRestarts++;
    if (message.includes('session completed, restarting')) {
      this._counters.sessionCompletedRestarts++;
    }
    this._inner.info(message, context);
  }

  public warn(message: string, context?: Record<string, unknown>): void {
    this._counters.warnLogs++;
    if (message.includes('session failed, restarting')) this._counters.sessionFailedRestarts++;
    if (message.includes('entering cooldown')) this._counters.cooldowns++;
    this._inner.warn(message, context);
  }

  public error(message: string, context?: Record<string, unknown>): void {
    this._counters.errorLogs++;
    if (message.includes('failed permanently')) this._counters.permanentFailures++;
    if (this._counters.errorSamples.length < 30) {
      this._counters.errorSamples.push(`${message} ${JSON.stringify(context ?? {})}`);
    }
    this._inner.error(message, context);
  }

  public fatal(message: string, context?: Record<string, unknown>): void {
    this._counters.errorLogs++;
    this._inner.fatal(message, context);
  }

  public child(bindings: Record<string, unknown>): ILogger {
    return new CountingLogger(this._inner.child(bindings), this._counters);
  }
}

// ───────────────────────── Вспомогательные типы ─────────────────────────

/** Кольцевой буфер последних N строк. */
class Ring {
  private readonly _items: string[] = [];
  constructor(private readonly _cap: number) {}

  public push(item: string): void {
    this._items.push(item);
    if (this._items.length > this._cap) this._items.shift();
  }

  public toArray(): readonly string[] {
    return [...this._items];
  }
}

/** Счётчики одного CEX-потока (exchange-уровень). */
interface CexExchangeCounts {
  orderbook: number;
  trades: number;
  symbols: Set<string>;
}

/** Live-свидетельства одной композиции (собираются подписками на том же bus). */
interface CompositionEvidence {
  readonly runDir: string;
  readonly startedAtIso: string;
  finishedAtIso: string;
  busTotals: Record<string, number>;
  cexPerExchange: Record<string, { orderbook: number; trades: number; symbols: string[] }>;
  rtdsPerFeed: Record<string, number>;
  pmPerMarket: Record<string, number>;
  sequenceViolations: number;
  sequenceObserved: number;
  logCounters: LogCounters;
  /** Frozen ring-снимки рынков, покинувших ACTIVE: marketId → строки. */
  frozenMarketRings: Record<string, readonly string[]>;
  /** Frozen ring-снимки RTDS-фидов на момент выхода рынка из ACTIVE. */
  frozenRtdsRings: Record<string, Record<string, readonly string[]>>;
  /** Mid-run exact-match сэмплы CEX: `${exchange}\n${symbol}\n${stream}` → строки. */
  cexSamples: Record<string, readonly string[]>;
  finalStats: Record<string, unknown>;
  shutdownStepFailures: string[];
  activeResourcesAfterShutdown: readonly string[];
  cexSourcesFailed: string[];
  archivesSeen: string[];
}

// ───────────────────────── Одна композиция ──────────────────────────────

/** Параметры одной live-композиции. */
interface CompositionOptions {
  /** Директория этого запуска (изолированный output). */
  readonly runDir: string;
  /** Минимальная длительность сбора (мс). */
  readonly minMs: number;
  /** Дедлайн сбора (мс от старта). */
  readonly maxMs: number;
  /** Требовать ли полный Polymarket lifecycle (full mode). */
  readonly requireFullLifecycle: boolean;
}

/**
 * Поднимает ПОЛНУЮ композицию контура (один bus, один recorder, все
 * sources), собирает live-свидетельства и выполняет controlled shutdown.
 *
 * @param options - Параметры запуска (директории, длительности, режим)
 * @returns Свидетельства прогона для валидации и отчёта
 * @throws {Error} При невозможности поднять композицию (fail-fast конфигурация)
 */
async function runComposition(options: CompositionOptions): Promise<CompositionEvidence> {
  const logCounters = emptyLogCounters();
  const clock = new LiveClock();
  const logger: ILogger = new CountingLogger(new ConsoleLogger(clock, LogLevel.INFO), logCounters);
  const pmDir = path.join(options.runDir, 'polymarket');
  const cexDir = path.join(options.runDir, 'cex');
  fs.mkdirSync(pmDir, { recursive: true });
  fs.mkdirSync(cexDir, { recursive: true });

  const evidence: CompositionEvidence = {
    runDir: options.runDir,
    startedAtIso: new Date().toISOString(),
    finishedAtIso: '',
    busTotals: {},
    cexPerExchange: {},
    rtdsPerFeed: {},
    pmPerMarket: {},
    sequenceViolations: 0,
    sequenceObserved: 0,
    logCounters,
    frozenMarketRings: {},
    frozenRtdsRings: {},
    cexSamples: {},
    finalStats: {},
    shutdownStepFailures: [],
    activeResourcesAfterShutdown: [],
    cexSourcesFailed: [],
    archivesSeen: [],
  };

  logger.info('CHECKPOINT composition starting', {
    runDir: options.runDir,
    mode: MODE,
    exchanges: CEX_PLAN.map((spec) => spec.exchangeId),
  });

  // ── ONE bus / ONE recorder ────────────────────────────────────────────
  const client = createPublicClient();
  const bus = new ExternalMessageBus<ContourMessage>();
  const metadataGenerator = new MessageMetadataGenerator({
    clock,
    highResolutionClock: new LiveHighResolutionClock(),
  });
  const pmStorage = new DataRecorder(
    {
      outputDir: pmDir,
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
  const cexStorage = new CexWindowRecorder(
    {
      outputDir: cexDir,
      compression: 'gzip',
      bufferSize: 200,
      flushIntervalMs: 2_000,
    },
    logger,
  );
  await cexStorage.cleanup();
  const recorder = new ExternalMessageRecorder({
    bus,
    storage: pmStorage,
    logger,
    cex: { bus, storage: cexStorage },
  });
  recorder.start();

  // ── Polymarket contour (source + discovery + coordinator + finalizer) ─
  const pmSource = new PolymarketSource({ client, bus, metadataGenerator, logger });
  const discovery = new PolymarketMarketDiscovery(
    { client, filter: new MarketFilter(), scorer: new MarketScorer(clock), clock, logger },
    {
      filter: {
        minTimeToExpiryHours: 0,
        minSpread: 0,
        minLiquidity: 0,
        maxMarketsToReturn: MAX_MARKETS * 3,
        requiredKeywords: ['up or down'],
        anyOfKeywords: ['bitcoin', 'ethereum', 'solana', 'xrp'],
      },
    },
  );
  const coordinator = new MarketCollectionCoordinator(
    { discovery, source: pmSource, recorder, clock, logger },
    { maxMarkets: MAX_MARKETS, minTimeToStartMs: 30_000 },
  );
  const finalizer = new MarketFinalizer(
    { coordinator, recorder, gamma: client, clock, logger },
    { enrichmentRetryMs: 30_000, enrichmentMaxWaitMs: 60 * 60_000 },
  );

  // ── CEX sources (по одной на биржу) на ТОМ ЖЕ bus ─────────────────────
  const cexSources = CEX_PLAN.map(
    (config) => new CexSource({ config, bus, metadataGenerator, logger }),
  );

  // ── Checkpoint-счётчики: независимые подписки на ТОМ ЖЕ bus ───────────
  const busTotals = new Map<string, number>();
  const cexPerExchange = new Map<string, CexExchangeCounts>();
  const rtdsPerFeed = new Map<string, number>();
  const pmPerMarket = new Map<string, number>();
  const marketRings = new Map<string, Ring>();
  const rtdsRings = new Map<string, Ring>();
  const cexSampleStore = new Map<string, string[]>();
  let capturingCexSamples = false;
  const seq = { last: Number.NEGATIVE_INFINITY, violations: 0, observed: 0 };

  const bump = (map: Map<string, number>, key: string): void => {
    map.set(key, (map.get(key) ?? 0) + 1);
  };
  const observeSequence = (message: ContourMessage): void => {
    const candidate = (message as { metadata?: { sequence?: unknown } }).metadata?.sequence;
    if (typeof candidate === 'number') {
      seq.observed++;
      if (candidate <= seq.last) seq.violations++;
      else seq.last = candidate;
    }
  };

  const disposers: Array<() => void> = [];
  disposers.push(
    bus.subscribe('POLYMARKET_MARKET', (message) => {
      bump(busTotals, 'POLYMARKET_MARKET');
      observeSequence(message);
      const marketId = message.payload.payload.market;
      bump(pmPerMarket, marketId);
      let ring = marketRings.get(marketId);
      if (!ring) {
        ring = new Ring(RING_CAP);
        marketRings.set(marketId, ring);
      }
      ring.push(JSON.stringify(message.payload));
    }),
    bus.subscribe('POLYMARKET_CRYPTO_BINANCE', (message) => {
      bump(busTotals, 'POLYMARKET_CRYPTO_BINANCE');
      observeSequence(message);
      const key = `${message.payload.topic}\n${message.payload.payload.symbol}`;
      bump(rtdsPerFeed, key);
      let ring = rtdsRings.get(key);
      if (!ring) {
        ring = new Ring(RING_CAP);
        rtdsRings.set(key, ring);
      }
      ring.push(JSON.stringify(message.payload));
    }),
    bus.subscribe('POLYMARKET_CRYPTO_CHAINLINK', (message) => {
      bump(busTotals, 'POLYMARKET_CRYPTO_CHAINLINK');
      observeSequence(message);
      const key = `${message.payload.topic}\n${message.payload.payload.symbol}`;
      bump(rtdsPerFeed, key);
      let ring = rtdsRings.get(key);
      if (!ring) {
        ring = new Ring(RING_CAP);
        rtdsRings.set(key, ring);
      }
      ring.push(JSON.stringify(message.payload));
    }),
    bus.subscribe('CEX_ORDERBOOK', (message) => {
      bump(busTotals, 'CEX_ORDERBOOK');
      observeSequence(message);
      const payload = message.payload;
      let counts = cexPerExchange.get(payload.exchangeId);
      if (!counts) {
        counts = { orderbook: 0, trades: 0, symbols: new Set() };
        cexPerExchange.set(payload.exchangeId, counts);
      }
      counts.orderbook++;
      counts.symbols.add(payload.symbol);
      if (capturingCexSamples) {
        const key = `${payload.exchangeId}\n${payload.symbol}\norderbook`;
        const store = cexSampleStore.get(key) ?? [];
        if (store.length < 3) {
          store.push(JSON.stringify(payload));
          cexSampleStore.set(key, store);
        }
      }
    }),
    bus.subscribe('CEX_TRADE', (message) => {
      bump(busTotals, 'CEX_TRADE');
      observeSequence(message);
      const payload = message.payload;
      let counts = cexPerExchange.get(payload.exchangeId);
      if (!counts) {
        counts = { orderbook: 0, trades: 0, symbols: new Set() };
        cexPerExchange.set(payload.exchangeId, counts);
      }
      counts.trades++;
      counts.symbols.add(payload.symbol);
      if (capturingCexSamples) {
        const key = `${payload.exchangeId}\n${payload.symbol}\ntrades`;
        const store = cexSampleStore.get(key) ?? [];
        if (store.length < 3) {
          store.push(JSON.stringify(payload));
          cexSampleStore.set(key, store);
        }
      }
    }),
  );

  // ── Старт live-сбора ──────────────────────────────────────────────────
  for (const source of cexSources) source.start();

  const startedMs = Date.now();
  const knownActive = new Set<string>();
  let lastRefreshMs = 0;
  let lastStatusMs = 0;
  let pipelineError: unknown;

  /** Замораживает ring-снимки рынка, покинувшего ACTIVE (для exact-match валидации). */
  const freezeMarket = (marketId: string): void => {
    if (evidence.frozenMarketRings[marketId] !== undefined) return;
    evidence.frozenMarketRings[marketId] = marketRings.get(marketId)?.toArray() ?? [];
    const rtdsSnapshot: Record<string, readonly string[]> = {};
    for (const [key, ring] of rtdsRings) rtdsSnapshot[key] = ring.toArray();
    evidence.frozenRtdsRings[marketId] = rtdsSnapshot;
  };

  /** Список .jsonl.gz архивов Polymarket текущего прогона. */
  const listPmArchives = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.jsonl.gz')) out.push(full);
      }
    };
    walk(pmDir);
    return out.sort();
  };

  /** Есть ли завершённая gzip-партиция у КАЖДОЙ биржи. */
  const everyExchangeHasCompletedPartition = (): boolean =>
    CEX_PLAN.every((spec) => {
      const root = cexDir;
      if (!fs.existsSync(root)) return false;
      for (const dateDir of fs.readdirSync(root)) {
        const exchangeDir = path.join(root, dateDir, spec.exchangeId);
        if (!fs.existsSync(exchangeDir)) continue;
        if (fs.readdirSync(exchangeDir).some((name) => name.endsWith('.jsonl.gz'))) return true;
      }
      return false;
    });

  /**
   * Статус финализации архива с кэшем разбора.
   *
   * Архив неизменен после создания, поэтому успешный разбор кэшируется по
   * пути файла: `evidenceComplete` вызывается каждые 10 секунд, а разбор
   * header-а разжимает файл ЦЕЛИКОМ (архивы бывают по 8+ MB). Отказ разбора
   * НЕ кэшируется — `.jsonl.gz`, пойманный в момент сжатия, обязан быть
   * перечитан на следующем опросе.
   */
  const archiveHeaderCache = new Map<string, PmArchiveHeader>();
  const archiveFinalizationStatus = (file: string): string | undefined => {
    const cached = archiveHeaderCache.get(file);
    if (cached !== undefined) return cached.finalizationStatus;
    try {
      const parsed = parsePmArchiveHeader(file);
      archiveHeaderCache.set(file, parsed);
      return parsed.finalizationStatus;
    } catch {
      return undefined; // файл ещё дописывается — попробуем на следующем опросе
    }
  };

  /** Полный ли комплект live-свидетельств для остановки full-прогона. */
  const evidenceComplete = (): boolean => {
    if (!options.requireFullLifecycle) return false; // short-режим живёт до дедлайна
    if (Date.now() - startedMs < options.minMs) return false;
    const archiveComplete = listPmArchives().some(
      (file) => archiveFinalizationStatus(file) === 'complete',
    );
    if (!archiveComplete) return false;
    for (const spec of CEX_PLAN) {
      const counts = cexPerExchange.get(spec.exchangeId);
      if (!counts || counts.orderbook === 0 || counts.trades === 0) return false;
    }
    if (!everyExchangeHasCompletedPartition()) return false;
    const topics = new Set([...rtdsPerFeed.keys()].map((key) => key.split('\n')[0]!));
    if (!topics.has('prices.crypto.binance') || !topics.has('prices.crypto.chainlink')) {
      return false;
    }
    if (cexSampleStore.size === 0) return false;
    return true;
  };

  try {
    while (Date.now() - startedMs < options.maxMs && !stopRequested) {
      if (Date.now() - lastRefreshMs >= 30_000) {
        lastRefreshMs = Date.now();
        await coordinator.refreshCandidates();
      }
      await coordinator.fillSlots();
      await finalizer.runOnce();

      // Freeze ring-снимков рынков, покинувших ACTIVE (seal → архив)
      const nowActive = new Set<string>();
      for (const session of coordinator.listSessions()) {
        const key = String(session.marketId);
        if (session.state === 'ACTIVE') nowActive.add(key);
      }
      for (const key of knownActive) {
        if (!nowActive.has(key)) freezeMarket(key);
      }
      for (const key of nowActive) knownActive.add(key);

      // Окно захвата CEX-сэмплов: после ~60% MIN (full) / после 30s (short)
      const captureFromMs = options.requireFullLifecycle ? options.minMs * 0.6 : 30_000;
      capturingCexSamples = Date.now() - startedMs >= captureFromMs;

      if (Date.now() - lastStatusMs >= 60_000) {
        lastStatusMs = Date.now();
        logger.info('CHECKPOINT status', {
          minutes: Math.round((Date.now() - startedMs) / 6_000) / 10,
          busTotals: Object.fromEntries(busTotals),
          coordinator: coordinator.getStats(),
          finalizer: finalizer.getStats(),
          recorder: recorder.getStats(),
          recorderCex: recorder.getCexStats(),
          windows: cexStorage.getStats(),
          bus: bus.getStats(),
        });
      }

      if (evidenceComplete()) {
        logger.info('CHECKPOINT evidence complete, stopping collection early');
        break;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10_000);
      });
    }
  } catch (error) {
    pipelineError = error;
  }

  // Freeze всех оставшихся активных рынков ДО drain/shutdown (сэмплы колец —
  // подмножество уже записанных строк, exact-match работает и для рынков,
  // которые заархивируются во время drain)
  for (const key of knownActive) freezeMarket(key);

  // ── Drain: дождаться официальных резолюций уже начатых финализаций ────
  // (решение user 2026-08-25: остановка не срезает 60-мин окно ожидания;
  // опрос продолжается штатным 30s-cadence). SIGINT прерывает ожидание —
  // finalizer.close() в shutdown-лестнице разбудит спящий drain.
  if (options.requireFullLifecycle && DRAIN_FINALIZATIONS && !stopRequested) {
    logger.info('CHECKPOINT draining pending finalizations before shutdown', {
      finalizer: finalizer.getStats(),
      coordinator: coordinator.getStats(),
    });
    let drainSettled = false;
    // Отказ drain-а поглощается ЗДЕСЬ и попадает в evidence: если гонку
    // выигрывает polling-ветка (пришёл сигнал), непойманное отклонение
    // ушло бы в process-level unhandledRejection вместо отчёта
    const drainPromise = finalizer.drain().then(
      () => {
        drainSettled = true;
      },
      (error: unknown) => {
        drainSettled = true;
        const message = error instanceof Error ? error.message : String(error);
        evidence.shutdownStepFailures.push(`finalizer.drain: ${message}`);
        logger.error('CHECKPOINT finalization drain failed', { error: message });
      },
    );
    await Promise.race([
      drainPromise,
      (async () => {
        while (!stopRequested && !drainSettled) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 1_000);
          });
        }
      })(),
    ]);
    logger.info('CHECKPOINT finalization drain finished', {
      finalizer: finalizer.getStats(),
      interruptedBySignal: stopRequested,
    });
  }

  // ── Финальный снимок stats ДО shutdown ────────────────────────────────
  evidence.finalStats = {
    coordinator: coordinator.getStats(),
    finalizer: finalizer.getStats(),
    recorder: recorder.getStats(),
    recorderCex: recorder.getCexStats(),
    windows: cexStorage.getStats(),
    bus: bus.getStats(),
    cexSources: cexSources.map((source, index) => ({
      exchange: CEX_PLAN[index]!.exchangeId,
      stats: source.getStats(),
      hasFailed: source.hasFailed,
    })),
  };

  // ── Controlled shutdown в порядке контура ─────────────────────────────
  const cleanupStep = async (step: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      evidence.shutdownStepFailures.push(
        `${step}: ${error instanceof Error ? error.message : String(error)}`,
      );
      logger.error('CHECKPOINT cleanup step failed', {
        step,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  await cleanupStep('finalizer.close', async () => finalizer.close());
  await cleanupStep('coordinator.close', async () => coordinator.close());
  await cleanupStep('pmSource.close', async () => pmSource.close());
  await cleanupStep('cexSources.close', async () => {
    await Promise.all(cexSources.map(async (source) => source.close()));
  });
  await cleanupStep('bus.drain', async () => {
    const drained = await bus.drain();
    if (!drained.ok) throw new Error(`bus.drain rejected: ${drained.error.message}`);
  });
  await cleanupStep('recorder.close', async () => recorder.close());
  await cleanupStep('bus.close', async () => {
    const closed = await bus.close();
    if (!closed.ok) throw new Error(`bus.close rejected: ${closed.error.message}`);
  });
  for (const dispose of disposers) dispose();

  for (const [index, source] of cexSources.entries()) {
    if (source.hasFailed) evidence.cexSourcesFailed.push(CEX_PLAN[index]!.exchangeId);
  }

  evidence.finishedAtIso = new Date().toISOString();
  evidence.busTotals = Object.fromEntries(busTotals);
  evidence.cexPerExchange = Object.fromEntries(
    [...cexPerExchange].map(([exchange, counts]) => [
      exchange,
      { orderbook: counts.orderbook, trades: counts.trades, symbols: [...counts.symbols].sort() },
    ]),
  );
  evidence.rtdsPerFeed = Object.fromEntries(rtdsPerFeed);
  evidence.pmPerMarket = Object.fromEntries(pmPerMarket);
  evidence.sequenceViolations = seq.violations;
  evidence.sequenceObserved = seq.observed;
  evidence.cexSamples = Object.fromEntries(cexSampleStore);
  evidence.archivesSeen = listPmArchives();
  evidence.activeResourcesAfterShutdown = process.getActiveResourcesInfo();

  logger.info('CHECKPOINT composition finished', {
    busTotals: evidence.busTotals,
    shutdownStepFailures: evidence.shutdownStepFailures,
    activeResources: evidence.activeResourcesAfterShutdown,
  });

  if (pipelineError !== undefined) throw pipelineError;
  return evidence;
}

// ───────────────────────── Валидация артефактов ─────────────────────────

/** Компактный разбор header-а Polymarket-архива. */
interface PmArchiveHeader {
  readonly marketId: string;
  readonly conditionId: string;
  readonly question: string;
  readonly finalizationStatus: string | undefined;
  readonly finalizationAttempts: number;
  readonly priceToBeat: unknown;
  readonly finalPrice: unknown;
  readonly winningLabel: string | undefined;
  /** Происхождение победителя (winner-ladder). */
  readonly winningSource: string | undefined;
  /** Точный результат (официальные источники) или приблизительный. */
  readonly winningExact: boolean | undefined;
  /** UMA-резолюция дошла до архива. */
  readonly umaResolved: boolean;
  readonly expiresAtMs: number | null;
  readonly finalizedAtMs: number | null;
}

/**
 * Разбирает first-line header архива Polymarket.
 *
 * @param file - Путь к `.jsonl.gz`
 * @returns Компактные finalization-поля header-а
 * @throws {Error} Если файл не gzip/не JSONL/без meta-header
 */
function parsePmArchiveHeader(file: string): PmArchiveHeader {
  const firstLine = zlib
    .gunzipSync(fs.readFileSync(file))
    .toString('utf8')
    .split('\n', 1)[0]!;
  const header = JSON.parse(firstLine) as Record<string, unknown>;
  if (header['t'] !== 'meta') throw new Error(`not a meta header: ${file}`);
  const m = header['m'] as Record<string, unknown>;
  const timing = (m['timing'] ?? {}) as Record<string, unknown>;
  const finalization = (m['finalization'] ?? {}) as Record<string, unknown>;
  const crypto = (finalization['crypto'] ?? {}) as Record<string, unknown>;
  const winning = finalization['winning'] as Record<string, unknown> | undefined;
  const resolution = (finalization['resolution'] ?? {}) as Record<string, unknown>;
  return {
    marketId: String(header['marketId'] ?? ''),
    conditionId: String(m['conditionId'] ?? ''),
    question: String(m['question'] ?? ''),
    finalizationStatus:
      finalization['status'] !== undefined ? String(finalization['status']) : undefined,
    finalizationAttempts: Number(finalization['attempts'] ?? 0),
    priceToBeat: crypto['priceToBeat'],
    finalPrice: crypto['finalPrice'],
    winningLabel: winning !== undefined ? String(winning['label']) : undefined,
    winningSource:
      winning !== undefined && winning['source'] !== undefined
        ? String(winning['source'])
        : undefined,
    winningExact: winning !== undefined ? winning['exact'] === true : undefined,
    umaResolved: resolution['umaResolutionStatus'] === 'resolved',
    expiresAtMs: typeof timing['expiresAt'] === 'number' ? timing['expiresAt'] : null,
    finalizedAtMs:
      typeof finalization['finalizedAtMs'] === 'number' ? finalization['finalizedAtMs'] : null,
  };
}

/** Результат валидации артефактов одного прогона. */
interface ValidationReport {
  violations: string[];
  pmArchives: Array<{
    file: string;
    marketId: string;
    question: string;
    status: string | undefined;
    payloadLines: number;
    marketLines: number;
    rtdsLines: number;
    priceToBeat: unknown;
    finalPrice: unknown;
    winningLabel: string | undefined;
    winningSource: string | undefined;
    winningExact: boolean | undefined;
    umaResolved: boolean;
    enrichLatencyMin: number | null;
    exactMarketSampleMatched: boolean;
    exactRtdsSampleMatched: boolean;
    sizeBytes: number;
  }>;
  pmIncompleteFiles: string[];
  cex: {
    gzFiles: number;
    totalLines: number;
    orderbookLines: number;
    tradeLines: number;
    parseErrors: number;
    identityMismatches: number;
    envelopeLeaks: number;
    crossRouteLines: number;
    perExchangeFiles: Record<string, number>;
    perExchangeLines: Record<string, number>;
    incompleteFiles: string[];
    samplesMatched: number;
    samplesTotal: number;
  };
}

/** Есть ли в распарсенной строке запрещённые envelope-ключи. */
function hasEnvelopeLeak(parsed: Record<string, unknown>): boolean {
  return ENVELOPE_KEYS.some((key) => key in parsed);
}

/**
 * Полная валидация артефактов прогона: PM-архивы, CEX-партиции, routing,
 * payload-only, exact-match сэмплы.
 *
 * @param runDir - Директория прогона
 * @param evidence - Live-свидетельства композиции
 * @param requireFullLifecycle - Требовать ли complete-архив PM (full mode)
 * @returns Отчёт валидации с нарушениями
 */
function validateArtifacts(
  runDir: string,
  evidence: CompositionEvidence,
  requireFullLifecycle: boolean,
): ValidationReport {
  const report: ValidationReport = {
    violations: [],
    pmArchives: [],
    pmIncompleteFiles: [],
    cex: {
      gzFiles: 0,
      totalLines: 0,
      orderbookLines: 0,
      tradeLines: 0,
      parseErrors: 0,
      identityMismatches: 0,
      envelopeLeaks: 0,
      crossRouteLines: 0,
      perExchangeFiles: {},
      perExchangeLines: {},
      incompleteFiles: [],
      samplesMatched: 0,
      samplesTotal: 0,
    },
  };
  const pmRoot = path.join(runDir, 'polymarket');
  const cexRoot = path.join(runDir, 'cex');

  // ── Polymarket ────────────────────────────────────────────────────────
  const walk = (dir: string, onFile: (file: string) => void): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, onFile);
      else onFile(full);
    }
  };

  walk(pmRoot, (file) => {
    if (file.endsWith('.jsonl') && !file.endsWith('.jsonl.gz')) {
      report.pmIncompleteFiles.push(file);
      return;
    }
    if (!file.endsWith('.jsonl.gz')) return;
    let header: PmArchiveHeader;
    let lines: string[];
    try {
      const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
      lines = text.trimEnd().split('\n').filter((line) => line.length > 0);
      header = parsePmArchiveHeader(file);
    } catch (error) {
      report.violations.push(
        `PM archive unreadable: ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (header.marketId !== header.conditionId) {
      report.violations.push(
        `PM header identity mismatch in ${file}: marketId=${header.marketId} conditionId=${header.conditionId}`,
      );
    }
    let marketLines = 0;
    let rtdsLines = 0;
    // Повторяющиеся нарушения агрегируются per-archive (без флуда отчёта)
    let parseErrors = 0;
    let envelopeLeaks = 0;
    let crossRouted = 0;
    let foreignMarket = 0;
    let unclassifiable = 0;
    const lineSet = new Set<string>();
    for (const line of lines.slice(1)) {
      lineSet.add(line);
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        parseErrors++;
        continue;
      }
      if (hasEnvelopeLeak(parsed)) {
        envelopeLeaks++;
        continue;
      }
      if ('exchangeId' in parsed || 'orderBook' in parsed || 'trade' in parsed) {
        crossRouted++;
        continue;
      }
      // ВАЖНО: RTDS-события ТОЖЕ несут type ('update') — RTDS-ветка идёт
      // ПЕРВОЙ, market-события различаются по vendor topic === 'market'
      const topic = parsed['topic'];
      if (typeof topic === 'string' && topic.startsWith('prices.crypto.')) {
        rtdsLines++;
      } else if (topic === 'market') {
        marketLines++;
        const inner = parsed['payload'] as Record<string, unknown> | undefined;
        const lineMarket = inner !== undefined ? String(inner['market'] ?? '') : '';
        if (lineMarket !== header.conditionId) foreignMarket++;
      } else {
        unclassifiable++;
      }
    }
    if (parseErrors > 0) report.violations.push(`PM line parse errors in ${file}: ${parseErrors}`);
    if (envelopeLeaks > 0) report.violations.push(`PM envelope leaks in ${file}: ${envelopeLeaks}`);
    if (crossRouted > 0) {
      report.violations.push(`CEX lines cross-routed into PM archive ${file}: ${crossRouted}`);
    }
    if (foreignMarket > 0) {
      report.violations.push(`foreign market lines in ${file}: ${foreignMarket}`);
    }
    if (unclassifiable > 0) {
      report.violations.push(`unclassifiable PM lines in ${file}: ${unclassifiable}`);
    }

    // Exact-match сэмплы frozen ring-ов этого рынка
    const frozenMarket = evidence.frozenMarketRings[header.conditionId] ?? [];
    const exactMarketSampleMatched = frozenMarket.some((sample) => lineSet.has(sample));
    const frozenRtds = evidence.frozenRtdsRings[header.conditionId] ?? {};
    const exactRtdsSampleMatched = Object.values(frozenRtds).some((samples) =>
      samples.some((sample) => lineSet.has(sample)),
    );

    report.pmArchives.push({
      file,
      marketId: header.marketId,
      question: header.question,
      status: header.finalizationStatus,
      payloadLines: lines.length - 1,
      marketLines,
      rtdsLines,
      priceToBeat: header.priceToBeat,
      finalPrice: header.finalPrice,
      winningLabel: header.winningLabel,
      winningSource: header.winningSource,
      winningExact: header.winningExact,
      umaResolved: header.umaResolved,
      enrichLatencyMin:
        header.expiresAtMs !== null && header.finalizedAtMs !== null
          ? Math.round(((header.finalizedAtMs - header.expiresAtMs) / 60_000) * 10) / 10
          : null,
      exactMarketSampleMatched,
      exactRtdsSampleMatched,
      sizeBytes: fs.statSync(file).size,
    });
  });

  if (report.pmIncompleteFiles.length > 0) {
    report.violations.push(
      `stale incomplete PM .jsonl after shutdown: ${report.pmIncompleteFiles.join(', ')}`,
    );
  }
  if (requireFullLifecycle) {
    const complete = report.pmArchives.filter((archive) => archive.status === 'complete');
    if (complete.length === 0) {
      report.violations.push('no PM archive with finalization.status=complete');
    }
    for (const archive of complete) {
      if (archive.marketLines === 0) {
        report.violations.push(`complete PM archive has zero market lines: ${archive.file}`);
      }
      if (archive.rtdsLines === 0) {
        report.violations.push(`complete PM archive has zero RTDS lines: ${archive.file}`);
      }
      if (archive.priceToBeat === undefined || archive.finalPrice === undefined) {
        report.violations.push(`complete PM archive missing crypto finalization: ${archive.file}`);
      }
      // Winner-ladder (решение user 2026-08-25): у complete-архива победитель
      // ОБЯЗАН присутствовать и быть точным — либо из UMA-резолюции
      // (`resolution`), либо по формуле рынка на официальных ценах
      // (`official-prices`); приблизительные источники здесь недопустимы
      if (archive.winningLabel === undefined) {
        report.violations.push(`complete PM archive missing winning outcome: ${archive.file}`);
      } else if (
        archive.winningSource !== 'resolution' &&
        archive.winningSource !== 'official-prices'
      ) {
        report.violations.push(
          `complete PM archive has non-official winner source ` +
            `'${String(archive.winningSource)}': ${archive.file}`,
        );
      } else if (archive.winningExact !== true) {
        report.violations.push(`complete PM archive winner is not exact: ${archive.file}`);
      }
      if (archive.umaResolved && archive.winningSource !== 'resolution') {
        report.violations.push(
          `resolved PM archive should use resolution source, got ` +
            `'${String(archive.winningSource)}': ${archive.file}`,
        );
      }
      if (!archive.exactMarketSampleMatched) {
        report.violations.push(
          `no exact market payload sample matched in ${archive.file} (payload-only equality unproven)`,
        );
      }
      if (archive.rtdsLines > 0 && !archive.exactRtdsSampleMatched) {
        report.violations.push(`no exact RTDS payload sample matched in ${archive.file}`);
      }
    }
  }

  // Провенанс победителя корректен в ЛЮБОМ архиве, где он есть (в т.ч.
  // timeout): известный источник + согласованный флаг точности
  const EXACT_SOURCES = ['resolution', 'official-prices', 'recorded-twap'];
  const APPROXIMATE_SOURCES = ['recorded-rtds'];
  for (const archive of report.pmArchives) {
    if (archive.winningLabel === undefined) {
      continue;
    }
    const source = String(archive.winningSource);
    if (!EXACT_SOURCES.includes(source) && !APPROXIMATE_SOURCES.includes(source)) {
      report.violations.push(`unknown winner source '${source}': ${archive.file}`);
      continue;
    }
    if (EXACT_SOURCES.includes(source) !== (archive.winningExact === true)) {
      report.violations.push(
        `winner exactness contradicts source '${source}': ${archive.file}`,
      );
    }
  }

  // ── CEX ───────────────────────────────────────────────────────────────
  const sampleSets = new Map<string, Set<string>>();
  const sampleFound = new Map<string, number>();
  for (const [key, samples] of Object.entries(evidence.cexSamples)) {
    sampleSets.set(key, new Set(samples));
    sampleFound.set(key, 0);
    report.cex.samplesTotal += samples.length;
  }

  walk(cexRoot, (file) => {
    const name = path.basename(file);
    if (name.endsWith('.jsonl') && !name.endsWith('.jsonl.gz')) {
      report.cex.incompleteFiles.push(file);
      return;
    }
    if (!name.endsWith('.jsonl.gz')) return;
    report.cex.gzFiles++;
    const dirExchange = path.basename(path.dirname(file));
    report.cex.perExchangeFiles[dirExchange] = (report.cex.perExchangeFiles[dirExchange] ?? 0) + 1;
    // {exchange}_{symbol}_{marketType}_{stream}_{dateET}_{startET}-{endET}_ET.jsonl.gz
    const parts = name.replace(/\.jsonl\.gz$/, '').split('_');
    const fileExchange = parts[0] ?? '';
    const fileSymbol = parts[1] ?? '';
    const fileMarketType = parts[2] ?? '';
    const fileStream = parts[3] ?? '';
    if (fileExchange !== dirExchange) {
      report.cex.identityMismatches++;
      report.violations.push(`CEX file/dir exchange mismatch: ${file}`);
    }
    let text: string;
    try {
      text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
    } catch (error) {
      report.violations.push(
        `CEX gzip unreadable: ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    const lines = text.trimEnd().split('\n').filter((line) => line.length > 0);
    if (lines.length === 0) {
      report.violations.push(`empty completed CEX partition: ${file}`);
      return;
    }
    for (const line of lines) {
      report.cex.totalLines++;
      report.cex.perExchangeLines[dirExchange] =
        (report.cex.perExchangeLines[dirExchange] ?? 0) + 1;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        report.cex.parseErrors++;
        continue;
      }
      if (hasEnvelopeLeak(parsed)) {
        report.cex.envelopeLeaks++;
        continue;
      }
      const isOrderbook = 'orderBook' in parsed;
      const isTrade = 'trade' in parsed;
      if (!isOrderbook && !isTrade) {
        report.cex.crossRouteLines++;
        continue;
      }
      if (isOrderbook) report.cex.orderbookLines++;
      if (isTrade) report.cex.tradeLines++;
      const lineExchange = String(parsed['exchangeId'] ?? '');
      const lineSymbol = String(parsed['symbol'] ?? '');
      const lineMarketType = String(parsed['marketType'] ?? '');
      const sanitizedSymbol = lineSymbol.replace(/[/:]/g, '-');
      if (
        lineExchange !== fileExchange ||
        sanitizedSymbol !== fileSymbol ||
        lineMarketType !== fileMarketType ||
        (isOrderbook ? 'orderbook' : 'trades') !== fileStream
      ) {
        report.cex.identityMismatches++;
      }
      const sampleKey = `${lineExchange}\n${lineSymbol}\n${isOrderbook ? 'orderbook' : 'trades'}`;
      const sampleSet = sampleSets.get(sampleKey);
      if (sampleSet !== undefined && sampleSet.has(line)) {
        sampleSet.delete(line);
        sampleFound.set(sampleKey, (sampleFound.get(sampleKey) ?? 0) + 1);
      }
    }
  });

  for (const found of sampleFound.values()) report.cex.samplesMatched += found;
  if (report.cex.parseErrors > 0) {
    report.violations.push(`CEX parse errors: ${report.cex.parseErrors}`);
  }
  if (report.cex.envelopeLeaks > 0) {
    report.violations.push(`CEX envelope leaks: ${report.cex.envelopeLeaks}`);
  }
  if (report.cex.identityMismatches > 0) {
    report.violations.push(`CEX identity mismatches: ${report.cex.identityMismatches}`);
  }
  if (report.cex.crossRouteLines > 0) {
    report.violations.push(`non-CEX lines inside CEX partitions: ${report.cex.crossRouteLines}`);
  }
  if (report.cex.incompleteFiles.length > 0) {
    report.violations.push(
      `stale incomplete CEX .jsonl after shutdown: ${report.cex.incompleteFiles.join(', ')}`,
    );
  }
  if (requireFullLifecycle) {
    if (report.cex.gzFiles === 0) report.violations.push('no completed CEX partitions');
    if (report.cex.orderbookLines === 0) report.violations.push('no CEX orderbook lines');
    if (report.cex.tradeLines === 0) report.violations.push('no CEX trade lines');
    for (const spec of CEX_PLAN) {
      if ((report.cex.perExchangeFiles[spec.exchangeId] ?? 0) === 0) {
        report.violations.push(`no completed partitions for exchange ${spec.exchangeId}`);
      }
    }
    if (report.cex.samplesTotal === 0) {
      report.violations.push('no CEX exact-match samples were captured');
    } else if (report.cex.samplesMatched === 0) {
      report.violations.push('no CEX exact-match sample found in completed partitions');
    }
  }

  // ── Live-инварианты композиции ────────────────────────────────────────
  const finalStats = evidence.finalStats as {
    recorder?: { serializationFailures?: number; handlerErrors?: number };
    recorderCex?: { cexWriteFailures?: number; cexHandlerErrors?: number };
    windows?: {
      rotationFailures?: number;
      streamCloseFailures?: number;
      compressionFailures?: number;
    };
    bus?: { handlerErrorsTotal?: number; rejectedPublicationsTotal?: number; queueSize?: number };
    cexSources?: Array<{
      exchange: string;
      hasFailed: boolean;
      stats: { orderbookSnapshotFailures: number; tradeSnapshotFailures: number };
    }>;
  };
  if ((finalStats.recorder?.serializationFailures ?? 0) > 0) {
    report.violations.push('PM storage serialization failures > 0');
  }
  if ((finalStats.recorderCex?.cexWriteFailures ?? 0) > 0) {
    report.violations.push('CEX recorder write failures > 0');
  }
  if ((finalStats.recorderCex?.cexHandlerErrors ?? 0) > 0) {
    report.violations.push('CEX recorder handler errors > 0');
  }
  if ((finalStats.windows?.rotationFailures ?? 0) > 0) {
    report.violations.push('CEX window rotation failures > 0');
  }
  if ((finalStats.windows?.streamCloseFailures ?? 0) > 0) {
    report.violations.push('CEX window stream close failures > 0');
  }
  if ((finalStats.windows?.compressionFailures ?? 0) > 0) {
    report.violations.push('CEX window compression failures > 0');
  }
  if ((finalStats.bus?.rejectedPublicationsTotal ?? 0) > 0) {
    report.violations.push('bus rejected publications > 0');
  }
  for (const source of finalStats.cexSources ?? []) {
    if (source.hasFailed) report.violations.push(`CEX source failed: ${source.exchange}`);
    if (source.stats.orderbookSnapshotFailures > 0 || source.stats.tradeSnapshotFailures > 0) {
      report.violations.push(`CEX snapshot failures on ${source.exchange}`);
    }
  }
  if (evidence.logCounters.permanentFailures > 0) {
    report.violations.push('permanent transport failures observed in logs');
  }
  if (evidence.sequenceViolations > 0) {
    report.violations.push(`bus sequence monotonicity violations: ${evidence.sequenceViolations}`);
  }
  if (evidence.shutdownStepFailures.length > 0) {
    report.violations.push(`shutdown step failures: ${evidence.shutdownStepFailures.join('; ')}`);
  }
  if ((evidence.busTotals['POLYMARKET_MARKET'] ?? 0) === 0) {
    report.violations.push('no POLYMARKET_MARKET messages on bus');
  }
  const rtdsTotal =
    (evidence.busTotals['POLYMARKET_CRYPTO_BINANCE'] ?? 0) +
    (evidence.busTotals['POLYMARKET_CRYPTO_CHAINLINK'] ?? 0);
  if (rtdsTotal === 0) report.violations.push('no RTDS messages on bus');
  if ((evidence.busTotals['CEX_ORDERBOOK'] ?? 0) === 0) {
    report.violations.push('no CEX_ORDERBOOK messages on bus');
  }
  if ((evidence.busTotals['CEX_TRADE'] ?? 0) === 0) {
    report.violations.push('no CEX_TRADE messages on bus');
  }
  for (const spec of CEX_PLAN) {
    const counts = evidence.cexPerExchange[spec.exchangeId];
    if (counts === undefined || counts.orderbook === 0) {
      report.violations.push(`no orderbook messages from ${spec.exchangeId}`);
    }
    if (counts === undefined || counts.trades === 0) {
      report.violations.push(`no trade messages from ${spec.exchangeId}`);
    }
  }

  return report;
}

// ────────────────────────────── Main ────────────────────────────────────

/**
 * Точка входа checkpoint-runner-а: full или short (restart) режим.
 *
 * @returns Код выхода процесса (0 — PASS live-инвариантов)
 */
async function main(): Promise<number> {
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${MODE}`;
  const runRoot = path.resolve(OUTPUT_ROOT, runId);
  fs.mkdirSync(runRoot, { recursive: true });
  console.log(`CHECKPOINT #1 runner: mode=${MODE} runDir=${runRoot}`);

  const runs: Array<{ evidence: CompositionEvidence; validation: ValidationReport }> = [];
  let failure: unknown;
  try {
    if (MODE === 'full') {
      const evidence = await runComposition({
        runDir: runRoot,
        minMs: MIN_MINUTES * 60_000,
        maxMs: MAX_MINUTES * 60_000,
        requireFullLifecycle: true,
      });
      runs.push({ evidence, validation: validateArtifacts(runRoot, evidence, true) });
    } else {
      for (const label of ['run-a', 'run-b']) {
        if (stopRequested) break;
        const runDir = path.join(runRoot, label);
        fs.mkdirSync(runDir, { recursive: true });
        const evidence = await runComposition({
          runDir,
          minMs: SHORT_MINUTES * 60_000,
          maxMs: SHORT_MINUTES * 60_000,
          requireFullLifecycle: false,
        });
        runs.push({ evidence, validation: validateArtifacts(runDir, evidence, false) });
      }
    }
  } catch (error) {
    failure = error;
  }

  const allViolations = runs.flatMap((run, index) =>
    run.validation.violations.map((violation) => `[run ${index + 1}] ${violation}`),
  );
  if (processAnomalies.unhandledRejections > 0) {
    allViolations.push(`unhandled rejections: ${processAnomalies.unhandledRejections}`);
  }
  if (processAnomalies.uncaughtExceptions > 0) {
    allViolations.push(`uncaught exceptions: ${processAnomalies.uncaughtExceptions}`);
  }
  if (failure !== undefined) {
    allViolations.push(
      `pipeline failure: ${failure instanceof Error ? failure.stack ?? failure.message : String(failure)}`,
    );
  }

  const report = {
    checkpoint: 'CHECKPOINT #1 — RAW LIVE COLLECTION',
    mode: MODE,
    runId,
    runRoot,
    verdict: allViolations.length === 0 ? 'PASS' : 'FAIL',
    violations: allViolations,
    processAnomalies,
    runs: runs.map((run) => ({
      evidence: {
        ...run.evidence,
        // frozen rings и сэмплы объёмны — в report.json кладём только размеры
        frozenMarketRings: Object.fromEntries(
          Object.entries(run.evidence.frozenMarketRings).map(([key, ring]) => [key, ring.length]),
        ),
        frozenRtdsRings: Object.keys(run.evidence.frozenRtdsRings),
        cexSamples: Object.fromEntries(
          Object.entries(run.evidence.cexSamples).map(([key, samples]) => [
            key.replace(/\n/g, '|'),
            samples.length,
          ]),
        ),
      },
      validation: run.validation,
    })),
  };
  fs.writeFileSync(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2));

  console.log('\n════════ CHECKPOINT RUNNER REPORT ════════');
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nCHECKPOINT RUNNER VERDICT: ${report.verdict}`);
  return report.verdict === 'PASS' ? 0 : 2;
}

/**
 * Вооружает watchdog orphan-handles после завершения `main()`.
 *
 * @remarks
 * НЕ держит event loop (`unref`): если процесс жив спустя 60s после
 * завершения main — это orphan handles, падаем громко (не маскируем exit-ом).
 */
function armExitWatchdog(): void {
  const watchdog = setTimeout(() => {
    console.error('CHECKPOINT: process did not exit naturally within 60s after main()');
    console.error('Active resources:', process.getActiveResourcesInfo());
    process.exit(3);
  }, 60_000);
  watchdog.unref();
}

void main().then(
  (code) => {
    process.exitCode = code;
    armExitWatchdog();
  },
  (error: unknown) => {
    // Отказ САМОГО runner-а (не сбор evidence) — тоже FAIL по контракту
    // выхода. Без этой ветки зарегистрированный unhandledRejection-обработчик
    // подавил бы дефолтный аварийный выход Node, и прогон завершился бы с
    // кодом 0 без вердикта.
    console.error('CHECKPOINT RUNNER CRASHED before producing a verdict:', error);
    process.exitCode = 2;
    armExitWatchdog();
  },
);
