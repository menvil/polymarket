/**
 * Маппер ордеров Polymarket
 *
 * @remarks
 * Выполняет двустороннее преобразование между доменными типами Order и форматами ордеров API Polymarket.
 *
 * Двустороннее преобразование:
 * - Домен → API (для размещения ордеров)
 * - API → Домен (для чтения ордеров)
 *
 * @example
 * ```typescript
 * const mapper = new PolymarketOrderMapper(logger);
 *
 * // API → Домен
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

import type { ILogger } from '@polymarket/logger';
import type {
  CreateOrderRequest,
  CreateOrderResponse,
} from '../clients/PolymarketOrderRestClient.js';
import type { OrderResponse } from '../../ports/IExecutionAdapter.js';

/**
 * Маппер ордеров Polymarket
 */
export class PolymarketOrderMapper {
  constructor(private readonly logger: ILogger) {}

  /**
   * Преобразовать параметры доменного ордера в запрос к API
   *
   * @param params - Параметры доменного ордера
   * @returns Формат запроса к API
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
    postOnly?: boolean;
    orderType?: 'GTC' | 'GTD' | 'FOK' | 'FAK';
    priceTick?: number;
    negRisk?: boolean;
  }): CreateOrderRequest {
    // Нормализуем сторону в нижний регистр для сравнения (защита от uppercase на входе)
    const normalizedSide = params.side.toLowerCase();

    return {
      tokenId: params.tokenId,
      side: normalizedSide === 'buy' ? 'BUY' : 'SELL',
      price: params.price, // Число (0-1)
      size: params.size, // Число (акции)
      postOnly: params.postOnly,
      orderType: params.orderType,
      priceTick: params.priceTick,
      negRisk: params.negRisk,
    };
  }

  /**
   * Преобразовать ответ API по ордеру в доменный формат
   *
   * @param response - Необработанный ответ API
   * @returns Нормализованный доменный ордер
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
      orderId: response.orderID, // API возвращает "orderID" с заглавной D
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
   * Преобразовать статус API в доменный статус
   *
   * @param apiStatus - Статус API
   * @param filledSize - Исполненный объём
   * @param totalSize - Общий объём
   * @returns Доменный статус
   */
  private mapStatus(
    apiStatus: string,
    filledSize: number,
    totalSize: number
  ): 'open' | 'partially_filled' | 'filled' | 'cancelled' {
    // API возвращает статусы в нижнем регистре
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
      case 'matched': // Ордер полностью сопоставлен/исполнен
        return 'filled';

      case 'cancelled':
        return 'cancelled';

      default:
        this.logger.warn('Unknown order status', { apiStatus });
        return 'open';
    }
  }

  /**
   * Разобрать число из строки
   *
   * @param value - Строковое значение
   * @returns Разобранное число или 0 при невалидном значении
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
