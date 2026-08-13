/**
 * Venue-обновление статуса ордера (из Polymarket WS order-channel).
 *
 * @remarks
 * Discriminated union — тип обновления определяет доступные поля.
 * - ACCEPTED — ордер принят биржей и активен на стакане.
 * - REJECTED — ордер отклонён (невалидная цена, превышение лимита и т.д.).
 * - CANCELLED — ордер отменён (пользователем или биржей).
 * - EXPIRED — ордер истёк по TTL.
 */
import type { OrderId } from '@polymarket/ids';

export type VenueOrderUpdate =
  | { readonly type: 'ACCEPTED';  readonly orderId: OrderId }
  | { readonly type: 'REJECTED';  readonly orderId: OrderId; readonly reason: string }
  | { readonly type: 'CANCELLED'; readonly orderId: OrderId; readonly reason?: string }
  | { readonly type: 'EXPIRED';   readonly orderId: OrderId };
