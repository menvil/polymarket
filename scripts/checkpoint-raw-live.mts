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
 * Контур поднимается production-фабрикой `createDataCollector`
 * (`apps/collect-data/src/runtime`) — ТОЙ ЖЕ, что и production `main.ts`.
 * Собственной composition у runner-а больше нет: расхождение между
 * «проверенным» и «работающим» контуром — именно тот класс дефектов,
 * который verification обязан ловить, а не создавать.
 *
 * ```text
 *                 createDataCollector(...)
 *                     ↑              ↑
 *               production      checkpoint
 *                  main         verification
 * ```
 *
 * Биржи и пары — подмножество production-конфига коллектора
 * (`apps/collect-data/cex-config.json`): binance, coinbase, kraken,
 * cryptocom, okx, bybit; restartIntervalMs 15 минут — как в production
 * (плановый рестарт транспорта попадает в окно прогона и даёт живое
 * свидетельство restart+recovery). Окно CEX-партиций — production default
 * (5 минут), НЕ уменьшено.
 *
 * Runner ТОЛЬКО конфигурирует и наблюдает: собственных adapters нет,
 * payload не преобразуется, новая observability не строится (счётчики
 * checkpoint-а — независимые подписки на том же bus + счётный
 * logger-wrapper + read-only lifecycle-наблюдатель рантайма). Именно
 * независимая подписка на общий bus доказывает, что раздача сообщений не
 * замурована в recorder: тем же способом позже подключится Semantic Adapter.
 *
 * Режимы (`CHECKPOINT_MODE`):
 * - `full` (default) — полный прогон до полного lifecycle Polymarket
 *   (DISCOVER → … → FINALIZE → ARCHIVE) + завершённые CEX-окна по всем
 *   биржам; затем строгая валидация артефактов;
 * - `short` — restart-верификация: ДВЕ последовательные композиции в одном
 *   процессе (teardown → повторный startup), короткий сбор, лёгкая валидация.
 *
 * Shutdown full-режима — graceful wind-down: перед закрытием контура
 * выполняется `collector.drain()` — уже начатые финализации дожидаются
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
import { ConsoleLogger, LogLevel } from '@polymarket/logger';
import type { ILogger } from '@polymarket/logger';
import { LiveClock } from '@polymarket/time';
import { ExternalMessageBus } from '@polymarket/external-message-bus';
import {
  RAW_ARCHIVE_FORMAT_VERSION,
  decodeDetachedArchiveLine,
  detectRawArchiveFormat,
  readCexPartitionHeader,
  toRecordedObservation,
} from '@polymarket/raw-archive-format';
import type { CexSourceConfig } from '@polymarket/cex-v2';
import { createDataCollector } from '@polymarket/collect-data/runtime';
import type {
  ContourMessage,
  DataCollectorConfig,
  DataCollectorStatus,
} from '@polymarket/collect-data/runtime';

// ───────────────────────────── Конфигурация ─────────────────────────────

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

/**
 * Live-only поля metadata, которым ЗАПРЕЩЕНО попадать в архив.
 *
 * @remarks
 * Replayable Raw Format V2 записывает `ingress` (`runId`/`sequence` +
 * high-resolution момент наблюдения) — это исторический ключ порядка. А вот
 * identity доставки конкретного процесса (`messageId`/`correlationId`/
 * `causationId`) и весь live-конверт (`metadata`) на диск не идут: при
 * replay сообщение получит СВОЮ runtime metadata.
 */
const FORBIDDEN_LIVE_ONLY_KEYS = [
  'metadata',
  'messageId',
  'correlationId',
  'causationId',
  'createdAt',
] as const;

/** Ровно те поля, из которых состоит V2-наблюдение. */
const OBSERVATION_KEYS = ['ingress', 'payload', 'type'] as const;

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
 * Конфигурация рантайма для checkpoint-прогона.
 *
 * @param runDir - Изолированный корень датасетов этого прогона
 * @returns Конфигурация production-фабрики контура
 *
 * @remarks
 * Это КОНФИГУРАЦИЯ verification-прогона, а НЕ production defaults: широкий
 * discovery-фильтр, нулевые пороги, малый lead time и изолированный
 * output нужны, чтобы полный lifecycle рынка уложился в окно прогона.
 * Production-значения живут в `.env`/`cex-config.json` приложения.
 */
function checkpointConfig(runDir: string): DataCollectorConfig {
  return {
    outputDir: runDir,
    polymarket: {
      sourceSubDir: 'polymarket',
      bufferSize: 200,
      flushIntervalMs: 5_000,
      compression: 'gzip',
    },
    discovery: {
      filter: {
        minTimeToExpiryHours: 0,
        minSpread: 0,
        minLiquidity: 0,
        maxMarketsToReturn: MAX_MARKETS * 3,
        requiredKeywords: ['up or down'],
        anyOfKeywords: ['bitcoin', 'ethereum', 'solana', 'xrp'],
        excludedKeywords: [],
      },
    },
    collection: {
      maxMarkets: MAX_MARKETS,
      minTimeToStartMs: 30_000,
      discoveryRefreshMs: 30_000,
      runtimeTickMs: 5_000,
    },
    finalization: { enrichmentRetryMs: 30_000, enrichmentMaxWaitMs: 60 * 60_000 },
    cex: {
      sources: CEX_PLAN,
      bufferSize: 200,
      flushIntervalMs: 2_000,
      compression: 'gzip',
    },
  };
}

/**
 * Поднимает ПОЛНЫЙ контур production-фабрикой, собирает live-свидетельства
 * независимыми подписками на общий bus и выполняет controlled shutdown.
 *
 * @param options - Параметры запуска (директории, длительности, режим)
 * @returns Свидетельства прогона для валидации и отчёта
 * @throws {Error} При невозможности поднять контур (fail-fast конфигурация)
 */
async function runComposition(options: CompositionOptions): Promise<CompositionEvidence> {
  const logCounters = emptyLogCounters();
  const clock = new LiveClock();
  const logger: ILogger = new CountingLogger(new ConsoleLogger(clock, LogLevel.INFO), logCounters);
  fs.mkdirSync(options.runDir, { recursive: true });

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

  // ── Production-контур: ТА ЖЕ фабрика, что и у production main ─────────
  // Bus создаётся ЗДЕСЬ и передаётся фабрике: именно так consumer получает
  // возможность подписаться до старта ingress, не завися от коллектора.
  const bus = new ExternalMessageBus<ContourMessage>();
  const { collector } = createDataCollector({
    config: checkpointConfig(options.runDir),
    logger,
    clock,
    bus,
  });

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
      ring.push(JSON.stringify(toRecordedObservation(message)));
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
      ring.push(JSON.stringify(toRecordedObservation(message)));
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
      ring.push(JSON.stringify(toRecordedObservation(message)));
    }),
    bus.subscribe('POLYMARKET_CRYPTO_CHAINLINK_TWAP', (message) => {
      bump(busTotals, 'POLYMARKET_CRYPTO_CHAINLINK_TWAP');
      observeSequence(message);
      // Ключ фида несёт ОКНО: `btc/usd` TWAP 30 и TWAP 60 — разные потоки
      const payload = message.payload.payload;
      const key = `${message.payload.topic}\n${payload.symbol}\n${String(payload.windowSeconds)}`;
      bump(rtdsPerFeed, key);
      let ring = rtdsRings.get(key);
      if (!ring) {
        ring = new Ring(RING_CAP);
        rtdsRings.set(key, ring);
      }
      ring.push(JSON.stringify(toRecordedObservation(message)));
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

  /** Замораживает ring-снимки рынка, покинувшего ACTIVE (для exact-match валидации). */
  const freezeMarket = (marketId: string): void => {
    if (evidence.frozenMarketRings[marketId] !== undefined) return;
    evidence.frozenMarketRings[marketId] = marketRings.get(marketId)?.toArray() ?? [];
    const rtdsSnapshot: Record<string, readonly string[]> = {};
    for (const [key, ring] of rtdsRings) rtdsSnapshot[key] = ring.toArray();
    evidence.frozenRtdsRings[marketId] = rtdsSnapshot;
  };

  // ── Lifecycle-наблюдатель рантайма ────────────────────────────────────
  // Момент выхода рынка из ACTIVE (seal → архив) сообщает сам рантайм —
  // это же служит живым доказательством, что collection lifecycle
  // наблюдаем снаружи (MR-A PART 18/19), а не выводится опросом.
  const observedLifecycle: string[] = [];
  collector.onMarketLifecycle((event) => {
    observedLifecycle.push(`${event.kind}:${String(event.marketId)}`);
    if (event.kind === 'FINALIZING' || event.kind === 'DROPPED') {
      freezeMarket(String(event.marketId));
    }
  });

  // ── Старт live-сбора (recorder-first обеспечивает сам рантайм) ─────────
  await collector.start();

  const startedMs = Date.now();
  let lastStatusMs = 0;
  let pipelineError: unknown;

  /**
   * Разбирает раскладку датасетов прогона.
   *
   * @returns Пути завершённых архивов Polymarket и партиций CEX по биржам
   *
   * @remarks
   * Раскладка — production (обе политики пишут в ОДИН корень):
   * ```text
   * {runDir}/{YYYY-MM-DD}/polymarket/{question}___{marketId}.jsonl[.gz]
   * {runDir}/{YYYY-MM-DD}/{exchangeId}/{exchange}_{symbol}_..._ET.jsonl[.gz]
   * ```
   * Классификация идёт по имени родительской директории — то же правило,
   * по которому датасеты читает бэктест.
   */
  const scanDatasets = (): {
    pmArchives: string[];
    cexPartitionsByExchange: Map<string, string[]>;
  } => {
    const pmArchives: string[] = [];
    const cexPartitionsByExchange = new Map<string, string[]>();
    const exchangeIds = new Set(CEX_PLAN.map((spec) => spec.exchangeId));
    if (!fs.existsSync(options.runDir)) {
      return { pmArchives, cexPartitionsByExchange };
    }
    for (const dateEntry of fs.readdirSync(options.runDir, { withFileTypes: true })) {
      if (!dateEntry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(dateEntry.name)) continue;
      const dateDir = path.join(options.runDir, dateEntry.name);
      for (const sourceEntry of fs.readdirSync(dateDir, { withFileTypes: true })) {
        if (!sourceEntry.isDirectory()) continue;
        const sourceDir = path.join(dateDir, sourceEntry.name);
        const archives = fs
          .readdirSync(sourceDir)
          .filter((name) => name.endsWith('.jsonl.gz'))
          .map((name) => path.join(sourceDir, name));
        if (sourceEntry.name === 'polymarket') {
          pmArchives.push(...archives);
        } else if (exchangeIds.has(sourceEntry.name)) {
          const existing = cexPartitionsByExchange.get(sourceEntry.name) ?? [];
          existing.push(...archives);
          cexPartitionsByExchange.set(sourceEntry.name, existing);
        }
      }
    }
    pmArchives.sort();
    return { pmArchives, cexPartitionsByExchange };
  };

  /** Список .jsonl.gz архивов Polymarket текущего прогона. */
  const listPmArchives = (): string[] => scanDatasets().pmArchives;

  /** Есть ли завершённая gzip-партиция у КАЖДОЙ биржи. */
  const everyExchangeHasCompletedPartition = (): boolean => {
    const { cexPartitionsByExchange } = scanDatasets();
    return CEX_PLAN.every(
      (spec) => (cexPartitionsByExchange.get(spec.exchangeId) ?? []).length > 0,
    );
  };

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
    // Settlement-поток обязан наблюдаться: без него архив крипто-рынка не
    // содержит источника, по которому этот рынок в действительности резолвится
    if (!topics.has('prices.crypto.chainlink.twap')) {
      return false;
    }
    if (cexSampleStore.size === 0) return false;
    return true;
  };

  // ── Наблюдение (сбором управляет сам рантайм) ─────────────────────────
  // Цикл координатора/финализатора живёт ВНУТРИ коллектора; runner только
  // ждёт, пока накопится полный комплект свидетельств, и снимает статус.
  try {
    while (Date.now() - startedMs < options.maxMs && !stopRequested) {
      // Окно захвата CEX-сэмплов: после ~60% MIN (full) / после 30s (short)
      const captureFromMs = options.requireFullLifecycle ? options.minMs * 0.6 : 30_000;
      capturingCexSamples = Date.now() - startedMs >= captureFromMs;

      if (Date.now() - lastStatusMs >= 60_000) {
        lastStatusMs = Date.now();
        logger.info('CHECKPOINT status', {
          minutes: Math.round((Date.now() - startedMs) / 6_000) / 10,
          busTotals: Object.fromEntries(busTotals),
          status: collector.status(),
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

  // Freeze всех оставшихся отслеживаемых рынков ДО drain/shutdown (сэмплы
  // колец — подмножество уже записанных строк, поэтому exact-match работает
  // и для рынков, которые заархивируются во время drain)
  for (const marketId of pmPerMarket.keys()) freezeMarket(marketId);

  // ── Drain: дождаться официальных резолюций уже начатых финализаций ────
  // (решение user 2026-08-25: остановка не срезает 60-мин окно ожидания;
  // опрос продолжается штатным 30s-cadence). SIGINT прерывает ожидание —
  // close() коллектора разбудит спящий drain.
  if (options.requireFullLifecycle && DRAIN_FINALIZATIONS && !stopRequested) {
    logger.info('CHECKPOINT draining pending finalizations before shutdown', {
      status: collector.status(),
    });
    let drainSettled = false;
    // Отказ drain-а поглощается ЗДЕСЬ и попадает в evidence: если гонку
    // выигрывает polling-ветка (пришёл сигнал), непойманное отклонение
    // ушло бы в process-level unhandledRejection вместо отчёта
    const drainPromise = collector.drain().then(
      () => {
        drainSettled = true;
      },
      (error: unknown) => {
        drainSettled = true;
        const message = error instanceof Error ? error.message : String(error);
        evidence.shutdownStepFailures.push(`collector.drain: ${message}`);
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
      finalization: collector.status().finalization,
      interruptedBySignal: stopRequested,
    });
  }

  // ── Финальный снимок статуса ДО shutdown ──────────────────────────────
  const finalStatus: DataCollectorStatus = collector.status();
  evidence.finalStats = {
    coordinator: finalStatus.collection,
    finalizer: finalStatus.finalization,
    recorder: finalStatus.recorder,
    recorderCex: finalStatus.recorderCex,
    windows: finalStatus.cexWindows,
    bus: finalStatus.bus,
    lifecycle: finalStatus.lifecycle,
    cexSources: finalStatus.sources.cex.map((source) => ({
      exchange: source.exchangeId,
      stats: source.stats,
      hasFailed: source.hasFailed,
    })),
    lifecycleEvents: observedLifecycle,
  };

  // ── Controlled shutdown (лестница принадлежит рантайму) ───────────────
  try {
    await collector.close();
  } catch (error) {
    evidence.shutdownStepFailures.push(
      `collector.close: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const dispose of disposers) dispose();

  // Отказы отдельных шагов рантайм логирует и продолжает закрытие — снимаем
  // их из счётного logger-wrapper, чтобы вердикт учитывал каждый.
  for (const line of logCounters.errorSamples) {
    if (line.startsWith('Shutdown step failed')) evidence.shutdownStepFailures.push(line);
  }

  for (const source of finalStatus.sources.cex) {
    if (source.hasFailed) evidence.cexSourcesFailed.push(source.exchangeId);
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
  /** Machine-usable identity победителя. */
  readonly winningInstrumentId: string | undefined;
  readonly winningOutcomeIndex: number | undefined;
  /** Происхождение итога: official | fallback-chainlink-twap. */
  readonly resolutionProvenance: string | undefined;
  /** Что заставило перейти к fallback (таймаут/остановка). */
  readonly fallbackTrigger: string | undefined;
  /** Нормализованное правило расчёта рынка (для TWAP-рынков). */
  readonly settlement:
    | { readonly symbol: string; readonly windowSeconds: number; readonly resolutionSource: string }
    | undefined;
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
  const provenance = (finalization['provenance'] ?? {}) as Record<string, unknown>;
  const marketCrypto = (m['crypto'] ?? {}) as Record<string, unknown>;
  const settlement = (marketCrypto['settlement'] ?? {}) as Record<string, unknown>;
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
    winningInstrumentId:
      winning !== undefined && winning['instrumentId'] !== undefined
        ? String(winning['instrumentId'])
        : undefined,
    winningOutcomeIndex:
      winning !== undefined && typeof winning['outcomeIndex'] === 'number'
        ? winning['outcomeIndex']
        : undefined,
    resolutionProvenance:
      provenance['resolution'] !== undefined ? String(provenance['resolution']) : undefined,
    fallbackTrigger:
      provenance['fallbackTrigger'] !== undefined
        ? String(provenance['fallbackTrigger'])
        : undefined,
    settlement:
      typeof settlement['symbol'] === 'string' && typeof settlement['windowSeconds'] === 'number'
        ? {
            symbol: settlement['symbol'],
            windowSeconds: settlement['windowSeconds'],
            resolutionSource: String(settlement['resolutionSource'] ?? ''),
          }
        : undefined,
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
    /** Строки официального settlement-потока (доказательство состава архива). */
    twapLines: number;
    settlement:
      | { readonly symbol: string; readonly windowSeconds: number; readonly resolutionSource: string }
      | undefined;
    winningInstrumentId: string | undefined;
    winningOutcomeIndex: number | undefined;
    resolutionProvenance: string | undefined;
    fallbackTrigger: string | undefined;
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

/**
 * Проверяет строку архива на соответствие конверту V2.
 *
 * @param parsed - Распарсенная строка архива
 * @returns `true` — конверт не тот, что должен писать recorder
 *
 * @remarks
 * Строгая проверка: ровно три поля `{type, ingress, payload}` и ни одного
 * live-only поля metadata на верхнем уровне. Лишнее поле означало бы, что
 * на диск утекло что-то помимо наблюдения.
 */
function hasEnvelopeLeak(parsed: Record<string, unknown>): boolean {
  if (FORBIDDEN_LIVE_ONLY_KEYS.some((key) => key in parsed)) return true;
  const keys = Object.keys(parsed).sort();
  return keys.length !== OBSERVATION_KEYS.length || keys.some((key, i) => key !== OBSERVATION_KEYS[i]);
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
  // Раскладка — production: обе политики пишут в ОДИН корень датасетов, а
  // источник определяется именем директории внутри date-папки
  // (`polymarket` против `{exchangeId}`) — то же правило, по которому
  // датасеты читает бэктест.
  const cexExchangeIds = new Set(CEX_PLAN.map((spec) => spec.exchangeId));

  /**
   * Обходит все файлы датасетов прогона, разделяя их по источнику.
   *
   * @param onPolymarket - Обработчик файла market-сессии
   * @param onCex - Обработчик файла CEX-партиции (вместе с биржей)
   */
  const walkDatasets = (
    onPolymarket: (file: string) => void,
    onCex: (file: string, exchangeId: string) => void,
  ): void => {
    if (!fs.existsSync(runDir)) return;
    for (const dateEntry of fs.readdirSync(runDir, { withFileTypes: true })) {
      if (!dateEntry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(dateEntry.name)) continue;
      const dateDir = path.join(runDir, dateEntry.name);
      for (const sourceEntry of fs.readdirSync(dateDir, { withFileTypes: true })) {
        if (!sourceEntry.isDirectory()) continue;
        const sourceDir = path.join(dateDir, sourceEntry.name);
        const isPolymarket = sourceEntry.name === 'polymarket';
        const isCex = cexExchangeIds.has(sourceEntry.name);
        if (!isPolymarket && !isCex) continue;
        for (const fileEntry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
          if (!fileEntry.isFile()) continue;
          const full = path.join(sourceDir, fileEntry.name);
          if (isPolymarket) onPolymarket(full);
          else onCex(full, sourceEntry.name);
        }
      }
    }
  };

  const pmFiles: string[] = [];
  const cexFiles: Array<{ readonly file: string; readonly exchangeId: string }> = [];
  walkDatasets(
    (file) => pmFiles.push(file),
    (file, exchangeId) => cexFiles.push({ file, exchangeId }),
  );

  // ── Polymarket ────────────────────────────────────────────────────────
  for (const file of pmFiles) {
    if (file.endsWith('.jsonl') && !file.endsWith('.jsonl.gz')) {
      report.pmIncompleteFiles.push(file);
      continue;
    }
    if (!file.endsWith('.jsonl.gz')) continue;
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
      continue;
    }
    if (header.marketId !== header.conditionId) {
      report.violations.push(
        `PM header identity mismatch in ${file}: marketId=${header.marketId} conditionId=${header.conditionId}`,
      );
    }
    let marketLines = 0;
    let rtdsLines = 0;
    let twapLines = 0;
    // Повторяющиеся нарушения агрегируются per-archive (без флуда отчёта)
    let parseErrors = 0;
    let envelopeLeaks = 0;
    let crossRouted = 0;
    let foreignMarket = 0;
    let unclassifiable = 0;
    const lineSet = new Set<string>();
    for (const line of lines.slice(1)) {
      lineSet.add(line);
      let envelope: Record<string, unknown>;
      try {
        envelope = JSON.parse(line) as Record<string, unknown>;
      } catch {
        parseErrors++;
        continue;
      }
      if (hasEnvelopeLeak(envelope)) {
        envelopeLeaks++;
        continue;
      }
      // V2: конверт снят декодером, классификация идёт по source-native payload
      const observation = decodeDetachedArchiveLine(line);
      if (observation === undefined || observation.timingQuality !== 'EXACT_INGRESS') {
        parseErrors++;
        continue;
      }
      const parsed = observation.payload as Record<string, unknown>;
      if ('exchangeId' in parsed || 'orderBook' in parsed || 'trade' in parsed) {
        crossRouted++;
        continue;
      }
      // ВАЖНО: RTDS-события ТОЖЕ несут type ('update') — RTDS-ветка идёт
      // ПЕРВОЙ, market-события различаются по vendor topic === 'market'
      const topic = parsed['topic'];
      if (typeof topic === 'string' && topic.startsWith('prices.crypto.')) {
        rtdsLines++;
        if (topic === 'prices.crypto.chainlink.twap') {
          twapLines++;
          // Окно обязано присутствовать В САМОЙ строке: без него replay не
          // отличит поток расчёта одного рынка от потока другого
          const inner = parsed['payload'] as Record<string, unknown> | undefined;
          const window = inner?.['windowSeconds'];
          if (window !== 30 && window !== 60) {
            report.violations.push(
              `TWAP line without vendor window in ${file}: ${String(window)}`,
            );
          }
        }
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
      twapLines,
      settlement: header.settlement,
      winningInstrumentId: header.winningInstrumentId,
      winningOutcomeIndex: header.winningOutcomeIndex,
      resolutionProvenance: header.resolutionProvenance,
      fallbackTrigger: header.fallbackTrigger,
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
  }

  if (report.pmIncompleteFiles.length > 0) {
    report.violations.push(
      `stale incomplete PM .jsonl after shutdown: ${report.pmIncompleteFiles.join(', ')}`,
    );
  }
  // MR-B hard-инвариант: `timeout` — это триггер fallback, а не итог. Для
  // рынка с распознанным settlement-дескриптором завершённый архив со
  // статусом `timeout` (и тем более без победителя) означает, что система
  // выдала непригодный к replay датасет за пригодный.
  for (const archive of report.pmArchives) {
    if (archive.settlement === undefined) continue;
    if (archive.status === 'timeout') {
      report.violations.push(
        `TWAP market archived with timeout status instead of resolved/discarded: ${archive.file}`,
      );
    }
    if (archive.winningLabel === undefined) {
      report.violations.push(`TWAP market archived without a known winner: ${archive.file}`);
    }
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
      // MR-B: наличие ОБОИХ крипто-чисел больше НЕ является критерием
      // завершённости. Gamma публикует `finalPrice` не всегда и не раньше
      // резолюции (live 2026-08-26), а ждать его при уже известном
      // официальном итоге значит держать рынок весь бюджет. Критерий теперь
      // один и он строже: у завершённого архива ИЗВЕСТЕН ПОБЕДИТЕЛЬ.
      if (archive.priceToBeat === undefined) {
        report.violations.push(`complete PM archive has no price to beat: ${archive.file}`);
      }
      // Winner-ladder: у complete-архива победитель ОБЯЗАН присутствовать и
      // быть точным — официальная UMA-резолюция, формула рынка на официальных
      // ценах либо deterministic-деривация из записанного settlement-потока;
      // приблизительные источники здесь недопустимы
      if (archive.winningLabel === undefined) {
        report.violations.push(`complete PM archive missing winning outcome: ${archive.file}`);
      } else if (
        archive.winningSource !== 'resolution' &&
        archive.winningSource !== 'official-prices' &&
        archive.winningSource !== 'recorded-twap'
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
      // MR-B: рынок, чьё правило расчёта распознано, обязан нести в архиве
      // и сам settlement-поток, и полную machine-usable identity итога —
      // иначе датасет невозможно ни проверить, ни воспроизвести
      if (archive.settlement !== undefined) {
        if (archive.twapLines === 0) {
          report.violations.push(
            `TWAP market archive contains no settlement observations: ${archive.file}`,
          );
        }
        if (archive.winningInstrumentId === undefined || archive.winningOutcomeIndex === undefined) {
          report.violations.push(
            `TWAP market archive winner lacks machine-usable identity: ${archive.file}`,
          );
        }
        if (
          archive.resolutionProvenance !== 'official' &&
          archive.resolutionProvenance !== 'fallback-chainlink-twap'
        ) {
          report.violations.push(
            `TWAP market archive has unknown resolution provenance ` +
              `'${String(archive.resolutionProvenance)}': ${archive.file}`,
          );
        }
        if (archive.settlement.windowSeconds !== 30 && archive.settlement.windowSeconds !== 60) {
          report.violations.push(
            `TWAP market archive has out-of-domain window ` +
              `${String(archive.settlement.windowSeconds)}: ${archive.file}`,
          );
        }
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

  for (const { file, exchangeId } of cexFiles) {
    const name = path.basename(file);
    if (name.endsWith('.jsonl') && !name.endsWith('.jsonl.gz')) {
      report.cex.incompleteFiles.push(file);
      continue;
    }
    if (!name.endsWith('.jsonl.gz')) continue;
    report.cex.gzFiles++;
    const dirExchange = exchangeId;
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
      continue;
    }
    const lines = text.trimEnd().split('\n').filter((line) => line.length > 0);
    if (lines.length === 0) {
      report.violations.push(`empty completed CEX partition: ${file}`);
      continue;
    }

    // LINE 1 — header партиции: формат и routing identity объявлены В ФАЙЛЕ,
    // а не выводятся из имени. Имя проверяется ПРОТИВ header-а, не наоборот.
    const format = detectRawArchiveFormat(lines[0]);
    const partitionHeader = readCexPartitionHeader(format);
    if (partitionHeader === undefined) {
      report.cex.identityMismatches++;
      report.violations.push(
        `CEX partition without formatVersion ${String(RAW_ARCHIVE_FORMAT_VERSION)} header: ${file}`,
      );
      continue;
    }
    if (
      partitionHeader.exchangeId !== fileExchange ||
      partitionHeader.symbol.replace(/[/:]/g, '-') !== fileSymbol ||
      partitionHeader.marketType !== fileMarketType ||
      partitionHeader.stream !== fileStream
    ) {
      report.cex.identityMismatches++;
      report.violations.push(`CEX header/filename identity mismatch: ${file}`);
    }
    if (lines.length === 1) {
      report.violations.push(`CEX partition with header but no observations: ${file}`);
      continue;
    }

    for (const line of lines.slice(1)) {
      report.cex.totalLines++;
      report.cex.perExchangeLines[dirExchange] =
        (report.cex.perExchangeLines[dirExchange] ?? 0) + 1;
      let envelope: Record<string, unknown>;
      try {
        envelope = JSON.parse(line) as Record<string, unknown>;
      } catch {
        report.cex.parseErrors++;
        continue;
      }
      if (hasEnvelopeLeak(envelope)) {
        report.cex.envelopeLeaks++;
        continue;
      }
      const observation = decodeDetachedArchiveLine(line);
      if (observation === undefined || observation.timingQuality !== 'EXACT_INGRESS') {
        report.cex.parseErrors++;
        continue;
      }
      const parsed = observation.payload as Record<string, unknown>;
      const isOrderbook = 'orderBook' in parsed;
      const isTrade = 'trade' in parsed;
      if (!isOrderbook && !isTrade) {
        report.cex.crossRouteLines++;
        continue;
      }
      if (isOrderbook) report.cex.orderbookLines++;
      if (isTrade) report.cex.tradeLines++;
      // Discriminator конверта обязан совпадать с формой payload: иначе replay
      // опубликовал бы наблюдение на чужую typed-подписку
      const expectedType = isOrderbook ? 'CEX_ORDERBOOK' : 'CEX_TRADE';
      if (observation.type !== expectedType) {
        report.cex.identityMismatches++;
      }
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
  }

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
    // fs.writeSync, а НЕ console.error: запись в stderr асинхронна, когда он
    // подключён к pipe (CI, `| tee`), и следующий за ней process.exit() обрывает
    // её на полуслове. Потерять здесь можно ровно ту диагностику, ради которой
    // watchdog и существует.
    const lines = [
      'CHECKPOINT: process did not exit naturally within 60s after main()',
      `Active resources: ${JSON.stringify(process.getActiveResourcesInfo())}`,
      `Active handles: ${JSON.stringify(describeActiveHandles(), null, 2)}`,
      '',
    ];
    fs.writeSync(2, lines.join('\n'));
    process.exit(3);
  }, 60_000);
  watchdog.unref();
}

/**
 * Описывает удерживающие процесс handle-ы с деталями сокетов.
 *
 * @returns Человекочитаемые строки по каждому активному handle
 *
 * @remarks
 * `getActiveResourcesInfo()` отдаёт только типы (`'TCPSocketWrap'`), по которым
 * невозможно понять ВЛАДЕЛЬЦА утечки. Для сокетов решает `servername`: он прямо
 * называет хост (`ws-subscriptions-clob`, `gamma-api`, `stream.binance.com`), а
 * значит и подсистему, чей ресурс не закрыт. Используются недокументированные
 * `process._getActiveHandles/_getActiveRequests` — это диагностика runner-а, не
 * production-код, и их отсутствие не ломает вердикт.
 */
function describeActiveHandles(): readonly string[] {
  const handles =
    (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? [];
  const described = handles.map((handle) => {
    const entry = handle as Record<string, unknown>;
    const kind = (entry['constructor'] as { name?: string } | undefined)?.name ?? 'unknown';
    if (kind !== 'Socket' && kind !== 'TLSSocket') {
      return kind;
    }
    const servername = entry['servername'];
    return (
      `${kind} servername=${String(servername)} ` +
      `remote=${String(entry['remoteAddress'])}:${String(entry['remotePort'])} ` +
      `destroyed=${String(entry['destroyed'])}`
    );
  });
  const requests =
    (process as unknown as { _getActiveRequests?: () => unknown[] })._getActiveRequests?.() ?? [];
  return [...described, `activeRequests=${String(requests.length)}`];
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
