# @polymarket/application-events

Canonical contracts application-level событий: пакет отвечает на вопрос
**«что произошло»** на уровне приложения и ничего не знает о том, **«как это
доставляется»**.

## Контуры событий системы

- **Application events (этот пакет)** — semantic-уведомления application-слоя:
  fill-контур (`FILL_RECEIVED`, …), рыночные данные (`BOOK_UPDATED`, …),
  сигналы стратегий (`STRATEGY_SIGNAL`), legacy-lifecycle старого рантайма
  (`MARKET_OPENED`/`MARKET_CLOSED`), lifecycle нового торгового рантайма
  (`TRADING_MARKET_ADMITTED`, …), приватный контур торгового аккаунта
  (`TRADING_ACCOUNT_INITIALIZED`, …), venue-обновления ордеров
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
`@polymarket/order`, `@polymarket/portfolio`, `@polymarket/orderbook`,
`@polymarket/market`). Обратные зависимости (events → bus, domain → events)
запрещены — ни `Order`, ни `Portfolio` от этого пакета не зависят, поэтому
цикла нет.

`Portfolio` и `Order` попали в зависимости сознательно: приватные события
несут итоговые domain-снимки, и заводить рядом `AccountPortfolioDto` ради
«чистоты» значило бы получить второе представление тех же денег и обязанность
держать его согласованным с первым.

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
├── trading-account/    TradingAccountInitializedEvent,
│                       TradingAccountOrderCommittedEvent,
│                       TradingAccountFillAppliedEvent,
│                       TradingAccountFillConfirmedEvent,
│                       TradingAccountFillRevertedEvent
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

Идентичность рынка во всём новом контуре — **пара** `venueId + marketId`:
`MarketId` уникален только внутри пространства имён площадки (то же правило,
что у `Market.equals()` и ключа `MarketUniverse`). События с `Market` дают её
через сам рынок, `TRADING_MARKET_ACTIVATED`/`CLOSED`/`FINALIZED` — двумя полями
payload. По той же причине `TICK_SIZE_CHANGED` получил `venueId`: он был
единственным market-data событием без площадки.

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

## Приватный контур торгового аккаунта

Рыночные события отвечают на вопрос «что происходит на рынке». Приватные —
«что происходит с НАМИ».

| событие | что несёт | смысл |
| --- | --- | --- |
| `TRADING_ACCOUNT_INITIALIZED` | `venueId`, `accountId`, `Portfolio` | рантайм начал вести этот аккаунт |
| `TRADING_ACCOUNT_ORDER_COMMITTED` | `venueId`, `accountId`, `Order`, `Portfolio` | операция над заявкой зафиксирована, вот итог |
| `TRADING_ACCOUNT_FILL_APPLIED` | `Fill`, `Portfolio`, `Order?` | экономика исполнения УЖЕ применена |
| `TRADING_ACCOUNT_FILL_CONFIRMED` | `Fill` | исполнение достигло финальности |
| `TRADING_ACCOUNT_FILL_REVERTED` | `Fill`, `Portfolio`, `Order?`, `reason` | применённое исполнение откачено |
| `TRADING_ACCOUNT_FILL_VENUE_STATUS_OBSERVED` | `Fill`, `TradeStatus` | площадка сообщила статус; экономика не меняется |

Первые пять — **POST-COMMIT**:

```text
приватное наблюдение / команда
  ↓
domain/execution processing        ← здесь считается ВСЯ экономика
  ↓
post-commit Order / Portfolio / Fill
  ↓
TRADING_ACCOUNT_*                  ← здесь уже только итог
  ↓
IEventBus → AccountStateProjector → AccountHotState
```

### Две оси у исполнения

```text
что сделали МЫ        APPLIED → CONFIRMED | REVERTED    экономика
что говорит ПЛОЩАДКА  MATCHED → MINED → CONFIRMED       TradeStatus
                             ↘ RETRYING ↘ FAILED
```

`MATCHED` — матчер Polymarket (off-chain), `MINED` — блок Polygon. Утверждения
о разных системах, и разница между ними — реальная разница в риске отката.

`MINED` и `RETRYING` не имеют экономических двойников: они не меняют ни
портфель, ни заявку. `TRADING_ACCOUNT_FILL_VENUE_STATUS_OBSERVED` — единственное
событие, которым они могут приехать.

Статус типизирован существующим `TradeStatus` из `@polymarket/fill` (его штатный
носитель — `ExecutionMetadata.tradeStatus`), а не своим enum: тот же union уже
продублирован как `VenueTradeStatus` в `@polymarket/ports`, и третья копия была
бы лишней.

### Почему не переиспользованы старые события

| старое событие | что оно на самом деле означает |
| --- | --- |
| `FILL_RECEIVED` | исполнение получено и **ещё должно быть обработано** |
| `FILL_CONFIRMED` | finality в терминах старого use-case flow |
| `FILL_FAILED` | откат **считает подписчик** |
| `DIRECT_FILL_APPLIED` | эффект применён вне обычного flow |
| `ORDER_UPDATE_RECEIVED` | сырой `VenueOrderUpdate` — **без `Order` и без `Portfolio`** |

Все они описывают ВХОД старого контура обработки, а не его итог. Построить на
них новое состояние значило бы унаследовать чужие гарантии. Семантика старых
событий не меняется — они остаются своим потребителям.

Domain `OrderEvent` (`ORDER_CREATED`, `ORDER_ACCEPTED`, …) новый контур тоже
не заменяет и не использует напрямую: они описывают переход агрегата и не
несут портфель, а приватному состоянию нужна атомарная пара `Order +
Portfolio`.

### Идентичность и время

`venueId` в приватных событиях обязателен там, где его не даёт полезная
нагрузка: у `TRADING_ACCOUNT_INITIALIZED` и `TRADING_ACCOUNT_ORDER_COMMITTED`
он в payload, а у fill-событий берётся из самого `Fill` (`fill.venueId`,
`fill.accountId`) — дублировать его рядом значило бы завести второе место,
обязанное совпадать с первым.

Времена переходов — `event.metadata.createdAt`. Отдельных `initializedAt`,
`appliedAt`, `confirmedAt` в payload нет.

Producer'а у этих событий пока нет: приватный процессор и account reconciler
— следующие MR. Единственный подписчик — `AccountStateProjector` из
`@polymarket/account-state`.
