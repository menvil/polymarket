/**
 * Общие типы для стратегии OrderBookWall.
 *
 * @remarks
 * Стратегия торгует на отбой (rejection): когда цена упирается в крупный
 * уровень CEX-книги и поток трейдов затихает — уровень устоял.
 * Сигнал: BID-стенка держится → цена вверх; ASK-стенка держится → цена вниз.
 */

import type { CexVenue } from '@polymarket/strategy';

// ── Конфигурация ─────────────────────────────────────────────────────────────

/**
 * Конфигурация стратегии OrderBookWall.
 */
export interface OrderBookWallConfig {
  /** Торгуемая сторона: UP-токен или DOWN-токен. */
  readonly side: 'up' | 'down';
  /** Размер ордера в токенах. */
  readonly orderSize: number;
  /** CEX-биржа для чтения стакана и трейдов. Рекомендована 'coinbase' (50 уровней). */
  readonly venue: CexVenue;
  /** Окно истории книги и трейдов (мс). По умолчанию 60 000. */
  readonly lookbackMs?: number;
  /**
   * Ширина бэнда как доля от mid-price.
   * Для top-of-book (50 уровней в $25) нужно очень маленькое значение: 0.00005.
   * По умолчанию 0.00005 (0.005%).
   */
  readonly bandSizePct?: number;
  /**
   * Минимальный коэффициент превышения средней плотности бэнда.
   * По умолчанию 2.0.
   */
  readonly wallThresholdFactor?: number;
  /**
   * Минимальный объём стенки (в базовой валюте, напр. BTC).
   * По умолчанию 0.3.
   */
  readonly minWallSize?: number;
  /**
   * Минимальное время жизни стенки (мс) перед отслеживанием.
   * Защита от spoof-ордеров. По умолчанию 3 000.
   */
  readonly minWallAgeMs?: number;
  /** Окно накопления трейдов для consumptionRate (мс). По умолчанию 30 000. */
  readonly consumptionWindowMs?: number;
  /**
   * Короткое окно для оценки текущего потока (мс).
   * Сравнивается с consumptionWindowMs для детекции замедления.
   * По умолчанию 8 000.
   */
  readonly recentWindowMs?: number;
  /**
   * Максимальная доля поглощения стенки для сигнала rejection.
   * Если absorptionRatio > rejectionMaxAbsorption → стенка рушится, сигнала нет.
   * По умолчанию 0.2 (стенка должна быть > 80% целой).
   */
  readonly rejectionMaxAbsorption?: number;
  /**
   * Минимальный объём трейдов (BTC), попавших в диапазон стенки,
   * чтобы считать: цена протестировала уровень.
   * По умолчанию 0.05 BTC.
   */
  readonly minWallTestVolume?: number;
  /**
   * Коэффициент: recent_rate / historic_rate < flowDecelerationFactor → замедление.
   * Чем ниже — тем строже требование замедления потока.
   * По умолчанию 0.4.
   */
  readonly flowDecelerationFactor?: number;
  /**
   * Минимальная сила сигнала [0..1] для входа. По умолчанию 0.4.
   */
  readonly minSignalStrength?: number;
  /**
   * Минимальный edge в центах (fairCents - midCents). По умолчанию 0.
   */
  readonly minEdgeCents?: number;
  /** Максимальное время удержания позиции (мс). По умолчанию 240 000 (4 мин). */
  readonly holdMaxMs?: number;
  /** Стоп-лосс в центах от цены входа. По умолчанию 5. */
  readonly stopLossCents?: number;
  /** Волатильность (σ годовая) для GBM fair-value. По умолчанию 0.6. */
  readonly sigmaAnnual?: number;
}

// ── Wall Detection ────────────────────────────────────────────────────────────

/** Сторона стакана, на которой обнаружена стенка. */
export type WallSide = 'bid' | 'ask';

/**
 * Обнаруженная стенка в стакане.
 */
export interface DetectedWall {
  readonly side: WallSide;
  readonly priceLow: number;
  readonly priceHigh: number;
  readonly centerPrice: number;
  /** Суммарный объём в бэнде (в базовой валюте, напр. BTC). */
  readonly totalSize: number;
  /** Во сколько раз объём превышает средний по всем бэндам. */
  readonly densityFactor: number;
  readonly detectedAtMs: number;
}

// ── Consumption Tracking ──────────────────────────────────────────────────────

/** Состояние трекинга поглощения одной стенки. */
export interface WallConsumptionState {
  readonly key: string;
  readonly initialSize: number;
  currentSize: number;
  /** Суммарный объём трейдов в полном окне (windowMs). */
  tradeVolumeInWindow: number;
  readonly firstSeenMs: number;
  lastUpdatedMs: number;
}

/**
 * Метрики поглощения стенки — входные данные для WallSignalComputer.
 */
export interface WallConsumptionMetrics {
  readonly wall: DetectedWall;
  /** Доля поглощённого объёма: (initialSize - currentSize) / initialSize ∈ [0, 1]. */
  readonly absorptionRatio: number;
  /** Суммарный объём трейдов в полном окне (BTC). Показывает, тестировала ли цена уровень. */
  readonly tradeVolumeInWindow: number;
  /** Объём трейдов в коротком окне recentWindowMs (BTC). Показывает текущий поток. */
  readonly recentTradeVolume: number;
  /** Возраст стенки (мс). */
  readonly ageMs: number;
}

// ── Wall Signal ───────────────────────────────────────────────────────────────

/**
 * Тип торгового сигнала.
 *
 * Основной режим — rejection (отбой):
 * - `REJECTION_DOWN` — BID-стенка держится, цена отбивается вверх → BUY UP.
 * - `REJECTION_UP`   — ASK-стенка держится, цена отбивается вниз → BUY DOWN.
 *
 * Вспомогательные (для выхода):
 * - `BREAKOUT_UP`    — ASK-стенка сломана → цена идёт вверх (выход для DOWN).
 * - `BREAKOUT_DOWN`  — BID-стенка сломана → цена идёт вниз (выход для UP).
 * - `NEUTRAL`        — нет чёткого сигнала.
 */
export type WallSignalType =
  | 'REJECTION_DOWN'
  | 'REJECTION_UP'
  | 'BREAKOUT_UP'
  | 'BREAKOUT_DOWN'
  | 'NEUTRAL';

/** Результат анализа стакана — торговый сигнал. */
export interface WallSignal {
  readonly type: WallSignalType;
  /** Сила сигнала [0..1]. */
  readonly strength: number;
  readonly sourceWall?: DetectedWall;
  readonly sourceMetrics?: WallConsumptionMetrics;
}

// ── Strategy Data / Actions ───────────────────────────────────────────────────

/** Типизированный snapshot для OrderBookWallStrategy. */
export interface OBWData {
  readonly nowMs: number;
  readonly currentPrice: number;
  readonly targetPrice: number;
  readonly tauSec: number;
  readonly wallSignal: WallSignal;
  readonly fairCents: number;
  readonly ewmaMidCents: number | undefined;
  readonly openBuyPriceCents: number | undefined;
  readonly positionQty: number;
  readonly availableTokenQty: number;
  readonly availableUsdc: number;
  readonly hasInFlightFills: boolean;
  readonly hasOpenSell: boolean;
}

/** Действия стратегии. */
export type OBWAction =
  | { readonly type: 'BUY'; readonly priceCents: number; readonly sizeTokens: number }
  | { readonly type: 'SELL'; readonly priceCents: number; readonly sizeTokens: number }
  | { readonly type: 'CANCEL_ALL' }
  | { readonly type: 'HOLD' };
