/**
 * Событие создания заявки (первое событие в истории любого Order).
 *
 * @remarks
 * Canonical envelope `{ type, payload, metadata }` (M-003). Semantic-данные —
 * в {@link OrderCreatedPayload}; metadata materialize-ится на границе
 * `Order.pullEvents()` (Domain сам её не генерирует) и НЕ участвует в
 * replay-семантике (`Order.fromEvents()` читает только `type` + `payload`).
 */
import type { MessageEnvelope } from '@polymarket/messages';
import type { AccountId, AssetId, OrderId, StrategyId } from '@polymarket/ids';
import type { Price, Quantity, Side, Timestamp } from '@polymarket/value-objects';

/** Payload события создания заявки. */
export interface OrderCreatedPayload {
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

export type OrderCreatedEvent = MessageEnvelope<'ORDER_CREATED', OrderCreatedPayload>;
