/**
 * RiskAssessmentService - комплексная оценка рисков с интеграцией сигналов
 *
 * @remarks
 * Stateful доменный сервис для комплексной оценки рисков торговой сессии.
 * Интегрирует все signal-компоненты:
 * - **TradeFlowAnalyzer**: Fragility, Trade Imbalance, Market State
 * - **OrderbookHealthMonitor**: RefillRate, Book Imbalance, Thinning
 * - **EdgeAliveEvaluator**: Layer 0 edge liveness detection
 *
 * Оцениваемые риски:
 * 1. **Edge Risk (Layer 0)** - активность маркета, fragility
 * 2. **Position Risk** - размер позиции относительно лимитов
 * 3. **P&L Risk** - текущий unrealized P&L
 * 4. **Time Risk** - близость к экспирации рынка
 * 5. **Inventory Risk** - дисбаланс YES/NO позиций
 *
 * Trading Modes:
 * - **FLAT**: Нет позиции, можно котировать
 * - **QUOTE**: Есть позиция, нормальное котирование
 * - **INVENTORY**: Управление inventory, skewed quotes
 * - **RECOVERY**: Активное закрытие позиции
 * - **PANIC**: Экстренное закрытие, агрессивные ордера
 * - **DEAD**: Edge мёртв, прекратить торговлю
 *
 * @example
 * ```typescript
 * const service = new RiskAssessmentService(logger, edgeConfig, tradeFlowConfig);
 *
 * // Event-driven: записывать события
 * service.recordTrade(trade);
 * service.recordOrderbook(orderbook);
 * service.recordPriceTick(deltaTicks, timestamp);
 *
 * // Получить оценку
 * const assessment = service.assess(session, market, config);
 *
 * console.log(`Mode: ${assessment.mode}`);
 * console.log(`Fragility: ${assessment.fragilityScore}`);
 * console.log(`Edge Alive: ${assessment.edgeAlive}`);
 * ```
 */
import { TradingSession } from '../../aggregates/TradingSession.js';
import { Market } from '../../entities/Market.js';
import { Orderbook } from '../../entities/Orderbook.js';
import { Percentage } from '../../value-objects/Percentage.js';
import { ILogger } from '../../ports/ILogger.js';
import { ConfigLoader } from '../../../infrastructure/config/ConfigLoader.js';
import {
  TradeFlowAnalyzer,
  TradeFlowMetrics,
  TradeFlowConfig,
  TradeSideDetector,
  OrderbookHealthMonitor,
  OrderbookHealthConfig,
  MarketState,
  OrderBookSnapshot,
  DEFAULT_TRADE_FLOW_CONFIG,
  DEFAULT_ORDERBOOK_HEALTH_CONFIG,
  MarketContext,
  getMarketLogInfo,
} from '../signals/index.js';
import {
  EdgeAliveEvaluator,
  EdgeAliveConfig,
  EdgeEvaluation,
  DEFAULT_EDGE_ALIVE_CONFIG,
} from './EdgeAliveEvaluator.js';

/**
 * Risk configuration
 */
export interface RiskConfig {
  /**
   * Maximum net position size (signed)
   */
  maxNetPosition: number;

  /**
   * Maximum gross position size (absolute)
   */
  maxGrossPosition: number;

  /**
   * Panic mode threshold (0-1, default: 0.8)
   */
  panicThreshold: number;

  /**
   * Inventory mode threshold (0-1, default: 0.5)
   */
  inventoryThreshold: number;

  /**
   * Time urgency factor in seconds before expiry (default: 86400 = 24 hours)
   */
  timeUrgencySeconds: number;
}

/**
 * Risk status
 */
export type RiskStatus = 'NORMAL' | 'WARNING' | 'PANIC' | 'DEAD';

/**
 * Trading mode (extended with FLAT, RECOVERY, DEAD)
 *
 * @remarks
 * Priority order (highest to lowest):
 * 1. DEAD - Edge is dead, no trading
 * 2. PANIC - Emergency exit, aggressive orders
 * 3. RECOVERY - Active position closing
 * 4. INVENTORY - Skewed quotes to reduce inventory
 * 5. QUOTE - Normal two-sided quoting
 * 6. FLAT - No position, can quote
 */
export type TradingMode = 'FLAT' | 'QUOTE' | 'INVENTORY' | 'RECOVERY' | 'PANIC' | 'DEAD';

/**
 * Risk assessment result (extended with edge and fragility metrics)
 */
export interface RiskAssessment {
  /**
   * Overall risk status
   */
  status: RiskStatus;

  /**
   * Recommended trading mode
   */
  mode: TradingMode;

  /**
   * Urgency percentage (0-100%)
   */
  urgency: Percentage;

  /**
   * Net position utilization (0-100%)
   */
  netPositionUtilization: Percentage;

  /**
   * Gross position utilization (0-100%)
   */
  grossPositionUtilization: Percentage;

  /**
   * Time to expiry in seconds
   */
  secondsToExpiry: number;

  /**
   * Time to expiry in human-readable format
   */
  timeToExpiry: string;

  /**
   * Market question/name
   */
  marketQuestion: string;

  /**
   * Market URL on Polymarket
   */
  marketUrl: string;

  /**
   * Recommendations
   */
  recommendations: string[];

  // ========================================
  // Layer 0: Edge Alive (NEW)
  // ========================================

  /**
   * Is edge alive?
   *
   * @remarks
   * From EdgeAliveEvaluator. If false, bot should stop quoting.
   */
  edgeAlive: boolean;

  /**
   * Is edge in warning state?
   *
   * @remarks
   * Edge is dead but may recover (during warmup or before threshold).
   */
  edgeWarning: boolean;

  /**
   * Is edge death irreversible?
   */
  edgeIrreversible: boolean;

  /**
   * Reason for edge state
   */
  edgeReason: string;

  // ========================================
  // Trade Flow Metrics (NEW)
  // ========================================

  /**
   * Fragility score 0-1
   *
   * @remarks
   * How easily price moves with volume.
   * Higher = more fragile market.
   */
  fragilityScore: number;

  /**
   * Market state classification
   */
  marketState: MarketState;

  /**
   * Trade imbalance -1 to 1
   */
  tradeImbalance: number;

  /**
   * Book imbalance -1 to 1
   */
  bookImbalance: number;

  /**
   * Market pressure score
   */
  marketPressureScore: number;

  // ========================================
  // Orderbook Health (NEW)
  // ========================================

  /**
   * Orderbook refill rate 0-1
   */
  refillRate: number;

  /**
   * Is orderbook thinning?
   */
  isThinning: boolean;

  // ========================================
  // Position Info
  // ========================================

  /**
   * Current net position
   */
  netPosition: number;

  /**
   * Has any position?
   */
  hasPosition: boolean;
}

/**
 * Trade event for recording
 */
export interface TradeRecord {
  /** Trade price */
  price: number;
  /** Trade size */
  size: number;
  /** Best bid at time of trade */
  bestBid: number;
  /** Best ask at time of trade */
  bestAsk: number;
  /** Timestamp in ms */
  timestamp: number;
}

/**
 * RiskAssessmentService
 *
 * @remarks
 * Stateful сервис для комплексной оценки рисков.
 * Интегрирует TradeFlowAnalyzer, OrderbookHealthMonitor и EdgeAliveEvaluator.
 *
 * Алгоритм:
 * 1. Event-driven запись trades, orderbook, price ticks
 * 2. Layer 0: EdgeAliveEvaluator → edge status
 * 3. Layer 1: Position/Time risk → urgency
 * 4. Layer 2: Recovery check → recovery needed
 * 5. Mode determination based on all layers
 *
 * @example
 * ```typescript
 * const service = new RiskAssessmentService(logger);
 *
 * // Record events
 * service.recordTrade({ price: 0.5, size: 100, bestBid: 0.49, bestAsk: 0.51, timestamp: Date.now() });
 * service.recordOrderbook(orderbook);
 *
 * // Assess
 * const assessment = service.assess(session, market, config);
 * ```
 */
export class RiskAssessmentService {
  private readonly logger: ILogger;
  private readonly tradeFlowAnalyzer: TradeFlowAnalyzer;
  private readonly tradeSideDetector: TradeSideDetector;
  private readonly orderbookHealthMonitor: OrderbookHealthMonitor;
  private readonly edgeAliveEvaluator: EdgeAliveEvaluator;

  /** Previous mode for logging transitions */
  private previousMode: TradingMode | null = null;

  /** Summary logging interval */
  private lastSummaryTimestamp: number = 0;
  private readonly summaryIntervalMs: number = 30000; // 30 seconds

  /** Market context for multi-market logging */
  private marketContext: MarketContext | null = null;

  /**
   * Creates RiskAssessmentService
   *
   * @param logger - Logger instance (optional, uses console fallback)
   * @param edgeConfig - EdgeAliveEvaluator configuration (optional)
   * @param tradeFlowConfig - TradeFlowAnalyzer configuration (optional)
   * @param orderbookHealthConfig - OrderbookHealthMonitor configuration (optional)
   *
   * @example
   * ```typescript
   * const service = new RiskAssessmentService(logger);
   *
   * // Or with custom config
   * const service = new RiskAssessmentService(logger, {
   *   minFragilityScore: 0.15,
   *   warmupMs: 120000,
   * });
   *
   * // Or without logger (uses console fallback)
   * const service = new RiskAssessmentService();
   * ```
   */
  constructor(
    logger?: ILogger,
    edgeConfig: Partial<EdgeAliveConfig> = {},
    tradeFlowConfig: Partial<TradeFlowConfig> = {},
    orderbookHealthConfig: Partial<OrderbookHealthConfig> = {}
  ) {
    // Create a fallback no-op logger if none provided
    const fallbackLogger: ILogger = {
      silly: () => {},
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    const baseLogger = logger || fallbackLogger;
    this.logger = baseLogger.child?.('RiskAssessment') || baseLogger;

    // Initialize signal components
    const mergedTradeFlowConfig = { ...DEFAULT_TRADE_FLOW_CONFIG, ...tradeFlowConfig };
    this.tradeFlowAnalyzer = new TradeFlowAnalyzer(
      mergedTradeFlowConfig,
      baseLogger
    );
    this.tradeSideDetector = new TradeSideDetector(
      { minAggressiveVolume: mergedTradeFlowConfig.minAggressiveVolume },
      baseLogger
    );
    this.orderbookHealthMonitor = new OrderbookHealthMonitor(
      { ...DEFAULT_ORDERBOOK_HEALTH_CONFIG, ...orderbookHealthConfig },
      baseLogger
    );
    this.edgeAliveEvaluator = new EdgeAliveEvaluator(
      { ...DEFAULT_EDGE_ALIVE_CONFIG, ...edgeConfig },
      baseLogger
    );

    this.logger.info('[RiskAssessment] Service initialized', {
      edgeConfig: { ...DEFAULT_EDGE_ALIVE_CONFIG, ...edgeConfig },
      tradeFlowConfig: mergedTradeFlowConfig,
      tradeSideDetectorConfig: { minAggressiveVolume: mergedTradeFlowConfig.minAggressiveVolume },
    });
  }

  /**
   * Устанавливает market context для логирования
   *
   * @param context - Market context с идентификацией рынка
   *
   * @remarks
   * Передаёт контекст во все дочерние компоненты:
   * - TradeFlowAnalyzer
   * - OrderbookHealthMonitor
   * - EdgeAliveEvaluator
   *
   * @example
   * ```typescript
   * service.setMarketContext({
   *   marketId: '0x123...',
   *   marketSlug: 'btc-up-down',
   *   question: 'Bitcoin Up or Down?',
   *   expirationDate: new Date('2024-12-29T12:00:00Z'),
   * });
   * ```
   */
  public setMarketContext(context: MarketContext): void {
    this.marketContext = context;

    // Propagate to all child components
    this.tradeFlowAnalyzer.setMarketContext(context);
    this.orderbookHealthMonitor.setMarketContext(context);
    this.edgeAliveEvaluator.setMarketContext(context);

    this.logger.info('[RiskAssessment] Market context set', {
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
   * Records a trade (event-driven)
   *
   * @param trade - Trade record with price, size, best bid/ask
   *
   * @remarks
   * 1. Detects trade side using TradeSideDetector
   * 2. Records trade in TradeFlowAnalyzer
   *
   * @example
   * ```typescript
   * service.recordTrade({
   *   price: 0.52,
   *   size: 100,
   *   bestBid: 0.51,
   *   bestAsk: 0.53,
   *   timestamp: Date.now(),
   * });
   * ```
   */
  public recordTrade(trade: TradeRecord): void {
    // Detect trade side
    const side = this.tradeSideDetector.detect(
      trade.price,
      trade.size,
      { bid: trade.bestBid, ask: trade.bestAsk }
    );

    // Record in trade flow analyzer
    if (side !== 'UNKNOWN') {
      this.tradeFlowAnalyzer.recordTrade({
        side,
        price: trade.price,
        size: trade.size,
        timestamp: trade.timestamp,
      });
    }

    this.logger.trace('[RiskAssessment] Trade recorded', {
      ...this.getMarketInfo(),
      side,
      price: trade.price.toFixed(4),
      size: trade.size,
      bestBid: trade.bestBid.toFixed(4),
      bestAsk: trade.bestAsk.toFixed(4),
    });
  }

  /**
   * Records orderbook snapshot (event-driven)
   *
   * @param orderbook - Orderbook entity
   *
   * @remarks
   * 1. Records in OrderbookHealthMonitor
   * 2. Records in TradeFlowAnalyzer for bookImbalance
   *
   * @example
   * ```typescript
   * service.recordOrderbook(orderbook);
   * ```
   */
  public recordOrderbook(orderbook: Orderbook): void {
    // Record in orderbook health monitor
    this.orderbookHealthMonitor.recordSnapshot(orderbook);

    // Convert to OrderBookSnapshot for trade flow analyzer
    const snapshot: OrderBookSnapshot = {
      bids: orderbook.bids.map(level => ({
        price: level.price.value,
        size: level.quantity.value,
      })),
      asks: orderbook.asks.map(level => ({
        price: level.price.value,
        size: level.quantity.value,
      })),
      timestamp: orderbook.timestamp.getTime(),
    };

    // Record in trade flow analyzer for book imbalance
    this.tradeFlowAnalyzer.recordOrderBook(snapshot);
  }

  /**
   * Records price tick (event-driven)
   *
   * @param priceDeltaTicks - Price change in ticks (positive = up, negative = down)
   * @param timestamp - Timestamp in ms
   *
   * @remarks
   * Used for fragility calculation.
   * Call when mid price changes significantly.
   *
   * @example
   * ```typescript
   * // Price moved from 0.50 to 0.51 (10 ticks at 0.001 tick size)
   * service.recordPriceTick(10, Date.now());
   * ```
   */
  public recordPriceTick(priceDeltaTicks: number, timestamp: number): void {
    this.tradeFlowAnalyzer.recordPriceTick(priceDeltaTicks, timestamp);

    this.logger.trace('[RiskAssessment] Price tick recorded', {
      ...this.getMarketInfo(),
      deltaTicks: priceDeltaTicks,
      timestamp,
    });
  }

  /**
   * Assesses risk for trading session
   *
   * @param session - Trading session to assess
   * @param market - Market information
   * @param config - Risk configuration
   * @returns Risk assessment result with all metrics
   *
   * @remarks
   * Алгоритм оценки:
   *
   * 1. **Layer 0 - Edge Alive**:
   *    Evaluate edge using EdgeAliveEvaluator with fragilityScore and refillRate
   *
   * 2. **Layer 1 - Position Risk**:
   *    ```
   *    netUtilization = |netPosition| / maxNetPosition
   *    grossUtilization = grossPosition / maxGrossPosition
   *    positionUrgency = max(netUtilization, grossUtilization)
   *    ```
   *
   * 3. **Layer 2 - Time Risk**:
   *    ```
   *    secondsToExpiry = (expiry - now) / 1000
   *    timeUrgency = max(0, 1 - secondsToExpiry / timeUrgencySeconds)
   *    ```
   *
   * 4. **Mode Determination** (priority order):
   *    - Edge dead + no position → DEAD
   *    - Edge dead + has position → RECOVERY (forced)
   *    - urgency >= panicThreshold → PANIC
   *    - urgency >= inventoryThreshold → INVENTORY
   *    - has position → QUOTE
   *    - no position → FLAT
   *
   * @example
   * ```typescript
   * const assessment = service.assess(session, market, config);
   *
   * switch (assessment.mode) {
   *   case 'DEAD':
   *     console.log('Edge dead, stop trading');
   *     break;
   *   case 'PANIC':
   *     console.log('PANIC! Close positions immediately');
   *     break;
   *   case 'RECOVERY':
   *     console.log('Recovery mode, closing positions');
   *     break;
   *   case 'INVENTORY':
   *     console.log('Inventory mode, skew quotes');
   *     break;
   *   case 'QUOTE':
   *     console.log('Normal quoting');
   *     break;
   *   case 'FLAT':
   *     console.log('No position, ready to quote');
   *     break;
   * }
   * ```
   */
  public assess(
    session: TradingSession,
    market: Market,
    config: RiskConfig
  ): RiskAssessment {
    const now = Date.now();

    // ========================================
    // Layer 0: Edge Alive Evaluation
    // ========================================
    const tradeFlowMetrics = this.tradeFlowAnalyzer.getMarketState();
    const orderbookMetrics = this.orderbookHealthMonitor.getMetrics();
    const timeToExpiryMin = this.getTimeToExpiryMinutes(market);

    const edgeEval = this.edgeAliveEvaluator.evaluate(
      tradeFlowMetrics,
      orderbookMetrics,
      timeToExpiryMin
    );

    // ========================================
    // Layer 1: Position Risk
    // ========================================
    const netPosition = session.portfolio.netPosition;
    const absNetPosition = Math.abs(netPosition);
    const grossPosition = session.portfolio.grossPosition;
    const hasPosition = absNetPosition > 0.5; // Small threshold for floating point

    const netUtilization = config.maxNetPosition > 0 ? absNetPosition / config.maxNetPosition : 0;
    const grossUtilization = config.maxGrossPosition > 0 ? grossPosition / config.maxGrossPosition : 0;

    // ========================================
    // Layer 2: Time Risk
    // ========================================
    const expiry = market.expirationDate.getTime();
    const secondsToExpiry = (expiry - now) / 1000;

    let timeUrgency = 0;
    if (secondsToExpiry < config.timeUrgencySeconds) {
      timeUrgency = Math.max(0, 1 - secondsToExpiry / config.timeUrgencySeconds);
    }

    // ========================================
    // Calculate Overall Urgency
    // ========================================
    const positionUrgency = Math.min(1, Math.max(netUtilization, grossUtilization));
    const urgency = Math.min(1, Math.max(positionUrgency, timeUrgency));

    // ========================================
    // Determine Status and Mode
    // ========================================
    const { status, mode } = this.determineStatusAndMode(
      edgeEval,
      urgency,
      hasPosition,
      config
    );

    // ========================================
    // Generate Recommendations
    // ========================================
    const recommendations = this.generateRecommendations(
      edgeEval,
      netUtilization,
      grossUtilization,
      timeUrgency,
      mode,
      absNetPosition,
      grossPosition,
      secondsToExpiry,
      config
    );

    // ========================================
    // Log Mode Transition
    // ========================================
    if (this.previousMode !== null && this.previousMode !== mode) {
      this.logModeTransition(this.previousMode, mode, edgeEval, tradeFlowMetrics);
    }
    this.previousMode = mode;

    // ========================================
    // Periodic Summary Log
    // ========================================
    if (now - this.lastSummaryTimestamp >= this.summaryIntervalMs) {
      this.lastSummaryTimestamp = now;
      this.logSummary(mode, edgeEval, tradeFlowMetrics, orderbookMetrics, urgency, hasPosition);
    }

    // ========================================
    // TRACE-level: Position utilization calculation
    // ========================================
    this.logger.trace('[RiskAssessment] Position utilization calculation', {
      ...this.getMarketInfo(),
      netPosition: netPosition.toFixed(2),
      absNetPosition: absNetPosition.toFixed(2),
      maxNetPosition: config.maxNetPosition,
      netUtilization: `${absNetPosition.toFixed(2)} / ${config.maxNetPosition} = ${(netUtilization * 100).toFixed(2)}%`,
      grossPosition: grossPosition.toFixed(2),
      maxGrossPosition: config.maxGrossPosition,
      grossUtilization: `${grossPosition.toFixed(2)} / ${config.maxGrossPosition} = ${(grossUtilization * 100).toFixed(2)}%`,
      positionUrgency: `max(${(netUtilization * 100).toFixed(2)}%, ${(grossUtilization * 100).toFixed(2)}%) = ${(positionUrgency * 100).toFixed(2)}%`,
      hasPosition: hasPosition ? `YES (|netPosition| = ${absNetPosition.toFixed(2)} > 0.5)` : `NO (|netPosition| = ${absNetPosition.toFixed(2)} <= 0.5)`,
      formula: 'netUtilization = |netPosition| / maxNetPosition',
    });

    // ========================================
    // TRACE-level: Time urgency calculation
    // ========================================
    this.logger.trace('[RiskAssessment] Time urgency calculation', {
      ...this.getMarketInfo(),
      marketExpiry: new Date(expiry).toISOString(),
      nowTimestamp: new Date(now).toISOString(),
      secondsToExpiry: secondsToExpiry.toFixed(0),
      timeUrgencySeconds: config.timeUrgencySeconds,
      isUrgent: secondsToExpiry < config.timeUrgencySeconds ? `YES (${secondsToExpiry.toFixed(0)}s < ${config.timeUrgencySeconds}s)` : `NO (${secondsToExpiry.toFixed(0)}s >= ${config.timeUrgencySeconds}s)`,
      timeUrgency: `max(0, 1 - ${secondsToExpiry.toFixed(0)} / ${config.timeUrgencySeconds}) = ${(timeUrgency * 100).toFixed(2)}%`,
      formula: 'timeUrgency = max(0, 1 - secondsToExpiry / timeUrgencySeconds)',
    });

    // ========================================
    // TRACE-level: Overall urgency calculation
    // ========================================
    this.logger.trace('[RiskAssessment] Overall urgency calculation', {
      ...this.getMarketInfo(),
      positionUrgency: (positionUrgency * 100).toFixed(2) + '%',
      timeUrgency: (timeUrgency * 100).toFixed(2) + '%',
      urgency: `max(${(positionUrgency * 100).toFixed(2)}%, ${(timeUrgency * 100).toFixed(2)}%) = ${(urgency * 100).toFixed(2)}%`,
      inventoryThreshold: (config.inventoryThreshold * 100).toFixed(0) + '%',
      panicThreshold: (config.panicThreshold * 100).toFixed(0) + '%',
      inventoryTriggered: urgency >= config.inventoryThreshold ? `YES (${(urgency * 100).toFixed(2)}% >= ${(config.inventoryThreshold * 100).toFixed(0)}%)` : `NO (${(urgency * 100).toFixed(2)}% < ${(config.inventoryThreshold * 100).toFixed(0)}%)`,
      panicTriggered: urgency >= config.panicThreshold ? `YES (${(urgency * 100).toFixed(2)}% >= ${(config.panicThreshold * 100).toFixed(0)}%)` : `NO (${(urgency * 100).toFixed(2)}% < ${(config.panicThreshold * 100).toFixed(0)}%)`,
      formula: 'urgency = min(1, max(positionUrgency, timeUrgency))',
    });

    // ========================================
    // TRACE-level: Mode determination logic
    // ========================================
    this.logger.trace('[RiskAssessment] Mode determination', {
      ...this.getMarketInfo(),
      edgeAlive: edgeEval.alive,
      edgeIrreversible: edgeEval.irreversible,
      edgeReason: edgeEval.reason,
      hasPosition,
      urgency: (urgency * 100).toFixed(2) + '%',
      modeDecision: this.getModeDecisionTrace(edgeEval, urgency, hasPosition, config),
      finalMode: mode,
      finalStatus: status,
    });

    // ========================================
    // Debug Log
    // ========================================
    this.logger.debug('[RiskAssessment] Full assessment', {
      ...this.getMarketInfo(),
      mode,
      status,
      urgency: (urgency * 100).toFixed(1) + '%',
      edgeAlive: edgeEval.alive,
      edgeReason: edgeEval.reason,
      fragilityScore: tradeFlowMetrics.fragilityScore.toFixed(4),
      marketState: tradeFlowMetrics.state,
      refillRate: orderbookMetrics.refillRates.relative.toFixed(4),
      netPosition: netPosition.toFixed(2),
      hasPosition,
    });

    return {
      status,
      mode,
      urgency: Percentage.fromNumber(Math.min(100, urgency * 100)),
      netPositionUtilization: Percentage.fromNumber(Math.min(100, netUtilization * 100)),
      grossPositionUtilization: Percentage.fromNumber(Math.min(100, grossUtilization * 100)),
      secondsToExpiry,
      timeToExpiry: this.formatTimeToExpiry(secondsToExpiry),
      marketQuestion: market.question,
      marketUrl: market.marketUrl || '',
      recommendations,

      // Edge alive metrics
      edgeAlive: edgeEval.alive,
      edgeWarning: edgeEval.warning,
      edgeIrreversible: edgeEval.irreversible,
      edgeReason: edgeEval.reason,

      // Trade flow metrics
      fragilityScore: tradeFlowMetrics.fragilityScore,
      marketState: tradeFlowMetrics.state,
      tradeImbalance: tradeFlowMetrics.tradeImbalance,
      bookImbalance: tradeFlowMetrics.bookImbalance,
      marketPressureScore: tradeFlowMetrics.marketPressureScore,

      // Orderbook health metrics
      refillRate: orderbookMetrics.refillRates.relative,
      isThinning: orderbookMetrics.isThinning,

      // Position info
      netPosition,
      hasPosition,
    };
  }

  /**
   * Resets state for new market
   *
   * @remarks
   * Call when switching to a new market.
   * Resets all internal state of signal components.
   *
   * @example
   * ```typescript
   * service.resetForNewMarket();
   * ```
   */
  public resetForNewMarket(): void {
    this.tradeFlowAnalyzer.reset();
    this.orderbookHealthMonitor.reset();
    this.edgeAliveEvaluator.reset();
    this.previousMode = null;
    this.lastSummaryTimestamp = 0;

    this.logger.info('[RiskAssessment] State reset for new market', {
      ...this.getMarketInfo(),
    });
  }

  /**
   * Calculates urgency percentage (convenience method)
   *
   * @param session - Trading session
   * @param market - Market information
   * @returns Urgency percentage (0-100%)
   */
  public calculateUrgency(session: TradingSession, market: Market): Percentage {
    const config = ConfigLoader.getInstance().getRiskConfig();
    const assessment = this.assess(session, market, config);
    return assessment.urgency;
  }

  /**
   * Gets current trade flow metrics
   */
  public getTradeFlowMetrics(): TradeFlowMetrics {
    return this.tradeFlowAnalyzer.getMarketState();
  }

  /**
   * Gets current edge state
   */
  public getEdgeState(): ReturnType<EdgeAliveEvaluator['getState']> {
    return this.edgeAliveEvaluator.getState();
  }

  // ========================================
  // Private Methods
  // ========================================

  /**
   * Determines status and mode based on all factors
   */
  private determineStatusAndMode(
    edgeEval: EdgeEvaluation,
    urgency: number,
    hasPosition: boolean,
    config: RiskConfig
  ): { status: RiskStatus; mode: TradingMode } {
    // Priority 1: Edge dead
    if (!edgeEval.alive && edgeEval.irreversible) {
      if (hasPosition) {
        // Must close position even though edge is dead
        return { status: 'DEAD', mode: 'RECOVERY' };
      }
      return { status: 'DEAD', mode: 'DEAD' };
    }

    // Priority 2: Edge warning (dead but may recover)
    if (!edgeEval.alive && !edgeEval.irreversible) {
      // In warning state, continue with current mode but be cautious
      if (urgency >= config.panicThreshold) {
        return { status: 'PANIC', mode: 'PANIC' };
      }
      if (urgency >= config.inventoryThreshold || hasPosition) {
        return { status: 'WARNING', mode: 'INVENTORY' };
      }
      return { status: 'WARNING', mode: 'FLAT' };
    }

    // Priority 3: Panic threshold
    if (urgency >= config.panicThreshold) {
      return { status: 'PANIC', mode: 'PANIC' };
    }

    // Priority 4: Inventory threshold
    if (urgency >= config.inventoryThreshold) {
      return { status: 'WARNING', mode: 'INVENTORY' };
    }

    // Priority 5: Normal trading
    if (hasPosition) {
      return { status: 'NORMAL', mode: 'QUOTE' };
    }

    return { status: 'NORMAL', mode: 'FLAT' };
  }

  /**
   * Generates recommendations based on current state
   */
  private generateRecommendations(
    edgeEval: EdgeEvaluation,
    netUtilization: number,
    grossUtilization: number,
    timeUrgency: number,
    mode: TradingMode,
    absNetPosition: number,
    grossPosition: number,
    secondsToExpiry: number,
    config: RiskConfig
  ): string[] {
    const recommendations: string[] = [];

    // Edge recommendations
    if (!edgeEval.alive) {
      if (edgeEval.irreversible) {
        recommendations.push(`EDGE DEAD: ${edgeEval.reason} - stop trading`);
      } else {
        recommendations.push(`EDGE WARNING: ${edgeEval.reason} - monitoring for recovery`);
      }
    }

    // Position recommendations
    if (netUtilization > config.inventoryThreshold) {
      recommendations.push(
        `Reduce net position (current: ${absNetPosition.toFixed(0)}, limit: ${config.maxNetPosition})`
      );
    }

    if (grossUtilization > config.inventoryThreshold) {
      recommendations.push(
        `Reduce gross position (current: ${grossPosition.toFixed(0)}, limit: ${config.maxGrossPosition})`
      );
    }

    // Time recommendations
    if (timeUrgency > 0.5) {
      recommendations.push(
        `Market expires soon (${secondsToExpiry.toFixed(0)} seconds remaining)`
      );
    }

    // Mode-specific recommendations
    switch (mode) {
      case 'DEAD':
        recommendations.push('DEAD MODE: Edge is dead, no new quotes');
        break;
      case 'PANIC':
        recommendations.push('PANIC MODE: Close positions aggressively');
        break;
      case 'RECOVERY':
        recommendations.push('RECOVERY MODE: Active position closing');
        break;
      case 'INVENTORY':
        recommendations.push('INVENTORY MODE: Skew quotes to reduce position');
        break;
    }

    return recommendations;
  }

  /**
   * Gets time to expiry in minutes
   */
  private getTimeToExpiryMinutes(market: Market): number {
    const now = Date.now();
    const expiry = market.expirationDate.getTime();
    return (expiry - now) / 60000;
  }

  /**
   * Formats time to expiry in human-readable format
   */
  private formatTimeToExpiry(secondsToExpiry: number): string {
    const totalSeconds = Math.max(0, Math.floor(secondsToExpiry));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}h${minutes}m`;
    } else if (minutes > 0) {
      return `${minutes}m${seconds}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Logs mode transition
   */
  private logModeTransition(
    from: TradingMode,
    to: TradingMode,
    edgeEval: EdgeEvaluation,
    tradeFlowMetrics: TradeFlowMetrics
  ): void {
    const level = to === 'PANIC' || to === 'DEAD' ? 'warn' : 'info';

    this.logger[level]('[RiskAssessment] Mode change', {
      ...this.getMarketInfo(),
      from,
      to,
      edgeAlive: edgeEval.alive,
      edgeReason: edgeEval.reason,
      fragilityScore: tradeFlowMetrics.fragilityScore.toFixed(4),
      marketState: tradeFlowMetrics.state,
    });
  }

  /**
   * Logs periodic summary
   */
  private logSummary(
    mode: TradingMode,
    edgeEval: EdgeEvaluation,
    tradeFlowMetrics: TradeFlowMetrics,
    orderbookMetrics: ReturnType<OrderbookHealthMonitor['getMetrics']>,
    urgency: number,
    hasPosition: boolean
  ): void {
    this.logger.info('[RiskAssessment] Summary', {
      ...this.getMarketInfo(),
      mode,
      urgency: (urgency * 100).toFixed(1) + '%',
      edgeAlive: edgeEval.alive,
      edgeReason: edgeEval.reason,
      fragilityScore: tradeFlowMetrics.fragilityScore.toFixed(4),
      marketState: tradeFlowMetrics.state,
      tradeImbalance: tradeFlowMetrics.tradeImbalance.toFixed(4),
      bookImbalance: tradeFlowMetrics.bookImbalance.toFixed(4),
      refillRate: orderbookMetrics.refillRates.relative.toFixed(4),
      isThinning: orderbookMetrics.isThinning,
      hasPosition,
    });
  }

  /**
   * Generates trace string for mode decision logic
   */
  private getModeDecisionTrace(
    edgeEval: EdgeEvaluation,
    urgency: number,
    hasPosition: boolean,
    config: RiskConfig
  ): string {
    // Priority 1: Edge dead + irreversible
    if (!edgeEval.alive && edgeEval.irreversible) {
      if (hasPosition) {
        return 'Edge DEAD (irreversible) + hasPosition → RECOVERY';
      }
      return 'Edge DEAD (irreversible) + no position → DEAD';
    }

    // Priority 2: Edge warning (dead but may recover)
    if (!edgeEval.alive && !edgeEval.irreversible) {
      if (urgency >= config.panicThreshold) {
        return `Edge WARNING + urgency ${(urgency * 100).toFixed(0)}% >= panicThreshold ${(config.panicThreshold * 100).toFixed(0)}% → PANIC`;
      }
      if (urgency >= config.inventoryThreshold || hasPosition) {
        return `Edge WARNING + (urgency ${(urgency * 100).toFixed(0)}% >= inventoryThreshold ${(config.inventoryThreshold * 100).toFixed(0)}% OR hasPosition) → INVENTORY`;
      }
      return 'Edge WARNING + no urgency + no position → FLAT';
    }

    // Priority 3: Panic threshold
    if (urgency >= config.panicThreshold) {
      return `Edge ALIVE + urgency ${(urgency * 100).toFixed(0)}% >= panicThreshold ${(config.panicThreshold * 100).toFixed(0)}% → PANIC`;
    }

    // Priority 4: Inventory threshold
    if (urgency >= config.inventoryThreshold) {
      return `Edge ALIVE + urgency ${(urgency * 100).toFixed(0)}% >= inventoryThreshold ${(config.inventoryThreshold * 100).toFixed(0)}% → INVENTORY`;
    }

    // Priority 5: Normal trading
    if (hasPosition) {
      return 'Edge ALIVE + hasPosition → QUOTE';
    }

    return 'Edge ALIVE + no position → FLAT';
  }
}
