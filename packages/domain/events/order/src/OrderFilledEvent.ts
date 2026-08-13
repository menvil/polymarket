/**
 * Событие полного исполнения заявки
 *
 * @remarks
 * Несёт финальный fill + итоговую VWAP цену.
 * После этого события заявка переходит в терминальный статус FILLED.
 */
import type { OrderId } from '@polymarket/ids';
import type { Price } from '@polymarket/value-objects';
import type { FillData } from '@polymarket/fill';

export interface OrderFilledEvent {
  readonly type: 'ORDER_FILLED';
  readonly orderId: OrderId;
  readonly fill: FillData;        // последний fill
  readonly averagePrice: Price;   // итоговая VWAP
}
