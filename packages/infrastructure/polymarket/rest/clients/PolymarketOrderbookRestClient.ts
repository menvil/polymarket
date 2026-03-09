/**
 * Polymarket Orderbook REST Client
 *
 * @remarks
 * Handles /book endpoint:
 * - GET /book - Get orderbook snapshot
 *
 * Returns RAW API responses (NOT normalized).
 * Normalization is done by mappers in higher layers.
 *
 * **IMPORTANT**: This is PUBLIC market data, NOT user-specific data.
 *
 * @example
 * ```typescript
 * const client = new PolymarketOrderbookRestClient(restClient, logger);
 *
 * const orderbook = await client.getOrderbook('0x123');
 * console.log(`Best bid: ${orderbook.bids[0].price}`);
 * console.log(`Best ask: ${orderbook.asks[0].price}`);
 *
 * const top10 = await client.getOrderbook('0x123', 10);
 * console.log(`Top 10 levels`);
 * ```
 */

import type { ILogger } from '../../../../domain/ports/ILogger.js';
import type { PolymarketRestClient } from '../PolymarketRestClient.js';

/**
 * Orderbook level (raw API format)
 */
export interface OrderbookLevelResponse {
  /** Price (string format) */
  price: string;

  /** Size at this price (string format) */
  size: string;
}

/**
 * Orderbook response (raw API format)
 */
export interface OrderbookResponse {
  /** Token ID */
  tokenId: string;

  /** Bids (sorted descending by price) */
  bids: OrderbookLevelResponse[];

  /** Asks (sorted ascending by price) */
  asks: OrderbookLevelResponse[];

  /** Snapshot timestamp */
  timestamp: number;
}

/**
 * Polymarket Orderbook REST Client
 */
export class PolymarketOrderbookRestClient {
  constructor(
    private readonly restClient: PolymarketRestClient,
    private readonly logger: ILogger
  ) {}

  /**
   * Get orderbook snapshot
   *
   * @param tokenId - Token ID
   * @param depth - Optional: number of levels to return (default: all)
   * @returns Orderbook snapshot
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * Returns raw API response. Normalization should be done by mapper.
   * This is PUBLIC data (does not require authentication).
   *
   * @example
   * ```typescript
   * // Full orderbook
   * const orderbook = await client.getOrderbook('0x123');
   * console.log(`Bids: ${orderbook.bids.length}`);
   * console.log(`Asks: ${orderbook.asks.length}`);
   *
   * // Top 10 levels
   * const top10 = await client.getOrderbook('0x123', 10);
   * console.log(`Best bid: ${top10.bids[0].price}`);
   * console.log(`Best ask: ${top10.asks[0].price}`);
   * ```
   */
  async getOrderbook(tokenId: string, depth?: number): Promise<OrderbookResponse> {
    this.logger.debug('Getting orderbook', { tokenId, depth });

    // API ожидает параметры в формате snake_case
    const params: Record<string, string> = {
      token_id: tokenId, // КРИТИЧНО: API требует token_id, не tokenId
    };

    if (depth !== undefined) {
      params.depth = depth.toString();
    }

    const response = await this.restClient.get<OrderbookResponse>('/book', params);

    this.logger.debug('Orderbook retrieved', {
      tokenId,
      bids: response.bids.length,
      asks: response.asks.length,
      timestamp: response.timestamp,
    });

    return response;
  }

  /**
   * Get best bid and ask
   *
   * @param tokenId - Token ID
   * @returns Object with best bid and ask prices
   * @throws {ApiError} If API call fails
   *
   * @example
   * ```typescript
   * const { bestBid, bestAsk, spread } = await client.getBestPrices('0x123');
   * console.log(`Bid: ${bestBid}, Ask: ${bestAsk}, Spread: ${spread}`);
   * ```
   */
  async getBestPrices(
    tokenId: string
  ): Promise<{ bestBid: string; bestAsk: string; spread: string }> {
    this.logger.debug('Getting best prices', { tokenId });

    const orderbook = await this.getOrderbook(tokenId, 1);

    const bestBid = orderbook.bids[0]?.price ?? '0';
    const bestAsk = orderbook.asks[0]?.price ?? '0';

    const spread = (parseFloat(bestAsk) - parseFloat(bestBid)).toFixed(4);

    this.logger.debug('Best prices retrieved', {
      tokenId,
      bestBid,
      bestAsk,
      spread,
    });

    return { bestBid, bestAsk, spread };
  }

  /**
   * Get mid price
   *
   * @param tokenId - Token ID
   * @returns Mid price (average of best bid and ask)
   * @throws {ApiError} If API call fails
   *
   * @example
   * ```typescript
   * const midPrice = await client.getMidPrice('0x123');
   * console.log(`Mid price: ${midPrice}`);
   * ```
   */
  async getMidPrice(tokenId: string): Promise<string> {
    const { bestBid, bestAsk } = await this.getBestPrices(tokenId);

    const mid = (parseFloat(bestBid) + parseFloat(bestAsk)) / 2;
    const midPrice = mid.toFixed(4);

    this.logger.debug('Mid price calculated', {
      tokenId,
      midPrice,
    });

    return midPrice;
  }
}
