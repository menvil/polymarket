/**
 * OrderbookHealthMonitor - мониторинг здоровья стакана
 *
 * @remarks
 * Event-driven монитор состояния orderbook с тремя метриками восстановления ликвидности:
 * - **RefillRates**: Три комплементарные метрики скорости восстановления ликвидности
 *   - `absolute`: [0, 3] - Абсолютный прирост объёма относительно EMA baseline (USDC)
 *   - `relative`: [0, 1.5] - Процентный рост глубины стакана (0.5 = 50% рост)
 *   - `logarithmic`: [0, ∞) - Логарифмическое изменение (устойчиво к масштабу)
 * - **BookImbalance**: Дисбаланс bid/ask глубины
 * - **Thinning Detection**: Обнаружение истончения ликвидности
 *
 * Алгоритм расчета refillRates:
 * ```
 * // Absolute
 * absRefillRaw = max(0, Δbid) + max(0, Δask)
 * absRefillBaseline = EMA(absRefillRaw) с α=0.05
 * absoluteRefillRate = EMA(clamp(absRefillRaw/baseline, 0, 3)) с α=0.1
 *
 * // Relative
 * relRaw = (bidRel + askRel) / 2, где bidRel = max(0, ΔbidDepth/prevBidDepth)
 * relativeRefillRate = EMA(clamp(relRaw, 0, 1.5)) с α=0.1
 *
 * // Logarithmic
 * logRaw = log(currentBid/prevBid) + log(currentAsk/prevAsk)
 * logarithmicRefillRate = EMA(logRaw) с α=0.1 (без клиппинга)
 * ```
 *
 * Используется EdgeAliveEvaluator для определения "живости" edge.
 *
 * @example
 * ```typescript
 * const monitor = new OrderbookHealthMonitor(config, logger);
 *
 * // При каждом обновлении стакана
 * monitor.recordSnapshot(orderbook);
 *
 * // Получить текущие метрики
 * const metrics = monitor.getMetrics();
 * console.log(`Relative refill: ${metrics.refillRates.relative}`);
 * console.log(`Absolute refill: ${metrics.refillRates.absolute}`);
 * console.log(`Thinning: ${metrics.isThinning}`);
 * ```
 */
import { ILogger } from '../../ports/ILogger.js';
import { Orderbook } from '../../entities/Orderbook.js';
import {
  OrderbookHealthMetrics,
  OrderbookHealthConfig,
  DEFAULT_ORDERBOOK_HEALTH_CONFIG,
  MarketContext,
  getMarketLogInfo,
} from './types.js';

/**
 * OrderbookHealthMonitor
 *
 * @remarks
 * Stateful монитор здоровья стакана.
 * Вызывать recordSnapshot() при каждом обновлении orderbook.
 */
export class OrderbookHealthMonitor {
  private readonly config: OrderbookHealthConfig;
  private readonly logger: ILogger;

  /** Текущая глубина bid (top N levels) */
  private bidDepth: number = 0;

  /** Текущая глубина ask (top N levels) */
  private askDepth: number = 0;

  /** Текущий спред */
  private spread: number = 0;

  /** Absolute refill rate EMA [0, 3] */
  private absoluteRefillRate: number = 0.5;

  /** Relative refill rate EMA [0, 1.5] */
  private relativeRefillRate: number = 0.5;

  /** Logarithmic refill rate EMA [0, ∞) */
  private logarithmicRefillRate: number = 0.5;

  /**
   * Baseline для нормализации absoluteRefillRate
   * EMA самого refill-события (absRefillRaw)
   */
  private absRefillBaseline: number = 0;

  /** Предыдущая глубина bid для сравнения */
  private lastBidDepth: number = 0;

  /** Предыдущая глубина ask для сравнения */
  private lastAskDepth: number = 0;

  /** Timestamp последнего обновления */
  private lastUpdateTimestamp: number = Date.now();

  /** Timestamp последнего summary лога */
  private lastSummaryTimestamp: number = 0;

  /** Счётчик снапшотов для статистики */
  private snapshotCount: number = 0;

  /** Счётчик thinning событий */
  private thinningCount: number = 0;

  /** Market context for multi-market logging */
  private marketContext: MarketContext | null = null;

  /**
   * Создаёт OrderbookHealthMonitor
   *
   * @param config - Конфигурация (опционально)
   * @param logger - Логгер
   *
   * @example
   * ```typescript
   * const monitor = new OrderbookHealthMonitor({
   *   bookLevels: 2,
   *   minHealthyDepth: 20,
   *   emaAlpha: 0.1,
   * }, logger);
   * ```
   */
  constructor(
    config: Partial<OrderbookHealthConfig> = {},
    logger: ILogger
  ) {
    this.config = { ...DEFAULT_ORDERBOOK_HEALTH_CONFIG, ...config };
    this.logger = logger.child?.('OrderbookHealth') || logger;
  }

  /**
   * Устанавливает market context для логирования
   *
   * @param context - Market context с идентификацией рынка
   *
   * @example
   * ```typescript
   * monitor.setMarketContext({
   *   marketId: '0x123...',
   *   marketSlug: 'btc-up-down',
   *   question: 'Bitcoin Up or Down?',
   *   expirationDate: new Date('2024-12-29T12:00:00Z'),
   * });
   * ```
   */
  public setMarketContext(context: MarketContext): void {
    this.marketContext = context;
    this.logger.debug('[OrderbookHealth] Market context set', {
      ...getMarketLogInfo(context),
      marketId: context.marketId,
      marketSlug: context.marketSlug,
    });
  }

  /**
   * Возвращает market info для включения в JSON лога
   */
  private getMarketInfo(): { market: string; marketUrl: string; expiresInSec: number; expiresIn: string } {
    return getMarketLogInfo(this.marketContext);
  }

  /**
   * Записывает снапшот стакана (event-driven)
   *
   * @param orderbook - Orderbook entity
   *
   * @remarks
   * Обновляет:
   * - bidDepth, askDepth
   * - spread
   * - refillRate (EMA)
   * - thinning detection
   *
   * @example
   * ```typescript
   * // При каждом обновлении стакана от WebSocket
   * monitor.recordSnapshot(orderbook);
   * ```
   */
  public recordSnapshot(orderbook: Orderbook): void {
    const now = Date.now();
    this.snapshotCount++;

    // Сохраняем предыдущие значения для расчёта изменений
    const prevBidDepth = this.lastBidDepth;
    const prevAskDepth = this.lastAskDepth;
    const prevAbsoluteRefillRate = this.absoluteRefillRate;
    const prevRelativeRefillRate = this.relativeRefillRate;
    const prevLogarithmicRefillRate = this.logarithmicRefillRate;

    // Получаем глубину для top N levels
    const currentBidDepth = orderbook.getTotalBidVolume(this.config.bookLevels).value;
    const currentAskDepth = orderbook.getTotalAskVolume(this.config.bookLevels).value;

    // ============================================
    // 1. ABSOLUTE REFILL RATE
    // ============================================

    // Сырое значение: абсолютный прирост объёма
    const deltaBid = currentBidDepth - prevBidDepth;
    const deltaAsk = currentAskDepth - prevAskDepth;
    const absRefillRaw = Math.max(0, deltaBid) + Math.max(0, deltaAsk);

    // Обновляем baseline (EMA самого refill-события)
    if (this.absRefillBaseline === 0) {
      // Инициализация из первого snapshot
      this.absRefillBaseline = absRefillRaw > 0 ? absRefillRaw : 1; // Минимум 1 чтобы избежать деления на 0
    } else {
      // EMA с меньшим alpha для стабильной нормализации
      this.absRefillBaseline = this.config.baselineAlpha * absRefillRaw +
                               (1 - this.config.baselineAlpha) * this.absRefillBaseline;
    }

    // Нормализация и клиппинг
    const absNorm = this.absRefillBaseline > 0
      ? Math.min(absRefillRaw / this.absRefillBaseline, this.config.absMaxBound)
      : 0;

    // EMA
    this.absoluteRefillRate = this.config.emaAlpha * absNorm +
                              (1 - this.config.emaAlpha) * this.absoluteRefillRate;

    // ============================================
    // 2. RELATIVE REFILL RATE
    // ============================================

    // Сырое значение: процентный рост глубины
    const bidRel = prevBidDepth > 0
      ? Math.max(0, deltaBid / prevBidDepth)
      : 0;
    const askRel = prevAskDepth > 0
      ? Math.max(0, deltaAsk / prevAskDepth)
      : 0;
    const relRaw = (bidRel + askRel) / 2;

    // Клиппинг
    const relNorm = Math.min(relRaw, this.config.relMaxBound);

    // EMA
    this.relativeRefillRate = this.config.emaAlpha * relNorm +
                              (1 - this.config.emaAlpha) * this.relativeRefillRate;

    // ============================================
    // 3. LOGARITHMIC REFILL RATE
    // ============================================

    // Сырое значение: логарифмическое изменение (безопасное для division by zero)
    const bidLog = prevBidDepth > 0
      ? Math.log(Math.max(currentBidDepth / prevBidDepth, 1))
      : 0;
    const askLog = prevAskDepth > 0
      ? Math.log(Math.max(currentAskDepth / prevAskDepth, 1))
      : 0;
    const logRaw = bidLog + askLog;

    // Без клиппинга (логарифм естественно ограничен)
    const logNorm = logRaw;

    // EMA
    this.logarithmicRefillRate = this.config.emaAlpha * logNorm +
                                 (1 - this.config.emaAlpha) * this.logarithmicRefillRate;

    // Обновляем текущие значения
    this.bidDepth = currentBidDepth;
    this.askDepth = currentAskDepth;
    this.lastBidDepth = currentBidDepth;
    this.lastAskDepth = currentAskDepth;
    this.lastUpdateTimestamp = now;

    // Вычисляем спред
    const bestBid = orderbook.getBestBid();
    const bestAsk = orderbook.getBestAsk();
    this.spread = (bestBid && bestAsk) ? bestAsk.value - bestBid.value : 0;

    // Проверяем thinning
    const isThinning = this.bidDepth < this.config.minHealthyDepth ||
                       this.askDepth < this.config.minHealthyDepth;

    if (isThinning) {
      this.thinningCount++;
    }

    // Определяем изменение глубины для лога
    const bidChange = deltaBid > 0 ? '+' : (deltaBid < 0 ? '-' : '=');
    const askChange = deltaAsk > 0 ? '+' : (deltaAsk < 0 ? '-' : '=');

    // TRACE-level: Depth calculation breakdown
    this.logger.trace('[OrderbookHealth] Depth calculation breakdown', {
      ...this.getMarketInfo(),
      bookLevels: this.config.bookLevels,
      bidLevels: orderbook.bids.slice(0, this.config.bookLevels).map((l, i) => ({
        level: i + 1,
        price: l.price.value.toFixed(4),
        qty: l.quantity.value.toFixed(2),
      })),
      askLevels: orderbook.asks.slice(0, this.config.bookLevels).map((l, i) => ({
        level: i + 1,
        price: l.price.value.toFixed(4),
        qty: l.quantity.value.toFixed(2),
      })),
      bidDepthSum: `Σ(bid qty) = ${currentBidDepth.toFixed(2)}`,
      askDepthSum: `Σ(ask qty) = ${currentAskDepth.toFixed(2)}`,
      formula: 'depth = sum(qty for top N levels)',
    });

    // TRACE-level: AbsoluteRefillRate calculation breakdown
    this.logger.trace('[OrderbookHealth] AbsoluteRefillRate calculation', {
      ...this.getMarketInfo(),
      explanation: 'AbsoluteRefillRate измеряет абсолютный прирост ликвидности в USDC, нормализованный к EMA baseline текущего рынка. Показывает силу восстановления относительно "нормального" refill-события',
      prevBidDepth: prevBidDepth.toFixed(2),
      currentBidDepth: currentBidDepth.toFixed(2),
      deltaBid: deltaBid.toFixed(2),
      deltaBidPositive: Math.max(0, deltaBid).toFixed(2),
      prevAskDepth: prevAskDepth.toFixed(2),
      currentAskDepth: currentAskDepth.toFixed(2),
      deltaAsk: deltaAsk.toFixed(2),
      deltaAskPositive: Math.max(0, deltaAsk).toFixed(2),
      absRefillRaw: absRefillRaw.toFixed(2),
      absRefillRawFormula: `max(0, Δbid) + max(0, Δask) = ${Math.max(0, deltaBid).toFixed(2)} + ${Math.max(0, deltaAsk).toFixed(2)}`,
      absRefillBaseline: this.absRefillBaseline.toFixed(2),
      baselineAlpha: this.config.baselineAlpha,
      baselineFormula: `EMA(absRefillRaw) с α=${this.config.baselineAlpha}`,
      absNorm: absNorm.toFixed(4),
      absNormFormula: `min(${absRefillRaw.toFixed(2)} / ${this.absRefillBaseline.toFixed(2)}, ${this.config.absMaxBound}) = ${absNorm.toFixed(4)}`,
      absMaxBound: this.config.absMaxBound,
      emaAlpha: this.config.emaAlpha,
      prevAbsRefillRate: prevAbsoluteRefillRate.toFixed(4),
      emaCalculation: `${this.config.emaAlpha} × ${absNorm.toFixed(4)} + ${(1 - this.config.emaAlpha).toFixed(2)} × ${prevAbsoluteRefillRate.toFixed(4)}`,
      newAbsRefillRate: this.absoluteRefillRate.toFixed(4),
      formula: 'absRefillRate = α × clamp(absRaw/baseline, 0, absMax) + (1-α) × prevAbsRefillRate',
    });

    // TRACE-level: RelativeRefillRate calculation breakdown
    this.logger.trace('[OrderbookHealth] RelativeRefillRate calculation', {
      ...this.getMarketInfo(),
      explanation: 'RelativeRefillRate измеряет процентный рост глубины стакана. Показывает относительную силу восстановления (1.0 = рост на 100%)',
      prevBidDepth: prevBidDepth.toFixed(2),
      currentBidDepth: currentBidDepth.toFixed(2),
      deltaBid: deltaBid.toFixed(2),
      bidRel: bidRel.toFixed(4),
      bidRelFormula: prevBidDepth > 0 ? `max(0, ${deltaBid.toFixed(2)} / ${prevBidDepth.toFixed(2)}) = ${bidRel.toFixed(4)}` : '0 (prevBidDepth = 0)',
      prevAskDepth: prevAskDepth.toFixed(2),
      currentAskDepth: currentAskDepth.toFixed(2),
      deltaAsk: deltaAsk.toFixed(2),
      askRel: askRel.toFixed(4),
      askRelFormula: prevAskDepth > 0 ? `max(0, ${deltaAsk.toFixed(2)} / ${prevAskDepth.toFixed(2)}) = ${askRel.toFixed(4)}` : '0 (prevAskDepth = 0)',
      relRaw: relRaw.toFixed(4),
      relRawFormula: `(${bidRel.toFixed(4)} + ${askRel.toFixed(4)}) / 2 = ${relRaw.toFixed(4)}`,
      relNorm: relNorm.toFixed(4),
      relNormFormula: `min(${relRaw.toFixed(4)}, ${this.config.relMaxBound}) = ${relNorm.toFixed(4)}`,
      relMaxBound: this.config.relMaxBound,
      emaAlpha: this.config.emaAlpha,
      prevRelRefillRate: prevRelativeRefillRate.toFixed(4),
      emaCalculation: `${this.config.emaAlpha} × ${relNorm.toFixed(4)} + ${(1 - this.config.emaAlpha).toFixed(2)} × ${prevRelativeRefillRate.toFixed(4)}`,
      newRelRefillRate: this.relativeRefillRate.toFixed(4),
      formula: 'relRefillRate = α × clamp(relRaw, 0, relMax) + (1-α) × prevRelRefillRate',
    });

    // TRACE-level: LogarithmicRefillRate calculation breakdown
    this.logger.trace('[OrderbookHealth] LogarithmicRefillRate calculation', {
      ...this.getMarketInfo(),
      explanation: 'LogarithmicRefillRate измеряет динамику восстановления через логарифмическое изменение. Устойчиво к масштабу стакана, естественное ограничение роста',
      prevBidDepth: prevBidDepth.toFixed(2),
      currentBidDepth: currentBidDepth.toFixed(2),
      bidRatio: prevBidDepth > 0 ? (currentBidDepth / prevBidDepth).toFixed(4) : 'N/A',
      bidLog: bidLog.toFixed(6),
      bidLogFormula: prevBidDepth > 0 ? `log(max(${currentBidDepth.toFixed(2)} / ${prevBidDepth.toFixed(2)}, 1)) = log(${Math.max(currentBidDepth / prevBidDepth, 1).toFixed(4)}) = ${bidLog.toFixed(6)}` : '0 (prevBidDepth = 0)',
      prevAskDepth: prevAskDepth.toFixed(2),
      currentAskDepth: currentAskDepth.toFixed(2),
      askRatio: prevAskDepth > 0 ? (currentAskDepth / prevAskDepth).toFixed(4) : 'N/A',
      askLog: askLog.toFixed(6),
      askLogFormula: prevAskDepth > 0 ? `log(max(${currentAskDepth.toFixed(2)} / ${prevAskDepth.toFixed(2)}, 1)) = log(${Math.max(currentAskDepth / prevAskDepth, 1).toFixed(4)}) = ${askLog.toFixed(6)}` : '0 (prevAskDepth = 0)',
      logRaw: logRaw.toFixed(6),
      logRawFormula: `${bidLog.toFixed(6)} + ${askLog.toFixed(6)} = ${logRaw.toFixed(6)}`,
      logNorm: logNorm.toFixed(6),
      logNormNote: 'Без клиппинга - логарифм естественно ограничен',
      emaAlpha: this.config.emaAlpha,
      prevLogRefillRate: prevLogarithmicRefillRate.toFixed(6),
      emaCalculation: `${this.config.emaAlpha} × ${logNorm.toFixed(6)} + ${(1 - this.config.emaAlpha).toFixed(2)} × ${prevLogarithmicRefillRate.toFixed(6)}`,
      newLogRefillRate: this.logarithmicRefillRate.toFixed(6),
      formula: 'logRefillRate = α × logRaw + (1-α) × prevLogRefillRate (без клиппинга)',
    });

    // TRACE-level: RefillRates Summary
    this.logger.trace('[OrderbookHealth] RefillRates Summary', {
      ...this.getMarketInfo(),
      explanation_emaAlpha: 'emaAlpha (α) - сглаживающий коэффициент для EMA (Exponential Moving Average). Чем выше α, тем быстрее реакция на новые данные. α=0.1 означает: новые данные 10%, история 90%',
      emaAlpha: this.config.emaAlpha,
      absoluteRefillRate: this.absoluteRefillRate.toFixed(4),
      absoluteRange: '[0, 3]',
      relativeRefillRate: this.relativeRefillRate.toFixed(4),
      relativeRange: '[0, 1.5]',
      logarithmicRefillRate: this.logarithmicRefillRate.toFixed(6),
      logarithmicRange: '[0, ∞)',
      interpretation: this.absoluteRefillRate > 1.5 || this.relativeRefillRate > 0.5
        ? 'STRONG refill (ликвидность активно восстанавливается)'
        : this.absoluteRefillRate < 0.5 && this.relativeRefillRate < 0.2
        ? 'WEAK refill (ликвидность восстанавливается медленно)'
        : 'MODERATE refill',
    });

    // TRACE-level: Thinning detection breakdown
    this.logger.trace('[OrderbookHealth] Thinning detection', {
      ...this.getMarketInfo(),
      minHealthyDepth: this.config.minHealthyDepth,
      bidDepth: this.bidDepth.toFixed(2),
      bidThinning: this.bidDepth < this.config.minHealthyDepth ? `YES (${this.bidDepth.toFixed(2)} < ${this.config.minHealthyDepth})` : `NO (${this.bidDepth.toFixed(2)} >= ${this.config.minHealthyDepth})`,
      askDepth: this.askDepth.toFixed(2),
      askThinning: this.askDepth < this.config.minHealthyDepth ? `YES (${this.askDepth.toFixed(2)} < ${this.config.minHealthyDepth})` : `NO (${this.askDepth.toFixed(2)} >= ${this.config.minHealthyDepth})`,
      isThinning: isThinning ? 'YES (bidThinning OR askThinning)' : 'NO',
      formula: 'isThinning = bidDepth < minHealthyDepth OR askDepth < minHealthyDepth',
    });

    // TRACE-level: Book imbalance calculation
    const bookImbalance = this.computeBookImbalance();
    const totalDepth = this.bidDepth + this.askDepth;
    this.logger.trace('[OrderbookHealth] Book imbalance calculation', {
      ...this.getMarketInfo(),
      bidDepth: this.bidDepth.toFixed(2),
      askDepth: this.askDepth.toFixed(2),
      totalDepth: totalDepth.toFixed(2),
      numerator: `${this.bidDepth.toFixed(2)} - ${this.askDepth.toFixed(2)} = ${(this.bidDepth - this.askDepth).toFixed(2)}`,
      bookImbalance: bookImbalance.toFixed(4),
      interpretation: bookImbalance > 0.2 ? 'BID pressure (buyers)' :
                      bookImbalance < -0.2 ? 'ASK pressure (sellers)' :
                      'BALANCED',
      formula: 'bookImbalance = (bidDepth - askDepth) / (bidDepth + askDepth)',
    });

    // Debug лог при каждом снапшоте
    this.logger.debug('[OrderbookHealth] Snapshot', {
      ...this.getMarketInfo(),
      bidDepth: this.bidDepth.toFixed(2),
      askDepth: this.askDepth.toFixed(2),
      spread: (this.spread * 100).toFixed(2) + '%',
      absoluteRefillRate: this.absoluteRefillRate.toFixed(4),
      relativeRefillRate: this.relativeRefillRate.toFixed(4),
      logarithmicRefillRate: this.logarithmicRefillRate.toFixed(6),
      bookImbalance: bookImbalance.toFixed(4),
      isThinning,
      bidChange,
      askChange,
    });

    // Периодический INFO summary
    if (now - this.lastSummaryTimestamp >= this.config.summaryIntervalMs) {
      this.lastSummaryTimestamp = now;
      this.logSummary();
    }
  }

  /**
   * Возвращает текущие метрики
   *
   * @returns OrderbookHealthMetrics
   *
   * @example
   * ```typescript
   * const metrics = monitor.getMetrics();
   *
   * if (metrics.isThinning) {
   *   console.warn('Orderbook is thinning!');
   * }
   *
   * if (metrics.refillRates.absolute < 0.5) {
   *   console.warn('Low absolute refill rate - liquidity draining');
   * }
   * ```
   */
  public getMetrics(): OrderbookHealthMetrics {
    return {
      bidDepth: this.bidDepth,
      askDepth: this.askDepth,
      spread: this.spread,
      refillRates: {
        absolute: this.absoluteRefillRate,
        relative: this.relativeRefillRate,
        logarithmic: this.logarithmicRefillRate,
      },
      bookImbalance: this.computeBookImbalance(),
      isThinning: this.bidDepth < this.config.minHealthyDepth ||
                  this.askDepth < this.config.minHealthyDepth,
      lastUpdateTimestamp: this.lastUpdateTimestamp,
    };
  }

  /**
   * Сбрасывает состояние монитора
   *
   * @remarks
   * Вызывать при смене маркета или reset сессии.
   *
   * @example
   * ```typescript
   * monitor.reset();
   * ```
   */
  public reset(): void {
    this.bidDepth = 0;
    this.askDepth = 0;
    this.spread = 0;
    this.absoluteRefillRate = 0.5; // Нейтральное значение
    this.relativeRefillRate = 0.5; // Нейтральное значение
    this.logarithmicRefillRate = 0.5; // Нейтральное значение
    this.absRefillBaseline = 0; // Будет инициализирован из первого snapshot
    this.lastBidDepth = 0;
    this.lastAskDepth = 0;
    this.lastUpdateTimestamp = Date.now();
    this.lastSummaryTimestamp = 0;
    this.snapshotCount = 0;
    this.thinningCount = 0;

    this.logger.info('[OrderbookHealth] State reset', {
      ...this.getMarketInfo(),
    });
  }

  /**
   * Возвращает статистику работы монитора
   *
   * @returns Статистика
   */
  public getStats(): {
    snapshotCount: number;
    thinningCount: number;
    thinningRatio: number;
    avgRefillRates: {
      absolute: number;
      relative: number;
      logarithmic: number;
    };
  } {
    return {
      snapshotCount: this.snapshotCount,
      thinningCount: this.thinningCount,
      thinningRatio: this.snapshotCount > 0 ? this.thinningCount / this.snapshotCount : 0,
      avgRefillRates: {
        absolute: this.absoluteRefillRate, // EMA is already an average
        relative: this.relativeRefillRate,
        logarithmic: this.logarithmicRefillRate,
      },
    };
  }

  /**
   * Вычисляет book imbalance
   */
  private computeBookImbalance(): number {
    const total = this.bidDepth + this.askDepth;
    if (total === 0) return 0;
    return (this.bidDepth - this.askDepth) / total;
  }

  /**
   * Логирует периодический summary
   */
  private logSummary(): void {
    const stats = this.getStats();
    const metrics = this.getMetrics();

    this.logger.info('[OrderbookHealth] Summary', {
      ...this.getMarketInfo(),
      bidDepth: metrics.bidDepth.toFixed(2),
      askDepth: metrics.askDepth.toFixed(2),
      spread: (metrics.spread * 100).toFixed(2) + '%',
      absoluteRefillRate: metrics.refillRates.absolute.toFixed(4),
      relativeRefillRate: metrics.refillRates.relative.toFixed(4),
      logarithmicRefillRate: metrics.refillRates.logarithmic.toFixed(6),
      bookImbalance: metrics.bookImbalance.toFixed(4),
      isThinning: metrics.isThinning,
      snapshotCount: stats.snapshotCount,
      thinningRatio: (stats.thinningRatio * 100).toFixed(1) + '%',
    });
  }
}
