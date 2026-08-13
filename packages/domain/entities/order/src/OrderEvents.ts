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

import type { AccountId, OrderId } from '@polymarket/ids';
import type { Price, Quantity, Side, Timestamp } from '@polymarket/value-objects';
import type { AssetId } from '@polymarket/ids';
import type { FillData } from './OrderState.js';

/** Событие создания заявки (первое событие в истории любого Order). */
export interface OrderCreatedEvent {
  readonly type: 'ORDER_CREATED';
  readonly orderId: OrderId;
  readonly asset: AssetId;
  readonly side: Side;
  readonly price: Price;
  readonly size: Quantity;
  readonly timestamp: Timestamp;
  readonly strategyId?: string;
  /** ID аккаунта-владельца заявки (для ownership-проверок execution-слоя) */
  readonly accountId?: AccountId;
}

/** Событие подтверждения заявки биржей (переход в статус OPEN). */
export interface OrderAcceptedEvent {
  readonly type: 'ORDER_ACCEPTED';
  readonly orderId: OrderId;
}

/** Событие отклонения заявки биржей до исполнения (терминальный статус REJECTED). */
export interface OrderRejectedEvent {
  readonly type: 'ORDER_REJECTED';
  readonly orderId: OrderId;
  readonly reason: string;
  readonly strategyId?: string;
}

/** Событие отмены заявки (терминальный статус CANCELLED). */
export interface OrderCancelledEvent {
  readonly type: 'ORDER_CANCELLED';
  readonly orderId: OrderId;
  readonly reason: string;
}

/** Событие истечения срока действия заявки (терминальный статус EXPIRED). */
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

/** Объединение всех domain-событий Order — используется в `Order.fromEvents()` (replay) и event-логе. */
export type OrderEvent =
  | OrderCreatedEvent
  | OrderAcceptedEvent
  | OrderRejectedEvent
  | OrderCancelledEvent
  | OrderExpiredEvent
  | OrderPartiallyFilledEvent
  | OrderFilledEvent;
