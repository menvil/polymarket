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
 */
export interface OrderResponse {
  /** Специфичный для биржи ID ордера */
  orderId: string;

  /** ID токена/актива */
  tokenId: string;

  /** Сторона ордера */
  side: 'buy' | 'sell';

  /** Цена ордера */
  price: number;

  /** Исходный размер ордера */
  size: number;

  /** Оставшийся (неисполненный) размер */
  sizeRemaining: number;

  /** Статус ордера */
  status: OrderStatus;

  /** Временная метка создания ордера (миллисекунды) */
  createdAt: number;

  /** Временная метка последнего обновления (миллисекунды) */
  updatedAt?: number;
}

/**
 * Статусы ордера
 */
export type OrderStatus = 'open' | 'partially_filled' | 'filled' | 'cancelled';