/**
 * Order Data Transfer Object
 *
 * @remarks
 * DTO для передачи данных об ордере между слоями приложения.
 * Используется для сериализации/десериализации данных API.
 *
 * Отличие от Entity:
 * - DTO = простой объект данных (Plain Object)
 * - Entity = доменная модель с бизнес-логикой
 * - DTO используется на границах (API, DB)
 * - Entity используется внутри domain layer
 *
 * @example
 * ```typescript
 * const orderDTO: OrderDTO = {
 *   id: 'order-123',
 *   marketId: 'market-456',
 *   tokenId: 'token-yes',
 *   side: 'BUY',
 *   price: 0.65,
 *   size: 100,
 *   status: 'OPEN',
 *   filledSize: 40,
 *   averageFillPrice: 0.65,
 *   notional: 65.0,
 *   remainingSize: 60,
 *   fillPercentage: 40,
 *   timestamp: '2024-01-15T10:30:00.000Z'
 * };
 * ```
 */

/**
 * Order DTO interface
 *
 * @remarks
 * Все поля примитивных типов для легкой сериализации в JSON.
 */
export interface OrderDTO {
  /** Уникальный идентификатор ордера */
  id: string;

  /** ID рынка */
  marketId: string;

  /** ID токена (YES или NO) */
  tokenId: string;

  /** Сторона ордера */
  side: 'BUY' | 'SELL';

  /** Цена ордера */
  price: number;

  /** Размер ордера */
  size: number;

  /** Статус ордера */
  status: 'PENDING' | 'OPEN' | 'FILLED' | 'CANCELED' | 'REJECTED';

  /** Исполненный размер (опционально) */
  filledSize?: number;

  /** Средняя цена исполнения (опционально) */
  averageFillPrice?: number;

  /** Notional value (price × size) */
  notional: number;

  /** Оставшийся размер для исполнения */
  remainingSize: number;

  /** Процент исполнения (0-100) */
  fillPercentage: number;

  /** Время создания (ISO string) */
  timestamp: string;

  /** Время последнего обновления (ISO string, опционально) */
  updatedAt?: string;
}

/**
 * Convert a domain Order entity into an OrderDTO suitable for API/DB transmission.
 *
 * @param order - Domain Order entity to convert; optional fields on the entity are preserved as optional DTO fields.
 * @returns An OrderDTO containing primitive fields: `id`, `marketId`, `tokenId`, `side`, `price`, `size`, `status`, optional `filledSize`, optional `averageFillPrice`, `notional`, `remainingSize`, `fillPercentage`, and `timestamp`.
 */
export function toOrderDTO(order: any): OrderDTO {
  return {
    id: order.id,
    marketId: order.tokenId, // approximation
    tokenId: order.tokenId,
    side: order.side,
    price: order.price.value,
    size: order.size.value,
    status: order.status,
    filledSize: order.filledSize?.value,
    averageFillPrice: order.averageFillPrice?.value,
    notional: order.getNotional(),
    remainingSize: order.getRemainingSize().value,
    fillPercentage: order.getFillPercentage(),
    timestamp: order.timestamp.toISOString(),
  };
}