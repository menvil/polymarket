/**
 * Polymarket Positions REST Client
 *
 * @remarks
 * Handles Data API /positions endpoint:
 * - GET https://data-api.polymarket.com/positions - Get user positions
 *
 * **CRITICAL**: Uses Data API (data-api.polymarket.com), NOT CLOB API!
 *
 * Returns RAW API responses (NOT normalized).
 * Normalization is done by mappers in higher layers.
 *
 * **IMPORTANT**: Positions are FILLED trades, NOT open orders.
 * For open orders, use PolymarketOrdersRestClient.
 *
 * @example
 * ```typescript
 * const dataApiClient = new PolymarketDataApiClient({ baseUrl: 'https://data-api.polymarket.com' }, logger);
 * const client = new PolymarketPositionsRestClient(dataApiClient, userAddress, logger);
 *
 * const positions = await client.getPositions();
 * console.log(`Total positions: ${positions.length}`);
 *
 * const tokenPositions = await client.getPositions('condition-id-123');
 * console.log(`Market positions: ${tokenPositions.length}`);
 * ```
 */

import type { ILogger } from '../../../../domain/ports/ILogger.js';
import type { PolymarketDataApiClient } from '../PolymarketDataApiClient.js';

/**
 * Position response (raw Data API format)
 *
 * @remarks
 * From https://data-api.polymarket.com/positions
 */
export interface PositionResponse {
  /** Asset token ID */
  asset: string;

  /** Condition ID (market) */
  conditionId: string;

  /** Position size (number of shares) */
  size: number;

  /** Average entry price */
  avgPrice: number;

  /** Current market value */
  currentValue: number;

  /** Cash PnL */
  cashPnl: number;

  /** Percent PnL */
  percentPnl: number;

  /** Market metadata (nested object from API) */
  market?: any;
}

/**
 * Polymarket Positions REST Client
 */
export class PolymarketPositionsRestClient {
  constructor(
    private readonly dataApiClient: PolymarketDataApiClient,
    private readonly userAddress: string,
    private readonly logger: ILogger
  ) {}

  /**
   * Get user positions
   *
   * @param conditionId - Optional: filter by market condition ID
   * @returns Array of positions
   * @throws {Error} If API call fails
   *
   * @remarks
   * Uses Data API (data-api.polymarket.com), NOT CLOB API.
   * Returns filled trades, NOT open orders.
   * Returns raw API response (array of positions).
   *
   * API Endpoint: GET https://data-api.polymarket.com/positions
   * Parameters:
   * - user: User wallet address (required)
   * - market: Condition ID filter (optional)
   *
   * @example
   * ```typescript
   * // All positions for user
   * const allPositions = await client.getPositions();
   * console.log(`Total positions: ${allPositions.length}`);
   *
   * // Positions for specific market
   * const marketPositions = await client.getPositions('condition-id-123');
   * console.log(`Market positions: ${marketPositions.length}`);
   * ```
   */
  async getPositions(conditionId?: string): Promise<PositionResponse[]> {
    this.logger.debug('Getting positions from Data API', {
      user: this.userAddress,
      market: conditionId,
    });

    const params: Record<string, string> = {
      user: this.userAddress, // КРИТИЧНО: Data API использует 'user', не 'address'
    };

    if (conditionId) {
      params.market = conditionId; // КРИТИЧНО: Data API использует 'market' (conditionId), не 'tokenId'
    }

    // Data API возвращает массив напрямую, не обёрнутый в {positions: []}
    const positions = await this.dataApiClient.get<PositionResponse[]>('/positions', params);

    this.logger.debug('Positions retrieved from Data API', {
      count: positions.length,
    });

    // Детальное логирование позиций для отладки инвентаря
    this.logger.info('GET /positions FULL RESPONSE', {
      count: positions.length,
      user: this.userAddress.substring(0, 12) + '...',
      marketFilter: conditionId || 'ALL',
      positions: positions.length > 0 ? JSON.stringify(positions, null, 2) : 'NO POSITIONS',
    });

    return positions;
  }

  /**
   * Get position for specific asset (token)
   *
   * @param assetId - Asset token ID
   * @returns Position response or undefined if not found
   * @throws {Error} If API call fails
   *
   * @remarks
   * Fetches all user positions and filters by asset ID.
   * For better performance, use market filtering in getPositions().
   *
   * @example
   * ```typescript
   * const position = await client.getPositionForAsset('token-id-123');
   *
   * if (position) {
   *   console.log(`Size: ${position.size}`);
   *   console.log(`Avg price: ${position.avgPrice}`);
   *   console.log(`Cash PnL: ${position.cashPnl}`);
   * }
   * ```
   */
  async getPositionForAsset(assetId: string): Promise<PositionResponse | undefined> {
    this.logger.debug('Getting position for asset', { asset: assetId });

    // Получаем все позиции (без фильтра по маркету)
    const positions = await this.getPositions();

    // Фильтруем по ID актива
    const position = positions.find((p) => p.asset === assetId);

    if (position) {
      this.logger.debug('Position found', {
        asset: assetId,
        size: position.size,
        cashPnl: position.cashPnl,
      });
    } else {
      this.logger.debug('Position not found', { asset: assetId });
    }

    return position;
  }
}
