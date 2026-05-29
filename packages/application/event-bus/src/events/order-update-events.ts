/**
 * События обновления статуса ордера от биржи (Polymarket WS order-channel).
 *
 * @remarks
 * `VenueOrderUpdate` — discriminated union venue-обновлений статуса ордера.
 * `OrderUpdateReceivedEvent` — application-level событие, публикуется тонким
 * `OrderUpdateHandler` и подхватывается `OrderUpdateOrchestrator`.
 *
 * ### Жизненный цикл:
 * ```
 * WS order-channel → OrderUpdateHandler.handle()
 *   → EventBus.publish(ORDER_UPDATE_RECEIVED)
 *   → OrderUpdateOrchestrator → UpdateOrderStatusUseCase
 * ```
 */
import type { AccountId, OrderId } from '@polymarket/ids';
import type { Timestamp } from '@polymarket/value-objects';

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
export type VenueOrderUpdate =
  | { readonly type: 'ACCEPTED';  readonly orderId: OrderId }
  | { readonly type: 'REJECTED';  readonly orderId: OrderId; readonly reason: string }
  | { readonly type: 'CANCELLED'; readonly orderId: OrderId; readonly reason?: string }
  | { readonly type: 'EXPIRED';   readonly orderId: OrderId };

/**
 * Venue-обновление статуса ордера получено из WS (первичное событие).
 *
 * @remarks
 * Публикуется тонким `OrderUpdateHandler` при получении события из WS order-channel.
 * `OrderUpdateOrchestrator` подписывается и вызывает `UpdateOrderStatusUseCase`.
 */
export interface OrderUpdateReceivedEvent {
  readonly type: 'ORDER_UPDATE_RECEIVED';
  /** Venue-обновление с типом и orderId */
  readonly update: VenueOrderUpdate;
  /** ID аккаунта — для операций с Portfolio (release reservation) */
  readonly accountId: AccountId;
  /** Метка времени получения события из WS */
  readonly receivedAt: Timestamp;
}
