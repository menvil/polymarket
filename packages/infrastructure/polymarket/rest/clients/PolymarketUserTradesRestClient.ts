/**
 * Polymarket User Trades REST Client
 *
 * @remarks
 * Handles /data/trades endpoint (L2 authenticated):
 * - GET /data/trades - Get user's trade fills history
 *
 * Returns RAW API responses (NOT normalized).
 * Normalization is done by mappers in higher layers.
 *
 * **IMPORTANT**: This returns USER-SPECIFIC fills (authenticated), NOT public market trades.
 * For public market trades, use PolymarketTradesRestClient.
 *
 * @example
 * ```typescript
 * const client = new PolymarketUserTradesRestClient(restClient, logger);
 *
 * // Get all user fills
 * const fills = await client.getUserFills();
 * console.log(`Total fills: ${fills.length}`);
 *
 * // Get fills for specific market
 * const marketFills = await client.getUserFills({ market: '0x123...' });
 * console.log(`Market fills: ${marketFills.length}`);
 *
 * // Get fills for specific asset
 * const assetFills = await client.getUserFills({ asset_id: '123456...' });
 * ```
 */

import type { ILogger } from '../../../../domain/ports/ILogger.js';
import type { PolymarketRestClient } from '../PolymarketRestClient.js';

/**
 * User fill response (raw API format)
 *
 * @remarks
 * Represents a single fill (executed trade) for the authenticated user.
 */
export interface UserFillResponse {
  /** Trade ID */
  id: string;

  /** Order ID that was filled */
  order_id: string;

  /** Market condition ID */
  market: string;

  /** Asset ID (token ID) */
  asset_id: string;

  /** Trade side (BUY or SELL) */
  side: 'BUY' | 'SELL';

  /** Execution price (string format) */
  price: string;

  /** Fill size (string format) */
  size: string;

  /** Fee amount (string format) */
  fee_amount?: string;

  /** Fee rate in basis points */
  fee_rate_bps?: string;

  /** Execution timestamp (Unix milliseconds) */
  timestamp: number;

  /** Maker address */
  maker_address?: string;

  /** Match ID */
  match_id?: string;

  /** Transaction hash */
  transaction_hash?: string;
}

/**
 * User fills query parameters
 */
export interface UserFillsParams {
  /** Filter by market condition ID */
  market?: string;

  /** Filter by asset ID (token ID) */
  asset_id?: string;

  /** Filter by maker address */
  maker_address?: string;

  /** Filter fills before this timestamp */
  before?: number;

  /** Filter fills after this timestamp */
  after?: number;

  /** Maximum number of fills to return */
  limit?: number;

  /** Return only first page (default: false) */
  only_first_page?: boolean;
}

/**
 * Polymarket User Trades REST Client
 *
 * @remarks
 * L2 authenticated client for getting user's trade fill history.
 */
export class PolymarketUserTradesRestClient {
  constructor(
    private readonly restClient: PolymarketRestClient,
    private readonly logger: ILogger
  ) {}

  /**
   * Get user's trade fills
   *
   * @param params - Optional query parameters for filtering
   * @returns Array of user fills (sorted by timestamp descending)
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * Requires L2 authentication (HMAC-SHA256 signed headers).
   * Returns user's executed trades (fills), NOT open orders.
   *
   * @example
   * ```typescript
   * // Get all fills
   * const fills = await client.getUserFills();
   *
   * // Get fills for specific market
   * const marketFills = await client.getUserFills({
   *   market: '0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af',
   * });
   *
   * // Get recent fills (last 24 hours)
   * const recentFills = await client.getUserFills({
   *   after: Date.now() - 24 * 60 * 60 * 1000,
   * });
   *
   * // Get fills for specific token
   * const tokenFills = await client.getUserFills({
   *   asset_id: '108770292557037291842343444956827763454878470740965721806292624574119111069516',
   * });
   * ```
   */
  async getUserFills(params?: UserFillsParams): Promise<UserFillResponse[]> {
    this.logger.debug('Getting user fills', params);

    // Build query parameters (API expects snake_case)
    const queryParams: Record<string, string> = {};

    if (params?.market) {
      queryParams.market = params.market;
    }

    if (params?.asset_id) {
      queryParams.asset_id = params.asset_id;
    }

    if (params?.maker_address) {
      queryParams.maker_address = params.maker_address;
    }

    if (params?.before !== undefined) {
      queryParams.before = params.before.toString();
    }

    if (params?.after !== undefined) {
      queryParams.after = params.after.toString();
    }

    if (params?.limit !== undefined) {
      queryParams.limit = params.limit.toString();
    }

    if (params?.only_first_page !== undefined) {
      queryParams.only_first_page = params.only_first_page.toString();
    }

    // Call authenticated endpoint
    const fills = await this.restClient.get<UserFillResponse[]>(
      '/data/trades',
      queryParams
    );

    this.logger.debug('User fills retrieved', {
      count: fills.length,
      params,
    });

    return fills;
  }

  /**
   * Get total filled volume for user
   *
   * @param params - Optional query parameters for filtering
   * @returns Total volume (sum of size * price)
   * @throws {ApiError} If API call fails
   *
   * @remarks
   * Calculates total dollar volume of all fills.
   *
   * @example
   * ```typescript
   * // Total volume across all markets
   * const totalVolume = await client.getTotalVolume();
   * console.log(`Total traded: $${totalVolume.toFixed(2)}`);
   *
   * // Volume for specific market
   * const marketVolume = await client.getTotalVolume({
   *   market: '0x123...',
   * });
   * ```
   */
  async getTotalVolume(params?: UserFillsParams): Promise<number> {
    this.logger.debug('Calculating total volume', params);

    const fills = await this.getUserFills(params);

    const totalVolume = fills.reduce((sum, fill) => {
      const price = parseFloat(fill.price);
      const size = parseFloat(fill.size);
      return sum + price * size;
    }, 0);

    this.logger.debug('Total volume calculated', {
      totalVolume,
      fillCount: fills.length,
    });

    return totalVolume;
  }

  /**
   * Get fill statistics for user
   *
   * @param params - Optional query parameters for filtering
   * @returns Fill statistics (count, volume, fees)
   * @throws {ApiError} If API call fails
   *
   * @example
   * ```typescript
   * const stats = await client.getFillStats();
   * console.log(`Fills: ${stats.count}`);
   * console.log(`Volume: $${stats.volume.toFixed(2)}`);
   * console.log(`Fees paid: $${stats.totalFees.toFixed(2)}`);
   * ```
   */
  async getFillStats(params?: UserFillsParams): Promise<{
    count: number;
    volume: number;
    totalFees: number;
    buyCount: number;
    sellCount: number;
  }> {
    this.logger.debug('Calculating fill stats', params);

    const fills = await this.getUserFills(params);

    let volume = 0;
    let totalFees = 0;
    let buyCount = 0;
    let sellCount = 0;

    for (const fill of fills) {
      const price = parseFloat(fill.price);
      const size = parseFloat(fill.size);
      volume += price * size;

      if (fill.fee_amount) {
        totalFees += parseFloat(fill.fee_amount);
      }

      if (fill.side === 'BUY') {
        buyCount++;
      } else {
        sellCount++;
      }
    }

    const stats = {
      count: fills.length,
      volume,
      totalFees,
      buyCount,
      sellCount,
    };

    this.logger.debug('Fill stats calculated', stats);

    return stats;
  }
}
