/**
 * Venue-обновление статуса ордера получено из WS (первичное событие).
 *
 * @remarks
 * Публикуется тонким `OrderUpdateHandler` при получении события из WS order-channel.
 * `OrderUpdateOrchestrator` подписывается и вызывает `UpdateOrderStatusUseCase`,
 * передавая `event.metadata` как parent порождаемых Order-событий (causal chain).
 *
 * ### Жизненный цикл:
 * ```
 * WS order-channel → OrderUpdateHandler.handle()
 *   → EventBus.publish(ORDER_UPDATE_RECEIVED)
 *   → OrderUpdateOrchestrator → UpdateOrderStatusUseCase
 * ```
 *
 * Canonical envelope `{ type, payload, metadata }` (M-003): root-событие —
 * первичная реакция на внешнее WS-наблюдение.
 */
import type { MessageEnvelope } from '@polymarket/messages';
import type { AccountId } from '@polymarket/ids';
import type { Timestamp } from '@polymarket/timestamp';
import type { VenueOrderUpdate } from './VenueOrderUpdate.js';

export type OrderUpdateReceivedEvent = MessageEnvelope<
  'ORDER_UPDATE_RECEIVED',
  {
    /** Venue-обновление с типом и orderId */
    readonly update: VenueOrderUpdate;
    /** ID аккаунта — для операций с Portfolio (release reservation) */
    readonly accountId: AccountId;
    /** Метка времени получения события из WS */
    readonly receivedAt: Timestamp;
  }
>;
