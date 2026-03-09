/**
 * Polymarket Market Constraints Policy
 *
 * @remarks
 * Handles:
 * - Size normalization (round to sizeTick)
 * - Min/max size validation
 * - Learning from API errors ("size too small")
 * - Caching constraints in-memory
 *
 * This policy is used by PortfolioAdapter.canPlaceOrder() to validate
 * and normalize order parameters BEFORE sending to API.
 *
 * Key features:
 * - Safe defaults if no data: { minOrderSize: 10, sizeTick: 0.01, maxOrderSize: 10000 }
 * - Learns from API errors and updates cache
 * - Fast in-memory cache (no DB queries)
 *
 * @example
 * ```typescript
 * const policy = new PolymarketMarketConstraintsPolicy(marketDataClient, logger);
 *
 * const normalized = await policy.normalizeSize('0x123', 15.7777);
 * // Returns 15.78 (rounded to sizeTick=0.01)
 *
 * policy.learnFromError('0x123', 'size too small: minimum is 20');
 * // Updates cache: minOrderSize = 20
 *
 * const validation = await policy.validateSize('0x123', 5);
 * // Returns { ok: false, reason: 'Size 5 below minimum 20' }
 * ```
 */

import type { ILogger } from '../../../../domain/ports/ILogger.js';
import type { PolymarketMarketDataRestClient } from '../clients/PolymarketMarketDataRestClient.js';

/**
 * Market constraints (cached)
 */
interface MarketConstraints {
  /** Minimum order VALUE in USD for BUY orders (0 = no minimum, only require min shares) */
  minOrderValue: number;

  /** Minimum order SIZE in shares (for both BUY and SELL) */
  minOrderSize: number;

  /** Maximum order size */
  maxOrderSize: number;

  /** Size tick (minimum size increment) */
  sizeTick: number;

  /** Price tick (minimum price increment) */
  priceTick: number;

  /** Fee rate in basis points (learned from API errors) */
  feeRateBps?: number;
}

/**
 * Polymarket Market Constraints Policy
 */
export class PolymarketMarketConstraintsPolicy {
  private readonly cache: Map<string, MarketConstraints> = new Map();
  private readonly defaultConstraints: MarketConstraints = {
    minOrderValue: 0, // NO minimum value
    minOrderSize: 1, // Minimum 1 share (safe default)
    maxOrderSize: 10000,
    sizeTick: 0.01,
    priceTick: 0.01, // CRITICAL FIX: Use 0.01 as safest default (most common on Polymarket)
  };

  constructor(
    private readonly marketDataClient: PolymarketMarketDataRestClient,
    private readonly logger: ILogger
  ) {}

  /**
   * Get market constraints (from cache or API)
   *
   * @param tokenId - Token ID
   * @returns Market constraints
   *
   * @remarks
   * Safe defaults if no data: { minOrderSize: 10, sizeTick: 0.01, maxOrderSize: 10000 }
   * Results are cached in memory.
   *
   * @example
   * ```typescript
   * const constraints = await policy.getConstraints('0x123');
   * console.log(`Min size: ${constraints.minOrderSize}`);
   * ```
   */
  async getConstraints(tokenId: string): Promise<MarketConstraints> {
    // Check cache first
    if (this.cache.has(tokenId)) {
      return this.cache.get(tokenId)!;
    }

    // Fetch from API
    try {
      const apiConstraints = await this.marketDataClient.getMarketConstraints(tokenId);

      // ✅ v7.7.15: CRITICAL - API sometimes returns priceTick < 0.01, but REJECTS orders with that tick!
      // Example: API returns minimum_price_tick=0.0001, but rejects order with:
      // "Price (0.518990099009901) breaks minimum tick size rule: 0.01"
      //
      // Root cause: API calculates price as makerAmount/takerAmount and validates against 0.01 tick.
      // Solution: Use max(0.01, minimum_price_tick) as safe minimum.
      const apiPriceTick = apiConstraints.minimum_price_tick;
      const priceTick = Math.max(0.01, apiPriceTick);

      // ✅ v7.7.15: DEBUG - Log ALL constraints from API
      console.log('[PolymarketMarketConstraintsPolicy] API constraints:', {
        tokenId: tokenId.substring(0, 16) + '...',
        apiPriceTick: apiPriceTick,
        correctedPriceTick: priceTick,
        wasCorrected: apiPriceTick !== priceTick,
        minimum_tick_size: apiConstraints.minimum_tick_size,
        minimum_order_size: apiConstraints.minimum_order_size,
        minimum_order_value: apiConstraints.minimum_order_value,
        maximum_order_size: apiConstraints.maximum_order_size,
      });

      this.logger.debug('Using priceTick from API', {
        tokenId,
        priceTick,
      });

      const constraints: MarketConstraints = {
        minOrderValue: apiConstraints.minimum_order_value ?? this.defaultConstraints.minOrderValue,
        minOrderSize: apiConstraints.minimum_order_size ?? this.defaultConstraints.minOrderSize,
        maxOrderSize: apiConstraints.maximum_order_size,
        sizeTick: apiConstraints.minimum_tick_size,
        priceTick,
      };

      this.cache.set(tokenId, constraints);
      this.logger.info('Market constraints fetched and cached', {
        tokenId,
        constraints,
      });

      return constraints;
    } catch (error) {
      this.logger.warn('Failed to fetch constraints, using defaults', {
        tokenId,
        error,
      });

      // Use default constraints
      this.cache.set(tokenId, this.defaultConstraints);
      return this.defaultConstraints;
    }
  }

  /**
   * Normalize size to sizeTick
   *
   * @param tokenId - Market token ID
   * @param size - Original size
   * @returns Normalized size (rounded to sizeTick)
   *
   * @example
   * ```typescript
   * await policy.normalizeSize('0x123', 15.7777); // → 15.78
   * await policy.normalizeSize('0x123', 15.7333); // → 15.73
   * ```
   */
  async normalizeSize(tokenId: string, size: number): Promise<number> {
    const constraints = await this.getConstraints(tokenId);

    // Round to nearest sizeTick
    const normalized = Math.round(size / constraints.sizeTick) * constraints.sizeTick;

    // Ensure at least 2 decimal places
    const rounded = Math.round(normalized * 100) / 100;

    this.logger.debug('Normalized size', {
      tokenId,
      original: size,
      normalized: rounded,
      sizeTick: constraints.sizeTick,
    });

    return rounded;
  }

  /**
   * Normalize price to priceTick
   *
   * @param tokenId - Market token ID
   * @param price - Original price
   * @returns Normalized price (rounded to priceTick)
   *
   * @example
   * ```typescript
   * await policy.normalizePrice('0x123', 0.5234); // → 0.5234
   * ```
   */
  async normalizePrice(tokenId: string, price: number): Promise<number> {
    const constraints = await this.getConstraints(tokenId);

    // Round to nearest priceTick
    const normalized = Math.round(price / constraints.priceTick) * constraints.priceTick;

    // Ensure at least 4 decimal places (0.0001)
    const rounded = Math.round(normalized * 10000) / 10000;

    this.logger.debug('Normalized price', {
      tokenId,
      original: price,
      normalized: rounded,
      priceTick: constraints.priceTick,
    });

    return rounded;
  }

  /**
   * Validate size against constraints
   *
   * @param tokenId - Token ID
   * @param size - Size to validate
   * @param price - Order price
   * @param side - Order side ('buy' or 'sell')
   * @returns Validation result
   *
   * @remarks
   * BUY orders: minimum 1 share (if minOrderValue=0) OR minimum order VALUE (if minOrderValue>0)
   * SELL orders: no minimum SIZE (just maxOrderSize check)
   *
   * Examples (BUY with minOrderValue=0):
   * - Any price → minimum 1 share
   *
   * Examples (BUY with minOrderValue=$1):
   * - Price $0.60 → minimum 2 shares (2 × $0.60 = $1.20)
   * - Price $0.10 → minimum 10 shares (10 × $0.10 = $1.00)
   *
   * @example
   * ```typescript
   * const result = await policy.validateSize('0x123', 5, 0.60, 'buy');
   * if (!result.ok) {
   *   console.error(result.reason);
   * }
   * ```
   */
  async validateSize(
    tokenId: string,
    size: number,
    price: number,
    side: 'buy' | 'sell'
  ): Promise<{ ok: boolean; reason?: string; minShares?: number }> {
    const constraints = await this.getConstraints(tokenId);

    // BUY: check minimum order SIZE and VALUE
    if (side === 'buy') {
      // First check minimum order SIZE (shares)
      if (size < constraints.minOrderSize) {
        return {
          ok: false,
          reason: `Size ${size} below minimum ${constraints.minOrderSize} shares`,
          minShares: constraints.minOrderSize,
        };
      }

      // Then check minimum order VALUE (if > 0)
      if (constraints.minOrderValue > 0) {
        const orderValue = size * price;
        const minSharesForValue = Math.ceil(constraints.minOrderValue / price);

        if (size < minSharesForValue) {
          return {
            ok: false,
            reason: `Size ${size} × $${price.toFixed(2)} = $${orderValue.toFixed(2)} below minimum $${constraints.minOrderValue.toFixed(2)} (need ${minSharesForValue} shares)`,
            minShares: minSharesForValue,
          };
        }
      }

      if (size > constraints.maxOrderSize) {
        return {
          ok: false,
          reason: `Size ${size} exceeds maximum ${constraints.maxOrderSize}`,
        };
      }

      return { ok: true };
    }

    // SELL: check minimum SIZE and maximum
    if (size < constraints.minOrderSize) {
      return {
        ok: false,
        reason: `Size ${size} below minimum ${constraints.minOrderSize} shares`,
        minShares: constraints.minOrderSize,
      };
    }

    if (size > constraints.maxOrderSize) {
      return {
        ok: false,
        reason: `Size ${size} exceeds maximum ${constraints.maxOrderSize}`,
      };
    }

    return { ok: true };
  }

  /**
   * Learn from API error and update constraints
   *
   * @param tokenId - Market token ID
   * @param errorMsg - API error message
   *
   * @remarks
   * Parses error messages like "min size: $1" and updates cache.
   * Supports patterns:
   * - "min size: $X" → update minOrderValue
   * - "minimum is $X" → update minOrderValue
   * - "maximum is X" → update maxOrderSize
   * - "minimum tick size is X" → update sizeTick
   *
   * @example
   * ```typescript
   * policy.learnFromError('0x123', 'invalid amount ($0.50), min size: $1');
   * // Updates cache: minOrderValue = 1.0
   *
   * policy.learnFromError('0x123', 'size too large: maximum is 5000');
   * // Updates cache: maxOrderSize = 5000
   * ```
   */
  learnFromError(tokenId: string, errorMsg: string): void {
    const constraints = this.cache.get(tokenId) ?? { ...this.defaultConstraints };

    let updated = false;

    // Parse "min size: $X" or "minimum is $X"
    const minValueMatch = errorMsg.match(/min(?:imum)?\s+(?:size|is):\s*\$(\d+(?:\.\d+)?)/i);
    if (minValueMatch) {
      const newMin = parseFloat(minValueMatch[1]);
      if (newMin > constraints.minOrderValue) {
        constraints.minOrderValue = newMin;
        updated = true;
        this.logger.info('Learned minOrderValue from error', {
          tokenId,
          minOrderValue: newMin,
          errorMsg,
        });
      }
    }

    // Parse "maximum is X"
    const maxSizeMatch = errorMsg.match(/maximum\s+(?:is\s+)?(\d+(?:\.\d+)?)/i);
    if (maxSizeMatch) {
      const newMax = parseFloat(maxSizeMatch[1]);
      if (newMax < constraints.maxOrderSize) {
        constraints.maxOrderSize = newMax;
        updated = true;
        this.logger.info('Learned maxOrderSize from error', {
          tokenId,
          maxOrderSize: newMax,
          errorMsg,
        });
      }
    }

    // Parse "minimum tick size is X"
    const tickSizeMatch = errorMsg.match(/tick\s+size\s+(?:is\s+)?(\d+(?:\.\d+)?)/i);
    if (tickSizeMatch) {
      const newTick = parseFloat(tickSizeMatch[1]);
      if (newTick !== constraints.sizeTick) {
        constraints.sizeTick = newTick;
        updated = true;
        this.logger.info('Learned sizeTick from error', {
          tokenId,
          sizeTick: newTick,
          errorMsg,
        });
      }
    }

    // ✅ NEW: Parse "invalid fee rate (X), current market's maker fee: Y"
    const feeRateMatch = errorMsg.match(/invalid fee rate \((\d+)\), current market's maker fee:\s*(\d+)/i);
    if (feeRateMatch) {
      const correctFeeRate = parseInt(feeRateMatch[2], 10);
      // Store feeRateBps in constraints (add new field)
      if ((constraints as any).feeRateBps !== correctFeeRate) {
        (constraints as any).feeRateBps = correctFeeRate;
        updated = true;
        this.logger.warn('Learned feeRateBps from error', {
          tokenId,
          feeRateBps: correctFeeRate,
          errorMsg,
        });
      }
    }

    if (updated) {
      this.cache.set(tokenId, constraints);
      this.logger.info('Updated constraints from error', {
        tokenId,
        constraints,
      });
    } else {
      this.logger.debug('No learnable constraints in error', {
        tokenId,
        errorMsg,
      });
    }
  }

  /**
   * Get fee rate in basis points for token
   *
   * @param tokenId - Token ID
   * @returns Fee rate in basis points (default: 1000 if not learned)
   *
   * @remarks
   * Returns cached fee rate if learned from error, otherwise default 1000 (10%).
   * Most markets use 1000 bps, some use 0 bps.
   *
   * @example
   * ```typescript
   * const feeRate = policy.getFeeRateBps('0x123');
   * // Returns 1000 (default) or learned value like 0
   * ```
   */
  getFeeRateBps(tokenId: string): number {
    const constraints = this.cache.get(tokenId);
    const feeRate = constraints?.feeRateBps ?? 1000; // Default 10% maker fee

    this.logger.debug('Getting feeRateBps', {
      tokenId: tokenId.substring(0, 16) + '...',
      feeRate,
      learned: constraints?.feeRateBps !== undefined,
    });

    return feeRate;
  }

  /**
   * Clear cache for specific token
   *
   * @param tokenId - Token ID
   *
   * @remarks
   * Forces re-fetch of constraints on next access.
   */
  clearCache(tokenId: string): void {
    this.cache.delete(tokenId);
    this.logger.debug('Cleared constraints cache', { tokenId });
  }

  /**
   * Clear all cached constraints
   *
   * @remarks
   * Forces re-fetch of all constraints on next access.
   */
  clearAllCache(): void {
    this.cache.clear();
    this.logger.debug('Cleared all constraints cache');
  }
}
