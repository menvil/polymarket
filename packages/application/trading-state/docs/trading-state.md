# Trading Hot State

Оперативное состояние торгового рантайма. Строится из canonical application
events и ничего не знает об источниках.

```text
canonical Market
    ↓
TRADING_MARKET_ADMITTED
    ↓
IEventBus → TradingStateProjector → TradingHotState
                                      └── MarketRuntimeState
                                            ├── market       canonical Market
                                            ├── lifecycle    наш торговый цикл
                                            └── instruments  активные данные
```

## Идентичность рынка — пара «площадка + рынок»

```text
markets:            VenueId → MarketId     → MarketRuntimeState
instrumentToMarket: VenueId → InstrumentId → MarketId
```

Публичное чтение соответственно:

```typescript
view.getMarket(venueId, marketId);
view.getMarketForInstrument(venueId, instrumentId);
view.marketIdentities(); // [{ venueId, marketId }, …]
```

`MarketId` и `InstrumentId` уникальны **только внутри пространства имён своей
площадки** — это уже зафиксировано в `Market.equals()` (сравнивает
`venueId + id`) и в ключе `MarketUniverse`. Плоский `Map<MarketId, …>` дал бы
две поломки сразу:

```text
KALSHI:X приходит, POLYMARKET:X принят, инструмент совпал
    → чужой стакан тихо ложится в наш рынок

KALSHI:X приходит, POLYMARKET:X принят, инструмент НЕ совпал
    → ложный аварийный отказ вместо игнорирования чужих данных
```

Поэтому `venueId` не выбрасывается ни в одном маршруте, а `marketIds()` не
существует: из плоского списка идентификаторов нельзя вызвать `getMarket()`, и
два рынка разных площадок в нём стали бы неотличимы.

Вложенные `Map`, а не составная строка `"POLYMARKET:X"`: строка теряет типы и
делает совпадение идентификаторов неотличимым от опечатки — та же причина, по
которой так устроено shared-состояние.

Следствие для lifecycle-событий: `TRADING_MARKET_ACTIVATED`/`CLOSED`/
`FINALIZED` несут `venueId` рядом с `marketId`, а события с целым `Market`
берут пару из него. `TICK_SIZE_CHANGED` получил `venueId` тем же MR — он был
единственным market-data событием без площадки.

## Две вселенные рынков — и это не одно и то же

```text
MarketUniverse            какие canonical рынки технически существуют
                          (Discovery, десятки тысяч, обновляется целиком)

TradingHotState.markets   какие рынки торговый рантайм ПРИНЯЛ сам
                          (admission, единицы-десятки)
```

Discovery, `MarketUniverse`, `IMarketDiscoveryService`, Policy и
`PolymarketSubscriptionPlanner` о торговом lifecycle **не знают** и не должны:
Discovery обязан иметь право обновить двадцать тысяч рынков независимо от
того, существует ли торговый рантайм. Admission принадлежит будущему
owner/composition-слою над ними.

## Два жизненных цикла — и это тоже не одно и то же

```text
Market.state                     ACTIVE → CLOSED → RESOLVED
                                 что площадка подтверждает про внешний рынок;
                                 мы это наблюдаем, но не управляем

MarketRuntimeState.lifecycle     ADMITTED → ACTIVE → TRADING_CLOSED
                                          → RESOLVED → FINALIZED
                                 что наш рантайм делает с этим рынком
```

Комбинация «`market.state = ACTIVE`, наш статус = `TRADING_CLOSED`»
**законна**: мы уже перестали торговать по `expiresAt`, а площадка ещё
несколько секунд показывает рынок активным. Требовать согласованности значило
бы ставить торговые решения в зависимость от частоты обновлений площадки.

Внешнее состояние влияет на наш цикл в двух точках, и обе — проверки на входе
перехода, а не хранимая связь статусов:

```text
admission   принять можно только market.isActive()
resolution  принять можно только market.isResolved()  → и этот Market заменяет
                                                        сохранённый
```

Резолюция — единственный переход, который ЗАМЕНЯЕТ сохранённый `Market`
пришедшим, поэтому она же и единственная, где внешнее состояние обязано быть
конкретным (`RESOLVED`). Между этими двумя точками циклы идут независимо:
активация и остановка торговли на `market.state` не смотрят вовсе.

Доменный `Market` при этом не меняется: `ADMITTED`/`TRADING_CLOSED`/
`FINALIZED` — application-концепции, и добавлять их в `MarketState` нельзя.

## Инварианты

1. **`TradingStateProjector` — единственный писатель.** Обработчики одного
   события в `IEventBus` выполняются параллельно, поэтому несколько
   независимых подписчиков писали бы состояние вперемешку с неопределённым
   порядком эффектов. Правило держится не комментарием: конкретные
   mutable-классы из пакета **не экспортируются**, наружу выходят только
   проектор и read-only проекции.
2. **Consumers получают только чтение.** `TradingHotStateView` и
   `RollingWindowView` — без `append()` и без изменяемых `Map`.
3. **Market-specific состояние создаётся ТОЛЬКО admission-ом.** Рынок —
   основная единица владения; оба инструмента создаются сразу при
   `TRADING_MARKET_ADMITTED`, а не лениво от первой книги. Ленивое создание
   означало бы, что владение инструментом выводится задним числом из
   наблюдения, а не берётся из canonical `Market`.
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
   Admission создаёт рынок, ОБА инструмента и две записи индекса; резолюция
   заменяет `Market`, пишет времена и освобождает тяжёлые ряды — каждое из
   этих событий даёт `+1`, а не `+5` и не `+3`. Отвергнутый переход,
   проигнорированное наблюдение и повторный admission версию **не двигают**.
8. **Состояние одинаково собирается live и при replay.** Порядок и retention
   считаются по `event.metadata.createdAt`; `Date.now()` не используется
   нигде, а `getRecent()` на read-проекции требует явный момент отсчёта.
9. **`MARKET_OPENED` / `MARKET_CLOSED` намеренно не подписаны.** У них
   семантика старого рантайма — аллокация баланса, `strategyId`,
   освобождение и реализованный PnL, — а не жизненный цикл рынка, который мы
   проектируем. У нового контура свои имена: `TRADING_MARKET_*`.
10. **Любая отвергнутая мутация атомарна.** `Err` означает, что не изменились
    ни рынок, ни жизненный цикл, ни инструменты, ни индексы, ни версия. Все
    проверки идут ДО первой записи — включая проверку ОБОИХ инструментов при
    admission.
11. **Features, Decisions, Intents, Risk и Execution сюда не входят.** Strike,
    priceToBeat и settlement price — тоже: canonical `Market` их не содержит,
    а временное optional-поле стало бы источником истины без источника.

## Структура

```text
TradingHotState
├── markets: MarketId → MarketRuntimeState        ← ТОЛЬКО принятые рынки
│   ├── market: Market                            ← canonical, immutable
│   ├── lifecycle
│   │   ├── status         ADMITTED | ACTIVE | TRADING_CLOSED | RESOLVED | FINALIZED
│   │   ├── admittedAt     Timestamp
│   │   ├── activatedAt?   Timestamp
│   │   ├── tradingClosedAt? Timestamp
│   │   ├── resolvedAt?    Timestamp
│   │   └── finalizedAt?   Timestamp
│   └── instruments: InstrumentId → MarketInstrumentState   ← оба исхода сразу
│       ├── books        RollingWindow<BookObservation>                       ← BOOK_DEPTH
│       ├── publicTrades RollingWindow<PublicTradeObservation<OutcomePrice>>  ← TRADE_RECEIVED
│       └── tickSize     TickSizeState | undefined                            ← TICK_SIZE_CHANGED
├── sharedMarketData: VenueId → InstrumentId → SharedInstrumentState
│       ├── books        RollingWindow<BookObservation>
│       └── publicTrades RollingWindow<PublicTradeObservation<AssetPrice>>
├── referencePrices: sourceId → baseAsset → quoteAsset → SPOT | TWAP(windowSeconds)
├── instrumentToMarket: InstrumentId → MarketId     (вторичный индекс)
└── version: number
```

`question`, `startsAt`, `expiresAt`, `outcomes`, `family` и `crypto`
отдельными полями **не копируются** — они читаются из `market`. Две копии
одной структуры неизбежно разошлись бы, и было бы неясно, какая из них
источник истины.

## Admission — единственный способ создать состояние рынка

```text
TRADING_MARKET_ADMITTED
    ↓ все проверки ДО любой мутации:
    1. рынок с таким MarketId ещё не принят
    2. market.isActive() — площадка не закрыла и не разрешила его
    3. metadata.createdAt < market.startsAt   (ровно в startsAt уже поздно)
    4. ОБА instrumentId свободны
    5. политики хранения проходят для обоих инструментов
    ↓
MarketRuntimeState + MarketInstrumentState ×2 + instrumentToMarket ×2
version += 1
```

Инвариант «рынок приобретается ДО открытия» держится жёстко: mid-market
catch-up нам не нужен, а рынок с пустой предысторией несравним с нормально
принятым.

Оба инструмента создаются сразу, не дожидаясь первого стакана: canonical
`Market` гарантирует ровно два исхода с различными `InstrumentId`, и
стратегия, спросившая инструмент до первой книги, не должна получать
`undefined` у уже принятого рынка.

**Атомарность проверена тестом:** если конфликтует ВТОРОЙ исход, то ни рынок,
ни первый (свободный) инструмент не остаются зарегистрированными.

Повторный admission — ошибка жизненного цикла (`TradingMarketAlreadyAdmitted`),
а не обновление metadata: он стёр бы уже накопленную warm history либо молча
не сделал бы ничего, притворившись мутацией. Обновлять сохранённый `Market`
умеет только резолюция.

## Что происходит с market-data по НЕпринятому рынку

Ничего — и это намеренно.

```text
BOOK_DEPTH / TRADE_RECEIVED / TICK_SIZE_CHANGED с чужим marketId
    → IGNORE: без ошибки, без создания рынка, без version++
```

`IEventBus` — общая семантическая шина: на ней живут данные рынков, нужных
коллектору, другому владельцу или будущей стратегии. **Canonical-событие не
означает автоматически событие торгового состояния.** Отвечать ошибкой на
чужие данные значило бы, что торговое состояние считает себя единственным
потребителем шины.

Shared-данные (CEX, референсные цены) от admission не зависят вовсе: они
описывают актив, а не рынок.

Другое дело — инструмент, которого у ПРИНЯТОГО рынка нет:

```text
marketId принят, instrumentId не из market.outcomes
    → UnknownTradingMarketInstrumentError (fail closed)
```

Это нарушение canonical-маршрутизации, а не чужие данные. Создать третий ряд
«на всякий случай» значило бы принять данные, не относящиеся ни к одному
исходу, и отдать их стратегии как рыночные. Проверка идёт **до** проверки
фазы: нарушение маршрутизации остаётся нарушением и после остановки торгов.

## Какие фазы принимают market-data

```text
ADMITTED         принимает   ← warm history до startsAt
ACTIVE           принимает
TRADING_CLOSED   игнорирует
RESOLVED         игнорирует
FINALIZED        игнорирует
```

`ADMITTED` принимает НАМЕРЕННО: мы подписываемся до открытия рынка, чтобы к
`startsAt` уже иметь разогретый стакан и ленту.

```text
ADMITTED → BOOK_DEPTH/TRADES собираются → startsAt → ACTIVE
```

Поздние наблюдения после остановки торгов игнорируются **без ошибки**: они
законны со стороны площадки, просто нам больше не нужны. Ошибкой это делать
нельзя — иначе каждый venue, добравший книгу через секунду после нашего
закрытия, ронял бы `publish()`.

## Переходы жизненного цикла

```text
ADMITTED ──→ ACTIVE ──→ TRADING_CLOSED ──→ RESOLVED ──→ FINALIZED
                 └───────────────────────────┘
                     ACTIVE → RESOLVED разрешён
```

| переход | условия |
| --- | --- |
| `→ ADMITTED` | `admittedAt < startsAt`, рынок внешне `ACTIVE`, оба инструмента свободны |
| `ADMITTED → ACTIVE` | `startsAt <= activatedAt < expiresAt` |
| `ACTIVE → TRADING_CLOSED` | `tradingClosedAt >= activatedAt`; раньше `expiresAt` — можно |
| `ACTIVE\|TRADING_CLOSED → RESOLVED` | payload несёт RESOLVED `Market` той же структуры |
| `RESOLVED → FINALIZED` | `finalizedAt >= resolvedAt` |

Всё остальное — `Err` без мутации. `ADMITTED → RESOLVED` тоже: рынок, по
которому торговля не начиналась, наш рантайм разрешить не может.

Lifecycle-событие с ЧУЖОЙ площадкой отвергается как `NOT_ADMITTED`, а не как
конфликт структуры: `KALSHI:X` при принятом `POLYMARKET:X` — другая сущность
рынка, и рынок по паре просто не находится.

Времена переходов берутся **только** из `event.metadata.createdAt`. Ни
`Date.now()`, ни `clock.now()` в переходах нет — иначе replay той же ленты
давал бы другие времена. Инвариант:

```text
admittedAt < startsAt <= activatedAt <= tradingClosedAt <= resolvedAt <= finalizedAt
```

Планировщика в этом слое нет: кто публикует активацию ровно на `startsAt` —
ответственность будущей композиции рантайма.

## `ACTIVE → RESOLVED` закрывает торговлю сам

Внешний источник может отдать резолюцию сразу, а промежуточное закрытие мы
могли не увидеть или не успеть опубликовать. Поэтому переход разрешён и
делает три вещи одной атомарной мутацией:

```text
status          = RESOLVED
tradingClosedAt = resolvedAt      ← разрешённый рынок не остаётся ACTIVE
active data     освобождены
version        += 1               ← РОВНО один раз
```

## Что очищается при остановке торговли

```text
market                KEEP    canonical Market целиком
lifecycle             KEEP    все времена
instrumentToMarket    KEEP    структурная запись, не наблюдаемая
instrumentIds()       KEEP    оба исхода из market.outcomes

books / publicTrades / tickSize    DROP
MarketInstrumentState              DROP целиком
```

`MarketRuntimeState` **не удаляется**: позже к compact-части добавятся
ордера, филлы, позиции, решения, резолюция и итог — они обязаны переживать
закрытие торгов. Выселение финализированных рынков появится вместе с durable
Market History: сначала должно быть куда сохранить.

Отсюда важное различие в read API:

```text
instrumentIds()   структурные инструменты рынка — ВСЕГДА оба
getInstrument(id) активное тяжёлое состояние — undefined после закрытия
```

`instrumentIds()` берётся из canonical `market.outcomes`, а не из ключей
текущих рядов, поэтому состав рынка не «теряется» на закрытии.

## Резолюция приносит рынок целиком

`TRADING_MARKET_RESOLVED` несёт `Market`, а не победивший исход. Это решает
три задачи одним событием: фиксирует резолюцию, обновляет сохранённый
canonical `Market` до последнего внешнего состояния и отдаёт победителя через
существующий `market.resolvedOutcome`. Параллельных `winnerInstrumentId` /
`winnerIndex` / `resolution {}` в состоянии нет — второе представление
победителя пришлось бы синхронизировать с первым.

Поскольку сохранённый рынок заменяется, структура обязана совпасть:

```text
сравнивается   venueId, id, startsAt, expiresAt,
               outcomes[0..1].index, outcomes[0..1].instrumentId,
               family, crypto.asset, crypto.duration

НЕ сравнивается question, slug   display metadata — площадка вправе уточнить
               state             ОБЯЗАН измениться, в этом и смысл резолюции
```

`Market.equals()` для этого недостаточно — он сравнивает только `venueId + id`
и пропустил бы рынок с другими `InstrumentId` исходов. Обратное тоже верно:
расхождение по `venueId` конфликтом структуры **не бывает** — рынок ищется по
паре, поэтому резолюция чужой площадки не находит рынка и отвергается как
`NOT_ADMITTED`. Пробы `venueId`/`id` в helper'е остались для вызывающих, которые
сравнивают два рынка сами.
`JSON.stringify(market)` не годится тем более: он сравнил бы и `question`, и
`state`, то есть отверг бы любую законную резолюцию. Поэтому есть
`sameTradingMarketStructure(a, b)`.

Расхождение закрывается `TradingMarketStructureConflictError` — принять такой
рынок значило бы оставить накопленную историю относящейся к структуре,
которой в состоянии больше нет.

### Форма расхождения общая

`findTradingMarketStructureDifference` возвращает `FieldDifference` из
`@polymarket/errors` — ту же форму, что `findFillFactDifference` и
`findOrderIdentityDifference`:

```typescript
interface FieldDifference<TField extends string> {
  readonly field: TField;
  readonly left: string;   // первый аргумент сравнения
  readonly right: string;  // второй
}
```

Пара значений называется нейтрально, хотя здесь роли как раз известны. Причина
в том, что два других места сравнения живут в домене и НЕ знают, какой из
экземпляров сохранённый, а какой пришедший. Общая форма возможна только
нейтральная; роли называет тот, кто их знает:

```typescript
context: { field: d.field, admitted: d.left, incoming: d.right }
```

Для читателя лога ничего не изменилось — сообщение и ключи контекста
по-прежнему говорят `admitted` и `incoming`. Изменилось то, что четвёртое место
сравнения теперь не может завести пятую пару имён.

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

## Что означает `critical: true` — и чего не означает

Подписки проектора объявлены critical. Это значит ровно одно: отказ
обработчика возвращается публикующей стороне как `Err` из
`IEventBus.publish()`, а не глотается шиной.

**Остановки торгового рантайма отсюда не следует.** Сегодняшняя цепочка:

```text
SemanticAdapter → publish() → projector throws → publish() возвращает Err
                → адаптер логирует, увеличивает счётчик и ПРОДОЛЖАЕТ
```

Оба семантических адаптера так и задокументированы: отказ публикации не
прерывает обработку raw-сообщения. Для записи сырых данных это верно —
коллектор обязан писать дальше. Но состояние при этом может остаться с
дыркой: наблюдение №101 отвергнуто, №102 принято, и никто не остановился.

Это не дефект hot state, а незакрытый вопрос композиции. **Реакция живого
торгового контура на отказ семантической публикации обязана быть определена
fail-closed ДО включения Strategy.** Ожидаемая форма:

```text
semantic publish failure
    → Trading Runtime unhealthy
    → Strategy disabled
    → Execution остановлен контролируемо
    → Collector/Recorder продолжают писать raw
```

## Маршрутизация

Правило source-agnostic — решает **наличие** `marketId`, а не площадка:

```text
marketId !== undefined  → MarketRuntimeState (если рынок ПРИНЯТ)
marketId === undefined  → SharedMarketDataState
```

Проверок вида `if (venueId === BINANCE)` здесь нет.

`REFERENCE_PRICE_UPDATED` всегда идёт в shared: он описывает актив, а не рынок.
`TICK_SIZE_CHANGED` всегда market-scoped — так объявлено в его контракте, и он
подчиняется тем же правилам admission, что стакан и сделки: рынка он **не
создаёт**.

Полный разбор market-scoped маршрута — три исхода, и путать их нельзя:

```text
рынок не принят           → Ok(false)  игнор: чужие данные общей шины
инструмент не из outcomes → Err        нарушение canonical routing
фаза не принимает данные  → Ok(false)  игнор: поздние наблюдения
иначе                     → Ok(true)   запись + version++
```

Маршрут market-scoped наблюдения **ничего не создаёт**: рынок и оба
инструмента появляются только при admission. Поэтому отвергнутое или
проигнорированное наблюдение физически не может оставить за собой ни рынка,
ни инструмента, ни записи индекса.

## Ценовой домен сужается по владельцу

Canonical-событие несёт общий `DecimalPrice` — иначе union стал бы
prediction-only и CEX-адаптеру пришлось бы заводить второй тип события. Но
внутри состояния домен уже однозначен, потому что его определяет маршрут:

```text
market-scoped → рынок предсказаний → OutcomePrice (0, 1)
shared        → площадка актива    → AssetPrice   (0, ∞)
```

Сужение делает проектор ровно там, где решает маршрут, через `instanceof` —
без повторной проверки инварианта: значение прошло её при создании VO
(ADR, Решение 9). Несовпадение закрывается `PriceDomainMismatchError`: цена
BTC в рынке предсказаний означает ошибку маршрутизации в адаптере, и класть
её в ряд значило бы отдать стратегии величину другой размерности.

**Порядок проверок у двух маршрутов разный, и это не случайность.**
Market-scoped: сначала маршрут, потом домен — маршрут не мутирует состояние, а
события непринятых рынков нас не касаются, и проверять домен цены в чужих
данных значило бы отвечать за чужую маршрутизацию. Shared: сначала домен,
потом маршрут — там создание инструмента площадки уже является мутацией, и
отвергнутое событие иначе оставило бы за собой пустой ряд при неизменной
версии.

Замерено на записанных данных run-05: **7 163 758 ценовых уровней** Polymarket
(73 284 книги, 35 016 сделок) укладываются в **[0.001, 0.999]**, ни одного
значения вне (0.0001, 0.9999) и ни одного ровно 0 или 1. Сужение безопасно, а
отказ ловит настоящую аномалию, а не законный случай.

**Стакан остаётся на общем `DecimalPrice`.** Сузить `Orderbook` целиком одним
`instanceof` нельзя — пришлось бы проверять каждый уровень, и появился бы
вопрос, что делать с книгой, где не прошёл один уровень. Решать его без
потребителя значило бы угадывать требования.

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

## Ошибки

| ошибка | когда |
| --- | --- |
| `TradingMarketAlreadyAdmittedError` | повторный `TRADING_MARKET_ADMITTED` |
| `TradingMarketAdmissionTimingError` | `admittedAt >= market.startsAt` |
| `TradingMarketAdmissionStateError` | рынок внешне `CLOSED`/`RESOLVED` |
| `InstrumentMarketConflictError` | инструмент исхода занят другим принятым рынком ТОЙ ЖЕ площадки |
| `TradingMarketLifecycleTransitionError` | переход запрещён (`PHASE`), нарушает время (`TIMING`), рынок не принят (`NOT_ADMITTED`) либо payload не соответствует переходу (`PAYLOAD`) |
| `UnknownTradingMarketInstrumentError` | инструмент не из `market.outcomes` принятого рынка |
| `TradingMarketStructureConflictError` | резолюция принесла другую trading-critical структуру |
| `BookIdentityMismatchError` | идентичность внутри `Orderbook` разошлась с payload |
| `PriceDomainMismatchError` | цена пришла не в домене владельца ряда |

Один тип на все переходы жизненного цикла — намеренно: разница между
«активировали дважды» и «финализировали до резолюции» это значения полей, а не
разные виды отказа. Отдельный класс на каждую пару статусов дал бы двадцать
классов с одинаковым телом.

Все ошибки этого слоя имеют `severity: 'critical'` и возвращаются **до**
мутации.

## Пример

```typescript
const projector = TradingStateProjector.create(eventBus, retention, clock);
if (isErr(projector)) throw projector.error;
projector.value.start();

const view: TradingHotStateView = projector.value.state();

// Рынок появляется в состоянии ТОЛЬКО после admission.
await eventBus.publish(admittedEvent);
const runtimeMarket = view.getMarket(venueId, marketId);
runtimeMarket?.lifecycle.status;      // → 'ADMITTED'
runtimeMarket?.market.question;       // canonical Market целиком
runtimeMarket?.instrumentIds();       // → оба исхода, ещё до первой книги

const book = view.getMarket(venueId, marketId)?.getInstrument(tokenId)?.books.getLatest();
const recent = view
  .getSharedInstrument(binance, btcUsdt)
  ?.publicTrades.getRecent(5_000, decisionMadeAtMs);

projector.value.stop();
```
