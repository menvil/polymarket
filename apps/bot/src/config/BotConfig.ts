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

// ── Режим работы ─────────────────────────────────────────────────────────────

/** Режим работы бота */
export type BotMode = 'live' | 'paper' | 'backtest';

/** Тип стратегии */
export type StrategyType = 'dumb' | 'avellaneda-stoikov';

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
}

/** Автопоиск рынков через Gamma API */
export interface DiscoveryMarketConfig {
  readonly source: 'discovery';
  readonly filter: MarketDiscoveryFilter;
  /** Пауза между циклами поиска (мс) */
  readonly scanPauseMs: number;
  /**
   * Индекс outcome для торговли.
   * @defaultValue 0
   */
  readonly outcomeIndex: 0 | 1;
}

/** Исторические снапшоты для backtest */
export interface SnapshotMarketConfig {
  readonly source: 'snapshots';
  /**
   * Пути к папкам или файлам снапшотов.
   * Можно указать несколько рынков для последовательного прогона.
   */
  readonly paths: string[];
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

// ── Корневой конфиг ──────────────────────────────────────────────────────────

/** Полная конфигурация бота, читаемая из JSON файла */
export interface BotConfig {
  /** Тип стратегии (можно переопределить через env STRATEGY) */
  readonly strategy: StrategyType;

  /** Параметры конкретной стратегии (зависят от strategy) */
  readonly strategyParams: DumbStrategyConfig | ASStrategyConfig;

  /** Источник и конфигурация рынка */
  readonly market: MarketConfig;

  /** Параметры капитала и аллокации */
  readonly resources: ResourcesConfig;

  /** Параметры симуляции (только для paper/backtest) */
  readonly paper: PaperConfig;

  /** Параметры аккаунта */
  readonly account: AccountConfig;
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
