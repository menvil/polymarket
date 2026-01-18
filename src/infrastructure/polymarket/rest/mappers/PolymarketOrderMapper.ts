/**
 * Маппер ордеров Polymarket
 *
 * @remarks
 * Преобразует между доменными типами ордеров и форматами API Polymarket.
 *
 * Двунаправленное преобразование:
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
 * // { orderId: 'order-123', side: 'BUY', price: 0.52, size: 100, status: 'OPEN', ... }
 * ```
 */

import type { ILogger } from '../../../../domain/ports/ILogger.js';
import type {
  CreateOrderRequest,
  CreateOrderResponse,
  MatchedOrderResponse,
} from '../clients/PolymarketOrderRestClient.js';
import type { OrderResponse, OrderSide } from '../../../exchange/ports/IExecutionAdapter.js';
import type { OrderStatus } from '../../../exchange/types/OrderResponse.js';

/**
 * Маппер ордеров Polymarket
 */
export class PolymarketOrderMapper {
  constructor(private readonly logger: ILogger) {}

  /**
   * Преобразует параметры доменного ордера в запрос API
   *
   * @param params - Параметры доменного ордера
   * @returns Формат запроса API
   *
   * @example
   * ```typescript
   * const apiRequest = mapper.toApiRequest({
   *   tokenId: '0x123',
   *   side: 'BUY',
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
    side: OrderSide;
    price: number;
    size: number;
    priceTick?: number;
    feeRateBps?: number;
  }): CreateOrderRequest {
    return {
      tokenId: params.tokenId,
      side: params.side, // Уже в UPPERCASE (OrderSide = 'BUY' | 'SELL')
      price: params.price, // Число (0-1)
      size: params.size, // Число (количество акций)
      feeRateBps: params.feeRateBps ?? 1000, // Используем предоставленную или стандартную комиссию мейкера 10%
      // nonce опционален - если не передан, API автоматически назначит
      priceTick: params.priceTick, // Передаём priceTick в API builder (КРИТИЧНЫЙ ФИХ)
    };
  }

  /**
   * Преобразует ответ API ордера в формат домена
   *
   * @param response - Сырой ответ API
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
   * console.log(domainOrder.status); // 'PARTIALLY_FILLED'
   * ```
   */
  toDomainOrder(response: CreateOrderResponse): OrderResponse {
    const size = this.parseNumber(response.size || '0');
    const filledSize = this.parseNumber(response.filledSize || '0');
    const sizeRemaining = size - filledSize;

    return {
      orderId: response.orderID, // API возвращает "orderID" с заглавной D
      tokenId: response.tokenId || '',
      side: this.mapSide(response.side, response.orderID),
      price: this.parseNumber(response.price || '0'),
      size,
      sizeRemaining,
      status: this.mapStatus(response.status, filledSize, size),
      createdAt: response.timestamp || Date.now(),
      updatedAt: response.timestamp || Date.now(),
    };
  }

  /**
   * Преобразует сторону API в сторону домена (UPPERCASE)
   *
   * @param apiSide - Сторона API (может быть в любом регистре или отсутствовать)
   * @param orderId - ID ордера для логирования
   * @returns Сторона домена ('BUY' | 'SELL')
   */
  private mapSide(apiSide: string | undefined, orderId: string | undefined): OrderSide {
    if (!apiSide) {
      this.logger.warn('Order side is missing, defaulting to BUY', { orderId });
      return 'BUY';
    }

    const normalizedSide = apiSide.toUpperCase();

    if (normalizedSide === 'BUY') {
      return 'BUY';
    }

    if (normalizedSide === 'SELL') {
      return 'SELL';
    }

    this.logger.warn('Unknown order side, defaulting to BUY', { apiSide, orderId });
    return 'BUY';
  }

  /**
   * Преобразует статус API в статус домена (UPPERCASE)
   *
   * @param apiStatus - Статус API (может быть в любом регистре)
   * @param filledSize - Заполненный объём
   * @param totalSize - Общий объём
   * @returns Статус домена в UPPERCASE
   */
  private mapStatus(
    apiStatus: string,
    filledSize: number,
    totalSize: number
  ): OrderStatus {
    // API возвращает статусы в разных регистрах, нормализуем
    const normalizedStatus = apiStatus.toLowerCase();

    switch (normalizedStatus) {
      case 'pending':
      case 'live':
        if (filledSize === 0) {
          return 'OPEN';
        } else if (filledSize < totalSize) {
          return 'PARTIALLY_FILLED';
        } else {
          return 'FILLED';
        }

      case 'filled':
      case 'matched': // Ордер полностью сопоставлен/заполнен
        return 'FILLED';

      case 'cancelled':
        return 'CANCELED'; // Американское написание (без двойной L)

      default:
        this.logger.warn('Unknown order status', { apiStatus });
        return 'OPEN';
    }
  }

  /**
   * Парсит число из строки
   *
   * @param value - Строковое значение
   * @returns Распарсенное число или 0 при некорректном значении
   */
  private parseNumber(value: string): number {
    const parsed = parseFloat(value);

    if (isNaN(parsed)) {
      this.logger.warn('Invalid number value', { value });
      return 0;
    }

    return parsed;
  }

  /**
   * Преобразует ответ API MatchedOrderResponse в формат домена
   *
   * @param response - Ответ API из /data/orders с параметром status
   * @returns Нормализованный доменный ордер
   *
   * @remarks
   * Используется для ордеров полученных через getOrdersByApiStatus().
   * Поля отличаются от CreateOrderResponse:
   * - asset_id вместо tokenId
   * - original_size вместо size
   * - size_matched для расчёта sizeRemaining
   * - created_at вместо timestamp
   */
  toDomainOrderFromMatched(response: MatchedOrderResponse): OrderResponse {
    const size = this.parseNumber(response.original_size || '0');
    const filledSize = this.parseNumber(response.size_matched || '0');
    const sizeRemaining = size - filledSize;
    const createdAt = response.created_at ? new Date(response.created_at).getTime() : Date.now();

    return {
      orderId: response.orderID,
      tokenId: response.asset_id || '',
      side: this.mapSide(response.side, response.orderID),
      price: this.parseNumber(response.price || '0'),
      size,
      sizeRemaining,
      status: this.mapStatus(response.status, filledSize, size),
      createdAt,
      updatedAt: createdAt,
    };
  }
}
