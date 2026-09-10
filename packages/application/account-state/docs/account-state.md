# Account Hot State

Приватное состояние торгового аккаунта. Строится из canonical
`TRADING_ACCOUNT_*` событий и ничего не знает об источниках.

```text
canonical Portfolio / Order / Fill
    ↓
TRADING_ACCOUNT_*
    ↓
IEventBus → AccountStateProjector → AccountHotState
                                      └── AccountRuntimeState
                                            ├── portfolio  деньги + позиции + резервации
                                            ├── orders     наши заявки
                                            ├── fills      наши исполнения
                                            └── indexes    навигация
```

## Почему приватное состояние отдельно от рыночного

### Проблема

Соблазн один: «состояние торговли» — это же одно состояние. Один объект, в
котором лежит и стакан, и наш баланс, и наши заявки. Читать удобнее, писать
проще.

Проблема в том, что это **факты разной природы**, с разными источниками,
разными гарантиями и разной ценой ошибки.

| | рыночное состояние | приватное состояние |
| --- | --- | --- |
| источник | публичные фиды, доступные всем | приватный канал одного аккаунта |
| частота | десятки тысяч обновлений в минуту | единицы в минуту |
| незнакомый объект | норма — игнорируем | нарушение — отказ |
| цена молчания | стратегия видит устаревшую цену | заявка на несуществующие деньги |

Строка «незнакомый объект» — самая важная. Рыночный проектор **обязан** молча
игнорировать market-data по непринятому рынку: `IEventBus` общий, и на нём
живут данные коллектора и других владельцев. Приватный проектор обязан
поступать ровно **наоборот**: событие по неизвестному аккаунту означает
нарушение инварианта, потому что приватные события публикует сам рантайм.

Слить их в один объект — значит выбрать одно правило для двух
взаимоисключающих требований.

### Решение

Два независимых read-model на одной шине:

```text
IEventBus
├── TradingStateProjector  → TradingHotState   факты о РЫНКЕ
└── AccountStateProjector  → AccountHotState   факты о НАС
```

Это законно именно потому, что они обрабатывают **разные типы событий** и не
зависят от side-effect'ов друг друга. Обработчики одного события в `IEventBus`
выполняются параллельно, поэтому архитектура вида «обработчик B рассчитывает,
что обработчик A уже закончил» была бы гонкой. Ни один обработчик здесь такой
связи не имеет.

Согласованный снимок из обоих позже соберёт `TradingContextBuilder` — read-only
потребитель, а не третий писатель.

## Единственный писатель

```text
canonical account commit event
    ↓
ОДНА существующая IEventBus
    ↓
AccountStateProjector
    ↓
AccountHotState
```

Чего в пакете нет и не будет:

```text
Execution → state.orders.set(...)      ✗ публичных мутаций нет
Reconciler → state.portfolio = ...     ✗ писатель один
WS handler → state.fills.push(...)     ✗ третьей шины нет
```

Mutable-классы (`AccountHotState`, `AccountRuntimeState`) из пакета **не
экспортируются**. Иначе правило «один писатель» осталось бы комментарием: любой
потребитель мог бы вызвать `applyFill()` без единого приведения типов.

## Проектор не выполняет бизнес-логику исполнения

Это принципиально, а не стилистически.

Чего проектор **не делает**:

```text
не считает экономику исполнения      не резервирует баланс
не освобождает резервации            не применяет BUY/SELL-учёт
не гоняет FIFO                       не выводит лоты позиции
не решает переходы заявки            не решает коррекцию сверки
```

Всё это происходит **до** canonical commit-события:

```text
будущий Execution / приватный процессор
    ↓
domain operation                     ← здесь считается экономика
    ↓
post-commit Order / Portfolio / Fill  ← итог, immutable
    ↓
TRADING_ACCOUNT_*
    ↓
AccountStateProjector                ← только материализация
```

Причина простая: экономика уже реализована в домене. Вторая реализация рядом с
первой неизбежно с ней разойдётся, и разойдётся молча — состояние покажет один
баланс, домен посчитает другой.

## Portfolio — единственный источник истины

`AccountRuntimeState` **не** имеет параллельных полей:

```text
✗ balance            ✗ positions: Map
✗ availableBalance   ✗ tokenReservations: Map
✗ reservedBalance
```

Вместо этого:

```typescript
interface AccountRuntimeStateView {
  readonly portfolio: Portfolio;
  getPosition(instrumentId: InstrumentId): IPosition | undefined; // читает portfolio.positions
}
```

`Portfolio` уже содержит `balance`, `positions` и `tokenReservations`, и они
связаны его инвариантами. Скопировать их в состояние аккаунта значило бы взять
на себя обязанность держать копию синхронной — обязанность, которую невозможно
выполнить, если портфель приходит целиком в каждом событии.

`getPosition()` — удобный доступ, а не второй источник: он буквально
делегирует в `portfolio.getPosition()`, и тест проверяет **идентичность
экземпляра**, а не совпадение значений.

## Записи: canonical сущность + время рантайма

Ни `Order`, ни `Fill` не копируются в DTO. Обе сущности уже canonical,
immutable и провалидированы. Запись добавляет только то, чего у сущности быть
не может.

```typescript
interface AccountOrderRecord {
  readonly order: Order;
  readonly updatedAt: Timestamp;   // metadata.createdAt последнего commit'а
}

interface AccountFillRecord {
  readonly fill: Fill;             // canonical факт, immutable
  readonly status: 'APPLIED' | 'CONFIRMED' | 'REVERTED';
  readonly appliedAt: Timestamp;
  readonly confirmedAt?: Timestamp;
  readonly revertedAt?: Timestamp;
  readonly revertReason?: string;
}
```

Два вида времени различаются и не взаимозаменяемы:

```text
fill.timestamp                    КОГДА исполнение произошло на площадке
appliedAt/confirmedAt/revertedAt  КОГДА рантайм принял соответствующее событие
```

Времена переходов берутся **только** из `event.metadata.createdAt` — не из
часов, не из `order.timestamp`, не из `fill.timestamp`. Часов у состояния нет
вовсе: повтор той же ленты событий обязан давать то же состояние, иначе replay
перестал бы совпадать с торговлей.

### `marketId` у заявки

Его нет. `Order` не содержит `marketId`, и добавлять поле без canonical
producer'а значило бы придумать источник истины. Рынок заявки определяется
позже, при сборке торгового контекста:

```text
venueId + assetIdToInstrumentId(order.asset) + владение инструментом в TradingHotState
```

У `Fill` `marketId` есть — он приходит из canonical факта исполнения.

## Идентичность аккаунта

```text
Map<VenueId, Map<accountIdToString(AccountId), AccountRuntimeState>>
```

Два решения, оба существенные.

**Ключ — canonical строка, а не объект.** `AccountId` — обычный объект, а `Map`
ключуется по ссылке. Два эквивалентных `AccountId`, собранных в разных местах
(один разобран из снапшота, другой построен фабрикой), — разные JS-объекты, и
состояние увидело бы два аккаунта там, где есть один. Свой `JSON.stringify`
тоже не годится: ключ зависел бы от порядка полей.

**Вложенные `Map`, а не составная строка** `"POLYMARKET:wallet:0x…"`. Строка
теряет типы и делает совпадение идентификаторов неотличимым от опечатки. То же
решение принято в `TradingHotState` для пары `venueId + marketId`.

### Venue-bound AccountId

`AccountId` содержит площадку не всегда:

```text
VENUE       venue задан явно        → обязан совпасть с payload
SUBACCOUNT  venue = venue корня     → обязан совпасть, если корень VENUE
WALLET      venue не задан вовсе    → проверять нечего, это НЕ ошибка
```

Один и тот же кошелёк торгует на нескольких площадках, поэтому отсутствие
встроенной площадки у WALLET-аккаунта — норма. Venue namespace ему задаёт
payload.

## Validation-first, mutation-second

Жёсткий инвариант каждого обработчика:

```text
1. resolve       найти аккаунт
2. validate      проверить ВСЁ
3. calculate     вычислить предполагаемые изменения
4. mutate        и только теперь записать
```

Отвергнутое событие не оставляет за собой ничего:

```text
portfolio unchanged     indexes unchanged
orders unchanged        account version unchanged
fills unchanged         global version unchanged
                        lastMutationAt unchanged
```

Реализовано через `PendingMutation`: между «проверить» и «записать» не остаётся
ни одной операции, способной отказать. Метод `AccountRuntimeState.commit()` —
единственное место мутации, и внутри него отказать нечему.

Этот класс дефекта уже ловился в проекте (отвергнутая сделка мутировала
рыночное состояние), поэтому тест атомарности снимает **полный** отпечаток
состояния — портфель, заявки, исполнения, содержимое всех трёх индексов, обе
версии и `lastMutationAt` — и сверяет его после каждого невалидного события.

## Идемпотентность: три случая, а не два

```text
новый факт / законное обновление   apply, version += 1
точный дубликат                    Ok/no-op, версии не меняются
та же identity, другой факт        Err, версии не меняются
```

### Почему дубликат нельзя применять

Событие доставляется повторно — это нормально. Но повторно доставленное
событие несёт снимки **того момента, когда оно было создано**:

```text
t1  ORDER_COMMITTED   order OPEN,  portfolio available=9350 reserved=650  ← применено
t2  FILL_APPLIED      fill,        portfolio available=9350 reserved=390  ← применено
t3  ORDER_COMMITTED   order OPEN,  portfolio available=9350 reserved=650  ← ДУБЛИКАТ t1
```

Применить событие из `t3` — значит вернуть в `reserved` 650 вместо 390, то есть
откатить состояние на шаг назад по деньгам, которые уже частично исполнены.

Поэтому дубликат распознаётся **до** мутации и не трогает ни портфель, ни
заявку, ни индексы, ни версии, ни `lastMutationAt`.

### Как распознаётся дубликат

**Заявка.** У неё есть изменяемая часть, поэтому сравнений два:

```text
identity  id, accountId, asset, side, price, size, timestamp, strategyId
state     + status, filledSize, averagePrice, fillIds, reason
```

```text
identity различается             → Err (конфликт)
identity совпала, state — нет    → законное обновление, применить
совпало всё                      → дубликат, no-op
```

**Исполнение.** Изменяемой части нет — `Fill` целиком неизменяем:

```text
id, orderId, accountId, venueId, marketId, tokenId,
settlementAssetId, price, size, side, timestamp, fee
```

```text
всё совпало       → дубликат, no-op
что-то различно   → Err (конфликт)
```

Третьего случая быть не может: цена или размер исполнения не «уточняются».

### Почему не `JSON.stringify` и не сравнение по ссылке

`Order` и `Fill` пересобираются на каждом входе (из WS-наблюдения, из
REST-сверки, из архива), поэтому по ссылке равными два экземпляра одного факта
не бывают.

`JSON.stringify` даёт и ложные расхождения, и ложные совпадения: он зависит от
внутреннего представления `Decimal` внутри `OutcomePrice`/`Quantity`/`Fee` и от
порядка полей размеченного объединения `AssetId`.

Поэтому каждое поле сравнивается своим canonical-равенством:

| поле | сравнение |
| --- | --- |
| `accountId` | `accountIdEquals` (рекурсивно, с нормализацией адреса) |
| `asset` / `tokenId` | `AssetIdHelpers.equals` |
| `price` / `size` | `OutcomePrice.equals` / `Quantity.equals` (Decimal, не number) |
| `fee` | `Fee.equals` — и актив, и величина |
| `timestamp` | `Timestamp.equals` |
| `side` | `SideService.equals` |
| `fillIds` | по порядку: агрегат дописывает их в конец |

## Атомарность

**Commit заявки** — одна мутация:

```text
orders[order.id] = { order, updatedAt }
orderIdsByInstrument += order.id
portfolio = post-commit portfolio
version += 1   (аккаунт и глобально)
```

**Применение исполнения** — тоже одна:

```text
fills[fill.id] = { fill, status: APPLIED, appliedAt }
fillIdsByInstrument += fill.id
fillIdsByOrder += fill.id
portfolio = post-commit portfolio
если есть order:  orders[order.id] = …, orderIdsByInstrument += …
version += 1   (аккаунт и глобально)
```

Версия растёт **ровно на единицу**, даже когда событие изменило исполнение,
заявку, портфель и три индекса: считается принятое событие, а не число
затронутых структур.

Атомарность здесь не абстракция. Разнести заявку и портфель на два события
значило бы допустить окно, в котором состояние видит новую заявку со старым
портфелем, — то есть неправильную свободную сумму ровно в тот момент, когда по
ней принимается следующее решение.

## Версии

```text
AccountHotState.version       принятые мутации по ВСЕМ аккаунтам
AccountRuntimeState.version   принятые мутации ЭТОГО аккаунта
```

```text
account A init    → global 1, A 1
account B init    → global 2, B 1
account A order   → global 3, A 2
account A fill    → global 4, A 3
```

Инициализация — уже первая мутация, поэтому у только что созданного аккаунта
версия равна 1, а не 0. Отвергнутое событие и дубликат версий не меняют.

## Вторичные индексы

```text
orderIdsByInstrument  InstrumentId → Set<OrderId>
fillIdsByInstrument   InstrumentId → Set<FillId>
fillIdsByOrder        OrderId      → Set<FillId>
```

Индексы **только навигационные**. Источник истины — `orders`, `fills` и
`portfolio`; копий `Order`/`Fill` в индексе нет, иначе их пришлось бы держать
согласованными с оригиналом.

Значение — `Set`, а не массив: повторное обновление заявки не должно класть её
идентификатор второй раз. Инструмент входит в неизменяемую идентичность
заявки, поэтому обновление заявки индекс не меняет; исполнение неизменяемо
целиком, поэтому попадает в индекс один раз при `APPLIED`.

Инварианты проверяются тестами: ни одного висячего идентификатора, ни одного
дубля, дубликаты событий индексы не расширяют.

## `openOrders()`

Живыми считаются:

```text
PENDING            заявка отправлена, резервация уже сделана
OPEN               площадка приняла
PARTIALLY_FILLED   исполнена частично
```

`PENDING` входит **сознательно**: для нашего рантайма это уже незавершённая
экспозиция — деньги или токены под неё зарезервированы, — даже если площадка
ещё не ответила. Терминальные (`FILLED`, `CANCELED`, `REJECTED`, `EXPIRED`)
исключены.

Список задан **явно**, а не выведен как дополнение `TERMINAL_STATUSES`. Сегодня
это в точности дополнение, и тест полноты за этим следит. Но новый
нетерминальный статус, добавленный в `@polymarket/order` завтра, при выводе
через отрицание молча стал бы «открытым»; здесь он сломает тест полноты и
потребует осознанного решения.

## Что не подключено намеренно

### Старые fill-события

```text
FILL_RECEIVED         исполнение получено и ЕЩЁ должно быть обработано
FILL_CONFIRMED        finality в терминах старого use-case flow
FILL_FAILED           откат считает подписчик
DIRECT_FILL_APPLIED   эффект применён вне обычного flow
```

Все они — **вход** старого контура обработки. Новое
`TRADING_ACCOUNT_FILL_APPLIED` означает противоположное: экономический эффект
**уже** применён, вот итоговый `Portfolio`. Это разные уровни семантики, и
объединять их нельзя. Старые события не удалены и не изменены — у них свои
потребители.

### `ORDER_UPDATE_RECEIVED`

Несёт сырой `VenueOrderUpdate`, `accountId` и `receivedAt` — и **не** несёт ни
итогового `Order`, ни `Portfolio`. Это вход старого flow, а не его итог.

### Domain `OrderEvent`

`ORDER_CREATED`, `ORDER_ACCEPTED`, `ORDER_PARTIALLY_FILLED`, `ORDER_FILLED`,
`ORDER_CANCELLED`, `ORDER_REJECTED`, `ORDER_EXPIRED` описывают переход агрегата
и не несут портфель. Подписавшись на них, приватное состояние получило бы
заявку без гарантии, что соответствующие резервации уже материализованы.

Будущий command/domain-процессор после успешного commit'а публикует именно
`TRADING_ACCOUNT_ORDER_COMMITTED`.

## Что означает `critical: true`

Ровно одно: отказ обработчика возвращается публикующей стороне как `Err` из
`IEventBus.publish()`, а не глотается шиной. Никакой автоматической остановки
торгового рантайма отсюда **не** следует.

Fail-closed живого контура обязан быть решён отдельно и **до** включения
Strategy/Execution. Для приватного состояния цена молчания выше, чем для
рыночного: разошедшийся ответ на вопрос «сколько у нас денег» приводит к
реальным заявкам на несуществующие средства.

## Хранение

На время жизни рантайма. Ни `RollingWindow`, ни `maxAge`, ни `maxCount`, ни
компакции, ни персистентности.

Это сознательное решение, а не недоделка: заявок и исполнений на порядки
меньше, чем публичных обновлений стакана, и политика хранения, угаданная под
несуществующую нагрузку, оказалась бы либо избыточной, либо неверной.
Долговременная история и компакция появятся вместе с персистентностью
исполнения и аккаунта.

## Чего в этом слое нет

```text
reconciliation      IAccountReconciliationSource, AccountReconciler, REST-опрос,
                    таймеры сверки баланса и заявок, health, staleness
strategy            TradingContext, DecisionScheduler, Strategy, indicators,
                    features, Decision, RiskModel, TradingRiskGuard, Intent
execution           ExecutionEngine, IOrderExecutionVenue, новый IExchangeClient
```

Каждое — отдельный этап поверх готового состояния.

## Тесты

Все — через **настоящий** `EventBus`, а не прямыми вызовами состояния:
проверяется весь путь `IEventBus → projector → state`, включая
critical-подписки. Фикстуры строятся настоящими domain-конструкторами
(`Order.create`, `Fill.create`, `Portfolio.create`, `Balance.of`,
`SimplePosition`): половина инвариантов опирается на `equals()` реальных value
objects, и структурная заглушка проверяла бы не тот код.

| файл | что покрывает |
| --- | --- |
| `initialization.test.ts` | создание аккаунта, запрет повтора, ключевание по canonical-строке, изоляция площадок, три места идентичности портфеля, venue-bound `AccountId` |
| `orderCommit.test.ts` | атомарный commit, владелец заявки, разрешение инструмента, конфликты идентичности (table-driven), дубликат со stale-портфелем, законная эволюция, индекс по инструменту |
| `fillLifecycle.test.ts` | apply с заявкой и без, связь заявки и исполнения, дубликаты, конфликты факта (table-driven), `CONFIRMED`, `REVERTED`, запрещённые переходы |
| `navigation.test.ts` | навигационные API, `getPosition` из портфеля, семантика и полнота `openOrders`, инварианты индексов |
| `versionsAndTime.test.ts` | глобальная и локальная версии, `metadata.createdAt` как единственный источник времени |
| `atomicity.test.ts` | полный отпечаток состояния до и после 13 невалидных событий, `Err` из `publish()`, `stop()`/повторный `start()` |
| `replayDeterminism.test.ts` | одна лента на двух свежих рантаймах даёт эквивалентное состояние |
| `eventIsolation.test.ts` | старые application-события и Domain `OrderEvent` не проецируются |
| `identityHelpers.test.ts` | `accountKey`, `embeddedVenueId`, `sameOrderIdentity`/`sameOrderState`, `sameFillFact` — по каждому полю |
