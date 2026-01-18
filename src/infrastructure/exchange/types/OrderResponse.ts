 /**
 * Унифицированный тип ответа с ордером
 *
 * @remarks
 * Общий тип для всех интерфейсов, работающих с ордерами:
 * - IOrdersProvider (чтение ордеров)
 * - IExecutionAdapter (исполнение ордеров)
 * - ITradingGateway (торговый шлюз)
 *
 * Нормализованный формат для любой биржи.
 * Все значения в UPPERCASE для консистентности с domain layer.
 */
export interface OrderResponse {
  /** Специфичный для биржи ID ордера */
  orderId: string;

  /** ID токена/актива */
  tokenId: string;

  /** Сторона ордера (UPPERCASE) */
  side: OrderSide;

  /** Цена ордера */
  price: number;

  /** Исходный размер ордера */
  size: number;

  /** Оставшийся (неисполненный) размер */
  sizeRemaining: number;

  /** Статус ордера (UPPERCASE) */
  status: OrderStatus;

  /** Временная метка создания ордера (миллисекунды) */
  createdAt: number;

  /** Временная метка последнего обновления (миллисекунды) */
  updatedAt?: number;
}

/**
 * Сторона ордера (UPPERCASE)
 *
 * @remarks
 * Унифицировано с domain layer (Order.ts).
 */
export type OrderSide = 'BUY' | 'SELL';

/**
 * Статусы ордера (UPPERCASE)
 *
 * @remarks
 * Унифицировано с domain layer (Order.ts).
 * Используется американское написание CANCELED (не CANCELLED).
 */
export type OrderStatus = 'OPEN' |
    'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED';