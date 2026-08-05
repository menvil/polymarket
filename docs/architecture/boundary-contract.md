# ADR: Контракт границы примитив/VO для packages/domain + packages/application

**Статус:** Принято
**Дата:** 2026-08-04
**Контекст:** Этап 0 плана миграции `packages/domain` + `packages/application` на строгую
типизацию через value-objects/branded-ID/Result (`/Users/menvil/.claude/plans/synthetic-swimming-heron.md`).

---

## Контекст

Пакеты `domain/*` и `application/*` соблюдают эталонный контракт (`@polymarket/value-objects`,
`@polymarket/result`, `@polymarket/errors`, `@polymarket/ids`) неравномерно — это
подтверждено дважды независимо (механический построчный скан + ручное исследование).
Три системных расхождения:

1. Примитивы (`Decimal`/`number`/`string`) на публичных границах там, где есть готовый
   VO/branded ID.
2. `throw` вместо `Result<T, E>` вне `value-objects`.
3. Дублирование модели стакана (`@polymarket/orderbook` vs `@polymarket/order-book`) —
   закрывается отдельно, Этап 2 плана, не предмет этого ADR.

Дополнительно вскрылось: часть уже построенных VO/entities (`Position`, `Trade`,
`Ledger` read-API, 8 из 14 facade-слоёв VO) **не используются вообще** — проблема не
только «заменить примитив на VO», но и «начать вызывать то, что уже написано».

Этот документ фиксирует единый контракт как источник истины для всех последующих этапов
миграции (Этапы 1-11) — они на него ссылаются, а не переизобретают правило по месту.

---

## Решения

### 1. Граница примитив/VO

**Решение:** Примитивы (`Decimal`/`number`/`string`) легитимны **только на границах
системы**: JSON-DTO, персистентный снапшот (то, что реально лежит в БД/файле/journal),
лог/сообщение об ошибке, конфигурация, внутренняя реализация самого VO. Внутри доменных
сценариев (domain-модель, публичный API пакета, порт приложения) значения с доменным
смыслом (деньги, цена, количество, resolved identity, момент времени) обязаны быть VO
или branded ID.

**Обоснование:** Не любой примитив — долг. `string` для `MarketQuestion`/
`CancellationReason` не нуждается в VO (нет собственного инварианта или поведения —
завести класс ради класса значит породить архитектурный мусор). `.value().toString()`
в логе — не нарушение (десятки легитимных мест, например весь `PlaceOrderUseCase.ts`
логирует величины через `.toString()`). Нарушение — это когда значение с доменным
смыслом **вычисляется или сравнивается** как примитив там, где должен быть VO
(`price.value().times(size.value())` вместо cross-VO helper, `fill.side === 'BUY'`
там, где ценность несёт не сравнение, а `SideService.opposite()`/`canMatch()`).

**Контракт (правило для ESLint, Этап 0.4 / Решение 6 ниже):**

```
Запрещено вне {packages/domain/value-objects, packages/foundation/math}:
  import Decimal from 'decimal.js'
  + любая арифметика (.times/.plus/.minus/.div и т.п.) над извлечённым значением

Разрешено везде:
  .value().toString() / .value().toNumber() — сериализация в лог/DTO/сообщение об ошибке
```

Не бланкетный запрет `.value(): Decimal` — он дал бы ложные срабатывания на легитимных
местах и правило бы отключили.

### 2. Facade-слой для новых VO-операций — не копировать бездумно

**Решение:** Новые VO-операции (Этапы 1-9 плана) размещаются по критерию **тотальности**,
а не автоматически в `XxxService` facade:
- Тотальная операция над уже валидными экземплярами (не может провалиться содержательно) →
  core, plain-возврат. Пример-эталон — `SignedQuantity` (`add/subtract/compare/sign/abs/neg`
  все в core, все plain-возвраты).
- Частичная операция, где провал — бизнес-исход (`Balance.reserve` при недостатке
  средств) → core, но возвращает `Result`.
- Частичная операция, где провал — кривой внешний вход (`MoneyService.create(raw)`) или
  нужна policy (`PriceService.roundToMarketTick`) → facade, `Result`.
- Невозможное состояние → throw (только внутри value-objects).

**Обоснование:** Проверено прямым grep: 8 из 14 facade-сабмодулей VO (`MoneyService`,
`QuoteService`, `RatioService`, `TokenBalanceService`, `SideService`, `OutcomeTokenService`,
`FeeService`, `AssetQuantityService`) — **0 внешних вызовов**. Прикладной код либо зовёт
`Money.of()` напрямую (throw-API), либо считает на голом `Decimal`, мимо VO вообще —
в обе стороны мимо facade. Паттерн «спрятать всё в Service» уже показал, что его
игнорируют; копировать его для новых VO-операций значит повторить ту же ошибку.

### 3. Duration — новый VO не заводится

**Решение:** Для длительностей (`timeToExpiryMs`, `leaseMs`, `staleMs`,
`maxCrossVenueSkewMs`, `persistenceMs` и т.п.) отдельный класс/VO **не создаётся**.

**Обоснование:** `Timestamp` уже имеет `addMs(delta: Decimal): Timestamp` и
`diffMs`/`diffSeconds(other): Decimal` (core, `timestamp/core/Timestamp.ts:367,402,420`,
дублируется в facade `TimestampService`) — вся арифметика «точка времени ± длительность»
и «разница между двумя точками» уже закрыта. Отдельный класс здесь противоречил бы
собственному принципу «расширяем существующие модули, новых VO не заводим без крайней
нужды» (тот же принцип, по которому не заводится VO для `MarketQuestion`, Решение 1).

**Контракт:**
```
Длительность = разница двух Timestamp → Timestamp.diffMs / TimestampService.diffMs
               (не ручное a.toNumber() - b.toNumber())
Длительность = самостоятельный конфиг/порог (не производная двух Timestamp)
               → остаётся number(ms), это легитимный примитив без собственного инварианта
```

### 4. Orphaned сущности: реюз, а не удаление

**Решение:** Три сущности построены с полным соблюдением контракта, но не подключены —
для каждой принято решение (не «зафиксировать и забыть»):

| Сущность | Решение | Этап плана |
|---|---|---|
| `Position` (lot-based FIFO/LIFO) | Подключена в `PortfolioService._applyPositionUpdate` (не `Portfolio.applyFill` — такого метода не существует, ошибка в исходном тексте этого ADR) | Этап 3 |
| `Trade` + `ExecutionLinker` | Строить сейчас — `TradeMapper.fromPolymarketLastTradeEvent()` уже реализован, нужно только подключить (`MarketDataStore` TRADE_RECEIVED-обработчик + новый `ExecutionLinker`) | Этапы 2, 7 |
| `Ledger` read/replay API | Подключить реального потребителя (`LedgerService.ts`, reconciliation-сценарий) | Этап 7 |

**Обоснование:** `Portfolio` использует `SimplePosition` явно «без зависимости от
@polymarket/position» (`SimplePosition.ts:8`) — это не архитектурный дубль, а реальный
functional gap (PnL при частичном закрытии позиции без честного FIFO/LIFO).
`Fill.venueTradeId` спроектирован под связь с `Trade`, но `ExecutionLinker` не существует
нигде в коде. `Ledger` пишется (`.append()`), но не читается никем.

**Пересмотр валидационной стратегии для Position (при реализации Этапа 3):** исходная
формулировка этого ADR ("детерминированный shadow-compare гейт, полный исторический
бэктест-корпус, точное равенство Decimal") предполагала сравнение realized+unrealized PnL
между `SimplePosition`-путём и lot-based путём. Расследование при реализации показало:
production fill-путь (`PortfolioService._applyPositionUpdate`, до Этапа 3) **вообще не
вычислял** realized PnL — не приблизительно, а буквально нигде не накапливал такое число.
Сравнивать lot-based `realizedPnL` было не с чем. Пересмотренная стратегия (см.
`docs/architecture/position-accounting.md`): `quantity` — точное совпадение всегда
(проверяет корректность BUY/SELL/fee-проводки); `averageEntryPrice` — точное совпадение
только для single-price-lot сценариев, **математически ожидаемое расхождение** для
multi-lot partial close (не баг — сама причина, почему lot-based учёт вообще нужен);
`realizedPnL` — новая способность, валидируется выделенными unit-тестами с заранее
известными ожидаемыми значениями, не diff против несуществующего бейзлайна.

### 5. Deprecation-мост

**Решение:** Публичные сигнатуры, меняющиеся в рамках миграции и имеющие внешних
потребителей за пределами текущего этапа, получают временный `@deprecated`-мост: новое
API вводится рядом со старым, старое помечается `@deprecated` с указанием замены и этапа
снятия. Мосты снимаются централизованно на Этапе 10 (`grep -rn "@deprecated"` должен дать
пусто, кроме сознательно оставленных и перечисленных в `docs/migration/README.md`).

**Обоснование:** Позволяет каждому этапу быть самостоятельно зелёным (`build && test &&
lint && typecheck`) не дожидаясь, пока смигрируют все потребители сразу — потребители
переходят на новое API внутри СВОЕГО этапа (см. таблицу зависимостей этапов в плане).

### 6. ESLint-стратегия

**Решение:** Правило про `import Decimal from 'decimal.js'` (Решение 1) заводится в
Этапе 0 как `warn` + allowlist (список = `docs/migration/decimal-import-files.txt`,
сгенерирован `scripts/scan-conventions.mjs`). Allowlist сокращается по мере того, как
каждый этап (2,3,4,6,7,8,9) мигрирует свои файлы. Этап 11 снимает allowlist и переводит
правило в `error` без исключений (кроме `value-objects`/`math`), репо-wide, в CI.

**Обоснование:** Включение правила только в конце (после всех 10 этапов) оставляет всю
миграцию без защиты от НОВЫХ нарушений, вводимых по ходу работы — половина смысла
правила теряется. Baseline+shrink+hard-gate защищает с первого дня, не давая долгу расти
там, где он уже сокращается.

### 7. Что осознанно не реализуется в рамках этой миграции

- **UnitOfWork / IKeyedMutex TTL / recoverIncomplete()** — 5 TODO по коду
  (`IOrderStateStore.ts:240`, `IKeyedMutex.ts:48`, `IMarketDataRecorder.ts:131`,
  `ProcessFillUseCase.ts:821-822`, `PlaceOrderUseCase.ts:15,1015`) указывают на одну
  архитектурную проблему — нет транзакционной границы через
  Order+Portfolio+Ledger+ProcessedFill. Это concurrency/consistency-архитектура, другой
  род работы и риска, чем типизация. `docs/architecture/unit-of-work.md` (пишется на
  Этапе 5) — реальный design-документ с конкретным предлагаемым решением, не архив.
  Реализация — **Этап 12, следующий сразу за Этапом 11**, отдельная сессия планирования.
- **`MARKET_OPENED`/`MARKET_CLOSED` без продюсеров** — события уже есть в
  `ApplicationEvent` union (`event-bus/src/events/index.ts:65,66`), но никто их не
  публикует. Миграция не должна ломать эти контракты (сигнатуры трогать можно и нужно
  по правилам выше, публикацию не заводим).
  Реализация продюсеров — вне скоупа этой миграции.
- **Пакеты из `coordination-plan.md`** (`balance-allocator`, `market-lifecycle`,
  `coordinator`, `ReconcileOrdersUseCase`) — не реализуются. Фиксируется только то, что
  миграция не должна закрывать возможность их появления (не переименовывать/не удалять
  точки интеграции без явной причины).

### 8. Market lifecycle throw→Result: ADR приоритетнее pre-ADR package-local обоснования

**Решение:** `Market.close()`/`Market.resolve()` и `MarketState.close()`/`MarketState.resolve()`
(`@polymarket/market`) переведены с throw на `Result` в Этапе 3, несмотря на то, что
`docs/market-entity.md` (написан до этого ADR) содержал явное архитектурное обоснование
throw-поведения: "сигнализирует — ты вызвал метод в неверном состоянии, это баг в коде"
(различение programmer error vs expected failure).

**Обоснование:** Решение 1 этого ADR не делает исключения для "programmer error" —
throw легитимен только внутри `value-objects`, без оговорок. Конкретная, самосогласованная
pre-ADR позиция пакета не отменяет общий контракт, принятый для всей миграции: если бы
каждый пакет мог обосновать свой собственный throw своей локальной логикой, единого
контракта не было бы вообще. Конверсия оказалась полностью inert для прода — на момент
миграции ни один реальный вызывающий код нигде в репозитории не вызывал
`Market.close()`/`Market.resolve()` (только `type`-импорт `Market` как поля данных в
`StrategyScheduler`/`StrategySnapshot`) — нулевой риск сделал решение простым: не
потребовалось взвешивать "ценность строгого contract vs breaking real callers", реальных
callers не было.

**Общий принцип для будущих этапов:** там, где план (Этапы 4-9) встречает похожий
pre-ADR-обоснованный throw в других пакетах — то же правило: ADR имеет приоритет,
если у throw-сайта нет собственного, отдельно принятого исключения в этом документе
(как "static utility class constructor guard" ниже, Решение 1, или конструкторы-invariant
guards в `OrderIdGenerator`, зафиксированные отдельно для Этапа 9).

---

## Ссылки

- План миграции: `/Users/menvil/.claude/plans/synthetic-swimming-heron.md`
- Метрика долга: `docs/migration/debt.md` (генерируется `scripts/scan-conventions.mjs`)
- Baseline: `docs/migration/baseline.md`
