/**
 * Данные одного исполнения — lightweight domain-контракт.
 *
 * @remarks
 * Нижнеуровневый контракт домена исполнений — параметр `Order.applyFill()`.
 * Живёт в `@polymarket/fill`, а не в `@polymarket/order`, чтобы контракт
 * исполнения не зависел от сущности заявки:
 *
 * ```text
 * @polymarket/fill (FillData)
 *       ↑
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
