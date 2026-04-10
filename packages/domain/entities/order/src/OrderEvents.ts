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
  readonly strategyId?: string;
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

/**
 * Событие частичного исполнения заявки
 *
 * @remarks
 * Несёт данные fill + накопленное состояние для удобства подписчиков.
 * Подписчику не нужно самостоятельно считать filledSize и remainingSize.
 */
export interface OrderPartiallyFilledEvent {
  readonly type: 'ORDER_PARTIALLY_FILLED';
  readonly orderId: OrderId;
  readonly fill: FillData;
  readonly filledSize: Quantity;    // накопленный объём после этого fill
  readonly remainingSize: Quantity; // остаток после этого fill
}

/**
 * Событие полного исполнения заявки
 *
 * @remarks
 * Несёт финальный fill + итоговую VWAP цену.
 * После этого события заявка переходит в терминальный статус FILLED.
 */
export interface OrderFilledEvent {
  readonly type: 'ORDER_FILLED';
  readonly orderId: OrderId;
  readonly fill: FillData;        // последний fill
  readonly averagePrice: Price;   // итоговая VWAP
}

export type OrderEvent =
  | OrderCreatedEvent
  | OrderAcceptedEvent
  | OrderRejectedEvent
  | OrderCancelledEvent
  | OrderExpiredEvent
  | OrderPartiallyFilledEvent
  | OrderFilledEvent;
