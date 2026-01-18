/**
 * Market discovery service for finding best markets to trade
 *
 * @remarks
 * Orchestrates market fetching, filtering, and scoring to select best market.
 * Used in both simulation and live modes - no fake markets, only real data.
 *
 * Algorithm:
 * 1. Fetch markets from Gamma API
 * 2. Apply filters (time, volume, liquidity, keywords)
 * 3. Score candidates
 * 4. Return best market
 *
 * @module domain/services/market-discovery/MarketDiscoveryService
 */

import type {
  IMarketDiscoveryService,
  MarketFilterConfig,
  MarketScoringWeights,
  MarketDiscoveryResult,
  GammaMarketData,
} from './types.js';
import type { ILogger } from '../../ports/ILogger.js';
import { MarketFilter } from './MarketFilter.js';
import { MarketScorer, DEFAULT_SCORING_WEIGHTS } from './MarketScorer.js';

/**
 * Market discovery service configuration
 */
export interface MarketDiscoveryConfig {
  /** Filter configuration */
  filter: MarketFilterConfig;
  /** Scoring weights (optional, defaults to DEFAULT_SCORING_WEIGHTS) */
  scoring?: MarketScoringWeights;
}

/**
 * Market data provider interface (abstraction for API client)
 *
 * @remarks
 * Allows dependency injection of API client for testing.
 */
export interface IMarketDataProvider {
  /**
   * Fetch active markets
   *
   * @returns Array of market data
   * @throws {Error} If API request fails
   */
  getActiveMarkets(): Promise<GammaMarketData[]>;
}

/**
 * Market discovery service implementation
 *
 * @remarks
 * Main service for finding best markets to trade.
 * Coordinates filtering and scoring logic.
 *
 * **IMPORTANT**: This service works with REAL markets only.
 * - In SIMULATION mode: uses real Gamma API data, simulates orders
 * - In LIVE mode: uses real Gamma API data, places real orders
 *
 * There are NO fake/virtual markets for isolated testing.
 *
 * @example
 * ```typescript
 * const service = new MarketDiscoveryService(
 *   apiClient,
 *   {
 *     filter: {
 *       minTimeToExpiryHours: 0,
 *       minSpread: 0.02,
 *       minDailyVolume: 100,
 *       maxMarketsToTrack: 5,
 *       requiredKeywords: ['up', 'down'],
 *       anyOfKeywords: ['bitcoin', 'ethereum', 'solana', 'xrp'],
 *     },
 *   },
 *   logger
 * );
 *
 * const result = await service.findBestMarket();
 *
 * if (result.market) {
 *   console.log(`Selected: ${result.market.question}`);
 *   console.log(`Score: ${result.market.score}`);
 *   console.log(`Candidates: ${result.candidates.length}`);
 * } else {
 *   console.log('No suitable markets found');
 * }
 * ```
 */
export class MarketDiscoveryService implements IMarketDiscoveryService {
  private dataProvider: IMarketDataProvider;
  private config: MarketDiscoveryConfig;
  private logger: ILogger;
  private filter: MarketFilter;
  private scorer: MarketScorer;

  // Cache
  private lastFetch: Date | null = null;
  private cachedMarkets: GammaMarketData[] = [];

  /**
   * Create a new market discovery service
   *
   * @param dataProvider - Market data provider (API client)
   * @param config - Service configuration
   * @param logger - Logger instance
   *
   * @example
   * ```typescript
   * const service = new MarketDiscoveryService(
   *   gammaApiClient,
   *   { filter: { ... } },
   *   logger
   * );
   * ```
   */
  constructor(
    dataProvider: IMarketDataProvider,
    config: MarketDiscoveryConfig,
    logger: ILogger
  ) {
    this.dataProvider = dataProvider;
    this.config = config;
    this.logger = logger;

    // Initialize filter and scorer
    this.filter = new MarketFilter(config.filter, logger);
    this.scorer = new MarketScorer(
      config.scoring || DEFAULT_SCORING_WEIGHTS,
      logger
    );

    this.logger.info('MarketDiscoveryService initialized', {
      minTimeToExpiry: config.filter.minTimeToExpiryHours,
      minSpread: config.filter.minSpread,
      minVolume: config.filter.minDailyVolume,
      maxMarkets: config.filter.maxMarketsToTrack,
    });
  }

  /**
   * Find the best market to trade
   *
   * @returns Discovery result with best market
   * @throws {Error} If API request fails
   *
   * @remarks
   * Algorithm:
   * 1. Fetch markets from Gamma API (cached if recent)
   * 2. Apply filters
   * 3. Score candidates
   * 4. Return best market (highest score)
   *
   * If no markets pass filters, returns null market.
   *
   * @example
   * ```typescript
   * const result = await service.findBestMarket();
   *
   * if (result.market) {
   *   console.log(`Trading: ${result.market.question}`);
   * } else {
   *   console.log('No suitable markets found');
   * }
   * ```
   */
  async findBestMarket(): Promise<MarketDiscoveryResult> {
    this.logger.info('[Market Discovery] Searching for markets...');

    // Fetch markets
    const rawMarkets = await this.fetchMarkets();

    // Filter markets
    const filteredCandidates = this.filter.filterMarkets(rawMarkets);

    if (filteredCandidates.length === 0) {
      this.logger.info('[Market Discovery] Complete: 0 markets passed filters', {
        fetched: rawMarkets.length,
        passed: 0,
      });

      return {
        market: null,
        candidates: [],
        totalFetched: rawMarkets.length,
        totalFiltered: 0,
        timestamp: new Date(),
      };
    }

    // Score candidates
    const scoredCandidates = this.scorer.scoreMarkets(filteredCandidates);

    // Select best (highest score)
    const bestMarket = scoredCandidates[0];

    // Limit to max markets to track (0 = unlimited)
    const maxMarkets = this.config.filter.maxMarketsToTrack;
    const trackedCandidates = maxMarkets > 0
      ? scoredCandidates.slice(0, maxMarkets)
      : scoredCandidates;

    this.logger.info('[Market Discovery] Complete: found suitable markets', {
      fetched: rawMarkets.length,
      passed: filteredCandidates.length,
      selected: bestMarket.question.substring(0, 60) + '...',
    });

    return {
      market: bestMarket,
      candidates: trackedCandidates,
      totalFetched: rawMarkets.length,
      totalFiltered: filteredCandidates.length,
      timestamp: new Date(),
    };
  }

  /**
   * Refresh market list (fetch latest data)
   *
   * @throws {Error} If API request fails
   *
   * @remarks
   * Forces a fresh fetch from Gamma API, bypassing cache.
   *
   * @example
   * ```typescript
   * await service.refresh();
   * const result = await service.findBestMarket();
   * ```
   */
  async refresh(): Promise<void> {
    this.logger.debug('Refreshing market data...');
    this.cachedMarkets = await this.dataProvider.getActiveMarkets();
    this.lastFetch = new Date();
    this.logger.debug('Market data refreshed', {
      count: this.cachedMarkets.length,
    });
  }

  /**
   * Fetch markets from provider (with caching)
   *
   * @returns Array of market data
   * @throws {Error} If API request fails
   *
   * @remarks
   * Uses cache if data was fetched recently (within 60 seconds).
   * Otherwise fetches fresh data from API.
   */
  private async fetchMarkets(): Promise<GammaMarketData[]> {
    const CACHE_TTL_MS = 60 * 1000; // 60 seconds

    // Use cache if recent
    if (
      this.lastFetch &&
      Date.now() - this.lastFetch.getTime() < CACHE_TTL_MS
    ) {
      this.logger.debug('Using cached market data', {
        age: `${((Date.now() - this.lastFetch.getTime()) / 1000).toFixed(0)}s`,
        count: this.cachedMarkets.length,
      });
      return this.cachedMarkets;
    }

    // Fetch fresh data
    await this.refresh();
    return this.cachedMarkets;
  }
}
