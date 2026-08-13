/**
 * Событие создания заявки (первое событие в истории любого Order).
 */
import type { AccountId, AssetId, OrderId, StrategyId } from '@polymarket/ids';
import type { Price, Quantity, Side, Timestamp } from '@polymarket/value-objects';

export interface OrderCreatedEvent {
  readonly type: 'ORDER_CREATED';
  readonly orderId: OrderId;
  readonly asset: AssetId;
  readonly side: Side;
  readonly price: Price;
  readonly size: Quantity;
  readonly timestamp: Timestamp;
  readonly strategyId?: StrategyId;
  /** ID аккаунта-владельца заявки (для ownership-проверок execution-слоя) */
  readonly accountId?: AccountId;
}
