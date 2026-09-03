# PolymarketControlRuntime — прямая оркестрация control-plane

## Проблема

К этому моменту в контуре были готовы все части цепочки:

```text
PolymarketMarketDiscovery → MarketUniverse → PolymarketPolicy
  → PolymarketSubscriptionPlanner → PolymarketSubscriptionController
  → PolymarketSource
```

Не было одного: прохода, который соединяет их в решение. Каждый компонент
отвечал на свой вопрос, но никто не отвечал на общий:

- когда обновлять universe и что делать, если Gamma недоступна?
- какие из пригодных рынков брать и сколько?
- что происходит с уже приобретённым рынком, когда он стартовал?
- как двум владельцам одного рынка достаться предсказуемому исходу?

## Решение

Один детерминированный шаг — `runOnce()`:

```text
                    CONTROL PLANE

current V2 Gamma
      ↓
PolymarketMarketDiscovery
      ↓ refresh()
MarketUniverse
      ↓
runtime demands
├── strategy:A     + Policy + acquireLimit
├── strategy:B     + Policy + acquireLimit
└── collector:raw  + Policy + acquireLimit
      ↓
PolymarketControlRuntime.runOnce()
      ↓
PolymarketSubscriptionPlanner
      ↓ первые N пригодных будущих рынков
PolymarketSubscriptionController.acquire()
      ↓
общие физические подписки


                     DATA PLANE

PolymarketSource → ExternalMessageBus → существующие потребители
```

## Публичный API

```typescript
class PolymarketControlRuntime {
  constructor(dependencies: PolymarketControlRuntimeDependencies);

  runOnce(
    demands: readonly PolymarketSubscriptionDemand[],
  ): Promise<PolymarketControlRuntimeResult>;
}

interface PolymarketSubscriptionDemand {
  readonly ownerKey: SubscriptionOwnerKey;
  readonly policy: PolymarketPolicy;
  readonly acquireLimit: number;
}
```

Всё. Ни `start()`, ни `stop()`, ни `tick()` по таймеру, ни реестра
владельцев: у объекта нет состояния между проходами.

## Почему нет внутреннего таймера

`runOnce()` — детерминированный шаг, который можно вызвать из теста, из
replay и из живого рантайма и получить один и тот же ответ. Собственный
`setInterval` превратил бы его в фоновый сервис, то есть в объект, поведение
которого зависит от того, когда его наблюдают.

Каденцию («каждую секунду», «каждые пять», «по событию») выбирает
composition root — он же знает, чем ещё занят процесс.

## Главный инвариант: `acquireLimit` считает КАНДИДАТОВ

```text
17:57  план: [X=BTC 18:00, Y=BTC 18:05]  limit 1 → acquire X
17:58  план: [X, Y]                      limit 1 → X already-held
18:00  план: [Y, ...]  (X стартовал)     limit 1 → acquire Y

итог: владелец держит X (начавшийся) И Y (предстоящий)
```

Соблазнительное и неверное имя поля — `maxActiveMarkets`. Под ним третий
тик читался бы как «лимит исчерпан», и владелец перестал бы приобретать
рынки НАВСЕГДА после первой же покупки: снять claim с начавшегося рынка
некому, а значит место никогда не освободится.

Причина, по которой считать нужно именно кандидатов, лежит уровнем ниже:

```text
Planner    → какие НОВЫЕ рынки ещё можно приобрести
Controller → какие УЖЕ приобретённые рынки продолжают жить
```

Рынок исчезает из плана СРАЗУ после старта торгов — не потому, что он больше
не нужен, а потому, что приобретать его уже поздно. Поэтому «сколько рынков
в плане обработать» и «сколько рынков у владельца всего» — разные величины,
и путать их нельзя.

## Спрос — не desired-state

```text
demands = что сейчас нужно ПОПРОБОВАТЬ приобрести
demands ≠ полный список того, чем владелец должен владеть
```

Из этого следуют три правила, которых у рантайма нет ни в одной строке кода
(и это проверяется структурным тестом — вызовов `release`/`releaseOwner` в
пакете нет вовсе):

| Событие | Что делает рантайм |
|---|---|
| владелец пропал из `demands` | ничего: claim остаётся |
| policy владельца сменилась | приобретает новый рынок; старый НЕ отпускает |
| `acquireLimit` уменьшился | ничего: «лишние» claim-ы остаются |

Явный конец владения — работа composition root:

```typescript
await controller.releaseOwner(ownerKey); // экземпляр стратегии остановлен
```

Он знает то, чего рантайм знать не может: остановлен ли владелец на самом
деле, или его просто не оказалось в спросе этого тика.

Смена policy — сознательно промежуточное поведение. Вопрос «отпускать ли
старый рынок сразу или дожидаться конца его жизненного цикла» здесь не
решается: у него нет очевидно правильного ответа, а неявный ответ был бы
хуже отсутствующего.

## Один `now` на весь проход

Часы читаются РОВНО ОДИН раз — после обхода каталога, — и этот момент
получают все вызовы планировщика тика:

```text
владелец A → planner.plan(entries, policyA, now)
владелец B → planner.plan(entries, policyB, now)   ← тот же now
```

Иначе на стыке 18:00 владелец A увидел бы рынок 18:00 будущим, а владелец B,
спланированный на миллисекунду позже, — уже начавшимся: один тик описывал бы
два разных мира.

Контроллер при этом читает часы САМ на каждом `acquire()`, и это не
дублирование, а разные вопросы:

```text
время планировщика → единый снимок РЕШЕНИЯ тика
время контроллера  → последняя проверка перед ФИЗИЧЕСКИМ действием
```

## Обход каталога: last-good universe

```typescript
const refreshed = await discovery.refresh();
if (refreshed) {
  universe.replace(discovery.getSnapshot());
}
```

Проверка исхода обязательна. Контракт `refresh(): boolean` существует ровно
затем, что при отказе внутренний снимок discovery остаётся last-good.
Наивное

```typescript
await discovery.refresh();
universe.replace(discovery.getSnapshot()); // ← без проверки
```

на первом же неудачном обходе обнулило бы universe, а дальше переписывало бы
его тем же снимком впустую. Хуже другое: временная недоступность Gamma
читалась бы как «рынков больше нет», то есть как повод перестать приобретать
вообще.

Поэтому:

```text
transient discovery failure ≠ забыть все известные рынки
```

Отчёт при этом честно показывает `discoveryRefreshed: false`, и по
last-good universe можно приобрести рынок — это отдельный тест пакета.

Пустой universe + неудачный первый обход = нулевой отчёт, а НЕ исключение:
недоступный Gamma — нормальный рантайм control-plane.

## Детерминированный порядок владельцев

```text
1. валидация всего спроса
2. копия входного массива
3. сортировка по ownerKey ASC
4. последовательная обработка
```

Два владельца могут захотеть один рынок. При произвольном порядке было бы
недетерминировано, кто получит `opened`, а кто `joined`. Физический
результат от этого не меняется (подписка всё равно одна — дедупликацию
делает контроллер), а диагностика меняется, и повторяемость отчёта стоит
дороже нескольких миллисекунд параллелизма.

`Promise.all` здесь не используется СОЗНАТЕЛЬНО, хотя контроллер
конкурентное приобретение выдерживает. Станет узким местом — оптимизируем
осознанно.

## Валидация: fail-fast до побочных эффектов

| Дефект спроса | Результат |
|---|---|
| пустой/пробельный `ownerKey` | `ValidationError` |
| дубликат `ownerKey` в одном проходе | `ValidationError` |
| `acquireLimit` не целое `>= 1` | `ValidationError` |

Вся проверка выполняется ДО `discovery.refresh()` и ДО первого
`controller.acquire()`. Иначе «проход упал» означало бы «часть прохода
всё-таки выполнилась», и вызывающему пришлось бы выяснять, какая именно.

Дубликат владельца — именно ошибка, а не «побеждает первый»: два спроса
одного владельца в одном тике не отвечают на вопросы «какая policy
каноническая» и «какой лимит канонический».

Отвергаются `0`, отрицательные, дробные, `NaN` и `Infinity`. `slice(0, NaN)`
молча даёт пустой срез — владелец, чей спрос никогда не выполняется, выглядел
бы как владелец, которому просто не подошёл ни один рынок.

## Исходы приобретения — значения, а не исключения

Проход не бросает из-за недоступного Gamma, отказавшего транспорта или
непригодного рынка. Всё это попадает в отчёт:

| Исход | Что означает |
|---|---|
| `opened` | появился физический ресурс |
| `joined` | ресурс уже был, добавился владелец |
| `already-held` | этот владелец уже держит claim |
| `rejected` | рынок непригоден (стартовал, подготовка пропала, источник недоступен) |
| `failed` | отказ транспорта; всё открытое откачено |

Ни `joined`, ни `already-held` ошибками не являются — это нормальные исходы
общего ресурса.

### Никаких ретраев внутри прохода

На каждого отобранного кандидата — РОВНО одна попытка. Повтор произойдёт сам
собой на следующем внешнем тике, если планировщик всё ещё возвращает этот
рынок. Ретрай внутри прохода сделал бы длительность тика непредсказуемой и
ничего бы не исправил: за миллисекунды мир не меняется.

Замена терминально отказавшего `PolymarketSource` — тоже не работа рантайма:
он получает `source-unavailable` и показывает это в отчёте. Пересборка
источника с рематериализацией живых claim-ов будет отдельным шагом
композиции.

## Отчёт прохода

```typescript
interface PolymarketControlRuntimeResult {
  readonly ranAt: Timestamp;
  readonly discoveryRefreshed: boolean;
  readonly universeEntries: number;
  readonly owners: readonly PolymarketOwnerRuntimeResult[];   // ownerKey ASC
  readonly controller: PolymarketSubscriptionControllerStats;
}

interface PolymarketOwnerRuntimeResult {
  readonly ownerKey: SubscriptionOwnerKey;
  readonly acquireLimit: number;
  readonly plan: {
    readonly candidateCount: number;
    readonly diagnostics: PolymarketSubscriptionPlanDiagnostics;
  };
  readonly selectedMarketIds: readonly MarketId[];      // порядок планировщика
  readonly acquisitions: readonly PolymarketAcquireResult[];
}
```

Инвариант позиций: `selectedMarketIds[i] ↔ acquisitions[i]`. Оба массива
строятся из одного среза плана в одном цикле, поэтому сопоставление идёт по
индексу, без поиска по `marketId`.

Отчёт заморожен целиком. Наружу не выходят ни vendor-записи
(`SelectedPolymarketMarket`), ни Gamma-модели, ни внутренности снимка
discovery: рантайм — композиция, а не второй канал доступа к vendor-слою.

## Рантайм не ведёт второго реестра claim-ов

Никаких `_ownedMarkets`, `_acquiredByOwner`, `_previousPlan`,
`_previousDemands`. Source of truth владения — контроллер:

```typescript
controller.getStats();          // сводка
controller.listSubscriptions(); // кто чем владеет
```

Второй реестр означал бы два ответа на один вопрос, и расходиться они начали
бы на первом же откате транзакции контроллера.

## Почему пакет в Infrastructure и не generic

Слой соединяет Application-компоненты (`MarketUniverse`, `Policy`,
`Planner`) с конкретными Infrastructure-компонентами
(`PolymarketMarketDiscovery`, `PolymarketSubscriptionController`). Внешний
слой композиции живёт там, где лежат его конкретные зависимости.

`ControlLoop<T>` / `GenericVenueRuntime` до появления второй площадки был бы
предположением о том, что у CEX получится такая же форма прохода. Проверим
это после CEX-контроллера — а пока реализован конкретный
`PolymarketControlRuntime`.

## Live smoke

```bash
npx tsx packages/infrastructure/polymarket-control-runtime/scripts/control-runtime-smoke.ts

POLYMARKET_SMOKE_ASSET=xrp \
POLYMARKET_SMOKE_DURATION=15m \
POLYMARKET_SMOKE_ACQUIRE_LIMIT=2 \
DISCOVERY_WINDOW_HOURS=2 \
  npx tsx packages/infrastructure/polymarket-control-runtime/scripts/control-runtime-smoke.ts
```

Собирает НАСТОЯЩИЙ V2-путь: `createPublicClient()`, `LiveClock`,
`ExternalMessageBus`, `MessageMetadataGenerator`, `PolymarketMarketDiscovery`,
`PolymarketSource`, `PolymarketSubscriptionController`. Policy собирается
через `parsePolicyConfig()`, то есть той же дверью, что и живая
конфигурация.

Прогон делает два `runOnce()` с одним спросом, печатает диагностику, держит
подписку фиксированное dev-окно и закрывает всё в `finally` — контроллер →
source → bus.

Код возврата ненулевой, если: невалидные переменные окружения; ни один
проход не дал пригодного universe; policy не дала ни одного кандидата; ни
один кандидат не дал `opened`/`joined`/`already-held`; после успешного
приобретения у контроллера ноль рынков; источник перешёл в терминальный
отказ.

Число сообщений критерием НЕ является: приобретается предстоящий рынок, и в
короткое окно до старта торгов он законно может не прислать ни одного
события книги. Счётчики печатаются как диагностика.

### Результат прогона 2026-09-02 21:28 UTC

```text
policy: btc/5m, acquireLimit 1, окно обзора 1h

universe:      96 canonical рынков (400 просмотрено, 371 торгуемых)
plan:          10 кандидатов
               alreadyStarted=12, insufficientLeadTime=12, policyMismatch=62
tick 1:        0x0834ede2…7408 → opened   (startsAt 21:35:00)
tick 2:        0x0834ede2…7408 → already-held
controller:    opening=0, active=1, claims=1, rtdsFeeds=3
сообщения:     MARKET=10, BINANCE=19, CHAINLINK=17, CHAINLINK_TWAP=17
закрытие:      controller → source → bus (drain ok), процесс вышел сам
```

## Чего в пакете нет

```text
Collector · Recorder · Finalizer · CollectionSession
Strategy · StrategyRunner · Intent · Risk · Execution
CEX · семантические адаптеры · IEventBus · ExternalMessageBus в src
внутренний таймер · ретраи · автоматическое снятие claim-ов
```

Отсутствие проверяется структурным тестом по `package.json` и тексту
исходников, а не договорённостью: договорённость нарушается молча.
