/**
 * @polymarket/external-message-bus — контур доставки внешних сообщений.
 *
 * @remarks
 * Второй semantic delivery contour системы поверх ОДНОГО generic движка
 * доставки (`@polymarket/message-bus`):
 *
 * ```text
 *                  MessageBus<T>
 *                 /             \
 *   Application EventBus     ExternalMessageBus
 *            │                        │
 *     EventBusEvent             ExternalMessage
 *            │                        │
 *   semantic internal           source-native
 *        events                 observations
 * ```
 *
 * Пакет — тонкий фасад (композиция, не наследование): собственной очереди,
 * fan-out, lifecycle-механики, stats и error-классов у него нет. Технические
 * типы (`MessageHandler`, `MessageBusOptions`, `MessageBusPolicy`,
 * `MessageBusObserver`, `MessageBusStats`, ошибки) остаются canonical и
 * импортируются у `@polymarket/message-bus`; контракт сообщения — у
 * `@polymarket/external-messages`. Этот пакет их НЕ реэкспортирует.
 *
 * @example
 * ```typescript
 * import { ExternalMessageBus } from '@polymarket/external-message-bus';
 * import type { ExternalMessage } from '@polymarket/external-messages';
 *
 * type VenueExternalMessage =
 *   | ExternalMessage<'VENUE_BOOK', { readonly bids: readonly number[] }>
 *   | ExternalMessage<'VENUE_TRADE', { readonly price: number }>;
 *
 * const bus = new ExternalMessageBus<VenueExternalMessage>();
 * bus.subscribe('VENUE_TRADE', (message) => adapter.onTrade(message.payload.price));
 * await bus.publish({
 *   type: 'VENUE_TRADE',
 *   payload: decodeVenueTrade(rawFrame),
 *   metadata: metadataGenerator.nextRoot(),
 * });
 * ```
 */
/** Порт внешнего контура — type alias к generic IMessageBus (см. IExternalMessageBus.ts). */
export type { IExternalMessageBus } from './IExternalMessageBus.js';
/** Фасад над MessageBus для внешних сообщений (см. ExternalMessageBus.ts). */
export { ExternalMessageBus } from './ExternalMessageBus.js';
