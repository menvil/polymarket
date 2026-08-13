/**
 * Venue-обновление статуса ордера получено из WS (первичное событие).
 *
 * @remarks
 * Публикуется тонким `OrderUpdateHandler` при получении события из WS order-channel.
 * `OrderUpdateOrchestrator` подписывается и вызывает `UpdateOrderStatusUseCase`.
 *
 * ### Жизненный цикл:
 * ```
 * WS order-channel → OrderUpdateHandler.handle()
 *   → EventBus.publish(ORDER_UPDATE_RECEIVED)
 *   → OrderUpdateOrchestrator → UpdateOrderStatusUseCase
 * ```
 */
import type { AccountId } from '@polymarket/ids';
import type { Timestamp } from '@polymarket/value-objects';
import type { VenueOrderUpdate } from './VenueOrderUpdate.js';

export interface OrderUpdateReceivedEvent {
  readonly type: 'ORDER_UPDATE_RECEIVED';
  /** Venue-обновление с типом и orderId */
  readonly update: VenueOrderUpdate;
  /** ID аккаунта — для операций с Portfolio (release reservation) */
  readonly accountId: AccountId;
  /** Метка времени получения события из WS */
  readonly receivedAt: Timestamp;
}
