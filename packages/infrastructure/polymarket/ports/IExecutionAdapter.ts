/**
 * Порт исполнения ордеров.
 *
 * @remarks
 * Инфраструктурный интерфейс — реализуется PolymarketExecutionAdapter.
 * Не зависит от domain-пакетов.
 */

/** Параметры для размещения ордера */
export interface PlaceOrderParams {
  tokenId: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
  priceTick?: number;
  feeRateBps?: number;
  /** ID стратегии для изоляции multi-strategy */
  strategyId?: string;
}

/** Ответ биржи на размещение ордера */
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

/** Информация об исполнении (fill) */
export interface FillResponse {
  fillId: string;
  orderId: string;
  price: number;
  size: number;
  side: 'buy' | 'sell';
  tokenId: string;
  timestamp: number;
}

/**
 * Интерфейс для исполнения ордеров через биржевой API.
 *
 * @remarks
 * getOrderById возвращает упрощённый ответ API (не полный OrderResponse).
 */
export interface IExecutionAdapter {
  postOrder(params: PlaceOrderParams): Promise<OrderResponse>;
  cancelOrder(orderId: string): Promise<void>;
  getOpenOrders(tokenId?: string): Promise<OrderResponse[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getOrderById(orderId: string): Promise<any>;
  getFills(orderId: string): Promise<FillResponse[]>;
}
