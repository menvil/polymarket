/**
 * Domain events для Order
 *
 * @remarks
 * События — факты, которые уже произошли.
 * Используются в режиме replay: Order.fromEvents(events) воспроизводит
 * историю без валидации.
 *
 * Отличие от команд (accept(), applyFill()):
 * - Команда — намерение (нуждается в валидации, может вернуть ошибку)
 * - Событие — факт (применяется без валидации)
 */

import type { OrderId } from '@polymarket/ids';
import type { Price, Quantity, Side, Timestamp } from '@polymarket/value-objects';
import type { AssetId } from '@polymarket/ids';
import type { FillData } from './OrderState.js';

export interface OrderCreatedEvent {
  readonly type: 'ORDER_CREATED';
  readonly orderId: OrderId;
  readonly asset: AssetId;
  readonly side: Side;
  readonly price: Price;
  readonly size: Quantity;
  readonly timestamp: Timestamp;
  readonly strategyId?: string;
}

export interface OrderAcceptedEvent {
  readonly type: 'ORDER_ACCEPTED';
  readonly orderId: OrderId;
}

export interface OrderRejectedEvent {
  readonly type: 'ORDER_REJECTED';
  readonly orderId: OrderId;
  readonly reason: string;
}

export interface OrderCancelledEvent {
  readonly type: 'ORDER_CANCELLED';
  readonly orderId: OrderId;
  readonly reason: string;
}

export interface OrderExpiredEvent {
  readonly type: 'ORDER_EXPIRED';
  readonly orderId: OrderId;
}

export interface FillAppliedEvent {
  readonly type: 'FILL_APPLIED';
  readonly orderId: OrderId;
  readonly fill: FillData;
}

export type OrderEvent =
  | OrderCreatedEvent
  | OrderAcceptedEvent
  | OrderRejectedEvent
  | OrderCancelledEvent
  | OrderExpiredEvent
  | FillAppliedEvent;
