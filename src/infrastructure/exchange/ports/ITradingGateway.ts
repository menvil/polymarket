/**
 * Общий интерфейс торгового шлюза для любой биржи
 *
 * @remarks
 * Реализации должны быть специфичными для биржи (например, PolymarketTradingGateway).
 * Шлюз - это тонкий слой, транслирующий домен → API биржи.
 *
 * Паттерн шлюза предоставляет простую абстракцию над специфичными для биржи API,
 * позволяя доменному слою оставаться независимым от конкретной биржи.
 *
 * @example
 * ```typescript
 * const gateway = new PolymarketTradingGateway(orderClient, mapper, logger);
 *
 * const result = await gateway.placeOrder({
 *   tokenId: '0x123',
 *   side: 'buy',
 *   price: 0.52,
 *   size: 100,
 * });
 *
 * if (result.isOk()) {
 *   console.log(`Ордер размещён: ${result.value.orderId}`);
 * } else {
 *   console.error(`Ошибка: ${result.error.message}`);
 * }
 * ```
 */

import type { Result } from '../../../shared/types/Result.js';
import type { OrderResponse } from '../types/OrderResponse.js';

export type { OrderResponse };

/**
 * Параметры для размещения ордера
 */
export interface PlaceOrderParams {
  /** ID токена (asset ID, market ID или символ в зависимости от биржи) */
  tokenId: string;

  /** Сторона ордера */
  side: 'buy' | 'sell';

  /** Цена за единицу */
  price: number;

  /** Размер/количество ордера */
  size: number;
}

/**
 * Общий интерфейс торгового шлюза
 */
export interface ITradingGateway {
  /**
   * Разместить новый ордер
   *
   * @param params - Параметры ордера
   * @returns Result с ответом ордера или ошибкой
   *
   * @throws НЕ должен выбрасывать - возвращает тип Result вместо этого
   *
   * @example
   * ```typescript
   * const result = await gateway.placeOrder({
   *   tokenId: '0x123',
   *   side: 'buy',
   *   price: 0.52,
   *   size: 100,
   * });
   * ```
   */
  placeOrder(params: PlaceOrderParams): Promise<Result<OrderResponse, Error>>;

  /**
   * Отменить существующий ордер
   *
   * @param orderId - Специфичный для биржи ID ордера
   * @returns Result с void или ошибкой
   *
   * @throws НЕ должен выбрасывать - возвращает тип Result вместо этого
   */
  cancelOrder(orderId: string): Promise<Result<void, Error>>;

  /**
   * Получить все открытые ордера
   *
   * @param tokenId - Опционально: фильтр по ID токена
   * @returns Result с массивом ордеров или ошибкой
   *
   * @throws НЕ должен выбрасывать - возвращает тип Result вместо этого
   */
  getOpenOrders(tokenId?: string): Promise<Result<OrderResponse[], Error>>;

  /**
   * Получить конкретный ордер по ID
   *
   * @param orderId - Специфичный для биржи ID ордера
   * @returns Result с ответом ордера или ошибкой
   *
   * @throws НЕ должен выбрасывать - возвращает тип Result вместо этого
   */
  getOrderById(orderId: string): Promise<Result<OrderResponse, Error>>;
}