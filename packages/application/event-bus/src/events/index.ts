/**
 * Единственный источник всех типов событий в системе.
 *
 * @remarks
 * ApplicationEvent — полный union всех событий.
 * EventHandlerMap используется EventBus для per-event-type типизации handlers.
 *
 * ### Принципы:
 * - Все типы событий определены здесь (или re-export из domain)
 * - Handlers зависят от @polymarket/event-bus для получения типов событий
 * - Никакой другой пакет не определяет application-level события
 */
export type { FillReceivedEvent, FillConfirmedEvent, FillFailedEvent, DirectFillAppliedEvent } from './domain-events.js';
/** Реэкспорт типов событий стакана/тейпа (см. market-events.ts). */
export type {
  TopOfBook,
  BookUpdatedEvent,
  BookDepthEvent,
  TradeReceivedEvent,
} from './market-events.js';
/** Реэкспорт типов сигналов стратегии (см. strategy-events.ts). */
export type { SignalDirection, StrategySignalEvent } from './strategy-events.js';
/** Реэкспорт типов lifecycle-событий рынка (см. market-lifecycle-events.ts). */
export type {
  MarketOpenedEvent,
  MarketClosedEvent,
  MarketCloseReason,
} from './market-lifecycle-events.js';
/** Реэкспорт типов venue-обновлений ордера (см. order-update-events.ts). */
export type { VenueOrderUpdate, OrderUpdateReceivedEvent } from './order-update-events.js';
// Re-export Order domain events (из @polymarket/order)
/** Реэкспорт доменных событий Order (см. @polymarket/order). */
export type { OrderEvent } from '@polymarket/order';

import type { FillReceivedEvent, FillConfirmedEvent, FillFailedEvent, DirectFillAppliedEvent } from './domain-events.js';
import type { BookUpdatedEvent, BookDepthEvent, TradeReceivedEvent } from './market-events.js';
import type { StrategySignalEvent } from './strategy-events.js';
import type { MarketOpenedEvent, MarketClosedEvent } from './market-lifecycle-events.js';
import type { OrderUpdateReceivedEvent } from './order-update-events.js';
import type { OrderEvent } from '@polymarket/order';

/**
 * Полный union всех application-level событий в системе.
 *
 * @remarks
 * Используется в:
 * - IEventBus<K extends ApplicationEvent['type']> для типобезопасных подписок
 * - HandlerMap для per-event-type хранения handlers
 * - EventBus.publish(event: ApplicationEvent)
 *
 * User-channel события:
 * - FILL_RECEIVED — fill со статусом MATCHED → запустить ProcessFillUseCase
 * - FILL_FAILED   — fill со статусом FAILED → alert + reconciliation
 * - OrderEvent (из @polymarket/order) — Order FSM transitions
 *
 * Lifecycle события:
 * - MARKET_OPENED — рынок открыт, аллоцирован баланс, запустить стратегию
 * - MARKET_CLOSED — рынок закрыт, баланс освобождён, остановить стратегию
 */
export type ApplicationEvent =
  | FillReceivedEvent
  | FillConfirmedEvent
  | FillFailedEvent
  | DirectFillAppliedEvent
  | BookUpdatedEvent
  | BookDepthEvent
  | TradeReceivedEvent
  | StrategySignalEvent
  | MarketOpenedEvent
  | MarketClosedEvent
  | OrderUpdateReceivedEvent
  | OrderEvent;
