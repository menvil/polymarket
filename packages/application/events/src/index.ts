/**
 * @polymarket/application-events — canonical contracts application-level событий.
 *
 * @remarks
 * Пакет отвечает на вопрос «ЧТО произошло» на уровне приложения и ничего не
 * знает о том, «КАК это доставляется»: никаких зависимостей на
 * `@polymarket/event-bus` / `@polymarket/message-bus` здесь нет и быть не должно.
 *
 * ### Контуры событий системы:
 * - **Application events** (этот пакет) — semantic-уведомления application-слоя;
 * - **Domain events** — определяются в своих Domain-пакетах (например,
 *   `OrderEvent` в `@polymarket/order`; union {@link ApplicationEvent} лишь
 *   ссылается на него, не владея определением);
 * - **External source messages** — НЕ являются ApplicationEvent; будущий
 *   infrastructure-контур внешних сообщений будет отдельным.
 *
 * @example
 * ```typescript
 * import type {
 *   ApplicationEvent,
 *   FillReceivedEvent,
 *   MarketOpenedEvent,
 * } from '@polymarket/application-events';
 * import { EventBus, type IEventBus } from '@polymarket/event-bus';
 * ```
 */
/** Application-события исполнения ордеров (см. fill/). */
export type {
  FillReceivedEvent,
  FillConfirmedEvent,
  FillFailedEvent,
  DirectFillAppliedEvent,
} from './fill/index.js';
/** Рыночные события стакана/тейпа (см. market-data/). */
export type {
  TopOfBook,
  BookUpdatedEvent,
  BookDepthEvent,
  TradeReceivedEvent,
} from './market-data/index.js';
/** Сигналы стратегий (см. strategy/). */
export type { SignalDirection, StrategySignalEvent } from './strategy/index.js';
/** События жизненного цикла рынка (см. market-lifecycle/). */
export type {
  MarketCloseReason,
  MarketOpenedEvent,
  MarketClosedEvent,
} from './market-lifecycle/index.js';
/** Venue-обновления ордеров (см. venue-order/). */
export type { VenueOrderUpdate, OrderUpdateReceivedEvent } from './venue-order/index.js';
/** Canonical union контура (см. ApplicationEvent.ts). OrderEvent не реэкспортируется. */
export type { ApplicationEvent } from './ApplicationEvent.js';
