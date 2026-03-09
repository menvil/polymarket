/**
 * Polymarket Order Mapper
 *
 * @remarks
 * Maps between domain Order types and Polymarket API order formats.
 *
 * Bidirectional mapping:
 * - Domain → API (for placing orders)
 * - API → Domain (for reading orders)
 *
 * @example
 * ```typescript
 * const mapper = new PolymarketOrderMapper(logger);
 *
 * // API → Domain
 * const rawOrder = {
 *   orderId: 'order-123',
 *   tokenId: '0x123',
 *   side: 'BUY',
 *   price: '0.52',
 *   size: '100',
 *   filledSize: '0',
 *   status: 'LIVE',
 *   timestamp: 1234567890,
 * };
 *
 * const domainOrder = mapper.toDomainOrder(rawOrder);
 * // { orderId: 'order-123', side: 'buy', price: 0.52, size: 100, ... }
 * ```
 */

import type { ILogger } from '../../../../domain/ports/ILogger.js';
import type {
  CreateOrderRequest,
  CreateOrderResponse,
} from '../clients/PolymarketOrderRestClient.js';
import type { OrderResponse } from '../../../exchange/ports/IExecutionAdapter.js';

/**
 * Polymarket Order Mapper
 */
export class PolymarketOrderMapper {
  constructor(private readonly logger: ILogger) {}

  /**
   * Map domain order params to API request
   *
   * @param params - Domain order parameters
   * @returns API request format
   *
   * @example
   * ```typescript
   * const apiRequest = mapper.toApiRequest({
   *   tokenId: '0x123',
   *   side: 'buy',
   *   price: 0.52,
   *   size: 100,
   *   priceTick: 0.001,
   * });
   *
   * // Returns: { tokenId: '0x123', side: 'BUY', price: '0.52', size: '100', priceTick: 0.001, ... }
   * ```
   */
  toApiRequest(params: {
    tokenId: string;
    side: 'buy' | 'sell';
    price: number;
    size: number;
    priceTick?: number;
    feeRateBps?: number;
  }): CreateOrderRequest {
    // Normalize side to lowercase for comparison (defensive against uppercase input)
    const normalizedSide = params.side.toLowerCase();

    return {
      tokenId: params.tokenId,
      side: normalizedSide === 'buy' ? 'BUY' : 'SELL',
      price: params.price, // Number (0-1)
      size: params.size, // Number (shares)
      feeRateBps: params.feeRateBps ?? 1000, // Use provided or default 10% maker fee
      nonce: Date.now(),
      priceTick: params.priceTick, // Pass priceTick to API builder (CRITICAL FIX)
    };
  }

  /**
   * Map API order response to domain format
   *
   * @param response - Raw API response
   * @returns Normalized domain order
   *
   * @example
   * ```typescript
   * const rawOrder = {
   *   orderId: 'order-123',
   *   tokenId: '0x123',
   *   side: 'BUY',
   *   price: '0.52',
   *   size: '100',
   *   filledSize: '25',
   *   status: 'LIVE',
   *   timestamp: 1234567890,
   * };
   *
   * const domainOrder = mapper.toDomainOrder(rawOrder);
   * console.log(domainOrder.status); // 'partially_filled'
   * ```
   */
  toDomainOrder(response: CreateOrderResponse): OrderResponse {
    const size = this.parseNumber(response.size || '0');
    const filledSize = this.parseNumber(response.filledSize || '0');
    const sizeRemaining = size - filledSize;

    return {
      orderId: response.orderID, // API returns "orderID" with capital D
      tokenId: response.tokenId || '',
      side: response.side === 'BUY' ? 'buy' : 'sell',
      price: this.parseNumber(response.price || '0'),
      size,
      sizeRemaining,
      status: this.mapStatus(response.status, filledSize, size),
      createdAt: response.timestamp || Date.now(),
      updatedAt: response.timestamp || Date.now(),
    };
  }

  /**
   * Map API status to domain status
   *
   * @param apiStatus - API status
   * @param filledSize - Filled size
   * @param totalSize - Total size
   * @returns Domain status
   */
  private mapStatus(
    apiStatus: string,
    filledSize: number,
    totalSize: number
  ): 'open' | 'partially_filled' | 'filled' | 'cancelled' {
    // API returns lowercase statuses
    const normalizedStatus = apiStatus.toLowerCase();

    switch (normalizedStatus) {
      case 'pending':
      case 'live':
        if (filledSize === 0) {
          return 'open';
        } else if (filledSize < totalSize) {
          return 'partially_filled';
        } else {
          return 'filled';
        }

      case 'filled':
      case 'matched': // Order fully matched/filled
        return 'filled';

      case 'cancelled':
        return 'cancelled';

      default:
        this.logger.warn('Unknown order status', { apiStatus });
        return 'open';
    }
  }

  /**
   * Parse number from string
   *
   * @param value - String value
   * @returns Parsed number or 0 if invalid
   */
  private parseNumber(value: string): number {
    const parsed = parseFloat(value);

    if (isNaN(parsed)) {
      this.logger.warn('Invalid number value', { value });
      return 0;
    }

    return parsed;
  }
}
