/**
 * Полный union application-owned событий — canonical contract Application-слоя.
 *
 * @remarks
 * Содержит ТОЛЬКО события, которыми владеет Application. Domain-события Order
 * (`OrderEvent` из `@polymarket/order-events`) сюда НЕ входят: это отдельный
 * semantic-контур. Union контура доставки, объединяющий оба —
 * `EventBusEvent = ApplicationEvent | OrderEvent` — определён в
 * `@polymarket/event-bus` (это union доставки, а не принадлежности к слою).
 *
 * User-channel события:
 * - FILL_RECEIVED — fill со статусом MATCHED → запустить ProcessFillUseCase
 * - FILL_FAILED   — fill со статусом FAILED → alert + reconciliation
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
  | OrderUpdateReceivedEvent;
