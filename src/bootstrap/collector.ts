/**
 * Data Collector Entry Point
 *
 * @remarks
 * Standalone data collection mode (no trading).
 * Collects raw WebSocket data from markets for analysis and backtests.
 *
 * Features:
 * - Uses same market discovery filters as trading
 * - Records all orderbook and trade events
 * - Saves data in NDJSON format with optional gzip compression
 * - Graceful shutdown on SIGINT/SIGTERM
 *
 * @example
 * ```bash
 * # Development mode
 * npm run collect:dev
 *
 * # Production mode
 * npm run collect
 * ```
 *
 * @module bootstrap/collector
 */

import { setupContainer } from './dependency-injection/providers.js';
import { ConfigLoader } from '../infrastructure/config/ConfigLoader.js';
import { ILogger } from '../domain/ports/ILogger.js';
import { DataCollectorService } from '../application/services/DataCollectorService.js';
import {
  MarketDiscoveryService,
  GammaApiClient,
} from '../domain/services/market-discovery/index.js';
import { PolymarketWsAdapter } from '../infrastructure/polymarket/ws/PolymarketWsAdapter.js';
import type { RawWsEvent } from '../domain/ports/IDataRecorder.js';
import type { MarketCandidate } from '../domain/services/market-discovery/types.js';

/**
 * Global references for graceful shutdown
 */
let dataCollector: DataCollectorService | null = null;
let wsManager: any = null;
let wsAdapter: PolymarketWsAdapter | null = null;
let scanTimer: NodeJS.Timeout | null = null;
let expiryTimer: NodeJS.Timeout | null = null;
let isRunning = false;

/**
 * Registered markets for tracking
 */
const registeredMarkets = new Map<string, MarketCandidate>();

/**
 * Main collector bootstrap function
 *
 * @remarks
 * Algorithm:
 * 1. Setup DI container
 * 2. Initialize logging
 * 3. Initialize DataCollector
 * 4. Initialize Market Discovery
 * 5. Connect WebSocket
 * 6. Find and register markets
 * 7. Subscribe to raw events
 * 8. Start periodic market scan
 * 9. Start expiry monitoring
 */
async function bootstrap(): Promise<void> {
  let logger: ILogger | null = null;

  try {
    console.log('📊 Starting Polymarket Data Collector...\n');

    // 1. Setup DI container
    console.log('📦 Setting up dependency injection container...');
    const container = setupContainer();
    console.log('✅ DI container configured\n');

    // 2. Get configuration
    console.log('⚙️  Loading configuration...');
    const config = container.resolve<ConfigLoader>('config');
    const env = config.getEnv();

    // Force enable data collection
    if (!env.DATA_COLLECTION_ENABLED) {
      console.log('⚠️  DATA_COLLECTION_ENABLED=0, forcing enabled for collector mode');
    }

    console.log(`   Environment: ${env.NODE_ENV}`);
    console.log(`   Output Dir: ${env.DATA_COLLECTION_OUTPUT_DIR}`);
    console.log(`   Format: ${env.DATA_COLLECTION_FORMAT}`);
    console.log(`   Compression: ${env.DATA_COLLECTION_COMPRESSION}`);
    console.log(`   Buffer Size: ${env.DATA_COLLECTION_BUFFER_SIZE}`);
    console.log(`   Flush Interval: ${env.DATA_COLLECTION_FLUSH_INTERVAL_MS}ms`);
    console.log('✅ Configuration loaded\n');

    // 3. Initialize logger
    console.log('📝 Initializing logger...');
    logger = container.resolve<ILogger>('logger');
    logger.info('Data Collector starting');
    console.log('✅ Logger ready\n');

    // 4. Initialize DataCollector
    console.log('💾 Initializing Data Collector...');
    dataCollector = container.resolve<DataCollectorService>('dataCollector');

    // Force enable if not enabled
    if (!dataCollector.isEnabled()) {
      console.log('   Reinitializing with forced enabled...');
      // We need to create a new DataRecorder with enabled=true
      const { DataRecorder } = await import('../infrastructure/persistence/data-collection/DataRecorder.js');
      const { NDJSONFormatter } = await import('../infrastructure/persistence/data-collection/formatters/NDJSONFormatter.js');
      const { GzipCompressor } = await import('../infrastructure/persistence/data-collection/compression/GzipCompressor.js');

      const formatter = new NDJSONFormatter();
      const compressor = env.DATA_COLLECTION_COMPRESSION === 'gzip' ? new GzipCompressor() : null;

      const enabledRecorder = new DataRecorder(
        {
          enabled: true, // Force enabled
          outputDir: env.DATA_COLLECTION_OUTPUT_DIR,
          bufferSize: env.DATA_COLLECTION_BUFFER_SIZE,
          flushIntervalMs: env.DATA_COLLECTION_FLUSH_INTERVAL_MS,
          compression: env.DATA_COLLECTION_COMPRESSION,
        },
        formatter,
        compressor,
        logger
      );

      dataCollector = new DataCollectorService(enabledRecorder, logger);
    }

    await dataCollector.initialize();
    console.log('✅ Data Collector initialized\n');

    // 5. Initialize Market Discovery
    console.log('🔍 Initializing Market Discovery...');
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
    });
    console.log('✅ Market Discovery ready\n');

    // 6. Get WebSocket Manager
    console.log('🔧 Creating WebSocket adapter...');
    wsManager = container.resolve<any>('wsManager');

    // 7. Create PolymarketWsAdapter (manages WebSocket connection)
    wsAdapter = new PolymarketWsAdapter(wsManager, logger);
    console.log('✅ WebSocket adapter created\n');

    // 8. Connect through adapter (so adapter knows it's connected)
    console.log('🔌 Connecting to WebSocket...');
    await wsAdapter.connect();
    console.log('✅ WebSocket connected\n');

    // 8. Subscribe to raw events
    console.log('📡 Subscribing to raw events...');
    wsManager.on('raw', (event: RawWsEvent) => {
      dataCollector?.handleRawEvent(event);
    });
    console.log('✅ Subscribed to raw events\n');

    // 8. Find and register initial markets
    console.log('🔎 Scanning for markets...');
    isRunning = true;

    const result = await marketDiscovery.findBestMarket();
    logger.info('Markets discovered', {
      totalFetched: result.totalFetched,
      totalFiltered: result.totalFiltered,
      candidates: result.candidates.length,
    });

    if (result.candidates.length === 0) {
      console.log('⚠️  No suitable markets found');
      console.log(`   Will continue scanning every ${env.MARKET_SCAN_PAUSE_MS / 1000}s\n`);
    } else {
      console.log(`   Found ${result.candidates.length} markets\n`);

      // FIRST: Register markets in DataCollector (so tokenToSlug mapping exists)
      for (const candidate of result.candidates) {
        await registerMarketOnly(candidate, logger);
      }

      // THEN: Subscribe to all markets using PolymarketWsAdapter
      logger.info(`📊 Subscribing to ${result.candidates.length} initial markets`);

      try {
        console.log(`   📡 Subscribing to ${result.candidates.length} markets...`);

        // Subscribe to each market using wsAdapter
        // wsAdapter handles reconnect logic internally
        for (const candidate of result.candidates) {
          const yesTokenId = candidate.outcomes[0].tokenId;
          const noTokenId = candidate.outcomes[1].tokenId;

          logger.debug(`Subscribing to market: ${candidate.question.substring(0, 30)}...`, {
            conditionId: candidate.conditionId.substring(0, 16) + '...',
            yesTokenId: yesTokenId.substring(0, 16) + '...',
            noTokenId: noTokenId.substring(0, 16) + '...',
          });

          await wsAdapter!.subscribeToMarket(yesTokenId, noTokenId);
        }

        console.log('   ✅ Subscribed to all markets\n');
        logger.info('✅ Initial subscription successful');
      } catch (error) {
        console.error('   ❌ Failed to subscribe:', error);
        logger.error('Failed to subscribe to markets', error);
      }
    }

    // 9. Start periodic market scan
    console.log('⏰ Starting periodic market scan...');
    scanTimer = setInterval(async () => {
      if (!isRunning) return;

      try {
        await marketDiscovery.refresh();
        const scanResult = await marketDiscovery.findBestMarket();

        // Find new markets (not yet registered)
        const newMarkets = scanResult.candidates.filter(
          candidate => !registeredMarkets.has(candidate.conditionId)
        );

        if (newMarkets.length > 0) {
          // Check how many slots are available
          // Markets are removed ONLY when expired (handled by expiry timer)
          // so free slots = markets that expired since last scan
          const maxMarkets = env.MAX_CONCURRENT_MARKETS;
          const currentCount = registeredMarkets.size;
          const freeSlots = maxMarkets > 0
            ? Math.max(0, maxMarkets - currentCount)
            : Infinity; // 0 = unlimited

          if (freeSlots === 0) {
            logger?.debug(`No free slots for new markets (${currentCount}/${maxMarkets} active, ${newMarkets.length} candidates waiting)`);
          } else {
            // Add only as many as fit in the limit
            const marketsToAdd = maxMarkets > 0
              ? newMarkets.slice(0, freeSlots)
              : newMarkets;

            logger?.info(`🔄 Found ${marketsToAdd.length} new markets to add (${newMarkets.length} available, ${freeSlots} slots free)`);

            // FIRST: Register new markets in DataCollector (so tokenToSlug mapping exists)
            for (const candidate of marketsToAdd) {
              await registerMarketOnly(candidate, logger!);
            }

            // THEN: Subscribe to new markets using PolymarketWsAdapter
            try {
              for (const candidate of marketsToAdd) {
                const yesTokenId = candidate.outcomes[0].tokenId;
                const noTokenId = candidate.outcomes[1].tokenId;

                logger?.info(`Adding market: ${candidate.question.substring(0, 50)}...`);
                await wsAdapter!.subscribeToMarket(yesTokenId, noTokenId);
              }

              logger?.info(`✅ Added ${marketsToAdd.length} new markets (total: ${registeredMarkets.size}/${maxMarkets || '∞'} markets)`);
            } catch (error) {
              logger?.error('❌ Failed to add new markets', error);
              return;
            }
          }
        } else {
          // No new markets available
          logger?.debug(`No new markets available (tracking ${registeredMarkets.size}/${env.MAX_CONCURRENT_MARKETS || '∞'} markets)`);
        }
      } catch (error) {
        logger?.error('Market scan failed', error);
      }
    }, env.MARKET_SCAN_PAUSE_MS);
    console.log(`   Scanning every ${env.MARKET_SCAN_PAUSE_MS / 1000}s\n`);

    // 10. Start expiry monitoring
    console.log('⏱️  Starting expiry monitoring...');
    expiryTimer = setInterval(async () => {
      if (!isRunning) return;

      const now = Date.now();
      const expiredMarkets: string[] = [];

      for (const [conditionId, candidate] of registeredMarkets) {
        if (now >= candidate.endDate.getTime()) {
          expiredMarkets.push(conditionId);
        }
      }

      if (expiredMarkets.length > 0) {
        logger?.info(`⏱️  Found ${expiredMarkets.length} expired markets`);

        try {
          // Process each expired market
          for (const conditionId of expiredMarkets) {
            const candidate = registeredMarkets.get(conditionId);
            if (!candidate) continue;

            logger?.info('Market expired', {
              conditionId: conditionId.substring(0, 16) + '...',
              question: candidate.question.substring(0, 50) + '...',
            });

            // 1. СНАЧАЛА отписываемся от WebSocket (перестаём получать события)
            const yesTokenId = candidate.outcomes[0].tokenId;
            const noTokenId = candidate.outcomes[1].tokenId;
            await wsAdapter!.unsubscribeFromMarket(yesTokenId, noTokenId);

            // 2. ПОТОМ финализируем маркет (записываем последние данные и удаляем mapping)
            // Теперь события уже не приходят, race condition исключён
            await dataCollector?.finalizeMarket(conditionId, true);

            // 3. Remove from registered markets
            registeredMarkets.delete(conditionId);
          }

          if (registeredMarkets.size > 0) {
            logger?.info(`✅ Removed ${expiredMarkets.length} expired markets (remaining: ${registeredMarkets.size})`);
          } else {
            logger?.warn('⚠️  No markets remaining after expiry cleanup');
          }
        } catch (error) {
          logger?.error('❌ Failed to remove expired markets', error);
        }
      }
    }, env.MARKET_EXPIRY_CHECK_INTERVAL_MS);
    console.log(`   Checking every ${env.MARKET_EXPIRY_CHECK_INTERVAL_MS / 1000}s\n`);

    // Ready
    console.log('═'.repeat(50));
    console.log('📊 Data Collector is running!');
    console.log(`   Registered markets: ${registeredMarkets.size}`);
    console.log(`   Output: ${env.DATA_COLLECTION_OUTPUT_DIR}`);
    console.log('   Press Ctrl+C to stop');
    console.log('═'.repeat(50) + '\n');

    logger.info('Data Collector started', {
      registeredMarkets: registeredMarkets.size,
      outputDir: env.DATA_COLLECTION_OUTPUT_DIR,
    });

    // Keep process alive
    await new Promise(() => {
      /* Run forever until SIGINT/SIGTERM */
    });
  } catch (error) {
    if (logger) {
      logger.error('Failed to start Data Collector', error);
    }
    console.error('\n❌ Failed to start Data Collector:', error);
    process.exit(1);
  }
}

/**
 * Register a market for data collection (without WebSocket subscription)
 * WebSocket subscription should be done separately for all markets at once
 */
async function registerMarketOnly(
  candidate: MarketCandidate,
  logger: ILogger
): Promise<void> {
  const conditionId = candidate.conditionId;

  if (registeredMarkets.has(conditionId)) {
    return;
  }

  // Register in DataCollector
  dataCollector?.registerMarket(candidate);

  registeredMarkets.set(conditionId, candidate);

  console.log(`   📈 Registered: ${candidate.question.substring(0, 60)}...`);
  logger.info('Market registered for collection', {
    conditionId: conditionId.substring(0, 16) + '...',
    question: candidate.question.substring(0, 50) + '...',
  });
}

/**
 * Graceful shutdown handler
 */
async function shutdown(): Promise<void> {
  console.log('\n📊 Shutting down Data Collector...');
  isRunning = false;

  // Stop timers
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
  if (expiryTimer) {
    clearInterval(expiryTimer);
    expiryTimer = null;
  }

  // СНАЧАЛА отключаем WebSocket (перестаём получать события)
  if (wsManager) {
    console.log('   Disconnecting WebSocket...');
    try {
      await wsManager.disconnect();
    } catch {
      // Ignore disconnect errors
    }
  }

  // ПОТОМ финализируем маркеты (race condition исключён)
  if (dataCollector) {
    console.log('   Finalizing markets...');
    for (const conditionId of registeredMarkets.keys()) {
      try {
        await dataCollector.finalizeMarket(conditionId, false);
      } catch (error) {
        console.error(`   Error finalizing ${conditionId}:`, error);
      }
    }

    console.log('   Closing Data Collector...');
    await dataCollector.close();
  }

  console.log('\n✅ Data Collector stopped\n');
  process.exit(0);
}

// Handle shutdown signals
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  shutdown();
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  shutdown();
});

// Start collector
bootstrap();
