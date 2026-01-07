/**
 * Dependency injection providers configuration
 *
 * @remarks
 * Registers all application services in the DI container.
 *
 * @example
 * ```typescript
 * import { setupContainer } from '@bootstrap/dependency-injection/providers';
 *
 * const container = setupContainer();
 * const config = container.resolve('config');
 * ```
 */
import { Container } from './Container.js';
import { ConfigLoader } from '../../infrastructure/config/ConfigLoader.js';
import { ConsoleLogger } from '../../infrastructure/logging/ConsoleLogger.js';
import { InMemoryOrderRepository } from '../../infrastructure/persistence/repositories/InMemoryOrderRepository.js';
import { CLOBClient } from '../../infrastructure/exchange/clients/CLOBClient.js';
import { WebSocketManager } from '../../infrastructure/exchange/clients/WebSocketManager.js';
import { PolymarketRestAdapter } from '../../infrastructure/exchange/adapters/PolymarketRestAdapter.js';
import { PolymarketOrderbookRestClient } from '../../infrastructure/exchange/clients/PolymarketOrderbookRestClient.js';
import { PolymarketBalanceRestClient } from '../../infrastructure/exchange/clients/PolymarketBalanceRestClient.js';
import { PolymarketPositionRestClient } from '../../infrastructure/exchange/clients/PolymarketPositionRestClient.js';
import { HttpClient } from '../../shared/http/HttpClient.js';
import { MarketConstraintsPolicy } from '../../infrastructure/exchange/policies/MarketConstraintsPolicy.js';
import { BalancePolicy } from '../../infrastructure/exchange/policies/BalancePolicy.js';
import { PolymarketExecutionAdapter } from '../../infrastructure/exchange/adapters/execution/PolymarketExecutionAdapter.js';
import { PolymarketPortfolioAdapter } from '../../infrastructure/exchange/adapters/portfolio/PolymarketPortfolioAdapter.js';
import { InMemoryEventStore } from '../../shared/events/InMemoryEventStore.js';
import { LoggingProjector } from '../../application/projectors/LoggingProjector.js';
import { OrderRepositoryProjector } from '../../application/projectors/OrderRepositoryProjector.js';
import { PortfolioProjector } from '../../application/projectors/PortfolioProjector.js';
import { MetricsProjector } from '../../application/projectors/MetricsProjector.js';
import { PolymarketWsAdapter } from '../../infrastructure/polymarket/ws/PolymarketWsAdapter.js';
import { TwoSidedMarketMaker } from '../../domain/strategies/TwoSidedMarketMaker.js';
import { Quantity } from '../../domain/value-objects/Quantity.js';
import { MainTradingOrchestrator } from '../../application/orchestrators/MainTradingOrchestrator.js';
import { DataRecorder } from '../../infrastructure/persistence/data-collection/DataRecorder.js';
import { NDJSONFormatter } from '../../infrastructure/persistence/data-collection/formatters/NDJSONFormatter.js';
import { ParquetFormatter } from '../../infrastructure/persistence/data-collection/formatters/ParquetFormatter.js';
import { ArrowFormatter } from '../../infrastructure/persistence/data-collection/formatters/ArrowFormatter.js';
import { GzipCompressor } from '../../infrastructure/persistence/data-collection/compression/GzipCompressor.js';
import { DataCollectorService } from '../../application/services/DataCollectorService.js';
import type { IDataRecorder } from '../../domain/ports/IDataRecorder.js';
import type { IFormatter } from '../../infrastructure/persistence/data-collection/formatters/IFormatter.js';
import { InMemoryEventBus } from '../../shared/events/InMemoryEventBus.js';
import { UserEventsFeedService } from '../../infrastructure/exchange/services/UserEventsFeedService.js';
import { DiagnosticsService } from '../../infrastructure/diagnostics/DiagnosticsService.js';

// New execution pipeline components
import { IntentNormalizer } from '../../application/execution/IntentNormalizer.js';
import { ValidationPipeline } from '../../application/execution/ValidationPipeline.js';
import { ValidationContextProvider } from '../../application/execution/ValidationContextProvider.js';
import { BalanceProvider } from '../../infrastructure/exchange/adapters/providers/BalanceProvider.js';
import { PositionProvider } from '../../infrastructure/exchange/adapters/providers/PositionProvider.js';
import { PolymarketTradingGateway } from '../../infrastructure/exchange/gateways/PolymarketTradingGateway.js';
import { ExecutionService } from '../../application/execution/ExecutionService.js';

/**
 * Sets up and configures the DI container
 *
 * @returns Configured container instance
 *
 * @remarks
 * Registers all core services:
 * - Configuration (ConfigLoader)
 * - Logging (ConsoleLogger)
 * - Exchange adapters (Polymarket REST + WS)
 * - Repositories (InMemoryOrderRepository)
 * - Strategy (TwoSidedMarketMaker)
 * - Orchestrator (MainTradingOrchestrator)
 */
export function setupContainer(): Container {
  const container = new Container();

  // Configuration (singleton)
  container.registerSingleton('config', () => ConfigLoader.getInstance());

  // Logger (singleton)
  container.registerSingleton('logger', () => {
    const config = container.resolve<ConfigLoader>('config');
    const env = config.getEnv();

    // Parse LOG_LEVEL from env (case-insensitive)
    const logLevelMap: Record<string, 'silly' | 'trace' | 'debug' | 'info' | 'warn' | 'error'> = {
      SILLY: 'silly',
      TRACE: 'trace',
      DEBUG: 'debug',
      INFO: 'info',
      WARN: 'warn',
      ERROR: 'error',
    };
    const envLevel = (env.LOG_LEVEL || 'INFO').toUpperCase();
    const level = logLevelMap[envLevel] || 'info';

    return new ConsoleLogger({
      level,
      colors: true,
      timestamp: true,
      showMetadata: true,
    });
  });

  // Event Bus (singleton)
  // Used by REST execution adapters for event-driven architecture
  container.registerSingleton('eventBus', () => {
    const logger = container.resolve<ConsoleLogger>('logger');
    return new InMemoryEventBus(logger);
  });

  // Event Store (singleton) - Step 4
  // Stores all events in memory for debugging and replay
  container.registerSingleton('eventStore', () => {
    const logger = container.resolve<ConsoleLogger>('logger');
    const eventStore = new InMemoryEventStore(logger);

    // Subscribe to all events to store them
    const eventBus = container.resolve<InMemoryEventBus>('eventBus');
    eventBus.subscribe('*', (event) => eventStore.append(event));

    return eventStore;
  });

  // Logging Projector (singleton) - Step 4
  // Logs all execution events
  container.registerSingleton('loggingProjector', () => {
    const eventBus = container.resolve<InMemoryEventBus>('eventBus');
    const logger = container.resolve<ConsoleLogger>('logger');
    const projector = new LoggingProjector(eventBus, logger);
    projector.start();
    return projector;
  });

  // Order Repository Projector (singleton) - Step 4
  // Updates OrderRepository on execution events
  container.registerSingleton('orderRepositoryProjector', () => {
    const eventBus = container.resolve<InMemoryEventBus>('eventBus');
    const orderRepository = container.resolve<InMemoryOrderRepository>('orderRepository');
    const logger = container.resolve<ConsoleLogger>('logger');
    const projector = new OrderRepositoryProjector(eventBus, orderRepository, logger);
    projector.start();
    return projector;
  });

  // Portfolio Projector (singleton) - Step 4
  // Updates portfolio state on fill events
  container.registerSingleton('portfolioProjector', () => {
    const eventBus = container.resolve<InMemoryEventBus>('eventBus');
    const logger = container.resolve<ConsoleLogger>('logger');
    const projector = new PortfolioProjector(eventBus, logger);
    projector.start();
    return projector;
  });

  // Metrics Projector (singleton) - Step 4
  // Collects execution metrics
  container.registerSingleton('metricsProjector', () => {
    const eventBus = container.resolve<InMemoryEventBus>('eventBus');
    const logger = container.resolve<ConsoleLogger>('logger');
    const projector = new MetricsProjector(eventBus, logger);
    projector.start();
    return projector;
  });

  // Order Repository (singleton)
  container.registerSingleton('orderRepository', () => {
    const logger = container.resolve<ConsoleLogger>('logger');
    return new InMemoryOrderRepository(logger);
  });

  // CLOB Client (singleton)
  container.registerSingleton('clobClient', () => {
    const config = container.resolve<ConfigLoader>('config');
    const env = config.getEnv();
    const httpClient = container.resolve<HttpClient>('httpClient');

    return new CLOBClient({
      httpClient,
      privateKey: env.PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000001',
      chainId: 137, // Polygon
    });
  });

  // WebSocket Manager (singleton)
  container.registerSingleton('wsManager', () => {
    const config = container.resolve<ConfigLoader>('config');
    const env = config.getEnv();
    const logger = container.resolve<ConsoleLogger>('logger');

    return new WebSocketManager({
      url: env.POLYMARKET_WS_URL || 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
      reconnectDelay: 1000,
      maxReconnectDelay: 30000,
      heartbeatInterval: 30000,
      heartbeatTimeout: 5000,
      logger,
    });
  });

  // HTTP Client (singleton) - базовый клиент для REST API
  container.registerSingleton('httpClient', () => {
    const config = container.resolve<ConfigLoader>('config');
    const env = config.getEnv();
    const logger = container.resolve<ConsoleLogger>('logger');

    return new HttpClient({
      baseUrl: env.POLYMARKET_API_URL || 'https://clob.polymarket.com',
      timeout: 30000,
      maxRetries: 3,
      retryDelay: 1000,
      maxRetryDelay: 10000,
    }, logger);
  });

  // Orderbook REST Client (singleton)
  container.registerSingleton('orderbookRestClient', () => {
    const httpClient = container.resolve<HttpClient>('httpClient');
    const logger = container.resolve<ConsoleLogger>('logger');

    return new PolymarketOrderbookRestClient(httpClient, logger);
  });

  // Balance REST Client (singleton)
  container.registerSingleton('balanceRestClient', () => {
    const httpClient = container.resolve<HttpClient>('httpClient');
    const logger = container.resolve<ConsoleLogger>('logger');

    return new PolymarketBalanceRestClient(httpClient, logger);
  });

  // Position REST Client (singleton)
  container.registerSingleton('positionRestClient', () => {
    const httpClient = container.resolve<HttpClient>('httpClient');
    const logger = container.resolve<ConsoleLogger>('logger');

    return new PolymarketPositionRestClient(httpClient, logger);
  });

  // Market Constraints Policy (singleton)
  // Manages market constraints (minOrderSize, sizeTick, maxOrderSize)
  container.registerSingleton('marketConstraintsPolicy', () => {
    const logger = container.resolve<ConsoleLogger>('logger');

    return new MarketConstraintsPolicy(logger);
  });

  // Balance Policy (singleton)
  // Validates balance before placing orders
  container.registerSingleton('balancePolicy', () => {
    const logger = container.resolve<ConsoleLogger>('logger');

    return new BalancePolicy(logger);
  });

  // User Events Feed Service (singleton) - Step 5
  // Manages WebSocket subscriptions + polling fallback for user events
  container.registerSingleton('userEventsFeed', () => {
    const wsManager = container.resolve<WebSocketManager>('wsManager');
    const clobClient = container.resolve<CLOBClient>('clobClient');
    const eventBus = container.resolve<InMemoryEventBus>('eventBus');
    const logger = container.resolve<ConsoleLogger>('logger');

    const service = new UserEventsFeedService(wsManager, clobClient, eventBus, logger);

    // Auto-start service
    service.start().catch((error) => {
      logger.error('[DI] Failed to start UserEventsFeedService', error);
    });

    return service;
  });

  // ==================== NEW EXECUTION PIPELINE ====================

  // IntentNormalizer (singleton)
  // Pure function for order intent normalization (banker's rounding)
  container.registerSingleton('intentNormalizer', () => {
    return new IntentNormalizer();
  });

  // ValidationPipeline (singleton)
  // Pure function for validation WITHOUT IO
  container.registerSingleton('validationPipeline', () => {
    const logger = container.resolve<ConsoleLogger>('logger');
    return new ValidationPipeline(logger);
  });

  // BalanceProvider (singleton)
  // Provides balance for ValidationContextProvider
  container.registerSingleton('balanceProvider', () => {
    const balanceClient = container.resolve<PolymarketBalanceRestClient>('balanceRestClient');
    const logger = container.resolve<ConsoleLogger>('logger');
    return new BalanceProvider(balanceClient, logger);
  });

  // PositionProvider (singleton)
  // Provides position state for ValidationContextProvider
  container.registerSingleton('positionProvider', () => {
    const positionClient = container.resolve<PolymarketPositionRestClient>('positionRestClient');
    const logger = container.resolve<ConsoleLogger>('logger');
    const config = container.resolve<ConfigLoader>('config');

    // Get position limit from config (risk management)
    const tradingConfig = config.getTrading();
    const maxPositionLimit = tradingConfig.RISK.MAX_NET_POSITION;

    return new PositionProvider(positionClient, logger, maxPositionLimit);
  });

  // ValidationContextProvider (singleton)
  // IO layer for fetching ValidationContext
  container.registerSingleton('validationContextProvider', () => {
    const marketConstraintsPolicy = container.resolve<MarketConstraintsPolicy>('marketConstraintsPolicy');
    const balanceProvider = container.resolve<BalanceProvider>('balanceProvider');
    const positionProvider = container.resolve<PositionProvider>('positionProvider');
    const logger = container.resolve<ConsoleLogger>('logger');

    return new ValidationContextProvider(
      marketConstraintsPolicy,
      balanceProvider,
      positionProvider,
      logger
    );
  });

  // PolymarketTradingGateway (singleton)
  // "Dumb" gateway WITHOUT policies (just HTTP translator)
  container.registerSingleton('tradingGateway', () => {
    const clobClient = container.resolve<CLOBClient>('clobClient');
    const logger = container.resolve<ConsoleLogger>('logger');

    return new PolymarketTradingGateway(clobClient, logger);
  });

  // ExecutionService (singleton)
  // Coordinates execution pipeline: Normalize → Validate → Execute
  container.registerSingleton('executionService', () => {
    const intentNormalizer = container.resolve<IntentNormalizer>('intentNormalizer');
    const validationPipeline = container.resolve<ValidationPipeline>('validationPipeline');
    const contextProvider = container.resolve<ValidationContextProvider>('validationContextProvider');
    const tradingGateway = container.resolve<PolymarketTradingGateway>('tradingGateway');
    const logger = container.resolve<ConsoleLogger>('logger');

    return new ExecutionService(
      intentNormalizer,
      validationPipeline,
      contextProvider,
      tradingGateway,
      logger
    );
  });

  // ==================== END NEW EXECUTION PIPELINE ====================

  // Execution Adapter (singleton)
  // Handles execution operations (place/cancel orders, subscriptions)
  container.registerSingleton('executionAdapter', () => {
    const clobClient = container.resolve<CLOBClient>('clobClient');
    const marketConstraintsPolicy = container.resolve<MarketConstraintsPolicy>('marketConstraintsPolicy');
    const balancePolicy = container.resolve<BalancePolicy>('balancePolicy');
    const eventBus = container.resolve<InMemoryEventBus>('eventBus');
    const userEventsFeed = container.resolve<UserEventsFeedService>('userEventsFeed');
    const logger = container.resolve<ConsoleLogger>('logger');

    return new PolymarketExecutionAdapter(
      clobClient,
      marketConstraintsPolicy,
      balancePolicy,
      eventBus,
      userEventsFeed,
      logger
    );
  });

  // Portfolio Adapter (singleton)
  // Handles portfolio queries (balance, positions, orderbook)
  container.registerSingleton('portfolioAdapter', () => {
    const balanceClient = container.resolve<PolymarketBalanceRestClient>('balanceRestClient');
    const positionClient = container.resolve<PolymarketPositionRestClient>('positionRestClient');
    const orderbookClient = container.resolve<PolymarketOrderbookRestClient>('orderbookRestClient');
    const logger = container.resolve<ConsoleLogger>('logger');

    return new PolymarketPortfolioAdapter(
      balanceClient,
      positionClient,
      orderbookClient,
      logger
    );
  });

  // Exchange Adapter (singleton) - Facade for ExecutionAdapter + PortfolioAdapter
  container.registerSingleton('exchangeAdapter', () => {
    const executionAdapter = container.resolve<PolymarketExecutionAdapter>('executionAdapter');
    const portfolioAdapter = container.resolve<PolymarketPortfolioAdapter>('portfolioAdapter');
    const logger = container.resolve<ConsoleLogger>('logger');

    return new PolymarketRestAdapter(
      executionAdapter,
      portfolioAdapter,
      logger
    );
  });

  // Market Data Feed (singleton)
  container.registerSingleton('marketDataFeed', () => {
    const wsManager = container.resolve<WebSocketManager>('wsManager');
    const logger = container.resolve<ConsoleLogger>('logger');

    return new PolymarketWsAdapter(wsManager, logger);
  });

  // Trading Strategy (singleton)
  container.registerSingleton('strategy', () => {
    const config = container.resolve<ConfigLoader>('config');
    const strategyConfig = config.getStrategyConfig();
    const logger = container.resolve<ConsoleLogger>('logger');

    return new TwoSidedMarketMaker({
      baseSpread: strategyConfig.baseSpread,
      quoteSize: Quantity.fromNumber(strategyConfig.quoteSize),
      inventorySensitivity: strategyConfig.inventorySensitivity,
      maxSkew: strategyConfig.maxSkew,
      minSpread: strategyConfig.minSpread,
      maxSpread: strategyConfig.maxSpread,
    }, logger);
  });

  // Trading Orchestrator (singleton - for backward compatibility)
  container.registerSingleton('orchestrator', () => {
    const config = container.resolve<ConfigLoader>('config');
    const env = config.getEnv();
    const exchangeAdapter = container.resolve<PolymarketRestAdapter>('exchangeAdapter');
    const marketDataFeed = container.resolve<PolymarketWsAdapter>('marketDataFeed');
    const orderRepository = container.resolve<InMemoryOrderRepository>('orderRepository');
    const strategy = container.resolve<TwoSidedMarketMaker>('strategy');
    const logger = container.resolve<ConsoleLogger>('logger');

    // Загружаем riskConfig из ConfigLoader (использует RISK_TIME_URGENCY_SECONDS из .env)
    const riskConfig = ConfigLoader.getInstance().getRiskConfig(logger);

    return new MainTradingOrchestrator({
      exchangeAdapter,
      marketDataFeed,
      orderRepository,
      strategy,
      logger,
      riskConfig,
      quoteUpdateInterval: 5000, // 5 seconds
      throttleOrderbookUpdates: true,
      orderbookThrottleMs: 1000, // 1 second
      tradingFeePercent: env.TRADING_FEE_PERCENT,
    });
  });

  // Orchestrator Factory (for multi-market trading)
  // Returns a function that creates NEW orchestrator instances
  container.registerSingleton('orchestratorFactory', () => {
    return () => {
      const config = container.resolve<ConfigLoader>('config');
      const env = config.getEnv();
      const exchangeAdapter = container.resolve<PolymarketRestAdapter>('exchangeAdapter');
      const marketDataFeed = container.resolve<PolymarketWsAdapter>('marketDataFeed');
      const orderRepository = container.resolve<InMemoryOrderRepository>('orderRepository');
      const strategy = container.resolve<TwoSidedMarketMaker>('strategy');
      const logger = container.resolve<ConsoleLogger>('logger');
      const riskConfig = ConfigLoader.getInstance().getRiskConfig(logger);

      return new MainTradingOrchestrator({
        exchangeAdapter,
        marketDataFeed,
        orderRepository,
        strategy,
        logger,
        riskConfig,
        quoteUpdateInterval: 5000,
        throttleOrderbookUpdates: true,
        orderbookThrottleMs: 1000,
        tradingFeePercent: env.TRADING_FEE_PERCENT,
      });
    };
  });

  // Data Recorder (singleton)
  // Records raw WebSocket events to files for analysis and backtests
  container.registerSingleton('dataRecorder', () => {
    const config = container.resolve<ConfigLoader>('config');
    const env = config.getEnv();
    const logger = container.resolve<ConsoleLogger>('logger');

    // Create formatter based on config
    let formatter: IFormatter;
    switch (env.DATA_COLLECTION_FORMAT) {
      case 'parquet':
        formatter = new ParquetFormatter();
        logger.info('Using Parquet formatter for data collection');
        break;
      case 'arrow':
        formatter = new ArrowFormatter();
        logger.info('Using Arrow formatter for data collection');
        break;
      case 'ndjson':
      default:
        formatter = new NDJSONFormatter();
        logger.debug('Using NDJSON formatter for data collection');
        break;
    }

    // Create compressor if gzip is enabled
    const compressor = env.DATA_COLLECTION_COMPRESSION === 'gzip'
      ? new GzipCompressor()
      : null;

    return new DataRecorder(
      {
        enabled: env.DATA_COLLECTION_ENABLED,
        outputDir: env.DATA_COLLECTION_OUTPUT_DIR,
        bufferSize: env.DATA_COLLECTION_BUFFER_SIZE,
        flushIntervalMs: env.DATA_COLLECTION_FLUSH_INTERVAL_MS,
        compression: env.DATA_COLLECTION_COMPRESSION,
      },
      formatter,
      compressor,
      logger
    );
  });

  // Data Collector Service (singleton)
  // Coordinates data collection from WebSocket events
  container.registerSingleton('dataCollector', () => {
    const dataRecorder = container.resolve<IDataRecorder>('dataRecorder');
    const logger = container.resolve<ConsoleLogger>('logger');

    return new DataCollectorService(dataRecorder, logger);
  });

  // Diagnostics Service (singleton) - Step 7
  // Provides system health checks, metrics, state snapshots
  container.registerSingleton('diagnostics', () => {
    const eventBus = container.resolve<InMemoryEventBus>('eventBus');
    const metricsProjector = container.resolve<MetricsProjector>('metricsProjector');
    const userEventsFeed = container.resolve<UserEventsFeedService>('userEventsFeed');
    const orderRepository = container.resolve<InMemoryOrderRepository>('orderRepository');
    const logger = container.resolve<ConsoleLogger>('logger');

    return new DiagnosticsService(
      eventBus,
      metricsProjector,
      userEventsFeed,
      orderRepository,
      logger
    );
  });

  return container;
}
