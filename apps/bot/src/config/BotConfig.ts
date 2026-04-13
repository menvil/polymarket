/**
 * Конфигурационная схема торгового бота.
 *
 * @remarks
 * ### Источники конфигурации (приоритет: ENV > JSON файл):
 * - ENV: `MODE`, `STRATEGY`, `CONFIG` (путь к JSON файлу)
 * - JSON файл: все остальные параметры
 *
 * ### Режимы работы:
 * - `live`     — реальная биржа, реальные деньги
 * - `paper`    — реальные рыночные данные, симулированные ордера
 * - `backtest` — исторические снапшоты, детерминированное время
 *
 * ### Источники рынка:
 * - `fixed`     — конкретный рынок по MARKET_ID, первый или указанный outcome
 * - `discovery` — автоматический поиск рынков по фильтру
 *
 * @example
 * ```json
 * {
 *   "market": { "source": "fixed", "marketId": "0xabc", "outcomeIndex": 0 },
 *   "strategyParams": { "orderSize": 5, "buyOffsetPct": 10, "profitMarginPct": 5, "repriceThreshold": 0.08 },
 *   "resources": { "initialBalance": 1000, "maxConcurrentMarkets": 1, "minCapitalPerMarket": 10, "tradingBalanceRatio": 1.0 }
 * }
 * ```
 */

import type { DumbStrategyConfig } from '../strategies/DumbStrategy.js';
import type { ASStrategyConfig } from '../strategies/AvellanedaStoikovStrategy.js';
import type { CrossMarketArbConfig } from '../strategies/CrossMarketArbStrategy.js';
import type { ProbTableConfig } from '../strategies/ProbTableStrategy.js';
import type { CryptoProbConfig } from '../strategies/CryptoProbStrategy.js';
import type { SelectiveEntryConfig } from '../strategies/SelectiveEntryStrategy.js';
import type { OscillationMMConfig } from '../strategies/OscillationMMStrategy.js';
import type { MomentumScalpConfig } from '../strategies/MomentumScalpStrategy.js';
import type { SmartEntryConfig } from '../strategies/SmartEntryStrategy.js';
import type { AdaptiveEntryConfig } from '../strategies/AdaptiveEntryStrategy.js';
import type { FairValueMMConfig } from '../strategies/FairValueMMStrategy.js';
import type { BinanceProbMMConfig } from '../strategies/BinanceProbMMStrategy.js';
import type { CexLeadLagConfig } from '../strategies/CexLeadLagStrategy.js';
import type { CexExchangeConfig } from '@polymarket/cex-market-data';

// ── Режим работы ─────────────────────────────────────────────────────────────

/** Режим работы бота */
export type BotMode = 'live' | 'paper' | 'backtest';

/** Тип стратегии */
export type StrategyType = 'dumb' | 'avellaneda-stoikov' | 'cross-market-arb' | 'prob-table' | 'crypto-prob' | 'selective-entry' | 'oscillation-mm' | 'momentum-scalp' | 'smart-entry' | 'adaptive-entry' | 'fair-value-mm' | 'binance-prob-mm' | 'cex-lead-lag';

// ── Источник рынка ───────────────────────────────────────────────────────────

/** Конкретный рынок по ID */
export interface FixedMarketConfig {
  readonly source: 'fixed';
  /** condition_id рынка на Polymarket */
  readonly marketId: string;
  /**
   * Индекс outcome для торговли (0 = первый = обычно YES, 1 = второй = NO).
   * @defaultValue 0
   */
  readonly outcomeIndex: 0 | 1;
}

/** Фильтр для автопоиска рынков */
export interface MarketDiscoveryFilter {
  readonly minLiquidity?: number;
  readonly minTimeToExpiryHours?: number;
  readonly anyOfKeywords?: string[];
  readonly requiredKeywords?: string[];
  readonly excludedKeywords?: string[];
  /** Минимальная длительность рынка в минутах (из eventStartTime/endDate API). */
  readonly minDurationMinutes?: number;
  /** Максимальная длительность рынка в минутах. */
  readonly maxDurationMinutes?: number;
}

/** Автопоиск рынков через Gamma API */
export interface DiscoveryMarketConfig {
  readonly source: 'discovery';
  readonly filter: MarketDiscoveryFilter;
  /**
   * Опциональные snapshot paths для backtest.
   *
   * @remarks
   * Если MODE=backtest и paths заданы, discovery filter применяется
   * к метаданным snapshot-файлов вместо live Gamma discovery.
   */
  readonly paths?: string[];
  /** Пауза между циклами поиска (мс) */
  readonly scanPauseMs: number;
  /**
   * Индекс outcome для торговли.
   * @defaultValue 0
   */
  readonly outcomeIndex: 0 | 1;
  /**
   * Открывать два слота на рынок (UP + DOWN).
   * Для каждого создаётся отдельный экземпляр стратегии с side='up'/'down'.
   * @defaultValue false
   */
  readonly bidirectional?: boolean;
}

/** Исторические снапшоты для backtest */
export interface SnapshotMarketConfig {
  readonly source: 'snapshots';
  /**
   * Пути к папкам или файлам снапшотов.
   * Можно указать несколько рынков для последовательного прогона.
   */
  readonly paths: string[];
  /** Опциональный фильтр snapshot-рынков по question и длительности. */
  readonly filter?: MarketDiscoveryFilter;
  /**
   * Индекс outcome для торговли (0 = YES, 1 = NO).
   * Читается из заголовка снапшота (meta-строка).
   * @defaultValue 1
   */
  readonly outcomeIndex?: 0 | 1;
}

export type MarketConfig = FixedMarketConfig | DiscoveryMarketConfig | SnapshotMarketConfig;

// ── Ресурсы ──────────────────────────────────────────────────────────────────

/** Параметры распределения капитала */
export interface ResourcesConfig {
  /** Начальный баланс USDC */
  readonly initialBalance: number;
  /** Максимальное количество одновременно активных рынков */
  readonly maxConcurrentMarkets: number;
  /**
   * Минимальный капитал на один рынок (USDC).
   * Если нельзя выделить хотя бы столько — новый рынок не открывается.
   */
  readonly minCapitalPerMarket: number;
  /**
   * Доля от initialBalance, которую используем для торговли (0–1).
   * Остаток — резерв на случай непредвиденного.
   * @defaultValue 1.0
   */
  readonly tradingBalanceRatio: number;
}

// ── Paper-специфичная конфигурация ───────────────────────────────────────────

/** Параметры симуляции fills в paper/backtest режиме */
export interface PaperConfig {
  /**
   * Генерировать full fill при пересечении цены по стакану (BOOK_UPDATED).
   * @defaultValue true
   */
  readonly fillOnBookCrossing: boolean;
  /**
   * Генерировать partial/full fill по реальным сделкам из ленты (TRADE_RECEIVED).
   * @defaultValue true
   */
  readonly fillOnTape: boolean;
  /**
   * Цена исполнения = цена ордера (true) или рыночная цена (false).
   * При true — нет price improvement, предсказуемее для отладки.
   * @defaultValue true
   */
  readonly fillAtOrderPrice: boolean;
}

// ── Параметры аккаунта ────────────────────────────────────────────────────────

/** Идентификация аккаунта */
export interface AccountConfig {
  /**
   * Строковый ID в формате `venue:POLYMARKET:<address>`.
   * @defaultValue `venue:POLYMARKET:paper-account`
   */
  readonly accountId: string;
}

/** Execution-level toggles for strategies that support them. */
export interface ExecutionConfig {
  /**
   * true = post-only order; exchange rejects marketable orders.
   *
   * @remarks
   * Currently consumed by SelectiveEntryStrategy to allow A/B backtests
   * between maker-only and non-post-only entry behaviour.
   * @defaultValue true
   */
  readonly postOnly: boolean;
}

// ── Мульти-стратегия ────────────────────────────────────────────────────────

/** Тип параметров стратегии (union всех возможных конфигов) */
export type AnyStrategyParams =
  | DumbStrategyConfig
  | ASStrategyConfig
  | CrossMarketArbConfig
  | ProbTableConfig
  | CryptoProbConfig
  | SelectiveEntryConfig
  | OscillationMMConfig
  | MomentumScalpConfig
  | SmartEntryConfig
  | AdaptiveEntryConfig
  | FairValueMMConfig
  | BinanceProbMMConfig
  | CexLeadLagConfig;

/**
 * Фильтр для маршрутизации рынка на конкретную стратегию.
 *
 * @remarks
 * Используется в `strategyRules` для определения какая стратегия обслуживает рынок.
 * Все поля опциональны — пустой фильтр матчит все рынки (catch-all).
 */
export interface StrategyMatchFilter {
  /** Минимальная длительность рынка в минутах */
  readonly minDurationMinutes?: number;
  /** Максимальная длительность рынка в минутах */
  readonly maxDurationMinutes?: number;
  /** Рынок должен содержать хотя бы одно из этих слов (в question) */
  readonly anyOfKeywords?: string[];
  /** Рынок должен содержать все эти слова (в question) */
  readonly requiredKeywords?: string[];
}

/**
 * Правило маршрутизации: фильтр рынка → стратегия + параметры.
 *
 * @remarks
 * Правила проверяются в порядке массива, первое совпадение побеждает.
 * Рынок, не попавший ни в одно правило, пропускается.
 */
export interface StrategyRule {
  /** Человекочитаемая метка (для логов) */
  readonly label: string;
  /** Фильтр рынка */
  readonly match: StrategyMatchFilter;
  /** Тип стратегии */
  readonly strategy: StrategyType;
  /** Параметры стратегии */
  readonly strategyParams: AnyStrategyParams;
}

// ── Запись данных (live/paper observability) ────────────────────────────────

/**
 * Конфигурация записи рыночных данных и журнала решений.
 *
 * @remarks
 * Включается в live/paper режимах для:
 * - Записи сырых WS-событий (orderbook, trades) в `.jsonl.gz` — можно прогнать бектест
 * - Ведения журнала решений стратегии — отдельный файл с контекстом каждого решения
 * - Последующей сверки live vs backtest через replay-compare.ts
 *
 * @param enabled - Включить запись (default false)
 * @param outputDir - Директория для рыночных данных (default './data/recordings')
 * @param journalDir - Директория для журналов решений (default './data/journals')
 * @param compression - Сжатие: 'gzip' или 'none' (default 'gzip')
 */
export interface RecordingConfig {
  /** Включить запись рыночных данных и журнала решений */
  readonly enabled: boolean;
  /** Директория для записи рыночных данных (.jsonl.gz) */
  readonly outputDir: string;
  /** Директория для журналов решений (.journal.jsonl) */
  readonly journalDir: string;
  /** Сжатие рыночных данных */
  readonly compression: 'none' | 'gzip';
}

// ── CEX market data feed ───────────────────────────────────────────────────

export interface CexFeedConfig {
  readonly enabled: boolean;
  readonly exchanges: Readonly<Record<string, CexExchangeConfig>>;
  readonly outputDir?: string;
  readonly compression?: 'none' | 'gzip';
  readonly windowMinutes?: number;
  readonly bufferSize?: number;
  readonly flushIntervalMs?: number;
}

// ── Корневой конфиг ──────────────────────────────────────────────────────────

/**
 * Полная конфигурация бота, читаемая из JSON файла.
 *
 * @remarks
 * Поддерживает два режима:
 * - **Одна стратегия**: `strategy` + `strategyParams` (обратная совместимость)
 * - **Мульти-стратегия**: `strategyRules[]` — массив правил маршрутизации.
 *   Когда `strategyRules` задан, `strategy`/`strategyParams` игнорируются.
 */
export interface BotConfig {
  /** Тип стратегии (можно переопределить через env STRATEGY) */
  readonly strategy: StrategyType;

  /** Параметры конкретной стратегии (зависят от strategy) */
  readonly strategyParams: AnyStrategyParams;

  /**
   * Массив правил маршрутизации (мульти-стратегия).
   * Когда задан, `strategy`/`strategyParams` используются как fallback.
   * Первое совпадение побеждает. Рынок без совпадения пропускается.
   */
  readonly strategyRules?: readonly StrategyRule[];

  /** Источник и конфигурация рынка */
  readonly market: MarketConfig;

  /** Параметры капитала и аллокации */
  readonly resources: ResourcesConfig;

  /** Параметры симуляции (только для paper/backtest) */
  readonly paper: PaperConfig;

  /** Параметры аккаунта */
  readonly account: AccountConfig;

  /** Execution policy toggles shared by supported strategies. */
  readonly execution: ExecutionConfig;

  /** Запись рыночных данных и журнала решений (live/paper) */
  readonly recording?: RecordingConfig;

  /** Live/paper CEX orderbook/trades feed. */
  readonly cex?: CexFeedConfig;
}

// ── Дефолты ──────────────────────────────────────────────────────────────────

/** Дефолтные значения для paper конфигурации */
export const DEFAULT_PAPER_CONFIG: PaperConfig = {
  fillOnBookCrossing: true,
  fillOnTape: true,
  fillAtOrderPrice: true,
};

/** Дефолтные значения для ресурсов */
export const DEFAULT_RESOURCES_CONFIG: ResourcesConfig = {
  initialBalance: 1000,
  maxConcurrentMarkets: 1,
  minCapitalPerMarket: 10,
  tradingBalanceRatio: 1.0,
};

/** Дефолтный аккаунт для paper режима */
export const DEFAULT_ACCOUNT_CONFIG: AccountConfig = {
  accountId: 'venue:POLYMARKET:paper-account',
};

/** Дефолтные execution toggles */
export const DEFAULT_EXECUTION_CONFIG: ExecutionConfig = {
  postOnly: true,
};

/** Дефолтные значения для записи данных */
export const DEFAULT_RECORDING_CONFIG: RecordingConfig = {
  enabled: false,
  outputDir: './data/live-recordings',
  journalDir: './data/journals',
  compression: 'gzip',
};

export const DEFAULT_CEX_FEED_CONFIG: CexFeedConfig = {
  enabled: false,
  exchanges: {},
};
