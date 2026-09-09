# Trading Hot State

Оперативное состояние торгового рантайма. Строится из canonical application
events и ничего не знает об источниках.

```text
canonical Application Events → IEventBus → TradingStateProjector → TradingHotState
```

## Инварианты

1. **`TradingStateProjector` — единственный писатель.** Обработчики одного
   события в `IEventBus` выполняются параллельно, поэтому несколько
   независимых подписчиков на `BOOK_UPDATED` писали бы состояние вперемешку
   с неопределённым порядком эффектов. Всё остальное строится **над** готовым
   состоянием, а не рядом с ним.
2. **Потребители получают только чтение.** Наружу выходят
   `TradingHotStateView` и `RollingWindowView` — без `append()` и без
   изменяемых `Map`.
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
   Отвергнутое устаревшее `BOOK_UPDATED` версию не двигает.
8. **Состояние одинаково собирается live и при replay.** Порядок и retention
   считаются по `event.metadata.createdAt`; `Date.now()` не используется
   нигде.
9. **`MARKET_OPENED` / `MARKET_CLOSED` намеренно не подписаны.** У них
   семантика старого рантайма — аллокация баланса, `strategyId`,
   освобождение и реализованный PnL, — а не жизненный цикл рынка, который мы
   проектируем. Переиспользовать их «пока что» значило бы построить новый
   lifecycle на чужих гарантиях.
10. **Features, Decisions, Intents, Risk и Execution сюда не входят.** Их
    добавят отдельными этапами; структура состояния этому не мешает.

## Структура

```text
TradingHotState
├── markets: MarketId → MarketRuntimeState
│   └── instruments: InstrumentId → MarketInstrumentState
│       ├── topOfBooks   RollingWindow<TopOfBookObservation>    ← BOOK_UPDATED
│       ├── books        RollingWindow<BookObservation>         ← BOOK_DEPTH
│       ├── publicTrades RollingWindow<PublicTradeObservation>  ← TRADE_RECEIVED
│       └── tickSize     TickSizeState | undefined              ← TICK_SIZE_CHANGED
├── sharedMarketData: VenueId → InstrumentId → SharedInstrumentState
│       ├── topOfBooks
│       ├── books
│       └── publicTrades
├── referencePrices: sourceId → baseAsset → quoteAsset → SPOT | TWAP(windowSeconds)
├── instrumentToMarket: InstrumentId → MarketId     (вторичный индекс)
└── version: number
```

## Маршрутизация

Правило source-agnostic — решает **наличие** `marketId`, а не площадка:

```text
marketId !== undefined  → MarketRuntimeState
marketId === undefined  → SharedMarketDataState
```

Проверок вида `if (venueId === BINANCE)` здесь нет: application state не знает
вендорских правил.

`REFERENCE_PRICE_UPDATED` всегда идёт в shared: он описывает актив, а не рынок.
`TICK_SIZE_CHANGED` всегда market-scoped — так объявлено в его контракте.

## Идентичность рядов

**Инструмент площадки** — вложенные `Map<VenueId, Map<InstrumentId, …>>`.
Составных строк вроде `"binance:BTCUSDT"` нет: они теряют типы и делают
одинаковый `instrumentId` на двух площадках неотличимым от опечатки.

**Референсная цена** — вся различающая информация события:

```text
sourceId → baseAsset → quoteAsset → SPOT | TWAP(windowSeconds)
```

Склеивать нельзя ничего: `BTC/USD` и `BTC/USDT` — разные пары, SPOT и TWAP 30 —
разные величины, два источника с одинаковой парой могут расходиться, и именно
расхождение бывает сигналом. `nativeSymbol` в идентичность не входит — это
происхождение.

## Два времени в каждом наблюдении

| поле | что это | на что влияет |
| --- | --- | --- |
| `observedAt` | `event.metadata.createdAt` | порядок и вытеснение |
| `sourceTimestamp` / `venueTimestamp` | время площадки из payload | только данные |

Время площадки может идти назад — состояние от этого не ломается, потому что
на него ничего не опирается.

## Защита от отката по `sequenceNumber`

Логический поток — «рынок + инструмент» либо «площадка + инструмент». Номер
последнего принятого берётся из самого ряда, отдельного поля нет.

```text
sequenceNumber <= последний принятый  → не добавляем, latest не меняем, version не растёт
```

Разрыв номеров (`10 → 15`) **принимается**: восстановление, health-подсистема,
REST-resync и gap-события — предмет отдельного этапа, а не догадка здесь.

## Хранение

`TradingStateRetentionConfig` — это **не** `Policy`. Policy решает, какие
источники и рынки мы слушаем; retention — сколько из уже пришедшего хранить.
Значений по умолчанию нет: ядро получает конфиг явно, и все политики
проверяются при создании состояния, а не при первом живом событии.

Ряды: `market.{topOfBooks,books,trades}`, `shared.{topOfBooks,books,trades}`,
`referencePrices`.

## Пример

```typescript
const state = TradingHotState.create(retention, clock);
if (isErr(state)) throw state.error;

const projector = new TradingStateProjector(eventBus, state.value);
projector.start();

const view: TradingHotStateView = projector.state();
const book = view.getMarket(marketId)?.getInstrument(tokenId)?.books.getLatest();
const btc = view.getSharedInstrument(binance, btcUsdt)?.publicTrades.getLast(10);

projector.stop();
```
