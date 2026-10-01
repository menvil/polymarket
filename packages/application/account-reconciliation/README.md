# @polymarket/account-reconciliation

Authoritative-сверка торгового аккаунта: получает состояние аккаунта от
внешнего authoritative-источника, сравнивает его с локальным `AccountHotState`
и при расхождении корректирует локальное состояние — через **ту же**
canonical-шину и **того же** единственного писателя.

```text
authoritative account source        IAccountReconciliationSource
        ↓
AccountReconciler                   один проход: снимок + expectedAccountVersion
        ↓
TRADING_ACCOUNT_RECONCILED
        ↓
IEventBus
        ↓
AccountStateProjector               единственный писатель: CAS + одна мутация
        ↓
AccountHotState
```

Рядом объявлен (но сверкой пока не вызывается) контракт **фактов площадки**
для настоящего venue-адаптера — `IAccountVenueObservationSource`, см.
[Venue Observations vs Local Portfolio](#venue-observations-vs-local-portfolio).

```mermaid
flowchart TD
    RT[runtime: STARTUP / PERIODIC / RECONNECT / MANUAL / INCONSISTENCY] -->|request| C[AccountReconciliationCoordinator]
    C -->|single-flight per account| R[AccountReconciler]
    R -->|read-only view| V[AccountHotStateView]
    R -->|getPortfolio / getOpenOrders / getFills / getOrder| S[IAccountReconciliationSource]
    R -->|publish| B[IEventBus]
    B -->|critical| P[AccountStateProjector]
    P --> H[AccountHotState]
    C --> HV[health view]
```

## Что сверка исправляет

Живой контур (`TRADING_ACCOUNT_ORDER_COMMITTED`, `_FILL_APPLIED`, …) описывает
операции, которые рантайм выполнил сам. Он может пропустить факт: разрыв
приватного потока, рестарт, ошибка процессора. Тогда локальное состояние
расходится с площадкой — молча. Сверка берёт authoritative-снимок и
исправляет:

- **портфель** — деньги, позиции, токенные балансы;
- **заявки** — неизвестные вставляются, изменившиеся заменяются настоящим
  состоянием;
- **исполнения** — пропущенные появляются, применённые подтверждаются.

## Чем сверка НЕ является

Это не live-обработка и не её замена. Сверка не повторяет FSM заявки, не
считает резервации, комиссии и FIFO — она принимает готовое authoritative-
состояние. Живые события остаются основным путём; коррекция — ещё один
canonical-путь рядом с ними.

## Почему нет прямой мутации

У `AccountHotState` ровно один писатель — `AccountStateProjector`. Reconciler
получает только read-only `AccountHotStateView` и публикует canonical-событие
в ту же `IEventBus`:

```text
никаких прямых мутаций AccountHotState
никакой третьей шины и отдельного reconciliation bus
только canonical ApplicationEvent
```

Второй писатель вернул бы гонку, ради устранения которой проектор и заведён:
порядок эффектов двух писателей не определялся бы ничем.

## Почему CAS обязателен

Снимок строится несколькими запросами к источнику, пока живой контур
продолжает менять аккаунт:

```text
reconciler прочитал аккаунт      version = 100 → expectedAccountVersion
идут запросы к источнику
  живое событие                  version = 101
TRADING_ACCOUNT_RECONCILED(100)  → AccountReconciliationVersionConflictError
```

Снимок, основанный на версии 100, не видел изменения, создавшего версию 101.
Наложить его значило бы откатить это изменение — например, вернуть в
`available` деньги, уже зарезервированные под новую заявку. Поэтому
`AccountHotState` перед ЛЮБОЙ мутацией коррекции проверяет
`account.version === expectedAccountVersion` и при расхождении отвергает её
целиком: ни мутации, ни приращения версий, ни изменения `lastMutationAt`.

Конфликт — **нормальная гонка**, а не дефект. Координатор не ставит
`UNHEALTHY`, не публикует тот же снимок повторно (он устарел) и делает свежий
проход: заново читает и версию, и источник. Распознаётся конфликт по классу
(`instanceof AccountReconciliationVersionConflictError`), а не по тексту.

## Почему отсутствие open order требует `getOrder`

```text
локально:        order-123 OPEN
getOpenOrders:   order-123 нет
```

Из «её нет среди открытых» нельзя вывести, что с ней стало: отменена,
исполнена, отвергнута, истекла — или источник временно её не вернул. Поэтому
для каждой локально открытой заявки (`OPEN_ORDER_STATUSES` из
`@polymarket/order`), отсутствующей среди открытых, reconciler спрашивает
`getOrder(orderId)`:

```text
найдена     → её настоящее состояние идёт в снимок
undefined   → статус НЕ угадывается: события нет, health UNHEALTHY
```

Fail closed: угаданный статус освободил бы или оставил резервацию наугад.

`PENDING` входит в открытые сознательно: под неё уже зарезервированы деньги.
Следствие — заявка, ещё не дошедшая до площадки, делает сверку `UNHEALTHY`,
пока площадка её не узнает: по одному снимку «ещё летит» от «потеряна» не
отличить.

## Почему authoritative Fill сразу `CONFIRMED`

У исполнения две оси:

```text
TradeStatus        MATCHED / MINED / RETRYING / CONFIRMED / FAILED   что говорит площадка
AccountFillStatus  APPLIED / CONFIRMED / REVERTED                    что сделал рантайм
```

Сверка работает со второй. Присутствие исполнения в `getFills()` означает, что
сделка на площадке существует, — на оси рантайма это подтверждение:

```text
нет локально   → { status: CONFIRMED, appliedAt = confirmedAt = время коррекции }
APPLIED        → CONFIRMED, исходный appliedAt сохранён
CONFIRMED      → no-op
REVERTED       → Err: противоречие нашего отката и площадки, не «воскрешаем»
другой факт    → Err (findFillFactDifference)
```

Искусственного `APPLIED → CONFIRMED` у нового исполнения нет: его экономика
уже внутри authoritative-портфеля, и симулировать для неё живой жизненный цикл
незачем. Venue-ось (`venueStatus`, `venueStatusAt`) коррекция не стирает и не
придумывает.

## Почему Portfolio принимается целиком

Authoritative-портфель — экономическая истина аккаунта. `AccountStateProjector`
**не** пересчитывает его из заявок и исполнений: вторая реализация экономики
рядом с первой неизбежно разошлась бы с ней. Все инварианты `Portfolio`
(владение, `Position.quantity == available + reserved` токенов) выполнены его
конструктором ещё на границе источника.

No-op определяется canonical-равенством домена — `samePortfolioState` из
`@polymarket/portfolio` (поверх `samePositionState` из `@polymarket/position`),
`sameOrderState`, `findFillFactDifference`, — а не `JSON.stringify`,
сравнением ссылок или числовым приведением.

### Требование к будущему источнику: настоящая lot provenance

`Position` лотовая: количество, средняя цена и FIFO-закрытие выводятся из
лотов. Будущий Polymarket-адаптер **не имеет права** собирать позицию из пары
`quantity + averagePrice` из REST: позиция выглядела бы валидной, но её лоты
были бы выдуманы, и первое же FIFO-закрытие дало бы неверный realized PnL.
Для materialization authoritative-портфеля адаптеру нужна достаточная история
исполнений, из которой строятся настоящие лоты. В этом MR адаптера нет —
fake-источник отдаёт заранее собранный валидный `Portfolio`.

Поэтому настоящий Polymarket-адаптер реализует не этот порт, а порт **фактов
площадки** `IAccountVenueObservationSource`: лоты остаются локальными, а
площадка сообщает только то, что знает (см. «Venue Observations vs Local
Portfolio»).

## Venue Observations vs Local Portfolio

`IAccountReconciliationSource` требует от источника готовый `Portfolio` — то
есть **наше локальное** состояние. Настоящая площадка его вернуть не может:

```text
Portfolio
├── Balance
│   ├── available        ← локальная бухгалтерия
│   └── reserved         ← локальная резервация под открытые заявки
├── Position
│   └── FIFO lots[]      ← локальная provenance исполнений
└── TokenBalance
    ├── available
    └── reserved         ← локальная резервация под открытые SELL
```

Polymarket authoritative знает внешние **факты** — collateral, владения
токенами, открытые заявки, сделки и их on-chain статус, — но не знает нашего
разделения `available`/`reserved`, наших FIFO-лотов, `strategyId` локальной
заявки и локальных времён. Адаптер, обязанный отдать `Portfolio`, был бы
вынужден всё это выдумать. Поэтому для настоящего venue-адаптера введён
отдельный порт **фактов площадки**:

```text
               POLYMARKET
                   ↓
      AuthoritativeAccountObservation
      ├── collateralBalance
      ├── positions[]
      ├── openOrders[]
      └── fills[] + venueStatus
                   ↓
             future matcher
                   ↕
             AccountHotState
                   ↓
               Portfolio
               ├── Balance
               ├── FIFO Position
               └── TokenBalance
```

```typescript
export interface IAccountVenueObservationSource {
  getAccountObservation(venueId, accountId):
    Promise<Result<AuthoritativeAccountObservation, AccountReconciliationSourceError>>;
  getOrderObservation(venueId, accountId, orderId):
    Promise<Result<AuthoritativeOrderObservation | undefined, AccountReconciliationSourceError>>;
  getAssetBalance(venueId, accountId, asset):
    Promise<Result<Quantity, AccountReconciliationSourceError>>;
}
```

**Сейчас это подготовка.** Порт и DTO только объявлены: их не вызывает ни
`AccountReconciler`, ни runtime, реализаций нет. Существующая сверка работает
через `IAccountReconciliationSource` без изменений. Переход:

```text
#107  контракт наблюдений (этот шаг)
#108  PolymarketAccountVenueObservationSource на официальном @polymarket/client
#109  matcher наблюдений и коррекция; переключение AccountReconciler на новый порт
```

### Факт площадки ↔ локальный факт

| факт площадки | | локальный факт |
| --- | --- | --- |
| `collateralBalance` | ↔ | `Balance.available + Balance.reserved` |
| `position.quantity` | ↔ | `Position.quantity` |
| | ↔ | `TokenBalance.available + TokenBalance.reserved` |
| открытые BUY | → | reserved cash |
| открытые SELL | → | reserved tokens |
| fill + venue status | ↔ | `AccountFillRecord` |

### Что НЕ является authoritative-заменой

```text
Polymarket position.avgPrice      ≠  источник локальных FIFO-лотов
Polymarket collateral balance     ≠  локальный Balance.available
Polymarket token balance          ≠  локальный TokenBalance.available
Polymarket order                  ≠  canonical локальная идентичность Order
```

Площадка даёт наблюдаемые факты. Рантайм владеет своей бухгалтерской
структурой.

### DTO наблюдения

`AuthoritativeAccountObservation` — **один логический проход** наблюдения, а
не атомарная транзакция площадки. Адаптер соберёт его несколькими запросами
(баланс, позиции, заявки, сделки), но каждый набор получен **один раз** за
проход, **целиком** (пагинация исчерпана) и сохранён как есть. Оборванная
пагинация и непонятая запись — `Err`, а не короткий список: короткий список
неотличим от «этого нет на площадке».

| DTO | authoritative | чего в нём нет и почему |
| --- | --- | --- |
| `collateralBalance: Money` | полное collateral-владение аккаунта | `availableCollateral`/`reservedCollateral` — резервация локальна |
| `AuthoritativePositionObservation` | `asset + quantity` | `lots[]` — площадка их не знает; `averagePrice`/`entryCost` есть, но только как диагностика |
| `AuthoritativeOrderObservation` | `orderId`, `asset`, `side`, `price`, `size`, `filledSize`, `status` | `strategyId`, `timestamp`, `reason`, `fillIds`, `accountId` — локальные поля `Order` |
| `AuthoritativeFillObservation` | canonical `Fill` + **обязательный** `metadata.tradeStatus` | — |

#### Заявка: почему не canonical `Order`

Неизменяемая идентичность `Order` (`findOrderIdentityDifference`) включает
`strategyId` и `timestamp`. Адаптер поставил бы `strategyId: undefined` там,
где локально стоит автор заявки, и canonical-сравнение дало бы ложный
конфликт на каждой заявке стратегии. `timestamp` у локальной заявки — момент
создания рантаймом, у площадки — момент приёма: это разные факты.

`AuthoritativeOrderStatus = Exclude<OrderStatus, 'PENDING'>`. `PENDING` —
локальное состояние (отправлена, но не принята), площадка его подтвердить не
может. Vendor-статус, который нельзя **однозначно** привести к
`OPEN`/`PARTIALLY_FILLED`/`FILLED`/`CANCELED`/`REJECTED`/`EXPIRED`, — `Err`
источника. Legacy-правило «неизвестный статус → `OPEN`» не переносится:
угаданный `OPEN` держал бы резервацию под заявкой, которой на площадке,
возможно, уже нет. Состав статусов закреплён тестом — новый `OrderStatus` не
станет authoritative молча.

#### Сделка: почему статус площадки обязателен

```text
MATCHED    матчинг произошёл — годится для восстановления, но НЕ финальность
MINED      расчётная транзакция в блоке — ещё НЕ финальность
RETRYING   расчёт повторяется — НЕ финальность
CONFIRMED  финальное подтверждение площадки
FAILED     исполнение окончательно не состоялось
```

Правило «сделка есть в ответе → `AccountFillStatus.CONFIRMED`» запрещено.
Это две разные оси, и смешивать их нельзя:

```text
TradeStatus        MATCHED / MINED / RETRYING / CONFIRMED / FAILED   что говорит площадка
AccountFillStatus  APPLIED / CONFIRMED / REVERTED                    что сделал рантайм
```

Наблюдение несёт только первую; во вторую её переведёт matcher (#109).
`FAILED` после локального `APPLIED` — случай отката/конфликта, решаемый там же.

`Fill` наблюдения обязан иметь **ту же** canonical-идентичность, что и
исполнение из приватного потока, — иначе одна сделка, увиденная дважды,
станет двумя исполнениями. Поэтому REST-сделка переводится тем же правилом
`FillId`, что и WS-событие (`FillMapper`), а не независимым маппером.

#### `getAssetBalance()` — только при расхождении

Независимое подтверждение владения **одним** outcome-активом: полное
количество на аккаунте, а не `TokenBalance.available`. Нужно, когда
количество позиции в наблюдении не сошлось с локальным:

```text
positions[].quantity ≠ Position.quantity
        ↓
getAssetBalance(asset)        независимый источник площадки (баланс расчётного слоя)
        ↕
TokenBalance.available + TokenBalance.reserved
        ↕
Position.quantity
```

В обычном успешном проходе для каждого токена его **не** вызывают.

### Будущая семантика резерваций (только описание — не реализовано)

Площадка сообщает полное владение, а локальная бухгалтерия делит его на
`available` и `reserved`. Резервация выводится из authoritative открытых
заявок:

```text
BUY   remaining = size - filledSize
      reserved cash   = remaining × order.price

SELL  remaining = size - filledSize
      reserved tokens = remaining
```

Отсюда главное соотношение — и главная причина observation-модели:

```text
venue holding  ≠  local available
venue holding  =  local available + local reserved
```

### Будущая политика сверки инвентаря (только описание — не реализовано)

```text
external position quantity  vs  local Position.quantity
```

**Совпадает** → существующие FIFO-лоты **сохраняются**, даже если
`avgPrice` площадки не равен `Position.averageEntryPrice`: модели учёта
(комиссии, частичные закрытия, merge) могут отличаться, а количество — нет.

**Не совпадает** → сначала ищется недостающее authoritative-исполнение:

```text
external qty = 10
local qty    = 8
fills[] содержит BUY +2, которого нет локально   → provenance найдена
```

Коррекция восстанавливает лоты из **настоящего** `Fill`. Если после учёта
известных исполнений расхождение не объясняется:

```text
POSITION_QUANTITY_MISMATCH → fail closed
```

Создать синтетический лот на разницу — **запрещено**.

## Один проход: `AccountReconciler`

```text
1. прочитать локальный аккаунт: version → expectedAccountVersion,
                                локально открытые заявки (одним синхронным участком)
2. getPortfolio + getOpenOrders + getFills   параллельно; любой отказ → Err, события нет
3. getOrder для каждой локально открытой, отсутствующей среди открытых
4. собрать снимок, опубликовать TRADING_ACCOUNT_RECONCILED
5. исход шины → исход прохода
```

Никогда не бросает: адаптер, нарушивший контракт порта исключением, даёт тот
же `AccountReconciliationSourceError`.

Проверки согласованности снимка (владелец, инструмент, идентичность,
переходы) живут в `AccountHotState` — reconciler проверяет только то, без
чего снимок не собрать.

### Граница подтверждения доставки: `publishConfirmed()`

Обычный `IEventBus.publish()` при уже активном drain только ставит событие в
очередь, и его `Ok` означает «принято в очередь», а не «обработано». Для
reentrant-доставки это правильно; для сверки — нет: успешный проход обязан
значить, что ИМЕННО её `TRADING_ACCOUNT_RECONCILED` прошёл critical-проектор.
Поэтому коррекция публикуется через `IEventBus.publishConfirmed()`:

```text
активен drain / в очереди backlog → дождаться (MessageBus.drain())
    backlog упал                  → Err, коррекция в очередь НЕ ставится вовсе
очередь пуста и drain нет         → коррекция первая в новом drain → её исход
    отказ ПОЗЖЕ в том же drain    → исход коррекции всё равно Ok
```

Отказ признаётся «своим» только по `CriticalHandlerError.context.messageId`,
совпавшему с `metadata.messageId` опубликованной коррекции, — не по типу
события. Координатор сверяет аккаунты параллельно, и `publishConfirmed()`
возвращает отказ уже стоявшего backlog — например, коррекции другого
аккаунта. Чужой отказ означает, что наша коррекция не публиковалась:
`PUBLISH_FAILED`, а не диагноз нашего снимка. Применить её позже он не может —
в очереди её нет.

```text
Ok                    именно эта коррекция прошла critical-обработчики:
                      состояние приняло её или признало no-op
Err(VersionConflict)  именно эта коррекция получила CAS-конфликт
Err(Validation)       именно эта коррекция отвергнута состоянием
Err(Publish)          эта коррекция не подтверждена (и не применится)
```

`reconcile()` и `request()` — внешняя request/response-граница: вызывать их с
`await` из handler'а шины нельзя — `publishConfirmed()` ждал бы drain, который
держит сам этот handler.

| исход | ошибка | `failureCode` | событие |
| --- | --- | --- | --- |
| аккаунт не принят состоянием | `AccountReconciliationValidationError` (`ACCOUNT_NOT_INITIALIZED`) | `VALIDATION_FAILED` | нет |
| отказ обязательного чтения | `AccountReconciliationSourceError` | `SOURCE_FAILED` | нет |
| `getOrder` → `undefined` | `AccountReconciliationUnresolvedOrderError` | `UNRESOLVED_ORDER` | нет |
| `getOrder(X)` вернул `Y` | `AccountReconciliationValidationError` (`ORDER_ID_MISMATCH`) | `VALIDATION_FAILED` | нет |
| состояние отвергло снимок | `AccountReconciliationValidationError` (`CORRECTION_REJECTED`) | `VALIDATION_FAILED` | опубликовано, не применено |
| шина не приняла коррекцию либо упал уже стоявший backlog (чужой `messageId`) | `AccountReconciliationPublishError` | `PUBLISH_FAILED` | не поставлено в очередь, не применится |
| снимок устарел | `AccountReconciliationVersionConflictError` | — (не отказ) | опубликовано, не применено |

## Планирование: `AccountReconciliationCoordinator`

Per-account single-flight с dirty-флагом `requestedAgain`:

```text
request(A) ──► проход A#1
request(A) ─┐
   … ×10    ├► requestedAgain = true — параллельных проходов нет
request(A) ─┘
               A#1 завершён ──► ОДИН свежий проход A#2
                                (запросы во время A#2 → A#3, …)
request(B) ──► B#1 идёт параллельно с A — аккаунты независимы
```

Запрос, пришедший во время прохода, этим проходом обслужен быть не может — тот
уже начал читать источник раньше него. Поэтому `request()` отдаёт исход
ПЕРВОГО прохода, начавшегося после запроса. Ключ аккаунта — `VenueId` +
canonical `accountIdToString` на вложенных `Map`, как в `AccountHotState`.

При конфликте версий ожидающие переходят к свежему проходу. Серия конфликтов
подряд ограничена `maxConsecutiveVersionConflicts` (по умолчанию
`DEFAULT_MAX_CONSECUTIVE_VERSION_CONFLICTS = 3`): аккаунт, который живой контур
меняет быстрее, чем источник отвечает, иначе держал бы координатор в
бесконечной петле запросов. По исчерпании ожидающие получают конфликт, health
не меняется. Это предохранитель, а не каденция.

Таймеров нет. Причина запроса — `AccountReconciliationTrigger`
(`STARTUP` | `PERIODIC` | `RECONNECT` | `MANUAL` | `INCONSISTENCY`) — только
запоминается в health; когда какую запрашивать, решает будущий runtime.

## Health

Отдельное состояние пакета — не в `AccountHotState` и не в `Portfolio`:
проекция строится только из событий, а health — результат наших попыток эти
события подтвердить.

```text
INITIALIZING  успешной сверки ещё не было (так же — для незнакомого аккаунта)
READY         последняя завершённая сверка успешна, включая no-op
UNHEALTHY     последняя завершённая сверка отказала
```

| событие | status | времена |
| --- | --- | --- |
| начат проход | не меняется | `lastAttemptAt`, `lastTrigger` |
| успех (применено или no-op) | `READY` | `lastSuccessAt`; `failureCode`/`failureReason` сняты |
| отказ | `UNHEALTHY` | `lastFailureAt`, `failureCode`, `failureReason` |
| конфликт версий | **не меняется** | только `lastAttemptAt` (свежий проход) |

Время — только от инъецированного `IClock`; `Date.now()` и `new Date()` в коде
пакета нет (это проверяет `boundary.test.ts`). Health — текущее состояние, а
не история попыток; персистентности нет.

## Пример

```typescript
import {
  AccountReconciler,
  AccountReconciliationCoordinator,
} from '@polymarket/account-reconciliation';

const reconciler = AccountReconciler.create({
  source,                          // IAccountReconciliationSource
  eventBus,                        // та же IEventBus, что у живого контура
  accountState: projector.state(), // AccountHotStateView — только чтение
  metadata,                        // MessageMetadataGenerator рантайма
});
const coordinator = AccountReconciliationCoordinator.create({ reconciler, clock });

const result = await coordinator.request(venueId, accountId, 'STARTUP');
if (!result.ok) {
  // UNHEALTHY или исчерпан предел конфликтов — решает рантайм
}
coordinator.health().get(venueId, accountId).status; // 'READY' | 'UNHEALTHY' | 'INITIALIZING'
```

## Известные ограничения

- **Чужой упавший backlog делает проход `UNHEALTHY`.** Если перед коррекцией
  в очереди упало чужое событие (например, коррекция другого аккаунта с
  конфликтом версий), коррекция не публикуется и проход получает
  `PUBLISH_FAILED`. Это fail closed: состояние не подтверждено; следующий
  запрос сверки делает свежий проход.
- **Живой контур по-прежнему на `publish()`.** Как он реагирует на отказ
  приватной публикации — открытый вопрос контура (см. `AccountStateProjector`),
  он обязан быть решён fail-closed до включения Strategy/Execution.
- **Локальный `APPLIED`, которого нет в `getFills()`,** не интерпретируется:
  ни откат, ни отказ. Порт не даёт «спросить исполнение по id», а список
  исполнений источника может быть окном, а не полной историей.
- **Согласованность снимка между вызовами** (портфель прочитан до исполнения,
  список исполнений — после) порт не гарантирует — это свойство адаптера.

## Что реализовано и что нет

| реализовано | не реализовано |
| --- | --- |
| узкий canonical-порт `IAccountReconciliationSource` | Polymarket REST-адаптер, SDK, DTO |
| контракт фактов площадки `IAccountVenueObservationSource` + `Authoritative*Observation` (только типы) | его реализация, matcher наблюдений, реконструкция резерваций, восстановление пропущенных исполнений, `POSITION_QUANTITY_MISMATCH` |
| `AccountReconciler` — один проход | таймеры, cron, production-каденция |
| событие `TRADING_ACCOUNT_RECONCILED` с CAS | startup/runtime wiring, CLI |
| атомарная коррекция в `AccountStateProjector` / `AccountHotState` | private WebSocket reconciliation |
| семантика заявок и исполнений | персистентный health / снимок |
| health: `INITIALIZING` / `READY` / `UNHEALTHY` | metrics exporter, dashboard |
| per-account single-flight координатор | Strategy, TradingContext, Risk, Execution |
| `FakeAccountReconciliationSource` (test-only) и тесты | |

## Тесты

| файл | что покрывает |
| --- | --- |
| `reconciler.test.ts` | ровно одно событие на успех; отказ каждого обязательного чтения → события нет; исключение адаптера; `getOrder` для отсутствующих открытых; `undefined` → `UnresolvedOrder`; `PENDING` как открытая; `ORDER_ID_MISMATCH`; `CORRECTION_REJECTED` |
| `coordinator.test.ts` | single-flight (10 запросов → один свежий проход), цепочка проходов, независимость аккаунтов, CAS-гонка v10 → v11 со свежим проходом, предел конфликтов, дефект reconciler'а |
| `health.test.ts` | все переходы статуса, времена из `PaperClock`, no-op → `READY`, конфликт ≠ `UNHEALTHY`, независимость аккаунтов |
| `publish.test.ts` | классификация исходов `publishConfirmed()` на stub-шине (обычный `publish()` в ней бросает): переполнение, исключение, critical-ошибка чужого события (другого типа и чужой `TRADING_ACCOUNT_RECONCILED` по `messageId`), конфликт по классу |
| `confirmedDelivery.test.ts` | настоящая шина: A держит drain — B не резолвится и не `READY` до обработки своей коррекции; конфликт A не достаётся B; упавший чужой backlog — коррекция B не встаёт в очередь и не применяется позже; отказ другого события после B в том же drain — исход B успешен |
| `venueObservation.types.test.ts` | compile-time контракт наблюдений: у заявки нет `strategyId`/`timestamp`, `PENDING` не authoritative (и состав статусов закреплён), без `tradeStatus` и голый `Fill` не компилируются, у позиции нет `lots`, у наблюдения нет `available`/`reserved`, `Portfolio` — не наблюдение; порт реализуем одними canonical-типами; операции ошибки = методы порта |
| `boundary.test.ts` | нет зависимостей на infrastructure; закрытый список импортов; контракт наблюдений зависит только от ids/value-objects/order/fill/result; нет `@polymarket/client`/`@polymarket/bindings`; нет часов, таймеров, `JSON.stringify`, HTTP |

`FakeAccountReconciliationSource` (`__tests__/helpers/`) задаёт данные по
аккаунтам, отказы (`Err` или исключение), удержание следующего вызова до
`release()` с сигналом `entered` и считает вызовы и пик одновременных вызовов
по методу.
