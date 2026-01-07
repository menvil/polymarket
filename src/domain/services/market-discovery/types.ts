/**
 * Market discovery types and interfaces
 *
 * @remarks
 * Defines types for market scanning, filtering, and selection from Gamma API.
 * Used for both simulation and live trading modes.
 *
 * @module domain/services/market-discovery/types
 */

/**
 * Raw market data from Gamma API
 *
 * @remarks
 * Represents a market as returned by the Polymarket Gamma API.
 * Field names match the actual API response (camelCase).
 */
export interface GammaMarketData {
  /** Market condition ID (unique identifier) */
  conditionId: string;
  /** Market question text */
  question: string;
  /** Market slug for URL generation */
  slug?: string;
  /** Market description */
  description?: string;
  /** Market end date (ISO string) */
  endDate: string;
  /** Is market active */
  active: boolean;
  /** Is market closed */
  closed: boolean;
  /** Is order book enabled */
  enableOrderBook: boolean;
  /** Market tags */
  tags?: string[];
  /** CLOB token IDs - JSON string or array (e.g., '["token_id_0", "token_id_1"]') */
  clobTokenIds?: string[] | string;
  /** Market outcomes - JSON string or array (e.g., '["Up", "Down"]') */
  outcomes?: string[] | string;
  /** Liquidity (string in API response) */
  liquidity?: string | number;
  /** Spread (bid-ask spread) */
  spread?: number;
  /** Best bid price */
  bestBid?: number;
  /** Best ask price */
  bestAsk?: number;
}

/**
 * Outcome candidate information
 *
 * @remarks
 * Represents a single outcome in a market candidate.
 */
export interface OutcomeCandidate {
  /** Token ID for this outcome */
  tokenId: string;
  /** Human-readable outcome name (e.g., "Up", "Down", "Yes", "No") */
  name: string;
}

/**
 * Processed market candidate for trading
 *
 * @remarks
 * Simplified market data after filtering and scoring.
 */
export interface MarketCandidate {
  /** Condition ID */
  conditionId: string;
  /** Market question */
  question: string;
  /** Market URL on Polymarket */
  marketUrl: string;
  /** End date */
  endDate: Date;
  /** Time to expiry (milliseconds) */
  timeToExpiry: number;
  /** Outcomes array [outcome0, outcome1] with token IDs and names */
  outcomes: [OutcomeCandidate, OutcomeCandidate];
  /** Daily volume */
  dailyVolume: number;
  /** Liquidity */
  liquidity: number;
  /** Spread */
  spread: number;
  /** Market score (higher = better) */
  score: number;
  /** Raw market data */
  rawData: GammaMarketData;
}

/**
 * Market filter configuration
 *
 * @remarks
 * Defines criteria for filtering markets from Gamma API.
 * Filters are applied before scoring and selection.
 */
export interface MarketFilterConfig {
  /** Minimum time to expiry (hours). 0 = any market including closest to expiry. */
  minTimeToExpiryHours: number;
  /** Minimum spread (0.02 = 2%). Markets with tighter spreads may have low liquidity. */
  minSpread: number;
  /** Minimum daily volume (USD). Ensures sufficient trading activity. */
  minDailyVolume: number;
  /** Maximum markets to track simultaneously */
  maxMarketsToTrack: number;
  /** Keywords that must be present in question (case-insensitive) */
  requiredKeywords?: string[];
  /** Keywords where at least one must be present (case-insensitive) */
  anyOfKeywords?: string[];
  /** Excluded keywords (if present, market is filtered out) */
  excludedKeywords?: string[];
}

/**
 * Market scoring weights
 *
 * @remarks
 * Defines how to rank markets. Higher weights = more important.
 * Priority: timeToExpiry > liquidity > volume
 */
export interface MarketScoringWeights {
  /** Weight for time to expiry (higher = prefer markets closer to expiry) */
  timeToExpiry: number;
  /** Weight for liquidity (higher = prefer more liquid markets) */
  liquidity: number;
  /** Weight for volume (higher = prefer higher volume markets) */
  volume: number;
}

/**
 * Market discovery result
 *
 * @remarks
 * Contains selected market and metadata about the discovery process.
 */
export interface MarketDiscoveryResult {
  /** Selected market (best candidate) */
  market: MarketCandidate | null;
  /** All candidates considered (sorted by score) */
  candidates: MarketCandidate[];
  /** Total markets fetched from API */
  totalFetched: number;
  /** Markets passed filters */
  totalFiltered: number;
  /** Discovery timestamp */
  timestamp: Date;
}

/**
 * Market discovery service interface
 *
 * @remarks
 * Defines the contract for market discovery implementations.
 * Used for both simulation and live trading.
 *
 * @example
 * ```typescript
 * const discovery = new MarketDiscoveryService(config, logger);
 * const result = await discovery.findBestMarket();
 *
 * if (result.market) {
 *   console.log(`Selected: ${result.market.question}`);
 *   console.log(`Score: ${result.market.score}`);
 *   console.log(`Time to expiry: ${result.market.timeToExpiry}ms`);
 * }
 * ```
 */
export interface IMarketDiscoveryService {
  /**
   * Find the best market to trade
   *
   * @returns Discovery result with best market
   * @throws {Error} If API request fails
   *
   * @remarks
   * 1. Fetches markets from Gamma API
   * 2. Applies filters (time, volume, liquidity, keywords)
   * 3. Scores remaining candidates
   * 4. Returns best market by score
   */
  findBestMarket(): Promise<MarketDiscoveryResult>;

  /**
   * Refresh market list (fetch latest data)
   *
   * @throws {Error} If API request fails
   */
  refresh(): Promise<void>;
}
