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
export type { FillReceivedEvent, FillFailedEvent } from './domain-events.js';
export type {
  TopOfBook,
  BookUpdatedEvent,
  BookDepthEvent,
  TradeReceivedEvent,
} from './market-events.js';
export type { RiskViolationType, RiskLimitBreachedEvent } from './risk-events.js';
export type { SignalDirection, StrategySignalEvent } from './strategy-events.js';

// Re-export Order domain events (из @polymarket/order)
export type { OrderEvent } from '@polymarket/order';

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
 */
import type { FillReceivedEvent, FillFailedEvent } from './domain-events.js';
import type { BookUpdatedEvent, BookDepthEvent, TradeReceivedEvent } from './market-events.js';
import type { RiskLimitBreachedEvent } from './risk-events.js';
import type { StrategySignalEvent } from './strategy-events.js';
import type { OrderEvent } from '@polymarket/order';

export type ApplicationEvent =
  | FillReceivedEvent
  | FillFailedEvent
  | BookUpdatedEvent
  | BookDepthEvent
  | TradeReceivedEvent
  | RiskLimitBreachedEvent
  | StrategySignalEvent
  | OrderEvent;
