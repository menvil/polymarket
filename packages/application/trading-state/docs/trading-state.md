# Trading Hot State

Оперативное состояние торгового рантайма. Строится из canonical application
events и ничего не знает об источниках.

```text
canonical Application Events → IEventBus → TradingStateProjector → TradingHotState
```

## Инварианты

1. **`TradingStateProjector` — единственный писатель.** Обработчики одного
   события в `IEventBus` выполняются параллельно, поэтому несколько
   независимых подписчиков писали бы состояние вперемешку с неопределённым
   порядком эффектов. Правило держится не комментарием: конкретные
   mutable-классы из пакета **не экспортируются**, наружу выходят только
   проектор и read-only проекции.
2. **Consumers получают только чтение.** `TradingHotStateView` и
   `RollingWindowView` — без `append()` и без изменяемых `Map`.
3. **Market-specific данные принадлежат `MarketRuntimeState`.** Рынок —
   основная единица владения; инструменты создаются лениво.
4. **Shared-данные не копируются в рынки.** История Binance BTC/USDT одна на
   всех, а не по копии в каждом пятиминутном рынке.
5. **Текущее значение ряда — это `getLatest()`.** Отдельных `currentBook` /
   `latestTrade` нет: вторая ссылка на тот же объект только добавляет способ
   рассинхронизировать состояние с историей. Исключение — `tickSize`: это
   одно действующее значение, а не ряд.
6. **Хранение — `RollingWindow`.** Своего кольцевого буфера нет.
   `append()` вытесняет относительно времени **добавляемого** элемента, а не
   показаний часов, поэтому вытеснение детерминировано.
7. **`version` растёт на принятую мутацию — ровно на единицу за событие.**
   Одно `BOOK_DEPTH` может создать рынок, инструмент, запись индекса и
   добавить наблюдение — это одно принятое наблюдение, значит `+1`.
8. **Состояние одинаково собирается live и при replay.** Порядок и retention
   считаются по `event.metadata.createdAt`; `Date.now()` не используется
   нигде, а `getRecent()` на read-проекции требует явный момент отсчёта.
9. **`MARKET_OPENED` / `MARKET_CLOSED` намеренно не подписаны.** У них
   семантика старого рантайма — аллокация баланса, `strategyId`,
   освобождение и реализованный PnL, — а не жизненный цикл рынка, который мы
   проектируем.
10. **Features, Decisions, Intents, Risk и Execution сюда не входят.**

## Структура

```text
TradingHotState
├── markets: MarketId → MarketRuntimeState
│   └── instruments: InstrumentId → MarketInstrumentState
│       ├── books        RollingWindow<BookObservation>         ← BOOK_DEPTH
│       ├── publicTrades RollingWindow<PublicTradeObservation>  ← TRADE_RECEIVED
│       └── tickSize     TickSizeState | undefined              ← TICK_SIZE_CHANGED
├── sharedMarketData: VenueId → InstrumentId → SharedInstrumentState
│       ├── books
│       └── publicTrades
├── referencePrices: sourceId → baseAsset → quoteAsset → SPOT | TWAP(windowSeconds)
├── instrumentToMarket: InstrumentId → MarketId     (вторичный индекс)
└── version: number
```

## Состояние стакана — только `BOOK_DEPTH`

```text
полная история стакана = BOOK_DEPTH
текущий стакан         = books.getLatest()
```

`BOOK_UPDATED` этот слой **не использует**. Оба семантических адаптера —
Polymarket и CEX — публикуют `BOOK_DEPTH` на каждое принятое изменение книги,
а `BOOK_UPDATED` выводят из **того же снимка** и только при изменении
верхушки. Отдельный ряд верхушек был бы копией того, что уже лежит в `books`:
верхушка получается из `snapshot` вычислением.

Само событие в `@polymarket/application-events` остаётся — оно может
пригодиться потребителю, которому нужно дешёвое уведомление без хранения
стакана. Просто hot state им не пользуется.

Gap detection и recovery — предмет отдельного этапа. Технический поток,
который стратегии не нужен, здесь не хранится «на будущее».

## Идентичность снимка проверяется

Контракт `BOOK_DEPTH` требует, чтобы `venueId` / `marketId` / `instrumentId`
события повторяли те же поля самого `Orderbook`. Маршрутизация берётся из
payload, а в состояние кладётся snapshot — при расхождении книга одного
инструмента тихо легла бы под ключом другого, и обнаружилось бы это только по
необъяснимым ценам у стратегии. Три сравнения дешевле такой отладки, поэтому
несовпадение закрывает событие `BookIdentityMismatchError`.

## Маршрутизация

Правило source-agnostic — решает **наличие** `marketId`, а не площадка:

```text
marketId !== undefined  → MarketRuntimeState
marketId === undefined  → SharedMarketDataState
```

Проверок вида `if (venueId === BINANCE)` здесь нет.

`REFERENCE_PRICE_UPDATED` всегда идёт в shared: он описывает актив, а не рынок.
`TICK_SIZE_CHANGED` всегда market-scoped — так объявлено в его контракте.

## Идентичность рядов

**Инструмент площадки** — вложенные `Map<VenueId, Map<InstrumentId, …>>`.
Составных строк вроде `"binance:BTCUSDT"` нет: они теряют типы и делают
одинаковый `instrumentId` на двух площадках неотличимым от опечатки.

**Референсная цена** — размеченное объединение:

```typescript
type ReferencePriceSeriesKey =
  | { sourceId; baseAsset; quoteAsset; kind: 'SPOT' }
  | { sourceId; baseAsset; quoteAsset; kind: 'TWAP'; windowSeconds: number };
```

У TWAP окно усреднения обязано существовать, и это гарантирует тип, а не
комментарий. Склеивать нельзя ничего: `BTC/USD` и `BTC/USDT` — разные пары,
SPOT и TWAP 30 — разные величины, два источника с одинаковой парой могут
расходиться, и именно расхождение бывает сигналом. `nativeSymbol` в
идентичность не входит — это происхождение.

## Два времени в каждом наблюдении

| поле | что это | на что влияет |
| --- | --- | --- |
| `observedAt` | `event.metadata.createdAt` | порядок и вытеснение |
| `sourceTimestamp` / `venueTimestamp` | время площадки из payload | только данные |

Время площадки может идти назад — состояние от этого не ломается, потому что
на него ничего не опирается.

## Хранение

`TradingStateRetentionConfig` — это **не** `Policy`. Policy решает, какие
источники и рынки мы слушаем; retention — сколько из уже пришедшего хранить.
Значений по умолчанию нет: ядро получает конфиг явно, все политики
проверяются при создании, а проверенный конфиг **копируется и замораживается** —
`readonly` не защищает от изменения через mutable-ссылку вызывающего.

Ряды: `market.{books,trades}`, `shared.{books,trades}`, `referencePrices`.

## Пример

```typescript
const projector = TradingStateProjector.create(eventBus, retention, clock);
if (isErr(projector)) throw projector.error;
projector.value.start();

const view: TradingHotStateView = projector.value.state();
const book = view.getMarket(marketId)?.getInstrument(tokenId)?.books.getLatest();
const recent = view
  .getSharedInstrument(binance, btcUsdt)
  ?.publicTrades.getRecent(5_000, decisionMadeAtMs);

projector.value.stop();
```
