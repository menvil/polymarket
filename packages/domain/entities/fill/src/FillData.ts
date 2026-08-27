/**
 * Данные одного исполнения — lightweight domain-контракт.
 *
 * @remarks
 * Общий нижнеуровневый контракт домена исполнений: параметр `Order.applyFill()`
 * и полезная нагрузка fill-событий Order (`ORDER_PARTIALLY_FILLED`/`ORDER_FILLED`
 * в `@polymarket/order-events`). Живёт в `@polymarket/fill`, чтобы
 * `@polymarket/order` и `@polymarket/order-events` могли разделять его без
 * циклической зависимости друг от друга:
 *
 * ```text
 * @polymarket/fill (FillData)
 *       ↑
 *       ├── @polymarket/order-events
 *       └── @polymarket/order
 * ```
 *
 * Это НЕ полноценная entity {@link Fill} (у той более богатый контракт:
 * account/venue/market/fee/timestamp и т.д.) — сознательно минимальный набор
 * полей одного исполнения в терминах Order-агрегата.
 */
import type { AssetId, FillId, OrderId } from '@polymarket/ids';
import type { OutcomePrice, Quantity, Side } from '@polymarket/value-objects';

export interface FillData {
  readonly id: FillId;
  readonly orderId: OrderId;
  readonly asset: AssetId;
  readonly side: Side;
  readonly size: Quantity;
  readonly price: OutcomePrice;
}
