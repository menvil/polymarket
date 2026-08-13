/**
 * События исполнения ордеров.
 *
 * @remarks
 * Внутренние события инфраструктурного слоя.
 * В Phase 2 будут заменены на ApplicationEvent из @polymarket/event-bus.
 */

/** Ордер принят биржей */
export interface OrderAccepted {
  type: 'OrderAccepted';
  orderId: string;
  strategyId?: string;
  side: 'BUY' | 'SELL';
  marketId: string;
  price: number;
  size: number;
  timestamp: Date;
}

/** Ордер отклонён биржей */
export interface OrderRejected {
  type: 'OrderRejected';
  orderId?: string;
  reason: string;
  errorCode: string;
  timestamp: Date;
}

/** Ордер отменён */
export interface OrderCancelled {
  type: 'OrderCancelled';
  orderId: string;
  reason: string;
  timestamp: Date;
}

/** Дискриминированный union событий исполнения */
export type ExecutionEvent = OrderAccepted | OrderRejected | OrderCancelled;
