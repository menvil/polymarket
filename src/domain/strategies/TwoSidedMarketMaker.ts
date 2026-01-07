/**
 * Two-Sided Market Maker Strategy (Mode-Aware)
 *
 * @remarks
 * Mode-aware двусторонняя стратегия market making для prediction markets.
 * Адаптирует поведение в зависимости от текущего TradingMode и fragilityScore.
 *
 * Режимы работы:
 * - **FLAT**: Нет позиции, двусторонние котировки
 * - **QUOTE**: Есть позиция, нормальные двусторонние котировки с inventory skew
 * - **INVENTORY**: Агрессивный inventory skew для снижения позиции
 * - **RECOVERY**: Односторонние котировки для закрытия позиции
 * - **PANIC**: Очень агрессивные котировки, пересекают спред
 * - **DEAD**: Не генерировать котировки
 *
 * Non-linear inventory skew:
 * ```
 * skew = sign(position) × |position/maxPosition|^exponent × baseFactor × timePressure
 * ```
 * Экспоненциальный skew более агрессивен при большой позиции.
 *
 * Fragility влияние:
 * - Высокий fragility → более агрессивные recovery quotes
 * - Низкий fragility → осторожнее, рынок не реагирует
 *
 * @example
 * ```typescript
 * const strategy = new TwoSidedMarketMaker(config, logger);
 *
 * // Mode-aware quote generation
 * const quotes = strategy.generateQuotes(
 *   session,
 *   market,
 *   orderbook,
 *   'QUOTE',      // mode from RiskAssessment
 *   0.35          // fragilityScore from RiskAssessment
 * );
 * ```
 */

import { TradingSession } from '../aggregates/TradingSession.js';
import { Market } from '../entities/Market.js';
import { Orderbook } from '../entities/Orderbook.js';
import { Quote } from '../value-objects/Quote.js';
import { Price } from '../value-objects/Price.js';
import { Quantity } from '../value-objects/Quantity.js';
import { FairValueCalculator, FairValueConfig } from '../services/pricing/FairValueCalculator.js';
import { PositionTracker } from '../services/inventory/PositionTracker.js';
import { RiskAssessmentService, RiskConfig, TradingMode } from '../services/risk/RiskAssessmentService.js';
import { ConfigLoader, StrategyConfig } from '../../infrastructure/config/ConfigLoader.js';
import { OrderValidator } from '../services/execution/OrderValidator.js';
import { Order } from '../entities/Order.js';
import { ILogger } from '../ports/ILogger.js';

/**
 * Конфигурация TwoSidedMarketMaker стратегии
 */
export interface TwoSidedMarketMakerConfig {
  /** Базовый spread (0.02 = 2%) */
  baseSpread: number;

  /** Размер quote (количество для bid и ask) */
  quoteSize: Quantity;

  /** Чувствительность к inventory (0.01 = 1% adjustment per 100% skew) */
  inventorySensitivity: number;

  /** Максимальный skew для корректировки (0.5 = 50%) */
  maxSkew: number;

  /** Минимальный spread (защита от слишком узких spread) */
  minSpread?: number;

  /** Максимальный spread (защита от слишком широких spread) */
  maxSpread?: number;

  /** Конфигурация fair value calculator */
  fairValueConfig?: FairValueConfig;

  /** Конфигурация risk assessment */
  riskConfig?: RiskConfig;

  // ========================================
  // Non-Linear Skew Configuration (NEW)
  // ========================================

  /**
   * Exponent for non-linear skew
   *
   * @remarks
   * Higher = more aggressive at high inventory
   * Formula: |position/maxPosition|^exponent
   * Default: 2.5
   */
  skewExponent?: number;

  /**
   * Base factor for non-linear skew
   *
   * @remarks
   * Multiplied by exponential skew
   * Default: 0.05 (5%)
   */
  skewBaseFactor?: number;

  /**
   * Maximum skew value (cap)
   *
   * @remarks
   * Absolute maximum price adjustment
   * Default: 0.20 (20%)
   */
  maxSkewValue?: number;

  // ========================================
  // Recovery/Panic Configuration (NEW)
  // ========================================

  /**
   * Base spread crossing for recovery mode
   *
   * @remarks
   * How much to cross the spread in recovery
   * Default: 0.01 (1%)
   */
  recoveryBaseCrossing?: number;

  /**
   * Maximum spread crossing for panic mode
   *
   * @remarks
   * How much to cross the spread in panic
   * Default: 0.03 (3%)
   */
  panicMaxCrossing?: number;
}

/**
 * Two-Sided Market Maker Strategy (Mode-Aware)
 *
 * @remarks
 * Stateful стратегия с mode-aware котированием.
 */
export class TwoSidedMarketMaker {
  private readonly fairValueCalculator: FairValueCalculator;
  private readonly positionTracker: PositionTracker;
  private readonly riskAssessmentService: RiskAssessmentService;
  private readonly orderValidator: OrderValidator;
  private readonly logger: ILogger;
  private previousFairValue: Price | null = null;

  /** Strategy configuration from environment */
  private readonly strategyConfig: StrategyConfig;

  /**
   * Создаёт новую TwoSidedMarketMaker стратегию
   *
   * @param config - Конфигурация стратегии
   * @param logger - Logger instance (optional)
   */
  constructor(
    private readonly config: TwoSidedMarketMakerConfig,
    logger?: ILogger
  ) {
    // Create fallback no-op logger
    const fallbackLogger: ILogger = {
      silly: () => {},
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    this.logger = logger?.child?.('MarketMaker') || logger || fallbackLogger;

    // Load strategy config from environment
    this.strategyConfig = ConfigLoader.getInstance().getStrategyConfig();

    this.fairValueCalculator = new FairValueCalculator();
    this.positionTracker = new PositionTracker();
    this.riskAssessmentService = new RiskAssessmentService();
    this.orderValidator = new OrderValidator();
  }

  /**
   * Генерирует quotes для market making (mode-aware)
   *
   * @param session - Текущая торговая сессия
   * @param market - Рынок для торговли
   * @param orderbook - Текущий orderbook
   * @param mode - Trading mode from RiskAssessment (optional, defaults to QUOTE)
   * @param fragilityScore - Fragility score 0-1 (optional, defaults to 0.5)
   * @returns Массив Quote
   *
   * @remarks
   * Mode-aware алгоритм:
   *
   * | Mode | Поведение |
   * |------|-----------|
   * | FLAT | Двусторонние quotes без skew |
   * | QUOTE | Двусторонние quotes с linear skew |
   * | INVENTORY | Двусторонние quotes с non-linear skew |
   * | RECOVERY | Односторонние quotes для закрытия позиции |
   * | PANIC | Агрессивные quotes, пересекают спред |
   * | DEAD | Пустой массив (не котировать) |
   *
   * @example
   * ```typescript
   * // Normal quoting
   * const quotes = strategy.generateQuotes(session, market, orderbook, 'QUOTE', 0.3);
   *
   * // Recovery mode
   * const recoveryQuotes = strategy.generateQuotes(session, market, orderbook, 'RECOVERY', 0.5);
   *
   * // Panic mode
   * const panicQuotes = strategy.generateQuotes(session, market, orderbook, 'PANIC', 0.8);
   * ```
   */
  public generateQuotes(
    session: TradingSession,
    market: Market,
    orderbook: Orderbook,
    mode: TradingMode = 'QUOTE',
    fragilityScore: number = 0.5
  ): Quote[] {
    // DEAD mode: no quotes
    if (mode === 'DEAD') {
      this.logger.debug('[MarketMaker] DEAD mode - no quotes generated');
      return [];
    }

    // Check if orderbook has valid mid-price
    const currentMidPrice = orderbook.getMidPrice();
    if (!currentMidPrice) {
      return [];
    }

    // Dispatch to mode-specific handlers
    switch (mode) {
      case 'PANIC':
        return this.generatePanicQuotes(session, market, orderbook, fragilityScore);

      case 'RECOVERY':
        return this.generateRecoveryQuotes(session, market, orderbook, fragilityScore);

      case 'INVENTORY':
        return this.generateInventoryQuotes(session, market, orderbook, fragilityScore);

      case 'FLAT':
      case 'QUOTE':
      default:
        return this.generateTwoSidedQuotes(session, market, orderbook, mode, fragilityScore);
    }
  }

  /**
   * Generates standard two-sided quotes (FLAT/QUOTE mode)
   */
  private generateTwoSidedQuotes(
    session: TradingSession,
    market: Market,
    orderbook: Orderbook,
    mode: TradingMode,
    fragilityScore: number
  ): Quote[] {
    const currentMidPrice = orderbook.getMidPrice()!;

    // 1. Calculate fair value using config from environment
    const fairValueConfig = this.config.fairValueConfig ?? {
      weightMid: this.strategyConfig.fairValueWeightMid,
      weightMicroprice: this.strategyConfig.fairValueWeightMicroprice,
      weightEma: this.strategyConfig.fairValueWeightEma,
      emaAlpha: this.strategyConfig.fairValueEmaAlpha,
    };

    const previousFV = this.previousFairValue ?? currentMidPrice;
    const fairValue = this.fairValueCalculator.calculate(orderbook, previousFV, fairValueConfig);
    this.previousFairValue = fairValue;

    // 2. Calculate inventory skew (linear for FLAT/QUOTE)
    const skew = mode === 'FLAT'
      ? 0
      : this.positionTracker.calculateSkew(session.portfolio, market.id, this.config.maxSkew);

    // 3. Calculate risk adjustment
    const riskConfig = this.config.riskConfig ?? ConfigLoader.getInstance().getRiskConfig();
    const riskAssessment = this.riskAssessmentService.assess(session, market, riskConfig);

    // 4. Apply adjustments
    let spread = this.config.baseSpread;
    const inventoryAdjustment = skew * this.config.inventorySensitivity;

    // Risk multiplier: widen spread at high utilization (configurable coefficient)
    const riskMultiplier = 1 + (riskAssessment.netPositionUtilization.value / 100) * this.strategyConfig.riskSpreadCoefficient;
    spread *= riskMultiplier;

    // Apply min/max bounds from config
    spread = Math.max(spread, this.config.minSpread ?? this.strategyConfig.minSpread);
    spread = Math.min(spread, this.config.maxSpread ?? this.strategyConfig.maxSpread);

    // 5. Calculate bid/ask prices
    const halfSpread = spread / 2;
    let bidPrice = fairValue.value - halfSpread - inventoryAdjustment;
    let askPrice = fairValue.value + halfSpread - inventoryAdjustment;

    // 6. Validate and create quote
    const quote = this.createValidatedQuote(
      bidPrice,
      askPrice,
      orderbook,
      session,
      market
    );

    if (quote) {
      this.logger.debug('[MarketMaker] Two-sided quote generated', {
        mode,
        fairValue: fairValue.value.toFixed(4),
        spread: (spread * 100).toFixed(2) + '%',
        skew: skew.toFixed(4),
        bidPrice: quote.bid?.value.toFixed(4),
        askPrice: quote.ask?.value.toFixed(4),
        fragilityScore: fragilityScore.toFixed(4),
      });
      return [quote];
    }

    return [];
  }

  /**
   * Generates quotes with non-linear skew (INVENTORY mode)
   */
  private generateInventoryQuotes(
    session: TradingSession,
    market: Market,
    orderbook: Orderbook,
    fragilityScore: number
  ): Quote[] {
    const currentMidPrice = orderbook.getMidPrice()!;

    // 1. Calculate fair value using config from environment
    const fairValueConfig = this.config.fairValueConfig ?? {
      weightMid: this.strategyConfig.fairValueWeightMid,
      weightMicroprice: this.strategyConfig.fairValueWeightMicroprice,
      weightEma: this.strategyConfig.fairValueWeightEma,
      emaAlpha: this.strategyConfig.fairValueEmaAlpha,
    };

    const previousFV = this.previousFairValue ?? currentMidPrice;
    const fairValue = this.fairValueCalculator.calculate(orderbook, previousFV, fairValueConfig);
    this.previousFairValue = fairValue;

    // 2. Calculate NON-LINEAR inventory skew
    const nonLinearSkew = this.calculateNonLinearSkew(session, market);

    // 3. Calculate base spread (wider in inventory mode, multiplier from config)
    let spread = this.config.baseSpread * this.strategyConfig.inventorySpreadMultiplier;

    // Apply min/max bounds from config
    spread = Math.max(spread, this.config.minSpread ?? this.strategyConfig.minSpread);
    spread = Math.min(spread, this.config.maxSpread ?? this.strategyConfig.maxSpread);

    // 4. Calculate bid/ask with non-linear skew
    const halfSpread = spread / 2;
    let bidPrice = fairValue.value - halfSpread - nonLinearSkew;
    let askPrice = fairValue.value + halfSpread - nonLinearSkew;

    // 5. Create quote
    const quote = this.createValidatedQuote(
      bidPrice,
      askPrice,
      orderbook,
      session,
      market
    );

    if (quote) {
      this.logger.debug('[MarketMaker] Inventory quote generated', {
        mode: 'INVENTORY',
        fairValue: fairValue.value.toFixed(4),
        spread: (spread * 100).toFixed(2) + '%',
        nonLinearSkew: nonLinearSkew.toFixed(4),
        bidPrice: quote.bid?.value.toFixed(4),
        askPrice: quote.ask?.value.toFixed(4),
        fragilityScore: fragilityScore.toFixed(4),
      });
      return [quote];
    }

    return [];
  }

  /**
   * Generates aggressive recovery quotes (RECOVERY mode)
   *
   * @remarks
   * One-sided quotes to close position:
   * - Long position → SELL quote (crosses spread)
   * - Short position → BUY quote (crosses spread)
   *
   * Fragility boost: higher fragility = more aggressive (market responds)
   */
  private generateRecoveryQuotes(
    session: TradingSession,
    market: Market,
    orderbook: Orderbook,
    fragilityScore: number
  ): Quote[] {
    const netPosition = session.portfolio.netPosition;

    // No position to recover
    if (Math.abs(netPosition) < 0.5) {
      return [];
    }

    const bestBid = orderbook.getBestBid();
    const bestAsk = orderbook.getBestAsk();

    if (!bestBid || !bestAsk) {
      return [];
    }

    // Calculate recovery urgency based on time (thresholds from config)
    const hoursToExpiry = (market.expirationDate.getTime() - Date.now()) / 3600000;
    let recoveryUrgency = this.strategyConfig.recoveryDefaultUrgency;
    if (hoursToExpiry < this.strategyConfig.recoveryUrgentHours) {
      recoveryUrgency = 1.0; // Very urgent
    } else if (hoursToExpiry < this.strategyConfig.recoveryModerateHours) {
      const urgentHours = this.strategyConfig.recoveryUrgentHours;
      const moderateHours = this.strategyConfig.recoveryModerateHours;
      recoveryUrgency = this.strategyConfig.recoveryDefaultUrgency +
        (1 - (hoursToExpiry - urgentHours) / (moderateHours - urgentHours)) *
        (1 - this.strategyConfig.recoveryDefaultUrgency);
    }

    // Fragility boost: higher fragility = more aggressive crossing (factor from config)
    const fragilityBoost = fragilityScore * this.strategyConfig.fragilityBoostFactor;

    // Base crossing + urgency + fragility (all from config)
    const baseCrossing = this.config.recoveryBaseCrossing ?? this.strategyConfig.recoveryBaseCrossing;
    const spreadCrossing = baseCrossing + (recoveryUrgency * this.strategyConfig.urgencyCrossingFactor) + fragilityBoost;

    let quote: Quote | null = null;

    if (netPosition > 0) {
      // Long position → SELL to close
      // Price below best bid to get filled
      const sellPrice = bestBid.value - spreadCrossing;
      const clampedPrice = Math.max(0.01, Math.min(0.99, sellPrice));

      this.logger.info('[MarketMaker] Recovery SELL quote', {
        netPosition: netPosition.toFixed(2),
        recoveryUrgency: recoveryUrgency.toFixed(2),
        fragilityBoost: fragilityBoost.toFixed(4),
        spreadCrossing: spreadCrossing.toFixed(4),
        sellPrice: clampedPrice.toFixed(4),
        bestBid: bestBid.value.toFixed(4),
      });

      quote = this.createOneSidedQuote(
        null, // No bid
        clampedPrice, // Sell
        session,
        market
      );
    } else {
      // Short position → BUY to close
      // Price above best ask to get filled
      const buyPrice = bestAsk.value + spreadCrossing;
      const clampedPrice = Math.max(0.01, Math.min(0.99, buyPrice));

      this.logger.info('[MarketMaker] Recovery BUY quote', {
        netPosition: netPosition.toFixed(2),
        recoveryUrgency: recoveryUrgency.toFixed(2),
        fragilityBoost: fragilityBoost.toFixed(4),
        spreadCrossing: spreadCrossing.toFixed(4),
        buyPrice: clampedPrice.toFixed(4),
        bestAsk: bestAsk.value.toFixed(4),
      });

      quote = this.createOneSidedQuote(
        clampedPrice, // Buy
        null, // No ask
        session,
        market
      );
    }

    return quote ? [quote] : [];
  }

  /**
   * Generates very aggressive panic quotes (PANIC mode)
   *
   * @remarks
   * Maximum aggression to exit positions immediately.
   * Crosses spread significantly.
   */
  private generatePanicQuotes(
    session: TradingSession,
    market: Market,
    orderbook: Orderbook,
    _fragilityScore: number
  ): Quote[] {
    const netPosition = session.portfolio.netPosition;

    // No position - nothing to panic about
    if (Math.abs(netPosition) < 0.5) {
      this.logger.warn('[MarketMaker] PANIC mode but no position to close');
      return [];
    }

    const bestBid = orderbook.getBestBid();
    const bestAsk = orderbook.getBestAsk();

    if (!bestBid || !bestAsk) {
      return [];
    }

    // Maximum crossing in panic (from config)
    const maxCrossing = this.config.panicMaxCrossing ?? this.strategyConfig.panicMaxCrossing;

    let quote: Quote | null = null;

    if (netPosition > 0) {
      // SELL aggressively
      const panicSellPrice = bestBid.value - maxCrossing;
      const clampedPrice = Math.max(0.01, Math.min(0.99, panicSellPrice));

      this.logger.warn('[MarketMaker] PANIC SELL quote', {
        netPosition: netPosition.toFixed(2),
        panicCrossing: maxCrossing.toFixed(4),
        sellPrice: clampedPrice.toFixed(4),
        bestBid: bestBid.value.toFixed(4),
      });

      quote = this.createOneSidedQuote(null, clampedPrice, session, market);
    } else {
      // BUY aggressively
      const panicBuyPrice = bestAsk.value + maxCrossing;
      const clampedPrice = Math.max(0.01, Math.min(0.99, panicBuyPrice));

      this.logger.warn('[MarketMaker] PANIC BUY quote', {
        netPosition: netPosition.toFixed(2),
        panicCrossing: maxCrossing.toFixed(4),
        buyPrice: clampedPrice.toFixed(4),
        bestAsk: bestAsk.value.toFixed(4),
      });

      quote = this.createOneSidedQuote(clampedPrice, null, session, market);
    }

    return quote ? [quote] : [];
  }

  /**
   * Calculates non-linear inventory skew
   *
   * @remarks
   * Formula:
   * ```
   * skew = sign(normalizedPosition) × |normalizedPosition|^exponent × baseFactor × timePressure
   * ```
   *
   * Time pressure multiplier:
   * - < 30 min: 5x
   * - < 2 hours: 1-5x (linear interpolation)
   * - > 2 hours: 1x
   */
  private calculateNonLinearSkew(session: TradingSession, market: Market): number {
    const netPosition = session.portfolio.netPosition;
    const riskConfig = this.config.riskConfig ?? ConfigLoader.getInstance().getRiskConfig();
    const maxPosition = riskConfig.maxNetPosition;

    if (maxPosition === 0) return 0;

    const normalizedPosition = netPosition / maxPosition;
    const exponent = this.config.skewExponent ?? this.strategyConfig.skewExponent;
    const baseFactor = this.config.skewBaseFactor ?? this.strategyConfig.skewBaseFactor;
    const maxSkewValue = this.config.maxSkewValue ?? this.strategyConfig.maxSkewValue;

    // Exponential skew
    const baseSkew = Math.sign(normalizedPosition) *
      Math.pow(Math.abs(normalizedPosition), exponent) *
      baseFactor;

    // Time pressure multiplier (thresholds from config)
    const hoursToExpiry = (market.expirationDate.getTime() - Date.now()) / 3600000;
    let timePressure = 1.0;

    if (hoursToExpiry < this.strategyConfig.skewUrgentHours) {
      timePressure = this.strategyConfig.skewMaxTimeMultiplier;
    } else if (hoursToExpiry < this.strategyConfig.skewModerateHours) {
      // Linear interpolation from 1x to maxTimeMultiplier
      const urgentHours = this.strategyConfig.skewUrgentHours;
      const moderateHours = this.strategyConfig.skewModerateHours;
      timePressure = 1.0 + (1 - (hoursToExpiry - urgentHours) / (moderateHours - urgentHours)) *
        this.strategyConfig.skewTimeMultiplierRange;
    }

    const finalSkew = baseSkew * timePressure;

    // Clamp to max
    return Math.max(-maxSkewValue, Math.min(maxSkewValue, finalSkew));
  }

  /**
   * Creates a validated two-sided quote
   */
  private createValidatedQuote(
    bidPrice: number,
    askPrice: number,
    orderbook: Orderbook,
    session: TradingSession,
    market: Market
  ): Quote | null {
    // Clamp to valid range
    bidPrice = Math.max(0.01, Math.min(0.99, bidPrice));
    askPrice = Math.max(0.01, Math.min(0.99, askPrice));

    // Ensure ask > bid (use validation min spread from config)
    if (askPrice <= bidPrice) {
      const midPrice = (bidPrice + askPrice) / 2;
      const minSpread = this.strategyConfig.validationMinSpread;
      bidPrice = Math.max(0.01, midPrice - minSpread / 2);
      askPrice = Math.min(0.99, midPrice + minSpread / 2);
    }

    // Don't cross the market (use price cross adjustment from config)
    const bestBid = orderbook.getBestBid();
    const bestAsk = orderbook.getBestAsk();

    if (bestBid && bidPrice >= bestBid.value) {
      bidPrice = bestBid.value - this.strategyConfig.priceCrossAdjustment;
    }

    if (bestAsk && askPrice <= bestAsk.value) {
      askPrice = bestAsk.value + this.strategyConfig.priceCrossAdjustment;
    }

    // Final clamp
    bidPrice = Math.max(0.01, Math.min(0.99, bidPrice));
    askPrice = Math.max(0.01, Math.min(0.99, askPrice));

    try {
      const quote = new Quote(
        Price.fromNumber(bidPrice),
        Price.fromNumber(askPrice),
        this.config.quoteSize,
        this.config.quoteSize,
        new Date()
      );

      // Validate through OrderValidator (using outcome 0 token)
      const isValidBid = this.validateQuoteSide('BUY', market.outcomes[0].tokenId, quote.bid!, quote.bidSize, session);
      const isValidAsk = this.validateQuoteSide('SELL', market.outcomes[0].tokenId, quote.ask!, quote.askSize, session);

      if (!isValidBid || !isValidAsk) {
        return null;
      }

      return quote;
    } catch {
      return null;
    }
  }

  /**
   * Creates a one-sided quote (for recovery/panic)
   */
  private createOneSidedQuote(
    bidPrice: number | null,
    askPrice: number | null,
    session: TradingSession,
    market: Market
  ): Quote | null {
    try {
      const bid = bidPrice !== null ? Price.fromNumber(bidPrice) : undefined;
      const ask = askPrice !== null ? Price.fromNumber(askPrice) : undefined;

      // At least one side must be present
      if (!bid && !ask) {
        return null;
      }

      const quote = new Quote(
        bid ?? null,
        ask ?? null,
        bid ? this.config.quoteSize : Quantity.fromNumber(0),
        ask ? this.config.quoteSize : Quantity.fromNumber(0),
        new Date()
      );

      // Validate (using outcome 0 token)
      if (bid) {
        const isValid = this.validateQuoteSide('BUY', market.outcomes[0].tokenId, bid, this.config.quoteSize, session);
        if (!isValid) return null;
      }

      if (ask) {
        const isValid = this.validateQuoteSide('SELL', market.outcomes[0].tokenId, ask, this.config.quoteSize, session);
        if (!isValid) return null;
      }

      return quote;
    } catch {
      return null;
    }
  }

  /**
   * Validates one side of a quote
   */
  private validateQuoteSide(
    side: 'BUY' | 'SELL',
    tokenId: string,
    price: Price,
    size: Quantity,
    session: TradingSession
  ): boolean {
    try {
      const tempOrder = Order.create({
        id: 'temp-validation',
        tokenId,
        side,
        price,
        size,
        status: 'PENDING',
        timestamp: new Date(),
      });

      const validation = this.orderValidator.validate(tempOrder, session);
      return validation.isValid;
    } catch {
      return false;
    }
  }

  /**
   * Updates strategy configuration
   */
  public updateConfig(updates: Partial<TwoSidedMarketMakerConfig>): void {
    Object.assign(this.config, updates);
  }

  /**
   * Returns current configuration
   */
  public getConfig(): Readonly<TwoSidedMarketMakerConfig> {
    return { ...this.config };
  }

  /**
   * Resets strategy state
   */
  public reset(): void {
    this.previousFairValue = null;
    this.logger.info('[MarketMaker] Strategy state reset');
  }

  /**
   * Returns strategy name
   */
  public getName(): string {
    return 'TwoSidedMarketMaker';
  }
}
