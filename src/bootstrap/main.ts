/**
 * Application entry point
 *
 * @remarks
 * Bootstraps the trading bot application:
 * 1. Initialize DI container
 * 2. Load configuration
 * 3. Setup services
 * 4. Start trading engine
 *
 * @example
 * ```bash
 * # Development mode with hot reload
 * npm run dev
 *
 * # Production mode
 * npm run build && npm start
 * ```
 */
import { setupContainer } from './dependency-injection/providers.js';
import { ConfigLoader } from '../infrastructure/config/ConfigLoader.js';
import { ILogger } from '../domain/ports/ILogger.js';
import { MultiMarketTrader } from '../application/services/MultiMarketTrader.js';
import { DataCollectorService } from '../application/services/DataCollectorService.js';
import { Money } from '../domain/value-objects/Money.js';
import { BlessedTradingUI, HeadlessUI } from '../infrastructure/ui/index.js';
import type { ITradingUI } from '../infrastructure/ui/types.js';
import {
  MarketDiscoveryService,
  GammaApiClient,
} from '../domain/services/market-discovery/index.js';
import type { OrchestratorFactory } from '../application/services/types/multi-market.js';
import type { RawWsEvent } from '../domain/ports/IDataRecorder.js';

/**
 * Global multi-market trader reference for graceful shutdown
 */
let multiMarketTrader: MultiMarketTrader | null = null;

/**
 * Global UI reference for graceful shutdown
 */
let ui: ITradingUI | null = null;

/**
 * Main application bootstrap function
 *
 * @remarks
 * Algorithm:
 * 1. Setup DI container with all services
 * 2. Load and validate configuration
 * 3. Initialize logging
 * 4. Connect to exchange
 * 5. Initialize trading session
 * 6. Start trading engine
 *
 * @throws {Error} If initialization fails
 */
async function bootstrap(): Promise<void> {
  let logger: ILogger | null = null;

  try {
    console.log('🚀 Starting Polymarket MM Bot v4...\n');

    // 1. Setup DI container
    console.log('📦 Setting up dependency injection container...');
    const container = setupContainer();
    console.log('✅ DI container configured\n');

    // 2. Get configuration
    console.log('⚙️  Loading configuration...');
    const config = container.resolve<ConfigLoader>('config');
    const env = config.getEnv();

    console.log(`   Environment: ${env.NODE_ENV}`);
    console.log(`   Log Level: ${env.LOG_LEVEL || 'info'}`);
    console.log(`   Simulation Mode: ${config.isSimulationMode()}`);
    console.log(`   Safe Mode: ${config.isSafeMode()}`);
    console.log('✅ Configuration loaded\n');

    // 3. Initialize logger
    console.log('📝 Initializing logger...');
    logger = container.resolve<ILogger>('logger');
    logger.info('Logger initialized');
    console.log('✅ Logger ready\n');

    // 4. Initialize UI
    const headlessMode = process.env.HEADLESS === '1';

    if (headlessMode) {
      console.log('🖥️  Initializing UI (Headless mode)...');
    }

    ui = headlessMode
      ? new HeadlessUI({ asciiOnly: true, updateInterval: 5000 })
      : new BlessedTradingUI({ asciiOnly: true, maxLogEntries: 200 });

    await ui.initialize();

    // After UI init, use ui.log() instead of console.log
    ui.log('UI initialized', 'system', 'INFO');
    logger.info(`UI initialized (${headlessMode ? 'Headless' : 'Blessed'})`);

    // 5. Initialize Market Discovery
    ui.log('Initializing Market Discovery...', 'system', 'INFO');
    const gammaApiClient = new GammaApiClient(
      {
        baseUrl: env.GAMMA_API_URL || 'https://gamma-api.polymarket.com',
        timeout: 10000,
      },
      logger
    );

    const marketDiscovery = new MarketDiscoveryService(
      gammaApiClient,
      {
        filter: {
          minTimeToExpiryHours: env.MARKET_DISCOVERY_MIN_TIME_TO_EXPIRY_HOURS,
          minSpread: env.MARKET_DISCOVERY_MIN_SPREAD,
          minDailyVolume: env.MARKET_DISCOVERY_MIN_DAILY_VOLUME,
          maxMarketsToTrack: env.MAX_CONCURRENT_MARKETS,
          requiredKeywords: env.MARKET_DISCOVERY_REQUIRED_KEYWORDS,
          anyOfKeywords: env.MARKET_DISCOVERY_ANY_OF_KEYWORDS,
        },
      },
      logger
    );

    logger.info('Market Discovery configured', {
      minTimeToExpiryHours: env.MARKET_DISCOVERY_MIN_TIME_TO_EXPIRY_HOURS,
      minSpread: env.MARKET_DISCOVERY_MIN_SPREAD,
      minDailyVolume: env.MARKET_DISCOVERY_MIN_DAILY_VOLUME,
      maxMarketsToTrack: env.MAX_CONCURRENT_MARKETS,
      requiredKeywords: env.MARKET_DISCOVERY_REQUIRED_KEYWORDS.join(', '),
      anyOfKeywords: env.MARKET_DISCOVERY_ANY_OF_KEYWORDS.join(', '),
    });

    ui.log('Market Discovery ready', 'system', 'INFO');

    // 6. Connect WebSocket
    ui.log('Connecting to WebSocket...', 'system', 'INFO');
    const wsManager = container.resolve<any>('wsManager');
    await wsManager.connect();
    ui.log('WebSocket connected', 'system', 'INFO');
    logger.info('WebSocket connected');

    // 7. Get orchestrator factory for multi-market trading
    ui.log('Initializing orchestrator factory...', 'system', 'INFO');
    const orchestratorFactory = container.resolve<OrchestratorFactory>('orchestratorFactory');
    logger.info('Orchestrator factory ready');

    // 8. Get initial balance
    const initialBalance = Money.fromUSDC(
      parseFloat(env.INITIAL_BALANCE || '10000')
    );

    ui.log(`Total balance: ${initialBalance.amount} USDC`, 'system', 'INFO');
    ui.log(`Trading ratio: ${env.TRADING_BALANCE_RATIO}`, 'system', 'INFO');
    ui.log(`Max concurrent markets: ${env.MAX_CONCURRENT_MARKETS}`, 'system', 'INFO');
    ui.log(`Min capital per market: ${env.MIN_CAPITAL_PER_MARKET} USDC`, 'system', 'INFO');

    logger.info('Balance configuration', {
      totalBalance: initialBalance.amount,
      tradingBalanceRatio: env.TRADING_BALANCE_RATIO,
      maxConcurrentMarkets: env.MAX_CONCURRENT_MARKETS,
      minCapitalPerMarket: env.MIN_CAPITAL_PER_MARKET,
    });

    // 9. Get DataCollector (if enabled)
    const dataCollector = container.resolve<DataCollectorService>('dataCollector');
    if (dataCollector.isEnabled()) {
      ui.log('Data collection ENABLED', 'system', 'INFO');
      logger.info('Data collection enabled', {
        outputDir: env.DATA_COLLECTION_OUTPUT_DIR,
        format: env.DATA_COLLECTION_FORMAT,
        compression: env.DATA_COLLECTION_COMPRESSION,
      });
    }

    // 10. Create MultiMarketTrader
    ui.log('Initializing Multi-Market Trader...', 'system', 'INFO');
    multiMarketTrader = new MultiMarketTrader(
      marketDiscovery,
      orchestratorFactory,
      {
        maxConcurrentMarkets: env.MAX_CONCURRENT_MARKETS,
        tradingBalanceRatio: env.TRADING_BALANCE_RATIO,
        minCapitalPerMarket: env.MIN_CAPITAL_PER_MARKET,
        scanPauseMs: env.MARKET_SCAN_PAUSE_MS,
        expiryCheckIntervalMs: env.MARKET_EXPIRY_CHECK_INTERVAL_MS,
      },
      logger,
      dataCollector
    );

    // Subscribe to raw WebSocket events for data collection
    if (dataCollector.isEnabled()) {
      wsManager.on('raw', (event: RawWsEvent) => {
        dataCollector.handleRawEvent(event);
      });
      logger.debug('Data collector subscribed to raw events');
    }

    logger.info('MultiMarketTrader created', {
      maxConcurrentMarkets: env.MAX_CONCURRENT_MARKETS,
      tradingBalanceRatio: env.TRADING_BALANCE_RATIO,
      minCapitalPerMarket: env.MIN_CAPITAL_PER_MARKET,
      scanPauseMs: env.MARKET_SCAN_PAUSE_MS,
      expiryCheckIntervalMs: env.MARKET_EXPIRY_CHECK_INTERVAL_MS,
      dataCollectionEnabled: dataCollector.isEnabled(),
    });

    // 11. Log trading mode
    if (config.isSimulationMode()) {
      logger.warn('Running in SIMULATION mode - no real orders will be placed');
      ui.log('SIMULATION MODE: No real orders', 'system', 'WARN');
    }

    if (config.isSafeMode()) {
      logger.warn('Running in SAFE mode - strict risk limits enabled');
      ui.log('SAFE MODE: Strict risk limits enabled', 'system', 'WARN');
    }

    // 12. Start multi-market trading
    ui.log('Starting multi-market trading...', 'system', 'INFO');
    await multiMarketTrader.start(initialBalance);

    const status = multiMarketTrader.getStatus();
    logger.info('Multi-market trading started', {
      activeMarkets: status.activeMarketCount,
      allocatedBalance: status.allocatedBalance,
      tradingBalance: status.tradingBalance,
    });

    if (status.activeMarketCount > 0) {
      ui.log(`Trading on ${status.activeMarketCount} markets!`, 'system', 'INFO');
      for (const market of status.markets) {
        ui.log(`  - ${market.question.substring(0, 50)}...`, 'system', 'INFO');
      }
    } else {
      ui.log('No markets found - waiting for suitable markets...', 'system', 'WARN');
      ui.log(`Scanning every ${env.MARKET_SCAN_PAUSE_MS / 1000}s`, 'system', 'INFO');
    }
    ui.log('Multi-market mode enabled - auto expiry handling', 'system', 'INFO');
    ui.log('Press Ctrl+C to stop', 'system', 'INFO');

    // Keep process alive
    await new Promise(() => {
      /* Run forever until SIGINT/SIGTERM */
    });
  } catch (error) {
    if (logger) {
      logger.error('Failed to start application', error);
    }
    console.error('\n❌ Failed to start application:', error);
    process.exit(1);
  }
}

/**
 * Graceful shutdown handler
 *
 * @remarks
 * Stops the trading engine cleanly:
 * 1. Stop accepting new quotes
 * 2. Cancel all open orders
 * 3. Close connections
 * 4. Save state (if needed)
 */
async function shutdown(): Promise<void> {
  console.log('\n Shutting down gracefully...');

  if (multiMarketTrader) {
    try {
      console.log('   Stopping multi-market trader...');
      await multiMarketTrader.stop();
      console.log('   Trading engine stopped');
    } catch (error) {
      console.error('   Error during shutdown:', error);
    }
  }

  if (ui) {
    try {
      console.log('   Closing UI...');
      await ui.destroy();
      console.log('   UI closed');
    } catch (error) {
      console.error('   Error closing UI:', error);
    }
  }

  console.log('\nGoodbye!\n');
  process.exit(0);
}

// Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  shutdown();
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  shutdown();
});

// Handle shutdown signals
process.on('SIGINT', () => {
  shutdown();
});

process.on('SIGTERM', () => {
  shutdown();
});

// Start application
bootstrap();
