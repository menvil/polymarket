/**
 * Событие частичного исполнения заявки
 *
 * @remarks
 * Несёт данные fill + накопленное состояние для удобства подписчиков.
 * Подписчику не нужно самостоятельно считать filledSize и remainingSize.
 */
import type { OrderId } from '@polymarket/ids';
import type { Quantity } from '@polymarket/value-objects';
import type { FillData } from '@polymarket/fill';

export interface OrderPartiallyFilledEvent {
  readonly type: 'ORDER_PARTIALLY_FILLED';
  readonly orderId: OrderId;
  readonly fill: FillData;
  readonly filledSize: Quantity;    // накопленный объём после этого fill
  readonly remainingSize: Quantity; // остаток после этого fill
}
