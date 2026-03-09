/**
 * Polymarket Trades REST Client
 *
 * @remarks
 * Handles /trades endpoint:
 * - GET /trades - Get market trades history
 *
 * Returns RAW API responses (NOT normalized).
 * Normalization is done by mappers in higher layers.
 *
 * **IMPORTANT**: This returns PUBLIC market trades, NOT user-specific fills.
 * For user fill history, use PolymarketOrderRestClient (future implementation).
 *
 * @example
 * ```typescript
 * const client = new PolymarketTradesRestClient(restClient, logger);
 *
 * const trades = await client.getMarketTrades('0x123', 100);
 * console.log(`Last 100 trades: ${trades.length}`);
 * console.log(`Last trade price: ${trades[0].price}`);
 * ```
 */

import type { ILogger } from '../../../../domain/ports/ILogger.js';
import type { PolymarketRestClient } from '../PolymarketRestClient.js';

/**
 * Market trade response (raw API format)
 */
export interface MarketTradeResponse {
  /** Trade ID */
  tradeId: string;

  /** Token ID */
  tokenId: string;

  /** Trade side (from taker perspective) */
  side: 'BUY' | 'SELL';

  /** Execution price (string format) */
  price: string;

  /** Trade size (string format) */
  size: string;

  /** Execution timestamp */
  timestamp: number;

  /** Taker address (optional) */
  taker?: string;

  /** Maker address (optional) */
  maker?: string;
}

/**
 * Get market trades response
 */
export interface GetMarketTradesResponse {
  /** Array of trades */
  trades: MarketTradeResponse[];
}

/**
 * Polymarket Trades REST Client
 */
export class PolymarketTradesRestClient {
  constructor(
    private readonly restClient: PolymarketRestClient,
    private readonly logger: ILogger
  ) {}

  /**
   * Get market trades history
   *
   * @param tokenId - Token ID
   * @param limit - Optional: max number of trades to return (default: 100)
   * @returns Array of market trades (sorted by timestamp descending)
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * Returns PUBLIC market trades (NOT user-specific fills).
   * Returns raw API response. Normalization should be done by mapper.
   *
   * @example
   * ```typescript
   * // Last 100 trades
   * const trades = await client.getMarketTrades('0x123');
   * console.log(`Last 100 trades: ${trades.length}`);
   *
   * // Last 50 trades
   * const recentTrades = await client.getMarketTrades('0x123', 50);
   * console.log(`Last trade price: ${recentTrades[0].price}`);
   * ```
   */
  async getMarketTrades(tokenId: string, limit?: number): Promise<MarketTradeResponse[]> {
    this.logger.debug('Getting market trades', { tokenId, limit });

    // API expects snake_case parameter names
    const params: Record<string, string> = {
      token_id: tokenId, // CRITICAL: API requires token_id not tokenId
    };

    if (limit !== undefined) {
      params.limit = limit.toString();
    }

    const response = await this.restClient.get<GetMarketTradesResponse>('/trades', params);

    this.logger.debug('Market trades retrieved', {
      tokenId,
      count: response.trades.length,
    });

    return response.trades;
  }

  /**
   * Get last trade price
   *
   * @param tokenId - Token ID
   * @returns Last trade price or undefined if no trades
   * @throws {ApiError} If API call fails
   *
   * @example
   * ```typescript
   * const lastPrice = await client.getLastTradePrice('0x123');
   *
   * if (lastPrice) {
   *   console.log(`Last trade price: ${lastPrice}`);
   * }
   * ```
   */
  async getLastTradePrice(tokenId: string): Promise<string | undefined> {
    this.logger.debug('Getting last trade price', { tokenId });

    const trades = await this.getMarketTrades(tokenId, 1);
    const lastPrice = trades[0]?.price;

    if (lastPrice) {
      this.logger.debug('Last trade price retrieved', {
        tokenId,
        price: lastPrice,
      });
    } else {
      this.logger.warn('No trades found', { tokenId });
    }

    return lastPrice;
  }

  /**
   * Get trade volume in time window
   *
   * @param tokenId - Token ID
   * @param windowMs - Time window in milliseconds
   * @returns Total volume (sum of sizes)
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * Calculates volume by summing trade sizes within specified time window.
   *
   * @example
   * ```typescript
   * // Volume in last hour
   * const hourVolume = await client.getTradeVolume('0x123', 3600000);
   * console.log(`Volume in last hour: ${hourVolume}`);
   * ```
   */
  async getTradeVolume(tokenId: string, windowMs: number): Promise<number> {
    this.logger.debug('Getting trade volume', { tokenId, windowMs });

    const now = Date.now();
    const cutoff = now - windowMs;

    // Get trades (may need to fetch more than limit to cover window)
    const trades = await this.getMarketTrades(tokenId, 1000);

    // Filter trades within window and sum sizes
    const volume = trades
      .filter((trade) => trade.timestamp >= cutoff)
      .reduce((sum, trade) => sum + parseFloat(trade.size), 0);

    this.logger.debug('Trade volume calculated', {
      tokenId,
      windowMs,
      volume,
      tradesCount: trades.filter((t) => t.timestamp >= cutoff).length,
    });

    return volume;
  }
}
