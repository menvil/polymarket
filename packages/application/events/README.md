# @polymarket/application-events

Canonical contracts application-level событий: пакет отвечает на вопрос
**«что произошло»** на уровне приложения и ничего не знает о том, **«как это
доставляется»**.

## Контуры событий системы

- **Application events (этот пакет)** — semantic-уведомления application-слоя:
  fill-контур (`FILL_RECEIVED`, …), рыночные данные (`BOOK_UPDATED`, …),
  сигналы стратегий (`STRATEGY_SIGNAL`), legacy-lifecycle старого рантайма
  (`MARKET_OPENED`/`MARKET_CLOSED`), lifecycle нового торгового рантайма
  (`TRADING_MARKET_ADMITTED`, …), venue-обновления ордеров
  (`ORDER_UPDATE_RECEIVED`).
- **Domain events** — определяются в своих Domain-пакетах. `OrderEvent` живёт
  в `@polymarket/order-events` и в `ApplicationEvent` **НЕ входит** — это
  отдельный semantic-контур. Union контура доставки, объединяющий оба
  (`EventBusEvent = ApplicationEvent | OrderEvent`), определён в
  `@polymarket/event-bus`; нужен именно `OrderEvent` — импортируй из
  `@polymarket/order-events`.
- **External source messages** — НЕ являются `ApplicationEvent`; будущий
  infrastructure-контур внешних сообщений будет отдельным.

## Зависимости и границы

Event definitions не зависят от `@polymarket/event-bus` и
`@polymarket/message-bus` — только от Domain/Foundation-типов
(`@polymarket/ids`, `@polymarket/value-objects`, `@polymarket/fill`,
`@polymarket/order`, `@polymarket/orderbook`, `@polymarket/market`). Обратные
зависимости (events → bus, domain → events) запрещены.

```text
@polymarket/event-bus        ← доставка (Application-фасад)
        ↓
@polymarket/application-events  ← контракты (этот пакет)
        ↓
domain / foundation
```

## Структура

Один публичный contract/type — один PascalCase-файл; папки — по контурам:

```text
src/
├── fill/               FillReceivedEvent, FillConfirmedEvent,
│                       FillFailedEvent, DirectFillAppliedEvent
├── market-data/        TopOfBook, BookUpdatedEvent, BookDepthEvent,
│                       TradeReceivedEvent
├── strategy/           SignalDirection, StrategySignalEvent
├── market-lifecycle/   MarketCloseReason, MarketOpenedEvent, MarketClosedEvent
│                       (legacy: аллокация старого рантайма)
├── trading-market-lifecycle/
│                       TradingMarketAdmittedEvent, TradingMarketActivatedEvent,
│                       TradingMarketClosedEvent, TradingMarketResolvedEvent,
│                       TradingMarketFinalizedEvent
├── venue-order/        VenueOrderUpdate, OrderUpdateReceivedEvent
├── ApplicationEvent.ts канонический union контура
└── index.ts            публичные exports
```

## Использование

```typescript
import type {
  ApplicationEvent,
  FillReceivedEvent,
  MarketOpenedEvent,
  StrategySignalEvent,
} from '@polymarket/application-events';

// Доставка — отдельный пакет:
import { EventBus, type IEventBus } from '@polymarket/event-bus';
```

События — canonical MessageEnvelope (M-003): каждый member union-а имеет форму
`{ type, payload, metadata }` (contract — `@polymarket/messages`). Semantic-данные
живут в `payload`; `metadata` (identity, runId, sequence, createdAt + hi-res
компоненты, correlation/causation) обязательна и создаётся producer-ом через
canonical `MessageMetadataGenerator` ДО публикации:

```typescript
const event = {
  type: 'FILL_RECEIVED',
  payload: { fill, receivedAt },
  metadata: metadataGenerator.nextRoot(), // root: первичная реакция на внешнее наблюдение
} satisfies FillReceivedEvent;

// Реакция на сообщение — child (наследует causal chain):
const reaction = {
  type: 'DIRECT_FILL_APPLIED',
  payload: { fill },
  metadata: metadataGenerator.nextChild(parent.metadata),
} satisfies DirectFillAppliedEvent;

// Потребители читают semantic-данные из payload:
eventBus.subscribe('FILL_RECEIVED', (event) => {
  processFill.execute(event.payload.fill, event.metadata);
});
```

## Два поколения lifecycle-событий рынка

В union живут оба набора, и они описывают разные вещи.

| контур | события | смысл |
| --- | --- | --- |
| legacy (`market-lifecycle/`) | `MARKET_OPENED`, `MARKET_CLOSED` | управление старым рантаймом: аллокация баланса, `strategyId`, освобождение и realized PnL |
| trading runtime (`trading-market-lifecycle/`) | `TRADING_MARKET_ADMITTED`, `TRADING_MARKET_ACTIVATED`, `TRADING_MARKET_CLOSED`, `TRADING_MARKET_RESOLVED`, `TRADING_MARKET_FINALIZED` | жизненный цикл рынка в НАШЕМ торговом рантайме |

Legacy-набор **не является** canonical trading lifecycle: у него нет ни
admission, ни резолюции, ни финализации, а `marketId` идёт вместе с
аллокацией. Он остаётся, пока у него есть legacy-потребители, и его семантика
не меняется. Новый набор — отдельные имена и отдельные payload'ы.

Новый lifecycle ещё и отделён от внешнего состояния рынка:

```text
Market.state             ACTIVE → CLOSED → RESOLVED
                         внешнее состояние на площадке; мы его наблюдаем

TradingMarketLifecycle   ADMITTED → ACTIVE → TRADING_CLOSED → RESOLVED → FINALIZED
                         что наш рантайм делает с этим рынком
```

`TRADING_MARKET_ADMITTED` и `TRADING_MARKET_RESOLVED` несут canonical
`Market` целиком: он уже является границей «инфраструктура → приложение», и
второе представление рынка (`TradingMarketDto`) пришлось бы синхронизировать
с первым. Победивший исход берётся из `market.resolvedOutcome`, а не из
отдельного поля payload. Времена переходов — `event.metadata.createdAt`,
отдельных `admittedAt`/`resolvedAt` в payload нет.

Producer'а у этих событий пока нет: admission принадлежит будущему
owner/composition-слою над `MarketUniverse` + Policy + Subscription Planner.
Discovery и Planner о них не знают. Единственный подписчик —
`TradingStateProjector` из `@polymarket/trading-state`.
