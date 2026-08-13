/**
 * Порт провайдера ордеров (read-only).
 */

/** Ответ с данными ордера */
export interface OrderResponse {
  orderId: string;
  status: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
  sizeRemaining: number;
  tokenId: string;
  createdAt: number;
  updatedAt?: number;
}

/**
 * Интерфейс для чтения ордеров (только чтение, не исполнение).
 */
export interface IOrdersProvider {
  getOpenOrders(tokenId?: string): Promise<OrderResponse[]>;
  getOrderById(orderId: string): Promise<OrderResponse | undefined>;
}
