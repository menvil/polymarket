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
 * ### Два поколения lifecycle-событий рынка
 *
 * В union сейчас живут ОБА набора, и они описывают разные вещи. Слить их или
 * переиспользовать одни вместо других нельзя.
 *
 * **Legacy lifecycle старого рантайма** (`market-lifecycle/`):
 *
 * ```text
 * MARKET_OPENED → аллокация баланса, strategyId, запуск старой стратегии
 * MARKET_CLOSED → остановка стратегии, освобождение аллокации, realized PnL
 * ```
 *
 * Это события УПРАВЛЕНИЯ старым рантаймом, а не жизненного цикла рынка.
 * Называть их canonical trading lifecycle неверно: у них нет ни admission, ни
 * резолюции, ни финализации, а `marketId` в них сопровождается аллокацией.
 * Они остаются, пока у них есть legacy-потребители, и их семантика не меняется.
 *
 * **Новый trading runtime lifecycle** (`trading-market-lifecycle/`):
 *
 * ```text
 * TRADING_MARKET_ADMITTED  → рантайм принял рынок; несёт canonical Market
 * TRADING_MARKET_ACTIVATED → началась торговля (metadata.createdAt >= startsAt)
 * TRADING_MARKET_CLOSED    → МЫ прекратили торговать
 * TRADING_MARKET_RESOLVED  → площадка объявила исход; несёт RESOLVED Market
 * TRADING_MARKET_FINALIZED → работа по рынку закончена, состояние retained
 * ```
 *
 * Это состояние НАШЕГО торгового рантайма, и оно отдельно от внешнего
 * `Market.state` (`ACTIVE → CLOSED → RESOLVED`), которым владеет площадка.
 * Комбинация «`market.state = ACTIVE`, наш lifecycle = `TRADING_CLOSED`»
 * законна: мы уже остановились по `expiresAt`, а площадка ещё показывает
 * рынок активным.
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
import type {
  TradingMarketAdmittedEvent,
  TradingMarketActivatedEvent,
  TradingMarketClosedEvent,
  TradingMarketResolvedEvent,
  TradingMarketFinalizedEvent,
} from './trading-market-lifecycle/index.js';
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
  // Legacy lifecycle старого рантайма — управление аллокацией, не жизненный
  // цикл рынка. Не переиспользуется новым trading runtime.
  | MarketOpenedEvent
  | MarketClosedEvent
  // Lifecycle нового trading runtime — отдельный от внешнего `Market.state`.
  | TradingMarketAdmittedEvent
  | TradingMarketActivatedEvent
  | TradingMarketClosedEvent
  | TradingMarketResolvedEvent
  | TradingMarketFinalizedEvent
  | OrderUpdateReceivedEvent;
