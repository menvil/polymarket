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
 * - **Domain-сущности** событий не публикуют (`Order` — immutable-сущность);
 * - **External source messages** — НЕ являются ApplicationEvent: они идут по
 *   `ExternalMessageBus` и превращаются в ApplicationEvent semantic-адаптерами.
 *
 * `IEventBus` (`@polymarket/event-bus`) доставляет ровно {@link ApplicationEvent}.
 *
 * @example
 * ```typescript
 * import type {
 *   ApplicationEvent,
 *   FillReceivedEvent,
 *   MarketOpenedEvent,
 *   TradingAccountFillAppliedEvent,
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
/** Рыночные события стакана/тейпа/референсных цен (см. market-data/). */
export type {
  TopOfBook,
  BookUpdatedEvent,
  BookDepthEvent,
  TradeReceivedEvent,
  TickSizeChangedEvent,
  ReferencePriceFeed,
  ReferencePriceUpdatedEvent,
} from './market-data/index.js';
/** Сигналы стратегий (см. strategy/). */
export type { SignalDirection, StrategySignalEvent } from './strategy/index.js';
/**
 * Legacy-события жизненного цикла старого рантайма (см. market-lifecycle/).
 *
 * @remarks
 * Аллокация баланса и запуск/остановка старой стратегии. НЕ canonical trading
 * lifecycle — новый контур ниже.
 */
export type {
  MarketCloseReason,
  MarketOpenedEvent,
  MarketClosedEvent,
} from './market-lifecycle/index.js';
/**
 * Lifecycle рынка в новом торговом рантайме (см. trading-market-lifecycle/).
 *
 * @remarks
 * `ADMITTED → ACTIVE → TRADING_CLOSED → RESOLVED → FINALIZED` — состояние
 * НАШЕГО рантайма, отдельное от внешнего `Market.state` площадки.
 */
export type {
  TradingMarketAdmittedEvent,
  TradingMarketActivatedEvent,
  TradingMarketClosedEvent,
  TradingMarketResolvedEvent,
  TradingMarketFinalizedEvent,
} from './trading-market-lifecycle/index.js';
/**
 * Приватный контур торгового аккаунта (см. trading-account/).
 *
 * @remarks
 * POST-COMMIT факты о НАС: инициализация аккаунта, итоговый `Order` вместе с
 * итоговым `Portfolio`, применение/подтверждение/откат исполнения. Отдельный
 * read-model (`AccountHotState`), не сливающийся с рыночным.
 *
 * `TRADING_ACCOUNT_RECONCILED` — authoritative batch-коррекция того же
 * состояния от сверки аккаунта (CAS по версии, одна мутация).
 */
export type {
  TradingAccountInitializedEvent,
  TradingAccountOrderCommittedEvent,
  TradingAccountFillAppliedEvent,
  TradingAccountFillConfirmedEvent,
  TradingAccountFillRevertedEvent,
  TradingAccountFillVenueStatusObservedEvent,
  TradingAccountReconciledEvent,
} from './trading-account/index.js';
/** Venue-обновления ордеров (см. venue-order/). */
export type { VenueOrderUpdate, OrderUpdateReceivedEvent } from './venue-order/index.js';
/** Canonical union application-owned событий (см. ApplicationEvent.ts). */
export type { ApplicationEvent } from './ApplicationEvent.js';
