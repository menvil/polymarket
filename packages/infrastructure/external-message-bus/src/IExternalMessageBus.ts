import type { IMessageBus } from '@polymarket/message-bus';
import type { AnyExternalMessage } from '@polymarket/external-messages';

/**
 * Порт доставки внешних сообщений — Infrastructure-контур системы.
 *
 * @remarks
 * Намеренно ЧИСТЫЙ type alias к generic-порту {@link IMessageBus}: контракт
 * доставки внешнего контура технически совпадает с canonical-контрактом
 * движка (FIFO, typed-подписки, Result-based operational-ошибки, lifecycle,
 * stats). Дублировать сигнатуры вручную означало бы завести второй источник
 * истины, который разъедется с движком при первом же его расширении.
 *
 * Отличие от Application `IEventBus` — semantic, а не технический:
 *
 * - `IEventBus` доставляет ВНУТРЕННИЕ Application/Domain-события и намеренно
 *   СКРЫВАЕТ generic lifecycle (`drain`/`close`), потому что Application-слою
 *   он не принадлежит;
 * - `IExternalMessageBus` доставляет source-native НАБЛЮДЕНИЯ и lifecycle
 *   ОТКРЫВАЕТ: transport lifecycle, graceful shutdown и будущий Reader/replay
 *   реально нуждаются в `drain()`/`close()` (Infrastructure-контур — законный
 *   владелец этих операций).
 *
 * Собственных technical types внешний контур не заводит:
 * `MessageHandler`, `MessageBusStats`, `MessageBusPublishError`,
 * `MessageBusDrainError`, `MessageBusOptions`, `MessageBusPolicy`,
 * `MessageBusObserver` — canonical и импортируются у `@polymarket/message-bus`.
 *
 * @typeParam TMessage - Discriminated union КОНКРЕТНЫХ внешних сообщений
 *   контура (не {@link AnyExternalMessage}: widening уничтожает narrowing)
 *
 * @example
 * ```typescript
 * type VenueExternalMessage =
 *   | ExternalMessage<'VENUE_BOOK', VenueBookPayload>
 *   | ExternalMessage<'VENUE_TRADE', VenueTradePayload>;
 *
 * function attachRecorder(bus: IExternalMessageBus<VenueExternalMessage>): void {
 *   bus.subscribe('VENUE_BOOK', (message) => recorder.write(message));
 * }
 * ```
 */
export type IExternalMessageBus<TMessage extends AnyExternalMessage> = IMessageBus<TMessage>;
