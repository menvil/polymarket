/**
 * Market sorting logic for ranking candidates
 *
 * @remarks
 * Sorts markets by expiry time (from v3.js):
 * - Primary: Earliest expiry first (ascending by endDate)
 * - Secondary: Alphabetical by question (if expiry times equal)
 *
 * This matches the v3.js `filterAndSortMarkets` function:
 * "Sort by expiry time: EARLIEST first (ascending order)"
 *
 * @module domain/services/market-discovery/MarketScorer
 */

import type { MarketCandidate, MarketScoringWeights } from './types';
import type { ILogger } from '../../ports/ILogger';

/**
 * Default scoring weights (kept for backwards compatibility, not used)
 *
 * @remarks
 * Note: v3.js uses simple earliest-expiry sorting, not weighted scoring.
 * These weights are preserved for API compatibility but not used.
 */
export const DEFAULT_SCORING_WEIGHTS: MarketScoringWeights = {
  timeToExpiry: 3.0,
  liquidity: 2.0,
  volume: 1.0,
};

/**
 * Market scorer for ranking candidates
 *
 * @remarks
 * Sorts markets by expiry time (matching v3.js logic).
 * Does NOT use weighted scoring - simply sorts by earliest expiry.
 *
 * Algorithm (from v3.js filterAndSortMarkets):
 * 1. Sort by endDate ascending (EARLIEST first)
 * 2. If endDate equal, sort alphabetically by question
 * 3. Set score to hours until expiry for display purposes
 *
 * @example
 * ```typescript
 * const scorer = new MarketScorer({
 *   timeToExpiry: 3.0,
 *   liquidity: 2.0,
 *   volume: 1.0,
 * }, logger);
 *
 * const sorted = scorer.scoreMarkets(candidates);
 * const best = sorted[0]; // Earliest expiry
 * ```
 */
export class MarketScorer {
  private logger: ILogger;

  /**
   * Create a new market scorer
   *
   * @param _weights - Scoring weights (not used, kept for API compatibility)
   * @param logger - Logger instance
   */
  constructor(_weights: MarketScoringWeights, logger: ILogger) {
    this.logger = logger;
  }

  /**
   * Sort markets by expiry time (v3.js logic)
   *
   * @param candidates - Market candidates to sort
   * @returns Sorted candidates (earliest expiry first)
   *
   * @remarks
   * From v3.js filterAndSortMarkets():
   * "Sort by expiry time: EARLIEST first (ascending order)
   *  If expiry time is the same, sort alphabetically by question"
   *
   * Score is set to hours until expiry for display purposes.
   *
   * @example
   * ```typescript
   * const sorted = scorer.scoreMarkets(candidates);
   * console.log(`Best market: ${sorted[0].question} (${sorted[0].score.toFixed(0)}h until expiry)`);
   * ```
   */
  scoreMarkets(candidates: MarketCandidate[]): MarketCandidate[] {
    if (candidates.length === 0) {
      return [];
    }

    // Set score to hours until expiry for display purposes
    for (const candidate of candidates) {
      const hoursToExpiry = candidate.timeToExpiry / (1000 * 60 * 60);
      candidate.score = hoursToExpiry;
    }

    // Sort by endDate ascending (EARLIEST first), then alphabetically
    // This matches v3.js filterAndSortMarkets() exactly
    const sorted = [...candidates].sort((a, b) => {
      const timeDiff = a.endDate.getTime() - b.endDate.getTime();

      // If times are equal, sort alphabetically by question
      if (timeDiff === 0) {
        return a.question.localeCompare(b.question);
      }

      return timeDiff; // Ascending: soonest first
    });

    // Log first few to verify sorting (matching v3.js)
    if (sorted.length > 0) {
      this.logger.info(
        `Sorted ${sorted.length} markets by expiry (soonest first)`
      );
      sorted.slice(0, 100).forEach((m, i) => {
        const timeFormatted = this.formatTimeToExpiry(m.timeToExpiry);
        this.logger.info(
          `  ${i + 1}. [${timeFormatted}] ${m.question}`
        );
      });
    }

    return sorted;
  }

  /**
   * Formats time to expiry in human-readable format
   *
   * @param timeToExpiryMs - Time to expiry in milliseconds
   * @returns Formatted string like "1h30m", "5m45s", or "30s"
   *
   * @remarks
   * Формат вывода:
   * - >= 1 часа: "1h30m"
   * - < 1 часа: "5m45s"
   * - < 1 минуты: "30s"
   */
  private formatTimeToExpiry(timeToExpiryMs: number): string {
    const totalSeconds = Math.floor(timeToExpiryMs / 1000);
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
}
