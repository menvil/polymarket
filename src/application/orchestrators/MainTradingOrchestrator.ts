/**
 * Main Trading Orchestrator - основной координатор торговой логики
 *
 * @remarks
 * Главный orchestrator который координирует весь trading flow:
 * - Инициализация TradingSession
 * - Подписка на market data (orderbook, trades)
 * - Генерация quotes через strategy
 * - Размещение/отмена ордеров
 * - Обработка order fills
 * - Мониторинг риска
 * - Управление trading modes (QUOTE→SKEW→UNWIND→PANIC)
 *
 * Алгоритм основного loop:
 * 1. Получить orderbook update
 * 2. Оценить текущий риск (RiskAssessmentService)
 * 3. Определить trading mode на основе риска
 * 4. Если mode = PAUSED → пропустить
 * 5. Если mode = PANIC → unwind позиции
 * 6. Если mode = UNWIND → агрессивно закрывать позиции
 * 7. Если mode = SKEW → применить inventory adjustments
 * 8. Если mode = QUOTE → нормальный market making
 * 9. Генерировать quotes через strategy
 * 10. Отменить старые orders
 * 11. Разместить новые orders
 * 12. Обработать order fills → обновить session
 *
 * @example
 * ```typescript
 * const orchestrator = new MainTradingOrchestrator({
 *   exchangeAdapter,
 *   marketDataFeed,
 *   orderRepository,
 *   strategy,
 *   logger
 * });
 *
 * // Инициализация
 * await orchestrator.initialize(market, initialBalance);
 *
 * // Запуск
 * await orchestrator.start();
 *
 * // Остановка
 * await orchestrator.stop();
 * ```
 */

import { TradingSession } from '../../domain/aggregates/TradingSession.js';
import { Market, OutcomeIndex } from '../../domain/entities/Market.js';
import { Orderbook } from '../../domain/entities/Orderbook.js';
import { Order } from '../../domain/entities/Order.js';
import { Trade } from '../../domain/entities/Trade.js';
import { Money } from '../../domain/value-objects/Money.js';
import { IExchangeAdapter } from '../../domain/ports/IExchangeAdapter.js';
import { IMarketDataFeed } from '../../domain/ports/IMarketDataFeed.js';
import { IOrderRepository } from '../../domain/ports/IOrderRepository.js';
import { ILogger } from '../../domain/ports/ILogger.js';
import { TwoSidedMarketMaker } from '../../domain/strategies/TwoSidedMarketMaker.js';
import {
  RiskAssessmentService,
  RiskConfig,
  RiskAssessment,
  TradingMode,
  TradeRecord,
} from '../../domain/services/risk/RiskAssessmentService.js';
import type { MarketContext } from '../../domain/services/signals/types.js';
import { ArbitrageDetector } from '../../domain/services/pricing/ArbitrageDetector.js';
import { Percentage } from '../../domain/value-objects/Percentage.js';
import { ConfigLoader } from '../../infrastructure/config/ConfigLoader.js';
import { OrderFilledEvent } from '../../domain/events/OrderFilledEvent.js';
import { PlaceOrderCommand, PlaceOrderHandler } from '../commands/PlaceOrderCommand.js';
import { CancelOrderCommand, CancelOrderHandler } from '../commands/CancelOrderCommand.js';
import { ReconcilePortfolioCommand, ReconcilePortfolioHandler } from '../commands/ReconcilePortfolioCommand.js';

/**
 * Конфигурация MainTradingOrchestrator
 */
export interface OrchestratorConfig {
  /** Exchange adapter для размещения ордеров */
  exchangeAdapter: IExchangeAdapter;

  /** Market data feed для получения orderbook/trades */
  marketDataFeed: IMarketDataFeed;

  /** Order repository для хранения ордеров */
  orderRepository: IOrderRepository;

  /** Trading strategy */
  strategy: TwoSidedMarketMaker;

  /** Logger */
  logger: ILogger;

  /** Risk config */
  riskConfig?: RiskConfig;

  /** Интервал обновления quotes (мс) */
  quoteUpdateInterval?: number;

  /** Включить throttling для orderbook updates */
  throttleOrderbookUpdates?: boolean;

  /** Throttle интервал для orderbook (мс) */
  orderbookThrottleMs?: number;

  /** Trading fee percentage for arbitrage detection (default: 0.2) */
  tradingFeePercent?: number;
}

/**
 * Callback for edge death notification
 *
 * @remarks
 * Called when EdgeAliveEvaluator determines edge is DEAD.
 * Allows external handlers (e.g., MarketRotationManager) to react.
 */
export type EdgeDeathCallback = (marketId: string, reason: string) => void;

/**
 * Структура для хранения ордербуков обоих токенов
 *
 * @remarks
 * Polymarket требует отдельных подписок на YES и NO токены.
 * Храним оба ордербука и агрегируем их при необходимости.
 */
interface OutcomeOrderbooks {
  /** Orderbooks по индексу outcome [0] и [1] */
  books: [Orderbook | null, Orderbook | null];
  /** Timestamps последнего обновления по индексу [0] и [1] */
  lastUpdate: [number, number];
}

/**
 * Main Trading Orchestrator
 *
 * @remarks
 * Координирует весь trading flow.
 * Single point of control для всей торговой логики.
 *
 * ВАЖНО: Polymarket использует два отдельных токена (YES и NO) для каждого рынка.
 * Orchestrator подписывается на оба токена и агрегирует данные.
 */
export class MainTradingOrchestrator {
  private session: TradingSession | null = null;
  private market: Market | null = null;
  private orderbooks: OutcomeOrderbooks = {
    books: [null, null],
    lastUpdate: [0, 0],
  };
  private recentTrades: Trade[] = [];
  private readonly maxRecentTrades = 100;
  private tradingMode: TradingMode = 'FLAT';
  private isRunning = false;
  private updateTimer: NodeJS.Timeout | null = null;
  private activeOrderIds: Set<string> = new Set();
  private lastQuoteUpdate = 0;

  /**
   * Activity metrics for monitoring (counts per minute)
   *
   * @remarks
   * Tracks trades, orderbook updates, and quote updates per minute.
   * Reset every minute for accurate per-minute rates.
   */
  private metrics = {
    tradesCount: 0,
    orderbookUpdatesCount: 0,
    quotesUpdatesCount: 0,
    lastResetTime: Date.now(),
    // Per-minute rates (calculated on demand)
    tradesPerMinute: 0,
    orderbookUpdatesPerMinute: 0,
    quotesUpdatesPerMinute: 0,
  };

  /** Risk assessment services per outcome [0] and [1] */
  private readonly riskAssessmentServices: [RiskAssessmentService, RiskAssessmentService];
  private readonly arbitrageDetector: ArbitrageDetector;
  private readonly tradingFees: Percentage;
  private readonly logger: ILogger;

  /** Last risk assessments per outcome [0] and [1] */
  private lastRiskAssessments: [RiskAssessment | null, RiskAssessment | null] = [null, null];

  /** Callback when edge dies (DEAD mode) */
  private onEdgeDeath: EdgeDeathCallback | null = null;

  /** Flag to prevent duplicate DEAD notifications */
  private edgeDeathNotified = false;

  // Command handlers
  private readonly placeOrderHandler: PlaceOrderHandler;
  private readonly cancelOrderHandler: CancelOrderHandler;
  private readonly reconcileHandler: ReconcilePortfolioHandler;

  /**
   * Создаёт новый MainTradingOrchestrator
   *
   * @param config - Конфигурация orchestrator
   *
   * @remarks
   * Initializes RiskAssessmentService with proper configs from ConfigLoader:
   * - EdgeAlive config (thresholds, streaks, warmup)
   * - TradeFlow config (fragility, decay)
   * - OrderbookHealth config (min depth, EMA alpha)
   */
  constructor(private readonly config: OrchestratorConfig) {
    this.logger = config.logger.child ? config.logger.child('Orchestrator') : config.logger;

    // Load signal configs from ConfigLoader
    const configLoader = ConfigLoader.getInstance();
    const edgeConfig = configLoader.getEdgeAliveConfig();
    const tradeFlowConfig = configLoader.getTradeFlowConfig();
    const orderbookHealthConfig = configLoader.getOrderbookHealthConfig();

    // Initialize RiskAssessmentServices per outcome [0] and [1]
    this.riskAssessmentServices = [
      new RiskAssessmentService(config.logger, edgeConfig, tradeFlowConfig, orderbookHealthConfig),
      new RiskAssessmentService(config.logger, edgeConfig, tradeFlowConfig, orderbookHealthConfig),
    ];

    this.arbitrageDetector = new ArbitrageDetector();
    // Trading fees from config (default: 0.2%)
    this.tradingFees = Percentage.fromNumber(config.tradingFeePercent ?? 0.2);

    // Initialize command handlers
    const isSimulation = configLoader.isSimulationMode();
    this.placeOrderHandler = new PlaceOrderHandler(
      config.orderRepository,
      config.exchangeAdapter,
      this.logger,
      isSimulation
    );
    this.cancelOrderHandler = new CancelOrderHandler(
      config.orderRepository,
      config.exchangeAdapter,
      this.logger,
      isSimulation
    );
    this.reconcileHandler = new ReconcilePortfolioHandler(
      config.orderRepository,
      config.exchangeAdapter,
      this.logger
    );
  }

  /**
   * Sets callback for edge death notification
   *
   * @param callback - Function to call when edge dies
   *
   * @remarks
   * The callback receives marketId and reason string.
   * Used by MarketRotationManager to switch to a new market.
   *
   * @example
   * ```typescript
   * orchestrator.setOnEdgeDeath((marketId, reason) => {
   *   logger.warn(`Edge died for ${marketId}: ${reason}`);
   *   rotationManager.rotateToNextMarket();
   * });
   * ```
   */
  public setOnEdgeDeath(callback: EdgeDeathCallback): void {
    this.onEdgeDeath = callback;
  }

  /**
   * Updates per-minute rates and resets counters if a minute has passed
   *
   * @remarks
   * Call this method before reading metrics to ensure accurate per-minute rates.
   * Automatically resets counters every minute.
   */
  private updateMetricRates(): void {
    const now = Date.now();
    const elapsed = now - this.metrics.lastResetTime;
    const elapsedMinutes = elapsed / 60000;

    // Calculate per-minute rates
    if (elapsedMinutes > 0) {
      this.metrics.tradesPerMinute = Math.round(this.metrics.tradesCount / elapsedMinutes);
      this.metrics.orderbookUpdatesPerMinute = Math.round(this.metrics.orderbookUpdatesCount / elapsedMinutes);
      this.metrics.quotesUpdatesPerMinute = Math.round(this.metrics.quotesUpdatesCount / elapsedMinutes);
    }

    // Reset counters every minute
    if (elapsed >= 60000) {
      this.metrics.tradesCount = 0;
      this.metrics.orderbookUpdatesCount = 0;
      this.metrics.quotesUpdatesCount = 0;
      this.metrics.lastResetTime = now;
    }
  }

  /**
   * Gets current activity metrics
   *
   * @returns Metrics object with per-minute rates
   */
  public getMetrics(): {
    tradesPerMinute: number;
    orderbookUpdatesPerMinute: number;
    quotesUpdatesPerMinute: number;
  } {
    this.updateMetricRates();
    return {
      tradesPerMinute: this.metrics.tradesPerMinute,
      orderbookUpdatesPerMinute: this.metrics.orderbookUpdatesPerMinute,
      quotesUpdatesPerMinute: this.metrics.quotesUpdatesPerMinute,
    };
  }

  /**
   * Gets orderbook state metrics for both outcome tokens
   *
   * @returns Orderbook metrics for status logging
   *
   * @remarks
   * Includes for each outcome token:
   * - bestBid, bestAsk, midPrice (4 decimal places), spread (4 decimal places)
   * - bidDepth (number of bid levels), askDepth (number of ask levels)
   *
   * Uses ArbitrageDetector to detect arbitrage opportunities:
   * - SELL_BOTH: when (outcome0_bid + outcome1_bid) > 1.0 + fees
   * - BUY_BOTH: when (outcome0_ask + outcome1_ask) < 1.0 - fees
   */
  private getOrderbookMetrics(): {
    outcomes: [
      {
        bestBid: string | null;
        bestAsk: string | null;
        midPrice: string | null;
        spread: string | null;
        bidDepth: number;
        askDepth: number;
      } | null,
      {
        bestBid: string | null;
        bestAsk: string | null;
        midPrice: string | null;
        spread: string | null;
        bidDepth: number;
        askDepth: number;
      } | null
    ];
    arbitrage: {
      buyBothCost: string | null;
      sellBothRevenue: string | null;
      opportunity: {
        type: string;
        profitPercent: string;
        action: string;
      } | null;
    };
  } {
    const orderbook0 = this.orderbooks.books[0];
    const orderbook1 = this.orderbooks.books[1];

    const metrics0 = orderbook0 ? {
      bestBid: orderbook0.getBestBid()?.value.toFixed(4) ?? null,
      bestAsk: orderbook0.getBestAsk()?.value.toFixed(4) ?? null,
      midPrice: orderbook0.getMidPrice()?.value.toFixed(4) ?? null,
      spread: orderbook0.getSpread()?.width().toFixed(4) ?? null,
      bidDepth: orderbook0.getBidDepth(),
      askDepth: orderbook0.getAskDepth(),
    } : null;

    const metrics1 = orderbook1 ? {
      bestBid: orderbook1.getBestBid()?.value.toFixed(4) ?? null,
      bestAsk: orderbook1.getBestAsk()?.value.toFixed(4) ?? null,
      midPrice: orderbook1.getMidPrice()?.value.toFixed(4) ?? null,
      spread: orderbook1.getSpread()?.width().toFixed(4) ?? null,
      bidDepth: orderbook1.getBidDepth(),
      askDepth: orderbook1.getAskDepth(),
    } : null;

    // Calculate raw sums (always shown) - use raw numbers for calculation
    const ask0 = orderbook0?.getBestAsk()?.value ?? null;
    const ask1 = orderbook1?.getBestAsk()?.value ?? null;
    const bid0 = orderbook0?.getBestBid()?.value ?? null;
    const bid1 = orderbook1?.getBestBid()?.value ?? null;

    const buyBothCost = (ask0 !== null && ask1 !== null)
      ? (ask0 + ask1).toFixed(4)
      : null;
    const sellBothRevenue = (bid0 !== null && bid1 !== null)
      ? (bid0 + bid1).toFixed(4)
      : null;

    // Use ArbitrageDetector to detect opportunities (accounts for fees)
    let opportunity: { type: string; profitPercent: string; action: string } | null = null;
    if (orderbook0 && orderbook1) {
      const detected = this.arbitrageDetector.detect(orderbook0, orderbook1, this.tradingFees);
      if (detected) {
        opportunity = {
          type: detected.type,
          profitPercent: detected.profitPercent.toFixed(4),
          action: detected.action,
        };
      }
    }

    return {
      outcomes: [metrics0, metrics1],
      arbitrage: {
        buyBothCost,
        sellBothRevenue,
        opportunity,
      },
    };
  }

  /**
   * Инициализирует trading session
   *
   * @param market - Рынок для торговли
   * @param initialBalance - Начальный баланс USDC
   *
   * @remarks
   * Создаёт новую TradingSession и подготавливает к торговле.
   *
   * @example
   * ```typescript
   * await orchestrator.initialize(
   *   market,
   *   Money.fromUSDC(10000)
   * );
   * ```
   */
  public async initialize(market: Market, initialBalance: Money): Promise<void> {
    this.logger.info(`Initializing trading session for market: ${market.question}`);

    // Создаём TradingSession
    this.session = TradingSession.create(market, initialBalance);
    this.market = market;
    this.tradingMode = 'FLAT';

    // Сбрасываем orderbooks для нового маркета
    this.orderbooks = {
      books: [null, null],
      lastUpdate: [0, 0],
    };

    // Сбрасываем историю trades
    this.recentTrades = [];

    // Сбрасываем метрики активности
    this.metrics = {
      tradesCount: 0,
      orderbookUpdatesCount: 0,
      quotesUpdatesCount: 0,
      lastResetTime: Date.now(),
      tradesPerMinute: 0,
      orderbookUpdatesPerMinute: 0,
      quotesUpdatesPerMinute: 0,
    };

    // Reset RiskAssessmentService state for new market (both outcomes)
    this.riskAssessmentServices[0].resetForNewMarket();
    this.riskAssessmentServices[1].resetForNewMarket();
    this.lastRiskAssessments = [null, null];
    this.edgeDeathNotified = false;

    // Set market context for outcome 0
    const marketSlug = this.generateMarketSlug(market.question);
    const context0: MarketContext = {
      marketId: market.id,
      tokenId: market.outcomes[0].tokenId,
      outcomeName: market.outcomes[0].name,
      marketSlug,
      question: market.question,
      expirationDate: market.expirationDate,
      marketUrl: market.marketUrl ?? undefined,
    };
    this.riskAssessmentServices[0].setMarketContext(context0);

    // Set market context for outcome 1
    const context1: MarketContext = {
      marketId: market.id,
      tokenId: market.outcomes[1].tokenId,
      outcomeName: market.outcomes[1].name,
      marketSlug,
      question: market.question,
      expirationDate: market.expirationDate,
      marketUrl: market.marketUrl ?? undefined,
    };
    this.riskAssessmentServices[1].setMarketContext(context1);

    // NOTE: НЕ получаем snapshot через getOrderbook!
    // Ордербук придёт через WebSocket подписку в start()
    this.logger.info('Trading session initialized (orderbook will come via WebSocket)');
  }

  /**
   * Запускает trading orchestrator
   *
   * @remarks
   * Алгоритм:
   * 1. Подписывается на orderbook updates
   * 2. Подписывается на order fills
   * 3. Запускает periodic quote update loop
   *
   * @example
   * ```typescript
   * await orchestrator.start();
   * console.log('Orchestrator started');
   * ```
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Orchestrator already running');
      return;
    }

    if (!this.session || !this.market) {
      throw new Error('Must initialize before starting');
    }

    // Логируем режим работы
    const isSimulation = ConfigLoader.getInstance().isSimulationMode();
    if (isSimulation) {
      this.logger.info('========================================');
      this.logger.info('  SIMULATION MODE - No real orders!');
      this.logger.info('========================================');
    } else {
      this.logger.info('========================================');
      this.logger.info('  LIVE MODE - Real orders will be placed!');
      this.logger.info('========================================');
    }

    this.logger.info('Starting trading orchestrator');
    this.isRunning = true;

    // Подписываемся на orderbook updates для обоих токенов
    // NOTE: Polymarket WebSocket требует подписку по token IDs, а не market ID
    const token0 = this.market.outcomes[0];
    const token1 = this.market.outcomes[1];
    this.logger.info(`Subscribing to orderbook for tokens: ${token0.name}=${token0.tokenId.substring(0, 16)}..., ${token1.name}=${token1.tokenId.substring(0, 16)}...`);

    // Сначала устанавливаем callbacks для каждого токена
    this.config.marketDataFeed.subscribeToOrderbook(token0.tokenId, (orderbook) => {
      this.handleOrderbookUpdate(orderbook);
    });

    this.config.marketDataFeed.subscribeToOrderbook(token1.tokenId, (orderbook) => {
      this.handleOrderbookUpdate(orderbook);
    });

    // Подписываемся на trades (для анализа и хранения истории)
    this.config.marketDataFeed.subscribeToTrades(token0.tokenId, (trade) => {
      this.handleTradeUpdate(trade, 0);
    });

    this.config.marketDataFeed.subscribeToTrades(token1.tokenId, (trade) => {
      this.handleTradeUpdate(trade, 1);
    });

    // ВАЖНО: Теперь отправляем подписку на WebSocket для ОБОИХ токенов одновременно
    // @ts-ignore - метод subscribeToMarket доступен в PolymarketWsAdapter
    if (typeof this.config.marketDataFeed.subscribeToMarket === 'function') {
      // @ts-ignore
      await this.config.marketDataFeed.subscribeToMarket(token0.tokenId, token1.tokenId);
    }

    // Запускаем periodic update loop
    this.startUpdateLoop();

    this.logger.info('Trading orchestrator started');
  }

  /**
   * Останавливает trading orchestrator
   *
   * @remarks
   * Алгоритм:
   * 1. Останавливает update loop
   * 2. Отменяет все активные ордера
   * 3. Отписывается от market data
   *
   * @example
   * ```typescript
   * await orchestrator.stop();
   * console.log('Orchestrator stopped');
   * ```
   */
  public async stop(): Promise<void> {
    if (!this.isRunning) {
      this.logger.warn('Orchestrator not running');
      return;
    }

    this.logger.info('Stopping trading orchestrator');
    this.isRunning = false;

    // Останавливаем update loop
    this.stopUpdateLoop();

    // Отменяем все активные ордера
    await this.cancelAllOrders();

    // Отписываемся от market data используя правильный Polymarket API
    if (this.market) {
      const t0 = this.market.outcomes[0];
      const t1 = this.market.outcomes[1];
      this.logger.info(`Unsubscribing from market: ${t0.name}=${t0.tokenId.substring(0, 16)}..., ${t1.name}=${t1.tokenId.substring(0, 16)}...`);

      // @ts-ignore - метод unsubscribeFromMarket доступен в PolymarketWsAdapter
      if (typeof this.config.marketDataFeed.unsubscribeFromMarket === 'function') {
        try {
          // @ts-ignore
          await this.config.marketDataFeed.unsubscribeFromMarket(t0.tokenId, t1.tokenId);
          this.logger.info('Successfully unsubscribed from market');
        } catch (error) {
          this.logger.warn('Failed to unsubscribe from market', { error });
        }
      } else {
        this.logger.debug('unsubscribeFromMarket not available, skipping WebSocket unsubscribe');
      }
    }

    this.logger.info('Trading orchestrator stopped');
  }

  /**
   * Обрабатывает orderbook update
   *
   * @param orderbook - Обновлённый orderbook
   *
   * @remarks
   * Определяет токен (YES или NO), сохраняет orderbook и триггерит quote update.
   *
   * Алгоритм:
   * 1. Определить токен по orderbook.id (YES или NO)
   * 2. Сохранить в соответствующее поле (yes или no)
   * 3. Обновить timestamp
   * 4. Логировать обновление
   * 5. Если throttling включен - проверить интервал
   * 6. Триггерить quote update
   *
   * @throws {Error} Если токен не распознан
   */
  private handleOrderbookUpdate(orderbook: Orderbook): void {
    if (!this.market) {
      return;
    }

    // Определяем какой outcome (0 или 1) по orderbook marketId
    const outcomeIndex = this.identifyToken(orderbook.marketId);
    const now = Date.now();

    if (outcomeIndex === null) {
      this.logger.warn(`Unknown token in orderbook update: ${orderbook.marketId}`);
      return;
    }

    // Update orderbook and timestamp for this outcome
    this.orderbooks.books[outcomeIndex] = orderbook;
    this.orderbooks.lastUpdate[outcomeIndex] = now;

    // Record orderbook in RiskAssessmentService for this outcome
    this.riskAssessmentServices[outcomeIndex].recordOrderbook(orderbook);

    // Increment orderbook update counter
    this.metrics.orderbookUpdatesCount++;

    // Trace: выводим обновление ордербука с полной информацией (moved from debug)
    const bestBid = orderbook.getBestBid();
    const bestAsk = orderbook.getBestAsk();
    const midPrice = orderbook.getMidPrice();
    const spread = orderbook.getSpread();
    const bidCount = orderbook.getBidDepth();
    const askCount = orderbook.getAskDepth();
    const tokenInfo = this.getTokenLogInfo(outcomeIndex);
    const marketSuffix = this.getMarketLogSuffix();

    this.logger.trace(`Orderbook ${tokenInfo}: bid=${bestBid?.value.toFixed(4)} ask=${bestAsk?.value.toFixed(4)} mid=${midPrice?.value.toFixed(4)} spread=${spread?.width().toFixed(4)} bids=${bidCount} asks=${askCount} ${marketSuffix}`);

    // Проверяем что получены оба ордербука
    if (!this.hasBothOrderbooks()) {
      this.logger.debug('Waiting for both orderbooks (both outcomes)');
      return;
    }

    // Throttling: не обновляем quotes слишком часто
    const throttleMs = this.config.orderbookThrottleMs ?? 1000;
    const timeSinceLastUpdate = now - this.lastQuoteUpdate;

    if (this.config.throttleOrderbookUpdates && timeSinceLastUpdate < throttleMs) {
      return;
    }

    this.lastQuoteUpdate = now;

    // Триггерим quote update (async без await чтобы не блокировать)
    this.updateQuotes().catch((error) => {
      this.logger.error('Failed to update quotes', error);
    });
  }

  /**
   * Обрабатывает trade update
   *
   * @param trade - Новый трейд
   * @param tokenType - Тип токена ('YES' или 'NO')
   *
   * @remarks
   * Сохраняет trade в историю, записывает в RiskAssessmentService и логирует.
   *
   * Алгоритм:
   * 1. Добавить trade в recentTrades
   * 2. Если превышен лимит - удалить старые trades
   * 3. Записать trade в RiskAssessmentService для TradeFlowAnalyzer
   * 4. Логировать trade
   */
  private handleTradeUpdate(trade: Trade, outcomeIndex: OutcomeIndex): void {
    // Increment trade counter
    this.metrics.tradesCount++;

    // Добавляем trade в историю
    this.recentTrades.push(trade);

    // Ограничиваем размер массива
    if (this.recentTrades.length > this.maxRecentTrades) {
      this.recentTrades.shift();
    }

    // Record trade in RiskAssessmentService for TradeFlowAnalyzer
    // Route to correct service based on outcome index
    const orderbook = this.orderbooks.books[outcomeIndex];
    const riskService = this.riskAssessmentServices[outcomeIndex];

    if (orderbook) {
      const bestBid = orderbook.getBestBid()?.value ?? 0;
      const bestAsk = orderbook.getBestAsk()?.value ?? 1;

      const tradeRecord: TradeRecord = {
        price: trade.price.value,
        size: trade.quantity.value,
        bestBid,
        bestAsk,
        timestamp: trade.timestamp.getTime(),
      };

      riskService.recordTrade(tradeRecord);
    }

    // Trace: логируем trade с полной информацией (moved from debug)
    const tokenInfo = this.getTokenLogInfo(outcomeIndex);
    const marketSuffix = this.getMarketLogSuffix();
    this.logger.trace(`Trade ${tokenInfo}: ${trade.side} ${trade.quantity.value} @ ${trade.price.value.toFixed(4)} ${marketSuffix}`);
  }

  /**
   * Определяет индекс outcome по token ID
   *
   * @param tokenId - ID токена из orderbook
   * @returns 0, 1 или null если не распознан
   *
   * @remarks
   * Сравнивает tokenId с outcomes[0].tokenId и outcomes[1].tokenId.
   */
  private identifyToken(tokenId: string): OutcomeIndex | null {
    if (!this.market) {
      return null;
    }

    return this.market.getOutcomeIndexByTokenId(tokenId);
  }

  /**
   * Проверяет, что получены оба ордербука (YES и NO)
   *
   * @returns true если оба ордербука присутствуют
   *
   * @remarks
   * Необходимо для полной картины рынка.
   */
  private hasBothOrderbooks(): boolean {
    return this.orderbooks.books[0] !== null && this.orderbooks.books[1] !== null;
  }

  /**
   * Возвращает суффикс маркета для логов (название + ID + URL)
   *
   * @returns Строка формата: "| Market Name (conditionId...) | URL"
   *
   * @remarks
   * Генерирует идентификацию маркета для размещения в конце лога:
   * - Полное название маркета
   * - Сокращённый conditionId (первые 10 символов)
   * - Ссылка на маркет
   *
   * @example
   * ```
   * "| Ethereum Up or Down - Dec 29 (0x1234abcd...) | https://polymarket.com/event/ethereum-up-or-down"
   * ```
   */
  private getMarketLogSuffix(): string {
    if (!this.market) {
      return '| Unknown Market';
    }
    const shortId = this.market.id.substring(0, 10) + '...';
    const marketUrl = this.market.marketUrl || `https://polymarket.com/event/${this.market.id}`;
    return `| ${this.market.question} (${shortId}) | ${marketUrl}`;
  }

  /**
   * Возвращает информацию о токене для логов
   *
   * @param tokenType - Тип токена ('YES' или 'NO')
   * @returns Строка формата: "(YES / tokenId...)"
   *
   * @remarks
   * Генерирует идентификацию токена для логов.
   *
   * @example
   * ```
   * "(YES / 71321045...)"
   * ```
   */
  private getTokenLogInfo(outcomeIndex: OutcomeIndex): string {
    if (!this.market) {
      return `(outcome ${outcomeIndex})`;
    }
    const outcome = this.market.outcomes[outcomeIndex];
    const shortTokenId = outcome.tokenId.substring(0, 10) + '...';
    return `(${outcome.name} / ${shortTokenId})`;
  }

  /**
   * Генерирует короткий slug из названия маркета
   *
   * @param question - Полное название маркета
   * @returns Короткий slug для логов (например, "btc-up-down")
   *
   * @remarks
   * Алгоритм:
   * 1. Извлекает ключевые слова (убирает общие слова)
   * 2. Приводит к lowercase
   * 3. Заменяет пробелы на дефисы
   * 4. Ограничивает длину до 20 символов
   *
   * @example
   * ```
   * "Bitcoin Up or Down - Dec 29" → "btc-up-down"
   * "Ethereum price above $4000" → "eth-price-4000"
   * ```
   */
  private generateMarketSlug(question: string): string {
    // Удаляем даты (Dec 29, January 15, etc.)
    let slug = question.replace(/\s*[-–]\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s*\d+/gi, '');

    // Удаляем общие слова
    const stopWords = ['the', 'a', 'an', 'or', 'and', 'to', 'be', 'will', 'on', 'at', 'by', 'for', 'of'];
    slug = slug.split(/\s+/)
      .filter(word => !stopWords.includes(word.toLowerCase()))
      .join(' ');

    // Заменяем криптовалюты на короткие названия
    const cryptoMap: Record<string, string> = {
      'bitcoin': 'btc',
      'ethereum': 'eth',
      'solana': 'sol',
      'cardano': 'ada',
      'dogecoin': 'doge',
      'ripple': 'xrp',
    };

    for (const [full, short] of Object.entries(cryptoMap)) {
      slug = slug.replace(new RegExp(full, 'gi'), short);
    }

    // Приводим к lowercase и заменяем пробелы/спецсимволы на дефисы
    slug = slug.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')  // Удаляем дефисы в начале и конце
      .replace(/-+/g, '-');     // Удаляем множественные дефисы

    // Ограничиваем длину
    if (slug.length > 20) {
      slug = slug.substring(0, 20).replace(/-+$/, '');
    }

    return slug || 'market';
  }

  /**
   * Возвращает агрегированный orderbook для YES токена
   *
   * @returns Orderbook для YES токена или null если не доступен
   *
   * @remarks
   * В Polymarket используется YES токен как основной для стратегии.
   * NO токен используется для анализа и проверки.
   *
   * Можно расширить для полной агрегации orderbooks обоих outcomes,
   * но для начального market making достаточно outcome 0 orderbook.
   */
  private getAggregatedOrderbook(): Orderbook | null {
    return this.orderbooks.books[0];
  }

  /**
   * Возвращает последние N trades
   *
   * @param limit - Максимальное количество trades
   * @returns Массив последних trades
   *
   * @example
   * ```typescript
   * const recentTrades = orchestrator.getRecentTrades(10);
   * console.log(`Last ${recentTrades.length} trades`);
   * ```
   */
  public getRecentTrades(limit?: number): Trade[] {
    const actualLimit = limit ?? this.maxRecentTrades;
    return this.recentTrades.slice(-actualLimit);
  }

  /**
   * Запускает periodic update loop
   */
  private startUpdateLoop(): void {
    const interval = this.config.quoteUpdateInterval ?? 5000; // 5 секунд по умолчанию

    this.updateTimer = setInterval(() => {
      this.updateQuotes().catch((error) => {
        this.logger.error('Error in update loop', error);
      });
    }, interval);
  }

  /**
   * Останавливает periodic update loop
   */
  private stopUpdateLoop(): void {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
  }

  /**
   * Обновляет quotes (главная логика с 4-layer decision system)
   *
   * @remarks
   * Алгоритм (4-Layer Decision System):
   * 1. Проверить наличие обоих ордербуков (YES и NO)
   * 2. Получить агрегированный orderbook
   * 3. **Layer 0**: Оценить риск через RiskAssessmentService
   *    - EdgeAliveEvaluator → edge status (ALIVE/WARNING/DEAD)
   *    - TradeFlowAnalyzer → fragility, market state
   *    - OrderbookHealthMonitor → refill rate, thinning
   * 4. **Layer 1**: Получить recommendedMode из riskAssessment
   * 5. **Layer 2**: Handle mode-specific logic:
   *    - DEAD → cancel orders, notify callback, return
   *    - PANIC → aggressive unwind
   *    - RECOVERY → one-sided quotes to close position
   *    - INVENTORY → skewed quotes
   *    - QUOTE/FLAT → normal two-sided quotes
   * 6. Отменить старые orders
   * 7. Разместить новые orders
   */
  private async updateQuotes(): Promise<void> {
    if (!this.session || !this.market || !this.isRunning) {
      return;
    }

    // Проверяем наличие обоих ордербуков
    if (!this.hasBothOrderbooks()) {
      this.logger.debug('Cannot update quotes: waiting for both orderbooks');
      return;
    }

    // Получаем агрегированный orderbook (YES токен)
    const currentOrderbook = this.getAggregatedOrderbook();
    if (!currentOrderbook) {
      this.logger.warn('Cannot get aggregated orderbook');
      return;
    }

    try {
      // ========================================
      // Layer 0: Risk Assessment (4-layer) - BOTH tokens
      // ========================================
      const riskConfig = this.config.riskConfig ?? ConfigLoader.getInstance().getRiskConfig(this.logger);

      // Assess outcome 0 token
      const riskAssessment0 = this.riskAssessmentServices[0].assess(
        this.session,
        this.market,
        riskConfig
      );

      // Assess outcome 1 token
      const riskAssessment1 = this.riskAssessmentServices[1].assess(
        this.session,
        this.market,
        riskConfig
      );

      // Store both for external access
      this.lastRiskAssessments = [riskAssessment0, riskAssessment1];

      // Use combined/most conservative assessment for trading decisions
      const riskAssessment = this.combineRiskAssessments(riskAssessment0, riskAssessment1);

      // Update and get per-minute metrics
      this.updateMetricRates();

      // Get orderbook state metrics
      const orderbookMetrics = this.getOrderbookMetrics();

      // Log comprehensive 4-layer status with BOTH tokens
      const statusWithMetrics = {
        // Market info
        market: {
          id: this.market.id,
          question: this.market.question,
          outcomes: [
            { name: this.market.outcomes[0].name, tokenId: this.market.outcomes[0].tokenId },
            { name: this.market.outcomes[1].name, tokenId: this.market.outcomes[1].tokenId },
          ],
        },
        // Layer 0: Edge - BOTH outcomes
        edge: {
          [this.market.outcomes[0].name]: {
            alive: riskAssessment0.edgeAlive,
            warning: riskAssessment0.edgeWarning,
            irreversible: riskAssessment0.edgeIrreversible,
            reason: riskAssessment0.edgeReason,
          },
          [this.market.outcomes[1].name]: {
            alive: riskAssessment1.edgeAlive,
            warning: riskAssessment1.edgeWarning,
            irreversible: riskAssessment1.edgeIrreversible,
            reason: riskAssessment1.edgeReason,
          },
          combined: {
            alive: riskAssessment.edgeAlive,
            reason: riskAssessment.edgeReason,
          },
        },
        // Layer 1: Signals - BOTH outcomes
        signals: {
          [this.market.outcomes[0].name]: {
            fragilityScore: riskAssessment0.fragilityScore.toFixed(3),
            marketState: riskAssessment0.marketState,
            refillRate: riskAssessment0.refillRate.toFixed(3),
            isThinning: riskAssessment0.isThinning,
            tradeImbalance: riskAssessment0.tradeImbalance.toFixed(3),
            bookImbalance: riskAssessment0.bookImbalance.toFixed(3),
          },
          [this.market.outcomes[1].name]: {
            fragilityScore: riskAssessment1.fragilityScore.toFixed(3),
            marketState: riskAssessment1.marketState,
            refillRate: riskAssessment1.refillRate.toFixed(3),
            isThinning: riskAssessment1.isThinning,
            tradeImbalance: riskAssessment1.tradeImbalance.toFixed(3),
            bookImbalance: riskAssessment1.bookImbalance.toFixed(3),
          },
        },
        // Layer 2: Risk (combined for trading decision)
        risk: {
          status: riskAssessment.status,
          mode: riskAssessment.mode,
          urgency: riskAssessment.urgency.value.toFixed(1) + '%',
          netPosition: riskAssessment.netPosition,
          hasPosition: riskAssessment.hasPosition,
        },
        // Time
        time: {
          secondsToExpiry: riskAssessment.secondsToExpiry,
          timeToExpiry: riskAssessment.timeToExpiry,
        },
        // Activity metrics
        activity: {
          tradesPerMinute: this.metrics.tradesPerMinute,
          orderbookUpdatesPerMinute: this.metrics.orderbookUpdatesPerMinute,
          quotesUpdatesPerMinute: this.metrics.quotesUpdatesPerMinute,
        },
        // Orderbook state
        orderbook: {
          outcomes: orderbookMetrics.outcomes,
          arbitrage: orderbookMetrics.arbitrage,
        },
      };
      this.logger.debug(JSON.stringify(statusWithMetrics, null, 2));

      // ========================================
      // Layer 1: Mode from RiskAssessment
      // ========================================
      const newMode = riskAssessment.mode;

      if (newMode !== this.tradingMode) {
        this.logger.info(`[4-Layer] Trading mode changed: ${this.tradingMode} → ${newMode}`, {
          reason: riskAssessment.edgeReason || riskAssessment.recommendations[0] || 'mode transition',
          urgency: riskAssessment.urgency.value.toFixed(1) + '%',
          fragility: riskAssessment.fragilityScore.toFixed(3),
          edgeAlive: riskAssessment.edgeAlive,
        });
        this.tradingMode = newMode;
      }

      // ========================================
      // Layer 2: Mode-specific handling
      // ========================================

      // DEAD mode: Edge is dead, stop trading
      if (this.tradingMode === 'DEAD') {
        await this.handleDeadMode(riskAssessment);
        return;
      }

      // PANIC mode: Emergency exit
      if (this.tradingMode === 'PANIC') {
        this.logger.warn('[4-Layer] PANIC mode - unwinding positions aggressively', {
          urgency: riskAssessment.urgency.value.toFixed(1) + '%',
          netPosition: riskAssessment.netPosition,
        });
        await this.unwindPositionsAggressively();
        return;
      }

      // ========================================
      // Layer 3: Quote Generation
      // ========================================
      // Pass mode and fragilityScore to strategy for mode-aware quoting
      const quotes = this.config.strategy.generateQuotes(
        this.session,
        this.market,
        currentOrderbook,
        this.tradingMode,
        riskAssessment.fragilityScore
      );

      if (quotes.length === 0) {
        this.logger.debug('[4-Layer] No valid quotes generated', {
          mode: this.tradingMode,
          fragility: riskAssessment.fragilityScore.toFixed(3),
        });
        return;
      }

      // 5. Отменяем старые ордера
      await this.cancelAllOrders();

      // 6. Размещаем новые ордера через PlaceOrderCommand
      const quote = quotes[0]; // Берём первый (основной) quote
      const tokenId = this.market.outcomes[0].tokenId;

      if (quote.bid && quote.bidSize.isPositive()) {
        await this.placeOrder('BUY', tokenId, quote.bid.value, quote.bidSize.value);
      }

      if (quote.ask && quote.askSize.isPositive()) {
        await this.placeOrder('SELL', tokenId, quote.ask.value, quote.askSize.value);
      }

      // Increment quotes update counter
      this.metrics.quotesUpdatesCount++;

      // Trace: логируем обновление котировок с mode info
      const outcome0Info = this.getTokenLogInfo(0);
      const marketSuffix = this.getMarketLogSuffix();
      this.logger.trace(
        `[4-Layer] Quotes ${this.tradingMode} ${outcome0Info}: bid=${quote.bid?.value.toFixed(4)}, ask=${quote.ask?.value.toFixed(4)} fragility=${riskAssessment.fragilityScore.toFixed(3)} ${marketSuffix}`
      );
    } catch (error) {
      this.logger.error('Failed to update quotes', error);
    }
  }

  /**
   * Handles DEAD mode - edge is dead, stop trading on this market
   *
   * @param riskAssessment - Current risk assessment with edge death reason
   *
   * @remarks
   * When edge dies:
   * 1. Cancel all active orders
   * 2. Log the death with reason
   * 3. Notify callback (if set) for market rotation
   * 4. Only notify once per market (edgeDeathNotified flag)
   */
  private async handleDeadMode(riskAssessment: RiskAssessment): Promise<void> {
    // Cancel all orders immediately
    await this.cancelAllOrders();

    // Log edge death (once)
    if (!this.edgeDeathNotified) {
      this.logger.warn('[4-Layer] DEAD mode - edge died, stopping quotes', {
        reason: riskAssessment.edgeReason,
        irreversible: riskAssessment.edgeIrreversible,
        fragilityScore: riskAssessment.fragilityScore.toFixed(3),
        refillRate: riskAssessment.refillRate.toFixed(3),
        secondsToExpiry: riskAssessment.secondsToExpiry,
      });

      // Notify callback for market rotation
      if (this.onEdgeDeath && this.market) {
        this.onEdgeDeath(this.market.id, riskAssessment.edgeReason);
      }

      this.edgeDeathNotified = true;
    }
  }

  /**
   * Размещает ордер через PlaceOrderCommand
   *
   * @param side - Сторона ордера (BUY/SELL)
   * @param tokenId - ID токена
   * @param price - Цена
   * @param size - Размер
   *
   * @remarks
   * Использует PlaceOrderHandler для размещения ордера.
   * Handler обрабатывает simulation vs live mode автоматически.
   */
  private async placeOrder(side: 'BUY' | 'SELL', tokenId: string, price: number, size: number): Promise<void> {
    if (!this.session || !this.market) {
      return;
    }

    try {
      const command = new PlaceOrderCommand(
        this.session.sessionId,
        this.market.id,
        tokenId,
        side,
        price,
        size
      );

      const result = await this.placeOrderHandler.execute(command);
      this.activeOrderIds.add(result.order.id);

      // В live mode подписываемся на order fills
      if (!result.isSimulation) {
        this.config.exchangeAdapter.subscribeToOrderUpdates(result.order.id, (updatedOrder) => {
          this.handleOrderUpdate(updatedOrder);
        });
      }
    } catch (error) {
      this.logger.error('Failed to place order', error);
    }
  }

  /**
   * Обрабатывает order update (fills)
   *
   * @param order - Обновлённый ордер
   */
  private async handleOrderUpdate(order: Order): Promise<void> {
    try {
      // Обновляем в repository
      await this.config.orderRepository.update(order);

      // Если ордер заполнен
      if (order.isFilled() && order.filledSize && order.averageFillPrice) {
        this.logger.info(`Order filled: ${order.id}`);

        // Создаём OrderFilledEvent
        const event = new OrderFilledEvent(
          order,
          order.filledSize,
          order.averageFillPrice,
          new Date()
        );

        // Обновляем session (portfolio)
        // NOTE: Здесь нужна полная реализация с обновлением позиций
        // В базовой версии просто логируем
        this.logger.info(
          `Position updated: ${order.side} ${event.fillSize.value} @ ${event.fillPrice.value}`
        );

        // Удаляем из active orders
        this.activeOrderIds.delete(order.id);
      }
    } catch (error) {
      this.logger.error('Failed to handle order update', error);
    }
  }

  /**
   * Отменяет все активные ордера через CancelOrderCommand
   *
   * @remarks
   * Использует CancelOrderHandler для отмены каждого ордера.
   * Handler обрабатывает simulation vs live mode автоматически.
   */
  private async cancelAllOrders(): Promise<void> {
    if (!this.session || this.activeOrderIds.size === 0) {
      return;
    }

    const count = this.activeOrderIds.size;
    const marketSuffix = this.getMarketLogSuffix();

    this.logger.debug(`Cancelling ${count} orders ${marketSuffix}`);

    const cancelPromises = Array.from(this.activeOrderIds).map(async (orderId) => {
      try {
        const command = new CancelOrderCommand(this.session!.sessionId, orderId);
        await this.cancelOrderHandler.execute(command);
        this.activeOrderIds.delete(orderId);
      } catch (error) {
        // Ignore "order not found" errors (order may have been filled or already cancelled)
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (!errorMessage.includes('not found')) {
          this.logger.error(`Failed to cancel order ${orderId}`, error);
        }
        // Still remove from active set to prevent retries
        this.activeOrderIds.delete(orderId);
      }
    });

    await Promise.allSettled(cancelPromises);
  }

  /**
   * Агрессивная распродажа позиций (PANIC mode)
   */
  private async unwindPositionsAggressively(): Promise<void> {
    // NOTE: Полная реализация требует:
    // 1. Получить текущие позиции
    // 2. Разместить market orders для закрытия
    // 3. Мониторить исполнение

    this.logger.warn('Unwinding positions (not fully implemented)');

    // Отменяем все quotes
    await this.cancelAllOrders();
  }

  /**
   * Возвращает текущий статус orchestrator
   *
   * @returns Статус orchestrator с информацией о рынке и ордербуках
   *
   * @remarks
   * Включает информацию о:
   * - Статусе работы (isRunning)
   * - Текущем trading mode
   * - Количестве активных ордеров
   * - Наличии ордербуков для обоих outcome токенов
   * - Количестве сохранённых trades
   */
  public getStatus(): {
    isRunning: boolean;
    tradingMode: TradingMode;
    activeOrders: number;
    hasOrderbooks: [boolean, boolean];
    hasBothOrderbooks: boolean;
    recentTradesCount: number;
    orderbookAges: [number, number];
  } {
    const now = Date.now();
    return {
      isRunning: this.isRunning,
      tradingMode: this.tradingMode,
      activeOrders: this.activeOrderIds.size,
      hasOrderbooks: [this.orderbooks.books[0] !== null, this.orderbooks.books[1] !== null],
      hasBothOrderbooks: this.hasBothOrderbooks(),
      recentTradesCount: this.recentTrades.length,
      orderbookAges: [
        this.orderbooks.lastUpdate[0] > 0 ? now - this.orderbooks.lastUpdate[0] : -1,
        this.orderbooks.lastUpdate[1] > 0 ? now - this.orderbooks.lastUpdate[1] : -1,
      ],
    };
  }

  /**
   * Возвращает текущий торгуемый маркет
   *
   * @returns Текущий Market или null если не инициализирован
   */
  public getCurrentMarket(): Market | null {
    return this.market;
  }

  /**
   * Возвращает последнюю оценку риска (4-layer)
   *
   * @returns RiskAssessment или null если ещё не было оценки
   *
   * @remarks
   * Содержит полную информацию из 4-layer decision system:
   * - Layer 0: Edge status (alive/warning/dead)
   * - Layer 1: Signals (fragility, refill rate, market state)
   * - Layer 2: Risk (status, mode, urgency)
   * - Position and time info
   *
   * @example
   * ```typescript
   * const assessment = orchestrator.getLastRiskAssessment();
   * if (assessment) {
   *   console.log(`Mode: ${assessment.mode}, Edge: ${assessment.edgeAlive}`);
   * }
   * ```
   */
  public getLastRiskAssessments(): [RiskAssessment | null, RiskAssessment | null] {
    return this.lastRiskAssessments;
  }

  /**
   * Combines two risk assessments (YES and NO) into a single conservative assessment
   *
   * @param yesAssessment - Risk assessment for YES token
   * @param noAssessment - Risk assessment for NO token
   * @returns Combined assessment using most conservative values
   *
   * @remarks
   * Combination rules (most conservative):
   * - Mode: DEAD > PANIC > RECOVERY > INVENTORY > QUOTE > FLAT
   * - EdgeAlive: false if EITHER is false
   * - FragilityScore: minimum (more fragile)
   * - RefillRate: minimum (lower is worse)
   */
  private combineRiskAssessments(
    yesAssessment: RiskAssessment,
    noAssessment: RiskAssessment
  ): RiskAssessment {
    // Mode priority (higher = more critical)
    const modePriority: Record<TradingMode, number> = {
      'DEAD': 6,
      'PANIC': 5,
      'RECOVERY': 4,
      'INVENTORY': 3,
      'QUOTE': 2,
      'FLAT': 1,
    };

    // Use the more critical mode
    const combinedMode = modePriority[yesAssessment.mode] >= modePriority[noAssessment.mode]
      ? yesAssessment.mode
      : noAssessment.mode;

    // Edge is dead if EITHER is dead
    const combinedEdgeAlive = yesAssessment.edgeAlive && noAssessment.edgeAlive;
    const combinedEdgeWarning = yesAssessment.edgeWarning || noAssessment.edgeWarning;
    const combinedEdgeIrreversible = yesAssessment.edgeIrreversible || noAssessment.edgeIrreversible;

    // Use the worst reason
    const combinedEdgeReason = !yesAssessment.edgeAlive
      ? `YES: ${yesAssessment.edgeReason}`
      : !noAssessment.edgeAlive
        ? `NO: ${noAssessment.edgeReason}`
        : yesAssessment.edgeReason;

    // Use minimum fragilityScore (more fragile = lower is worse for edge)
    const combinedFragility = Math.min(yesAssessment.fragilityScore, noAssessment.fragilityScore);

    // Use minimum refillRate (lower is worse)
    const combinedRefillRate = Math.min(yesAssessment.refillRate, noAssessment.refillRate);

    // Thinning if EITHER is thinning
    const combinedThinning = yesAssessment.isThinning || noAssessment.isThinning;

    // Status: use the more severe status
    const statusPriority: Record<string, number> = {
      'DEAD': 4,
      'PANIC': 3,
      'WARNING': 2,
      'NORMAL': 1,
    };
    const combinedStatus = statusPriority[yesAssessment.status] >= statusPriority[noAssessment.status]
      ? yesAssessment.status
      : noAssessment.status;

    // Use the higher urgency
    const combinedUrgency = yesAssessment.urgency.value >= noAssessment.urgency.value
      ? yesAssessment.urgency
      : noAssessment.urgency;

    // Return combined assessment (use YES for position/time data since it's the same)
    return {
      ...yesAssessment, // Base values from YES
      mode: combinedMode,
      status: combinedStatus,
      urgency: combinedUrgency,
      edgeAlive: combinedEdgeAlive,
      edgeWarning: combinedEdgeWarning,
      edgeIrreversible: combinedEdgeIrreversible,
      edgeReason: combinedEdgeReason,
      fragilityScore: combinedFragility,
      refillRate: combinedRefillRate,
      isThinning: combinedThinning,
      // MarketState: use the worse one (DEAD is worst)
      marketState: yesAssessment.marketState === 'DEAD' || noAssessment.marketState === 'DEAD'
        ? 'DEAD'
        : yesAssessment.marketState,
    };
  }

  /**
   * Сверяет портфель с биржей через ReconcilePortfolioCommand
   *
   * @param autoCorrect - Автоматически исправлять расхождения (default: false)
   * @returns Результат сверки или null если сессия не инициализирована
   *
   * @remarks
   * Выполняет сверку:
   * - Баланса USDC
   * - Позиций по токенам
   * - Статусов активных ордеров
   *
   * При обнаружении расхождений логирует предупреждения.
   * Если autoCorrect=true, автоматически исправляет расхождения.
   *
   * @example
   * ```typescript
   * const result = await orchestrator.reconcile(true);
   * if (result?.hasDiscrepancies) {
   *   console.warn('Found discrepancies:', result.discrepancies);
   * }
   * ```
   */
  public async reconcile(autoCorrect: boolean = false): Promise<{
    hasDiscrepancies: boolean;
    discrepancies: Array<{
      type: string;
      field: string;
      localValue: number;
      exchangeValue: number;
      difference: number;
      corrected: boolean;
    }>;
  } | null> {
    if (!this.session) {
      this.logger.warn('Cannot reconcile: session not initialized');
      return null;
    }

    try {
      const command = new ReconcilePortfolioCommand(this.session.sessionId, autoCorrect);
      const result = await this.reconcileHandler.execute(command, this.session);

      if (result.hasDiscrepancies) {
        this.logger.warn(`Reconciliation found ${result.discrepancies.length} discrepancies`, {
          localCash: result.localCash,
          exchangeCash: result.exchangeCash,
          positionsChecked: result.positionsChecked,
          ordersChecked: result.ordersChecked,
        });
      } else {
        this.logger.info('Reconciliation completed: no discrepancies found');
      }

      return {
        hasDiscrepancies: result.hasDiscrepancies,
        discrepancies: result.discrepancies,
      };
    } catch (error) {
      this.logger.error('Reconciliation failed', error);
      return null;
    }
  }
}
