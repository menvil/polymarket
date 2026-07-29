# Strategy: lifecycle, concurrency и execution safety

Пакет `@polymarket/strategy` (StrategyScheduler / ExecutionEngine / OrderEventBridge).

## Почему это сделано так?

Прежняя реализация имела несколько fail-open дыр:

1. `unregister()` мог выполнить final `CANCEL_ALL` **параллельно** с ещё идущим
   `ExecutionEngine.execute()`: поздний PLACE сохранял OPEN-ордер уже после
   отмены «всех» ордеров — после остановки стратегии оставался живой ордер.
2. PLACE блокировался только при `PENDING`-исходе cancel. `FAILED`, rejected
   Promise и исключения **не** блокировали размещение — fail-open
   cancel-and-replace (возможна двойная экспозиция).
3. `targetInstrumentId` можно было передать без `targetAsset` — ордер уходил
   на target instrument с primary asset (чужой CTF-токен).
4. CANCEL не проверял владельца ордера; post-cancel cooldown ставился на
   `ctx.instrumentId`, а не на инструмент фактически отменённого ордера.
5. Dedupe PLACE по `side:price.toNumber()` схлопывал BUY primary и BUY
   complementary по одинаковой цене.
6. `FILL_RECEIVED` снимал post-cancel cooldown **до** finality.
7. Прямые `setTimeout`/`setInterval`/`randomUUID` делали replay недетерминированным.
8. Retry/benign-классификация строилась на парсинге `error.message`.

## Lifecycle стратегии

```text
ACTIVE ──unregister()──▶ STOPPING ──(final intents done)──▶ STOPPED
```

Шаги `unregister()` (`StrategyScheduler._stopEntry`):

1. Атомарный переход `ACTIVE → STOPPING` (synchronous до первого await).
2. Немедленный detach: heartbeat остановлен, instrument/symbol/asset routing
   удалён, deferred timer отменён, стратегия убрана из queue; события во время
   `STOPPING` не ставят стратегию в очередь.
3. Ожидание активного `entry.executionPromise` (обычный execution).
4. `strategy.stop()` → final intents.
5. Исполнение final intents — **никогда** параллельно с обычным execution.
   Поздний PLACE к этому моменту уже сохранил Order → final `CANCEL_ALL` его видит.
6. Только после этого entry удаляется, lifecycle → `STOPPED`.

Повторный/конкурентный `unregister()` ждёт **тот же** `stopPromise`
(`strategy.stop()` и final intents выполняются ровно один раз).
`stopAll()` использует этот же flow.

## Cancel-replace: fail-closed

`ExecutionEngine.execute()` считает `allCancelsSafeForReplace`:

| Исход cancel | PLACE разрешён? |
|---|---|
| `CONFIRMED` (CANCELLED / ALREADY_CANCELLED) | да |
| `TERMINAL_NOOP` (ALREADY_TERMINAL) | да |
| `PENDING` (FILL_PENDING / ALREADY_FILLED / RECONCILIATION_REQUIRED) | **нет** |
| `FAILED` (Err / ownership-отказ) | **нет** |
| rejected Promise / exception / неизвестный результат | **нет** |

Любой небезопасный cancel блокирует **все** PLACE batch-а (и BUY, и SELL);
каждый заблокированный PLACE увеличивает `skipped` и `blockedByUnsafeCancel`
и получает typed outcome `BLOCKED_BY_UNSAFE_CANCEL` в `report.outcomes`.

## Атомарная target-пара

`PlaceIntent` — discriminated union: `targetInstrumentId` и `targetAsset`
либо заданы **оба**, либо **ни один**. Helper `placeTarget(instrumentId, asset)`
собирает пару в стратегиях. Runtime (fail-closed, до venue):

1. пара полная;
2. target в `ctx.allowedInstruments` (primary + additional + complementary);
3. target есть в каталоге;
4. `assetIdToInstrumentId(targetAsset) === targetInstrumentId`.

Результат валидации — единый `EffectiveOrderTarget`; никаких независимых
fallback `targetX ?? ctx.X`.

## Ownership CANCEL

Перед `CancelOrderUseCase` — authoritative `orderRepo.get(orderId)`:

- ордер не найден → `FAILED` (владелец неизвестен);
- `order.strategyId !== ctx.strategyId` → `FAILED`;
- `order.accountId` задан и ≠ `ctx.accountId` → `FAILED`
  (`Order` теперь несёт optional `accountId`, `PlaceOrderUseCase` заполняет его).

Use case при отказе **не вызывается**; PLACE batch-а блокируются.
`CANCEL_ALL` разворачивается через `getByStrategyId(ctx.strategyId)`.

## Post-cancel cooldown — по фактическому Order

Ставится **только** при `CANCELLED`/`ALREADY_CANCELLED`, **только** для
BUY-ордера, на `assetIdToInstrumentId(order.asset)` отменённого Order.
Отмена SELL cooldown не ставит; отмена комплементарного ордера не блокирует
primary. Снимается только `FILL_CONFIRMED` (см. ниже).

## FILL_RECEIVED vs FILL_CONFIRMED

- `onFillReceivedForInstrument`: dirty + enqueue. Cooldown **не** снимается.
- `onFillConfirmedForInstrument`: finality cleanup — `clearPostCancelCooldown`
  + `clearExchangeRejectionCooldown`, затем dirty + enqueue.

`OrderEventBridge` маршрутизирует события 1:1 на эти методы.

## Dedupe PLACE

Ключ: `effectiveInstrumentId | side | price.value().toString() | postOnly`.
«Последний побеждает» — только при полностью одинаковом ключе.

## Детерминизм: ISchedulerTimer + IOrderIdGenerator

```typescript
// production (composition root buildStrategyEngine — дефолты):
new NodeSchedulerTimer();       // Node timers + unref
new UuidOrderIdGenerator();     // randomUUID

// replay/backtest:
new DeterministicSchedulerTimer(startMs); // advanceTo(nowMs) синхронно исполняет due-таймеры
new SequentialOrderIdGenerator('replay'); // replay-1, replay-2, ...
```

В оркестрации нет прямых `setTimeout`/`setInterval`/`randomUUID`.

## Typed failure codes (без парсинга error.message)

Граница классификации venue-текстов — **только** infrastructure adapter
(`PolymarketExchangeClientAdapter` → `SubmitRejectionCode` + числовая
`balance`-metadata в `SubmitOrderResult.REJECTED`). `PlaceOrderUseCase`
конвертирует в `PlaceOrderFailureError` (`PlaceFailureCode`):
`POST_ONLY_WOULD_TAKE | INSUFFICIENT_TOKEN_BALANCE | INSUFFICIENT_ALLOWANCE |
DEFINITELY_REJECTED | SUBMISSION_OUTCOME_UNKNOWN | RISK_REJECTED |
PORTFOLIO_UNAVAILABLE | OTHER`.

`ExecutionEngine`:

- benign post-only skip — только точный код `POST_ONLY_WOULD_TAKE`;
- SELL dust-retry (ровно один) — только `INSUFFICIENT_TOKEN_BALANCE`
  (definite reject) **с** Decimal-metadata и дефицитом < 1%;
- `SUBMISSION_OUTCOME_UNKNOWN` / transport ambiguity → никакого retry.

## Constraints (reject-only)

- Отсутствие catalog entry для PLACE → fail-closed local reject.
- Цена не кратна `tickSize` → reject (Decimal `mod`, без float `%`, без
  молчаливого округления) — стратегия сама квантует цену.
- `minOrderValue` — `Money` (денежный notional), а не `Quantity`.
- `StrategySnapshot.complementaryConstraints` — constraints комплементарного
  инструмента из каталога.

## BaseStrategy.adjustBuySize

Новый контракт: `Decimal | undefined` — **никогда** не увеличивает размер:
`desired < minOrderSize` → `undefined`; `price × desired < minOrderValue` →
`undefined`. Явный opt-in overbuy — `adjustBuySizeAllowingIncrease(...)`.

## Register hardening / ScheduleConfig

- дубликат `strategy.id` (включая registration-in-progress) → `Err`;
- concurrent register одного ID — single-flight (`initialize()` один раз);
- `complementaryInstrumentId`/`complementaryAsset` — только парой;
- `validateScheduleConfig`: `minIntervalMs` int ≥ 0, `maxIdleMs` int > 0,
  `executionTimeoutMs` int > 0, `priorityTriggers` ⊆ известных reasons;
  внешний Set копируется.

## Watchdog

`ScheduleConfig.executionTimeoutMs` (default 30s): зависший `execute()` →
`entry.faulted = true` (critical log). Новые тики блокируются, параллельный
execution не запускается, `unregister()` не ждёт hung promise —
state-machine recovery, не «отмена» Promise.

## ExecutionReport

```typescript
{ placed, cancelled, skipped, localRejected, blockedByUnsafeCancel, failed,
  errors: [{ intent, error }],   // исходные ошибки, не synthetic
  outcomes: [{ intent, kind, failureCode?, error?, reason? }] }
```

## Пример кода (актуальный!)

```typescript
// apps/bot/src/bot/buildStrategyEngine.ts
const engine = buildStrategyEngine({
  infra, repos, useCases, marketDataStore, marketCatalog,
  // replay/backtest:
  schedulerTimer: new DeterministicSchedulerTimer(startMs),
  orderIdGenerator: new SequentialOrderIdGenerator('replay'),
});
engine.scheduler.start();
await engine.scheduler.register({
  strategy, instrumentId, asset, accountId, market,
  complementaryInstrumentId, complementaryAsset, // строго парой
});
await engine.scheduler.unregister(strategy.id);  // безопасный stop-flow
```
