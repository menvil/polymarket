/**
 * Polymarket Position Mapper
 *
 * @remarks
 * Maps raw Polymarket API position responses to domain types.
 *
 * Transformations:
 * - String → number conversion
 * - Field name normalization
 * - Safe defaults for missing fields
 *
 * @example
 * ```typescript
 * const mapper = new PolymarketPositionMapper();
 *
 * const rawPosition = {
 *   tokenId: '0x123',
 *   quantity: '50.5',
 *   side: 'YES',
 *   averagePrice: '0.52',
 *   realizedPnl: '10.5',
 *   unrealizedPnl: '5.25',
 * };
 *
 * const normalized = mapper.toDomainPosition(rawPosition);
 * // { tokenId: '0x123', size: 50.5, averagePrice: 0.52, ... }
 * ```
 */

import type { PositionResponse as ApiPositionResponse } from '../clients/PolymarketPositionsRestClient.js';
import type { PositionResponse } from '../../../exchange/ports/IPortfolioAdapter.js';

/**
 * Polymarket Position Mapper
 */
export class PolymarketPositionMapper {

  /**
   * Map API position response to domain format
   *
   * @param response - Raw API response from Data API
   * @returns Normalized domain position
   *
   * @remarks
   * Data API response format (numbers, not strings):
   * - asset: Token ID
   * - size: Position size (number of shares)
   * - avgPrice: Average entry price
   * - cashPnl: Realized PnL
   *
   * @example
   * ```typescript
   * const rawPosition = {
   *   asset: '0x123',
   *   conditionId: 'market-456',
   *   size: 50.5,
   *   avgPrice: 0.52,
   *   currentValue: 52.5,
   *   cashPnl: 10.5,
   *   percentPnl: 0.2,
   * };
   *
   * const normalized = mapper.toDomainPosition(rawPosition);
   * console.log(normalized.size); // 50.5
   * ```
   */
  toDomainPosition(response: ApiPositionResponse): PositionResponse {
    // Data API возвращает числа напрямую, парсинг не нужен
    const size = response.size;
    const averagePrice = response.avgPrice;
    const realizedPnl = response.cashPnl;

    // Data API не возвращает unrealizedPnl отдельно — вычисляем из currentValue
    // currentValue = size * currentPrice, поэтому unrealized = (currentValue - size * avgPrice)
    const unrealizedPnl = response.currentValue - size * averagePrice;

    return {
      tokenId: response.asset,
      conditionId: response.conditionId, // Передаём для сопоставления со стратегией
      size,
      averagePrice,
      realizedPnl,
      unrealizedPnl,
      updatedAt: Date.now(), // Data API не возвращает временну́ю метку
    };
  }

  /**
   * Map multiple API position responses to domain format
   *
   * @param responses - Array of raw API responses
   * @returns Array of normalized domain positions
   *
   * @example
   * ```typescript
   * const rawPositions = await positionsClient.getPositions();
   * const normalized = mapper.toDomainPositions(rawPositions);
   *
   * console.log(`Total positions: ${normalized.length}`);
   * ```
   */
  toDomainPositions(responses: ApiPositionResponse[]): PositionResponse[] {
    return responses.map((response) => this.toDomainPosition(response));
  }
}
