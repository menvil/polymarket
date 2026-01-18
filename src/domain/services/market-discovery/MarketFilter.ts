/**
 * Market filtering logic
 *
 * @remarks
 * Filters markets based on criteria:
 * - Time to expiry
 * - Spread
 * - Volume
 * - Liquidity
 * - Keywords (required, any-of, excluded)
 *
 * @module domain/services/market-discovery/MarketFilter
 */

import type {
  GammaMarketData,
  MarketFilterConfig,
  MarketCandidate,
  OutcomeCandidate,
} from './types';
import type { ILogger } from '../../ports/ILogger';

/**
 * Extracted outcomes with token IDs and names
 */
interface ExtractedOutcomes {
  outcomes: [OutcomeCandidate, OutcomeCandidate];
}

/**
 * Market filter for applying selection criteria
 *
 * @remarks
 * Filters raw market data from Gamma API based on configured criteria.
 * Converts passing markets to MarketCandidate format.
 *
 * @example
 * ```typescript
 * const filter = new MarketFilter({
 *   minTimeToExpiryHours: 0,
 *   minSpread: 0.02,
 *   minDailyVolume: 100,
 *   maxMarketsToTrack: 5,
 *   requiredKeywords: ['up', 'down'],
 *   anyOfKeywords: ['bitcoin', 'ethereum', 'solana', 'xrp'],
 * }, logger);
 *
 * const candidates = filter.filterMarkets(rawMarkets);
 * console.log(`${candidates.length} markets passed filters`);
 * ```
 */
export class MarketFilter {
  private config: MarketFilterConfig;
  private logger: ILogger;

  /**
   * Create a new market filter
   *
   * @param config - Filter configuration
   * @param logger - Logger instance
   */
  constructor(config: MarketFilterConfig, logger: ILogger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Filter markets based on configured criteria
   *
   * @param markets - Raw market data from API
   * @returns Array of market candidates that passed filters
   *
   * @remarks
   * Filters are applied in order:
   * 1. Basic criteria (active, not closed, order book enabled)
   * 2. Time to expiry
   * 3. Spread
   * 4. Volume
   * 5. Keywords (required, any-of, excluded)
   *
   * Markets that fail any filter are excluded.
   *
   * @example
   * ```typescript
   * const candidates = filter.filterMarkets(rawMarkets);
   * ```
   */
  filterMarkets(markets: GammaMarketData[]): MarketCandidate[] {
    const candidates: MarketCandidate[] = [];
    const seenConditionIds = new Set<string>();

    // Filter statistics
    const stats = {
      total: markets.length,
      duplicates: 0,
      failedBasicCriteria: 0,
      failedTimeToExpiry: 0,
      failedSpread: 0,
      failedKeywords: 0,
      failedVolume: 0,
      failedTokenExtraction: 0,
      passed: 0,
    };

    for (const market of markets) {
      // Deduplicate by conditionId (API may return multiple entries per market)
      if (seenConditionIds.has(market.conditionId)) {
        stats.duplicates++;
        continue;
      }
      seenConditionIds.add(market.conditionId);

      // Basic criteria
      if (!this.passesBasicCriteria(market)) {
        stats.failedBasicCriteria++;
        continue;
      }

      // Time to expiry
      const endDate = new Date(market.endDate);
      const timeToExpiry = endDate.getTime() - Date.now();
      const hoursToExpiry = timeToExpiry / (1000 * 60 * 60);

      if (hoursToExpiry < this.config.minTimeToExpiryHours) {
        stats.failedTimeToExpiry++;
        continue;
      }

      // Spread
      const spread = market.spread || 0;
      if (spread < this.config.minSpread) {
        stats.failedSpread++;
        continue;
      }

      // Keywords
      if (!this.passesKeywordFilters(market.question)) {
        stats.failedKeywords++;
        continue;
      }

      // Volume (use liquidity as proxy since API doesn't provide volume field)
      const dailyVolume = Number(market.liquidity || 0);
      if (dailyVolume < this.config.minDailyVolume) {
        stats.failedVolume++;
        continue;
      }

      // Extract outcomes (token IDs and names)
      const extracted = this.extractOutcomes(market);
      if (!extracted) {
        stats.failedTokenExtraction++;
        continue;
      }

      stats.passed++;

      // Generate market URL
      const marketUrl = this.generateMarketUrl(market);

      // Create candidate
      const candidate: MarketCandidate = {
        conditionId: market.conditionId,
        question: market.question,
        slug: market.slug, // КРИТИЧНО: Needed for getMarketConstraints API call
        marketUrl,
        endDate,
        timeToExpiry,
        outcomes: extracted.outcomes,
        dailyVolume,
        liquidity: Number(market.liquidity || 0),
        spread,
        score: 0, // Will be set by scorer
        orderMinSize: market.orderMinSize, // From Gamma API (e.g., 5 shares)
        orderPriceMinTickSize: market.orderPriceMinTickSize, // From Gamma API (e.g., 0.01)
        rawData: market,
      };

      candidates.push(candidate);
    }

    // Only log summary (detailed breakdown available in debug mode)
    this.logger.debug('Market filter summary', {
      total: stats.total,
      passed: stats.passed,
      filtered: stats.total - stats.passed,
    });

    return candidates;
  }

  /**
   * Check if market passes basic criteria
   *
   * @param market - Market data
   * @returns True if market passes basic criteria
   *
   * @remarks
   * Basic criteria:
   * - Market is active
   * - Market is not closed
   * - Order book is enabled
   */
  private passesBasicCriteria(market: GammaMarketData): boolean {
    return market.active && !market.closed && market.enableOrderBook;
  }

  /**
   * Check if market passes keyword filters
   *
   * @param question - Market question text
   * @returns True if question passes keyword filters
   *
   * @remarks
   * Keyword filters (all case-insensitive):
   * 1. requiredKeywords: ALL must be present
   * 2. anyOfKeywords: AT LEAST ONE must be present
   * 3. excludedKeywords: NONE must be present
   */
  private passesKeywordFilters(question: string): boolean {
    const lowerQuestion = question.toLowerCase();

    // Check required keywords (ALL must be present)
    if (this.config.requiredKeywords) {
      for (const keyword of this.config.requiredKeywords) {
        if (!lowerQuestion.includes(keyword.toLowerCase())) {
          return false;
        }
      }
    }

    // Check any-of keywords (AT LEAST ONE must be present)
    if (this.config.anyOfKeywords && this.config.anyOfKeywords.length > 0) {
      const hasAny = this.config.anyOfKeywords.some((keyword) =>
        lowerQuestion.includes(keyword.toLowerCase())
      );
      if (!hasAny) {
        return false;
      }
    }

    // Check excluded keywords (NONE must be present)
    if (this.config.excludedKeywords) {
      for (const keyword of this.config.excludedKeywords) {
        if (lowerQuestion.includes(keyword.toLowerCase())) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Extract outcomes (token IDs and names) from market data
   *
   * @param market - Market data from Gamma API
   * @returns Extracted outcomes or null if invalid
   *
   * @remarks
   * Extracts outcome information from Gamma API response:
   * 1. Parse clobTokenIds (JSON string: '["token_id_0", "token_id_1"]')
   * 2. Parse outcomes (JSON string: '["Up", "Down"]')
   * 3. Order matches: outcomes[0] corresponds to tokenIds[0]
   * 4. Falls back to generic names if parsing fails
   *
   * See docs/api/gamma-market-data-example.md for real API response example.
   */
  private extractOutcomes(market: GammaMarketData): ExtractedOutcomes | null {
    // Step 1: Parse clobTokenIds (handle both Array and JSON string)
    let tokenIds: string[] = [];

    if (!market.clobTokenIds) {
      return null;
    }

    if (Array.isArray(market.clobTokenIds)) {
      tokenIds = market.clobTokenIds;
    } else if (typeof market.clobTokenIds === 'string') {
      try {
        tokenIds = JSON.parse(market.clobTokenIds);
      } catch (e) {
        return null;
      }
    } else {
      return null;
    }

    // Step 2: Verify binary market (exactly 2 tokens)
    if (tokenIds.length !== 2) {
      return null;
    }

    // Step 3: Validate token IDs are non-empty strings
    if (
      !tokenIds[0] ||
      !tokenIds[1] ||
      typeof tokenIds[0] !== 'string' ||
      typeof tokenIds[1] !== 'string'
    ) {
      return null;
    }

    // Step 4: Verify required fields exist
    if (!market.conditionId || !market.question || !market.endDate) {
      return null;
    }

    // Step 5: Parse outcomes (handle both Array and JSON string)
    // market.outcomes is a JSON string like '["Up", "Down"]'
    // Order matches clobTokenIds: outcomes[0] corresponds to tokenIds[0]
    let outcomeNames: [string, string];

    if (typeof market.outcomes === 'string') {
      try {
        const parsed = JSON.parse(market.outcomes);
        if (Array.isArray(parsed) && parsed.length === 2) {
          outcomeNames = [parsed[0], parsed[1]];
        } else {
          outcomeNames = ['Outcome 0', 'Outcome 1'];
        }
      } catch (e) {
        outcomeNames = ['Outcome 0', 'Outcome 1'];
      }
    } else if (Array.isArray(market.outcomes) && market.outcomes.length === 2) {
      // Already an array
      outcomeNames = [market.outcomes[0], market.outcomes[1]];
    } else {
      outcomeNames = ['Outcome 0', 'Outcome 1'];
    }

    // All checks passed - return outcomes
    return {
      outcomes: [
        { tokenId: tokenIds[0], name: outcomeNames[0] },
        { tokenId: tokenIds[1], name: outcomeNames[1] },
      ],
    };
  }

  /**
   * Generate Polymarket URL for a market
   *
   * @param market - Market data
   * @returns Polymarket URL
   *
   * @remarks
   * URL format: https://polymarket.com/event/{slug}
   * If slug is not available, uses conditionId as fallback.
   */
  private generateMarketUrl(market: GammaMarketData): string {
    const slug = market.slug || market.conditionId;
    return `https://polymarket.com/event/${slug}`;
  }
}
