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
 *
 * Market-data события:
 * - BOOK_UPDATED / BOOK_DEPTH — верхушка и полный стакан инструмента
 * - TRADE_RECEIVED — публичный маркет-принт
 * - TICK_SIZE_CHANGED — venue сменил шаг цены (вход последующего execution)
 *
 * Market-data события несут `venueId`/`marketId?`/`instrumentId` — ту же
 * идентичность, что и Domain-сущность стакана, — и параметризованы ценовым
 * доменом, поэтому одинаково пригодны для рынка предсказаний и для биржи.
 * - REFERENCE_PRICE_UPDATED — цена ВНЕШНЕГО актива (BTC/USD); отдельный
 *   канал, потому что `OutcomePrice` рынка предсказаний ограничен `[0.0001, 0.9999]`
 *   и физически не может её представить
 */
import type { FillReceivedEvent, FillConfirmedEvent, FillFailedEvent, DirectFillAppliedEvent } from './fill/index.js';
import type { DecimalPrice } from '@polymarket/value-objects';
import type {
  BookUpdatedEvent,
  BookDepthEvent,
  TradeReceivedEvent,
  TickSizeChangedEvent,
  ReferencePriceUpdatedEvent,
} from './market-data/index.js';
import type { StrategySignalEvent } from './strategy/index.js';
import type { MarketOpenedEvent, MarketClosedEvent } from './market-lifecycle/index.js';
import type { OrderUpdateReceivedEvent } from './venue-order/index.js';

export type ApplicationEvent =
  | FillReceivedEvent
  | FillConfirmedEvent
  | FillFailedEvent
  | DirectFillAppliedEvent
  // Market-data события параметризованы САМЫМ ШИРОКИМ ценовым доменом:
  // `BookDepthEvent<OutcomePrice>` и `BookDepthEvent<AssetPrice>` в него
  // присваиваются оба (поля readonly → ковариантность). Зафиксировать здесь
  // `OutcomePrice` значило бы сделать канонический union prediction-only и
  // заставить CEX-адаптер заводить ВТОРОЙ тип события — ту же типовую стену,
  // только слоем выше.
  | BookUpdatedEvent<DecimalPrice>
  | BookDepthEvent<DecimalPrice>
  | TradeReceivedEvent<DecimalPrice>
  | TickSizeChangedEvent
  | ReferencePriceUpdatedEvent
  | StrategySignalEvent
  | MarketOpenedEvent
  | MarketClosedEvent
  | OrderUpdateReceivedEvent;
