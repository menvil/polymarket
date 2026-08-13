/**
 * Полный union application-level событий — canonical contract контура.
 *
 * @remarks
 * Используется в:
 * - IEventBus<K extends ApplicationEvent['type']> для типобезопасных подписок
 * - MessageBus<ApplicationEvent> как generic-параметр движка доставки
 * - EventBus.publish(event: ApplicationEvent)
 *
 * `OrderEvent` из `@polymarket/order` участвует в union как REFERENCE на
 * Domain-тип: его определение остаётся в Domain, и этот пакет его сознательно
 * НЕ реэкспортирует — потребителю, которому нужен именно `OrderEvent`,
 * следует импортировать его из `@polymarket/order`.
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
import type { FillReceivedEvent, FillConfirmedEvent, FillFailedEvent, DirectFillAppliedEvent } from './fill/index.js';
import type { BookUpdatedEvent, BookDepthEvent, TradeReceivedEvent } from './market-data/index.js';
import type { StrategySignalEvent } from './strategy/index.js';
import type { MarketOpenedEvent, MarketClosedEvent } from './market-lifecycle/index.js';
import type { OrderUpdateReceivedEvent } from './venue-order/index.js';
import type { OrderEvent } from '@polymarket/order';

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
