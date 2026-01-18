/**
 * Trade Flow Signal Types
 *
 * @remarks
 * Типы для анализа торгового потока (trade flow analysis).
 * Используются для определения направления рынка, fragility и market pressure.
 *
 * Ключевые концепции:
 * - **Fragility**: Насколько легко цена движется при агрессивном объёме
 * - **TradeImbalance**: Дисбаланс агрессивных покупок/продаж
 * - **BookImbalance**: Дисбаланс ликвидности в стакане
 * - **MarketState**: Классификация состояния рынка
 */

// ============================================
// Market Context (for multi-market logging)
// ============================================

/**
 * Market context for logging and traceability
 *
 * @remarks
 * Contains market and token identification for multi-market logging.
 * Should be passed to all signal services and included in all logs.
 */
export interface MarketContext {
  /** Unique market identifier (condition_id) */
  marketId: string;

  /** Token ID for this outcome */
  tokenId: string;

  /** Outcome name (e.g., "Up", "Down", "Up", "Down") */
  outcomeName: string;

  /** Short market name/slug for logs */
  marketSlug: string;

  /** Full market question */
  question: string;

  /** Market expiration date */
  expirationDate: Date;

  /** URL to market on Polymarket */
  marketUrl?: string;
}

/**
 * Creates a short log prefix from market context
 *
 * @param ctx - Market context
 * @returns Short prefix for log messages (e.g., "[btc-up-down|8m]")
 */
export function formatMarketPrefix(ctx: MarketContext | null): string {
  if (!ctx) return '';

  const now = Date.now();
  const msToExpiry = ctx.expirationDate.getTime() - now;
  const minToExpiry = Math.max(0, Math.floor(msToExpiry / 60000));

  const timeStr = minToExpiry >= 60
    ? `${Math.floor(minToExpiry / 60)}h${minToExpiry % 60}m`
    : `${minToExpiry}m`;

  return `[${ctx.marketSlug}|${timeStr}]`;
}

/**
 * Formats time to expiry in human-readable format
 *
 * @param secondsToExpiry - Seconds until market expiration
 * @returns Human-readable string (e.g., "2h15m30s", "45m12s", "30s")
 */
export function formatTimeToExpiry(secondsToExpiry: number): string {
  const totalSeconds = Math.max(0, Math.floor(secondsToExpiry));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h${minutes}m${seconds}s`;
  } else if (minutes > 0) {
    return `${minutes}m${seconds}s`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * Creates market info object for inclusion in log JSON
 *
 * @param ctx - Market context
 * @returns Object with market details for log JSON
 *
 * @example
 * ```typescript
 * const marketInfo = getMarketLogInfo(ctx);
 * logger.debug('Snapshot', { ...data, ...marketInfo });
 * // Output JSON:
 * // {
 * //   "bidDepth": 142.5,
 * //   "market": "Bitcoin Up or Down",
 * //   "marketUrl": "https://polymarket.com/...",
 * //   "expiresInSec": 3600,
 * //   "expiresIn": "1h0m0s"
 * // }
 * ```
 */
export function getMarketLogInfo(ctx: MarketContext | null): {
  market: string;
  marketId: string;
  tokenId: string;
  outcomeName: string;
  marketUrl: string;
  expiresInSec: number;
  expiresIn: string;
} {
  if (!ctx) {
    return {
      market: 'unknown',
      marketId: '',
      tokenId: '',
      outcomeName: '',
      marketUrl: '',
      expiresInSec: 0,
      expiresIn: '0s',
    };
  }

  const now = Date.now();
  const msToExpiry = ctx.expirationDate.getTime() - now;
  const secondsToExpiry = Math.max(0, Math.floor(msToExpiry / 1000));

  return {
    market: ctx.question,
    marketId: ctx.marketId,
    tokenId: ctx.tokenId,
    outcomeName: ctx.outcomeName,
    marketUrl: ctx.marketUrl || `https://polymarket.com/event/${ctx.marketId}`,
    expiresInSec: secondsToExpiry,
    expiresIn: formatTimeToExpiry(secondsToExpiry),
  };
}

// ============================================
// Trade Side Detection
// ============================================

/**
 * Сторона сделки (агрессивная)
 *
 * @remarks
 * - BUY: Агрессивная покупка (пересёк ask или выше mid)
 * - SELL: Агрессивная продажа (пересёк bid или ниже mid)
 * - UNKNOWN: Не удалось определить (мелкая сделка, внутри спреда)
 */
export type TradeSide = 'BUY' | 'SELL' | 'UNKNOWN';

/**
 * Лучшие цены из стакана
 */
export interface BestPrices {
  /** Лучший bid */
  bid: number;
  /** Лучший ask */
  ask: number;
  /** Минимальный значимый спред (для определения mid crossing) */
  spreadMin?: number;
}

/**
 * Контекст для определения стороны сделки
 *
 * @remarks
 * Дополнительная информация для более точного определения стороны.
 */
export interface TradeContext {
  /** Последняя цена тика */
  lastTickPrice?: number;
  /** Направление последнего тика: +1 = вверх, -1 = вниз */
  lastTickDirection?: 1 | -1;
  /** Timestamp последней сделки */
  lastTradeTimestamp?: number;
  /** Минимальный объём для агрессивной сделки */
  minAggressiveVolume?: number;
  /** Time-to-next-fill в ms (для усиления агрессивности) */
  timeToNextFillMs?: number;
}

// ============================================
// Trade Flow Analysis
// ============================================

/**
 * Торговая сделка для анализа
 */
export interface TradeEvent {
  /** Сторона сделки (определяется TradeSideDetector) */
  side: TradeSide;
  /** Цена сделки */
  price: number;
  /** Размер сделки */
  size: number;
  /** Timestamp в ms */
  timestamp: number;
}

/**
 * Уровень в стакане
 */
export interface OrderBookLevel {
  /** Цена уровня */
  price: number;
  /** Размер на уровне */
  size: number;
}

/**
 * Снапшот стакана
 */
export interface OrderBookSnapshot {
  /** Bids (отсортированы по убыванию цены) */
  bids: OrderBookLevel[];
  /** Asks (отсортированы по возрастанию цены) */
  asks: OrderBookLevel[];
  /** Timestamp снапшота */
  timestamp: number;
}

/**
 * Состояние рынка
 *
 * @remarks
 * Классификация текущего состояния на основе fragility и imbalances.
 *
 * | State | Условие | Описание |
 * |-------|---------|----------|
 * | DEAD | fragility = 0 | Рынок неактивен, нет движения |
 * | FRAGILE | fragility > 0, bookImbalance мал | Рынок активен, но без направления |
 * | DIRECTIONAL | tradeImbalance vs bookImbalance | Противоречивые сигналы |
 * | PRESSURE | tradeImbalance = bookImbalance | Согласованное давление |
 */
export type MarketState = 'DEAD' | 'FRAGILE' | 'DIRECTIONAL' | 'PRESSURE';

/**
 * Метрики торгового потока
 *
 * @remarks
 * Все метрики обновляются event-driven при каждой сделке/тике.
 */
export interface TradeFlowMetrics {
  /**
   * Fragility score 0-1
   *
   * @remarks
   * Насколько легко цена движется при агрессивном объёме.
   * Формула: (ticks / volume) × timeToFillScore
   * - 0: Рынок стабилен (большой объём, малое движение)
   * - 1: Рынок хрупкий (малый объём, большое движение)
   */
  fragilityScore: number;

  /**
   * Trade imbalance -1 to 1
   *
   * @remarks
   * Дисбаланс агрессивных сделок.
   * - +1: Все сделки - покупки
   * - -1: Все сделки - продажи
   * - 0: Равный баланс
   */
  tradeImbalance: number;

  /**
   * Book imbalance -1 to 1
   *
   * @remarks
   * Дисбаланс ликвидности в стакане (top N levels).
   * - +1: Вся ликвидность на bid (давление покупателей)
   * - -1: Вся ликвидность на ask (давление продавцов)
   * - 0: Равный баланс
   */
  bookImbalance: number;

  /**
   * Market pressure score
   *
   * @remarks
   * Агрегированная метрика давления.
   * Формула: fragility × bookImbalance × confirmation
   * Где confirmation = sign(tradeImbalance) === sign(bookImbalance) ? |tradeImbalance| : -|tradeImbalance|
   */
  marketPressureScore: number;

  /**
   * Market state classification
   */
  state: MarketState;

  /**
   * Bid depth (top N levels)
   */
  bidDepth: number;

  /**
   * Ask depth (top N levels)
   */
  askDepth: number;

  /**
   * Total aggressive buy volume (with decay)
   */
  buyVolume: number;

  /**
   * Total aggressive sell volume (with decay)
   */
  sellVolume: number;

  /**
   * Total price ticks (with decay)
   */
  totalTicks: number;
}

/**
 * Конфигурация TradeFlowAnalyzer
 */
export interface TradeFlowConfig {
  /**
   * Количество уровней стакана для bookImbalance
   * @default 2
   */
  bookLevels: number;

  /**
   * Минимальный bookImbalance для directional signal
   * @default 0.2
   */
  bookMinThreshold: number;

  /**
   * Минимальный объём для агрессивной сделки
   * @default 5
   */
  minAggressiveVolume: number;

  /**
   * Масштабирующий фактор для fragility
   * @default 5
   */
  fragilityScale: number;

  /**
   * Lambda для exponential decay (выше = быстрее decay)
   * @default 0.002
   */
  decayLambda: number;

  /**
   * Порог быстрого time-to-fill (ms)
   * @default 200
   */
  timeToFillFast: number;

  /**
   * Порог среднего time-to-fill (ms)
   * @default 500
   */
  timeToFillMedium: number;

  /**
   * Порог медленного time-to-fill (ms)
   * @default 1000
   */
  timeToFillSlow: number;
}

/**
 * Default configuration for TradeFlowAnalyzer
 */
export const DEFAULT_TRADE_FLOW_CONFIG: TradeFlowConfig = {
  bookLevels: 2,
  bookMinThreshold: 0.2,
  minAggressiveVolume: 5,
  fragilityScale: 5,
  decayLambda: 0.002,
  timeToFillFast: 200,
  timeToFillMedium: 500,
  timeToFillSlow: 1000,
};

// ============================================
// Orderbook Health Monitoring
// ============================================

/**
 * RefillRate метрики
 *
 * @remarks
 * Три способа измерения скорости восстановления ликвидности:
 * - **absolute**: Абсолютный прирост объёма, нормализованный к EMA baseline
 * - **relative**: Пропорциональный рост глубины (процентное изменение)
 * - **logarithmic**: Логарифмическое изменение (устойчиво к масштабу)
 */
export interface RefillRateMetrics {
  /**
   * Absolute refill rate [0, 3]
   *
   * @remarks
   * Измеряет абсолютный прирост ликвидности относительно EMA baseline.
   * Формула: clamp(absRefillRaw / absRefillBaseline, 0, 3)
   * где absRefillRaw = max(0, Δbid) + max(0, Δask)
   */
  absolute: number;

  /**
   * Relative refill rate [0, 1.5]
   *
   * @remarks
   * Измеряет процентный рост глубины стакана.
   * Формула: clamp((bidRel + askRel) / 2, 0, 1.5)
   * где bidRel = max(0, ΔbidDepth / prevBidDepth)
   */
  relative: number;

  /**
   * Logarithmic refill rate [0, ∞)
   *
   * @remarks
   * Устойчивый к масштабу индикатор роста ликвидности.
   * Формула: log(currentBid/prevBid) + log(currentAsk/prevAsk)
   * Не клиппируется, естественное ограничение роста.
   */
  logarithmic: number;
}

/**
 * Метрики здоровья стакана
 *
 * @remarks
 * Отслеживает состояние orderbook для EdgeAliveEvaluator.
 */
export interface OrderbookHealthMetrics {
  /**
   * Bid depth (top N levels)
   */
  bidDepth: number;

  /**
   * Ask depth (top N levels)
   */
  askDepth: number;

  /**
   * Current spread (ask - bid)
   */
  spread: number;

  /**
   * Refill rates (три метрики восстановления ликвидности)
   *
   * @remarks
   * Каждая метрика измеряет скорость восстановления по-своему:
   * - absolute: абсолютный объём
   * - relative: процентный рост
   * - logarithmic: логарифмическая динамика
   */
  refillRates: RefillRateMetrics;

  /**
   * Book imbalance -1 to 1
   *
   * @remarks
   * (bidDepth - askDepth) / (bidDepth + askDepth)
   */
  bookImbalance: number;

  /**
   * Is orderbook thinning?
   *
   * @remarks
   * True если depth упал ниже minHealthyDepth.
   */
  isThinning: boolean;

  /**
   * Timestamp последнего обновления
   */
  lastUpdateTimestamp: number;
}

/**
 * Конфигурация OrderbookHealthMonitor
 */
export interface OrderbookHealthConfig {
  /**
   * Количество уровней для мониторинга
   * @default 2
   */
  bookLevels: number;

  /**
   * Минимальная здоровая глубина (ниже = thinning)
   * @default 20
   */
  minHealthyDepth: number;

  /**
   * Alpha для exponential moving average refillRates (0-1)
   * Больше = быстрее реакция на изменения
   * @default 0.1
   */
  emaAlpha: number;

  /**
   * Alpha для EMA baseline (absRefillBaseline)
   * Меньше чем emaAlpha для более стабильной нормализации
   * @default 0.05
   */
  baselineAlpha: number;

  /**
   * Максимальная граница для absoluteRefillRate (клиппинг)
   * @default 3
   */
  absMaxBound: number;

  /**
   * Максимальная граница для relativeRefillRate (клиппинг)
   * @default 1.5
   */
  relMaxBound: number;

  /**
   * Интервал для periodic summary logging (ms)
   * @default 10000 (10 секунд)
   */
  summaryIntervalMs: number;
}

/**
 * Default configuration for OrderbookHealthMonitor
 */
export const DEFAULT_ORDERBOOK_HEALTH_CONFIG: OrderbookHealthConfig = {
  bookLevels: 2,
  minHealthyDepth: 20,
  emaAlpha: 0.1,
  baselineAlpha: 0.05,
  absMaxBound: 3,
  relMaxBound: 1.5,
  summaryIntervalMs: 10000,
};
