# План: Strategy Engine (reactive scheduling)

> Дата: 2026-03-13
> Ветка: phase-3 → новая ветка phase-strategy-engine
> Статус: обсуждение → финализация

## Архитектура

```
Exchange WS
    │
    ▼
EventAdapters (BookUpdateHandler, FillEventHandler, OrderUpdateHandler)
    │
    ▼
EventBus (внутренний транспорт — стратегии НЕ подписываются)
    │
    ▼
State Stores (in-memory, sync read, O(1))
    ├─ MarketDataStore     ← TopOfBook, BookHistory, TradeTape
    ├─ OrderStateStore     ← open orders per strategy/instrument
    └─ PortfolioStore      ← positions, balance (USDC), tokenReservations
    │
    │  каждый store при обновлении:
    │  scheduler.onStateChanged(instrumentId/strategyId, reason)
    │
    ▼
DirtyTracker (markDirty / isDirty / getReasons / clearDirty)
    │
    ▼
StrategyScheduler
    │  Запускает стратегию если:
    │  1. isDirty AND elapsed >= minIntervalMs
    │  ИЛИ 2. hasPriorityTrigger (FILL → немедленно)
    │  ИЛИ 3. elapsed >= maxIdleMs (heartbeat)
    │
    ▼
strategy.tick(snapshot, reasons) → StrategyIntent[]
    │
    ▼
ExecutionEngine
    │  1. Cancels first (параллельно)
    │  2. Places second (последовательно)
    │  3. Risk — внутри PlaceOrderUseCase (pre-trade, per-strategy)
    │         + DrawdownRiskMonitor (post-trade, system-wide)
    │
    ▼
Use Cases (PlaceOrderUseCase, CancelOrderUseCase)
    │
    ▼
IExchangeClient → Polymarket API
```

## Принципы

1. **events → state, strategy → snapshot** — стратегия НИКОГДА не подписывается на события
2. **tick() синхронный** — возвращает StrategyIntent[], без async, без API calls
3. **decide() чистая функция** — snapshot in → actions out, легко unit-тестировать
4. **Dirty flags + throttle** — стратегия вызывается только когда данные изменились
5. **Priority triggers** — FILL пробивает throttle, tick вызывается немедленно
6. **Sync read** — все stores in-memory, O(1), без async
7. **Intents, не actions** — стратегия декларирует намерения, ExecutionEngine исполняет

## Модель данных Portfolio (как балансы работают)

Portfolio — единственный агрегат для балансов. TokenBalance VO **не используется** в snapshot.

```
Portfolio {
  balance: Balance {
    available: Money    ← свободные USDC
    reserved: Money     ← USDC залочены в BUY ордерах
  }
  positions: Map<InstrumentId, IPosition> {
    quantity            ← сколько токенов владеем
    averageEntryPrice   ← средняя цена входа
    side: LONG/SHORT
  }
  tokenReservations: Map<InstrumentId, Decimal> {
    ← сколько токенов залочены в SELL ордерах
  }
}
```

### Сценарий BUY 100 @ 0.65

```
1. PlaceOrderUseCase: balance.reserve(65 USDC)
   → available: 9935, reserved: 65

2. ProcessFillUseCase: balance.applyDebit(65 USDC)
   → available: 9935, reserved: 0 (consumed from reservation)
   → position: { qty: 100, avgPrice: 0.65, side: LONG }
   → Ledger: +100 UP_token, -65 USDC, -0.02 USDC (fee)
```

### Сценарий SELL 50 @ 0.80

```
1. PlaceOrderUseCase: tokenReservations[UP_token] += 50
   → availableTokenQuantity = 100 - 50 = 50

2. ProcessFillUseCase:
   → releaseTokenReservation(50)
   → balance.applyCredit(40 USDC)
   → position: { qty: 50, avgPrice: 0.65 }
   → Ledger: -50 UP_token, +40 USDC, -0.02 USDC (fee)
```

### Что стратегия видит из snapshot

```
portfolio.balance.available()            → свободные USDC
portfolio.balance.reserved()             → залоченные USDC
portfolio.getPosition(instrumentId)      → позиция (qty, avgPrice)
portfolio.availableTokenQuantity(id)     → сколько токенов можно продать
portfolio.tokenReservations              → залоченные токены
```

## Граф зависимостей (порядок реализации)

```
Шаг 1: Типы (TriggerReason, StrategyIntent, StrategySnapshot, ScheduleConfig)
   │
Шаг 2: State Stores
   │     ├─ 2.1 MarketDataStore (фасад: TopOfBook + коллекторы + onChange)
   │     └─ 2.2 IOrderStateStore (sync read интерфейс)
   │
Шаг 3: DirtyTracker
   │
Шаг 4: IStrategy (новый) + BaseStrategy<S, A>
   │
Шаг 5: ExecutionEngine (intents → use-cases)
   │
Шаг 6: StrategyScheduler (ядро: dirty + throttle + snapshot + tick + execute)
   │
Шаг 7: Интеграция
   │     ├─ 7.1 OrderEventBridge (ORDER_* → scheduler + balance unreserve + cleanup)
   │     ├─ 7.2 FillsReconciler (recovery для fills)
   │     ├─ 7.3 StateReconciliationService (periodic truth checkpoint)
   │     ├─ 7.4 Risk: системный + стратегический (разделение)
   │     ├─ 7.5 Supervisors (MARKET_OPENED → register, MARKET_CLOSED → unregister)
   │     └─ 7.6 Удаление старого (TradingAPI, StrategyContext, StrategyRunner)
   │
Шаг 8: Примеры стратегий + apps/bot/src/main.ts
```

---

## Шаг 1. Типы

**Пакет:** `packages/application/strategy/src/types/`

### 1.1 TriggerReason.ts

```typescript
/**
 * Причина, по которой стратегия должна пересчитать.
 * Накапливаются в DirtyTracker между тиками.
 */
export type TriggerReason = 'BOOK' | 'TRADE' | 'FILL' | 'ORDER_UPDATE' | 'TIMER';
```

### 1.2 StrategyIntent.ts

```typescript
import type { OrderId } from '@polymarket/ids';
import type { Price, Quantity, Side } from '@polymarket/value-objects';

/**
 * Декларативное намерение стратегии.
 * ExecutionEngine решает как и когда исполнить.
 * Стратегия не вызывает API — она возвращает intents из tick().
 */
export type StrategyIntent =
  | { readonly type: 'PLACE'; readonly side: Side; readonly price: Price; readonly size: Quantity }
  | { readonly type: 'CANCEL'; readonly orderId: OrderId }
  | { readonly type: 'CANCEL_ALL' };

// AMEND удалён: на Polymarket нет атомарного amend.
// Cancel + Place — два отдельных intenta. Стратегия сама решает когда и как.
// Причины: race condition между cancel и place, нет гарантии что place пройдёт
// после cancel, risk check на новый place может не пройти.
```

### 1.3 StrategySnapshot.ts

```typescript
import type { InstrumentId } from '@polymarket/ids';
import type { TopOfBook } from '@polymarket/event-bus';
import type { OrderBookHistory } from '@polymarket/order-book';
import type { TradeTape } from '@polymarket/trade-tape';
import type { Order } from '@polymarket/order';
import type { Portfolio } from '@polymarket/portfolio';
import type { Market } from '@polymarket/market';

/**
 * Readonly snapshot состояния — передаётся стратегии в tick().
 * Собирается StrategyScheduler sync, O(1) из in-memory stores.
 *
 * Все поля readonly — стратегия не может мутировать state.
 */
export interface StrategySnapshot {
  /** ID инструмента */
  readonly instrumentId: InstrumentId;

  // ── Market ───────────────────────────────────────────────
  /** Рынок целиком: экспирация, вопрос, outcomes, state, ... */
  readonly market: Market;

  // ── Market Data ──────────────────────────────────────────
  /** Лучшие bid/ask/spread (последний из BookUpdateHandler) */
  readonly topOfBook: TopOfBook | undefined;
  /** Rolling history снапшотов стакана */
  readonly bookHistory: OrderBookHistory | undefined;
  /** Rolling лента публичных трейдов */
  readonly tradeTape: TradeTape | undefined;

  // ── Orders ───────────────────────────────────────────────
  /** Открытые ордера ЭТОЙ стратегии на ЭТОМ инструменте */
  readonly openOrders: readonly Order[];

  // ── Portfolio ────────────────────────────────────────────
  /**
   * Portfolio целиком: balance (USDC available/reserved),
   * positions, tokenReservations.
   *
   * Стратегия читает:
   * - portfolio.balance.available() → свободные USDC
   * - portfolio.getPosition(instrumentId) → позиция (qty, avgPrice)
   * - portfolio.availableTokenQuantity(instrumentId) → токены для продажи
   */
  readonly portfolio: Portfolio | undefined;

  // ── Timing ───────────────────────────────────────────────
  /** Текущее время (из IClock — для детерминизма в бэктесте) */
  readonly nowMs: number;
}
```

**Почему Portfolio целиком, а не отдельные поля:**
- Portfolio уже содержит balance, positions, tokenReservations — всё что нужно
- Стратегия может вызвать `portfolio.availableTokenQuantity(instrumentId)` напрямую
- Не нужен отдельный TokenBalance VO
- Market entity целиком — стратегия сама считает timeToExpiry, проверяет expiresAt, question

### 1.4 ScheduleConfig.ts

```typescript
import type { TriggerReason } from './TriggerReason.js';

/**
 * Конфигурация расписания стратегии.
 */
export interface ScheduleConfig {
  /** Минимальный интервал между tick (throttle). Default: 50ms */
  readonly minIntervalMs: number;
  /** Reasons которые игнорируют minInterval. Default: Set(['FILL']) */
  readonly priorityTriggers: ReadonlySet<TriggerReason>;
  /** Максимальное время без tick — force run даже если не dirty. Default: 5000ms */
  readonly maxIdleMs: number;
}

/** Default config */
export const DEFAULT_SCHEDULE_CONFIG: ScheduleConfig = {
  minIntervalMs: 50,
  priorityTriggers: new Set(['FILL']),
  maxIdleMs: 5000,
};
```

### 1.5 index.ts

Реэкспорт всех типов.

**Файлы:** 5 файлов в `strategy/src/types/`
**Тесты:** нет — чистые типы
**Зависимости:** ids, value-objects, event-bus, order-book, trade-tape, order, portfolio, market

---

## Шаг 2. State Stores

### 2.1 MarketDataStore

**Пакет:** `packages/application/market-state/src/MarketDataStore.ts`

**Обязанности:**
- Фасад над BookDepthCollector + TradeTapeCollector
- Хранит последний TopOfBook per instrumentId
- Подписывается на EventBus: BOOK_UPDATED, BOOK_DEPTH, TRADE_RECEIVED
- При обновлении вызывает `_onChange(instrumentId, reason)` callback

**Интерфейс:**

```typescript
export interface IMarketDataStore {
  getTopOfBook(instrumentId: InstrumentId): TopOfBook | undefined;
  getBookHistory(instrumentId: InstrumentId): OrderBookHistory | undefined;
  getTradeTape(instrumentId: InstrumentId): TradeTape | undefined;
}
```

**Реализация:**

```typescript
export class MarketDataStore implements IMarketDataStore {
  private readonly _topOfBooks = new Map<string, TopOfBook>();
  private _onChange?: (instrumentId: InstrumentId, reason: TriggerReason) => void;

  constructor(private readonly _deps: MarketDataStoreDeps) {}

  setOnChange(cb: (instrumentId: InstrumentId, reason: TriggerReason) => void): void;

  start(): void {
    // BOOK_UPDATED → save topOfBook + onChange('BOOK')
    // BOOK_DEPTH → bookCollector.recordDirect()
    //   (onChange уже вызван из BOOK_UPDATED — не дублируем)
    // TRADE_RECEIVED → tapeCollector.recordDirect() + onChange('TRADE')
  }

  stop(): void;

  // Sync reads
  getTopOfBook(id: InstrumentId): TopOfBook | undefined;
  getBookHistory(id: InstrumentId): OrderBookHistory | undefined;
  getTradeTape(id: InstrumentId): TradeTape | undefined;
}
```

**Изменения в существующих файлах:**
- `BookDepthCollector.ts` — добавить `public recordDirect(instrumentId, snapshot, nowMs): void`
- `TradeTapeCollector.ts` — добавить `public recordDirect(instrumentId, price, size, side, timestamp): void`
- `market-state/src/index.ts` — добавить экспорт MarketDataStore

**Тесты:** MarketDataStore.test.ts

### 2.2 IOrderStateStore

**Пакет:** `packages/application/ports/src/IOrderStateStore.ts`

**Интерфейс:**

```typescript
export interface IOrderStateStore {
  /** Sync: открытые ордера стратегии */
  getOpenOrders(strategyId: string): readonly Order[];
  /** Sync: ордера стратегии на конкретном инструменте */
  getOpenOrdersByInstrument(strategyId: string, instrumentId: InstrumentId): readonly Order[];
  /** Sync: конкретный ордер */
  getOrder(orderId: OrderId): Order | undefined;
}
```

**Реализация:** `InMemoryOrderRepository` уже хранит в sync Map.
Добавить sync методы + `implements IOrderStateStore`.

**Изменения:**
- `ports/src/IOrderStateStore.ts` (новый)
- `ports/src/index.ts` (экспорт)
- `infrastructure/backtesting/src/InMemoryOrderRepository.ts` (implements IOrderStateStore)

**Тесты:** обновить InMemoryOrderRepository.test.ts

---

## Шаг 3. DirtyTracker

**Пакет:** `packages/application/strategy/src/DirtyTracker.ts`

```typescript
export class DirtyTracker {
  private readonly _dirty = new Map<string, Set<TriggerReason>>();

  markDirty(strategyId: string, reason: TriggerReason): void;
  isDirty(strategyId: string): boolean;
  getReasons(strategyId: string): ReadonlySet<TriggerReason>;
  clearDirty(strategyId: string): void;
  hasPriorityTrigger(strategyId: string, priorities: ReadonlySet<TriggerReason>): boolean;
  /** Удалить стратегию из трекинга (при unregister) */
  remove(strategyId: string): void;
}
```

**Тесты:** DirtyTracker.test.ts
- markDirty → isDirty === true
- несколько reasons накапливаются
- clearDirty → isDirty === false, reasons пуст
- hasPriorityTrigger корректно фильтрует
- remove очищает полностью

---

## Шаг 4. IStrategy + BaseStrategy

**Пакет:** `packages/application/strategy/src/`

### 4.1 IStrategy.ts (переписываем)

```typescript
export interface IStrategy {
  readonly id: string;
  readonly name: string;

  /** Однократная инициализация. Без подписок — стратегия работает через tick() */
  initialize(): Promise<Result<void, Error>>;

  /**
   * Один цикл: данные → решение → намерения.
   * СИНХРОННЫЙ. Scheduler вызывает, передаёт готовый snapshot.
   *
   * @param snapshot - Readonly состояние (market, market data, orders, portfolio, timing)
   * @param reasons - Что изменилось с последнего tick (BOOK, TRADE, FILL, ...)
   * @returns Массив намерений (PLACE, CANCEL, CANCEL_ALL) или [] (ничего не делать)
   */
  tick(snapshot: StrategySnapshot, reasons: ReadonlySet<TriggerReason>): StrategyIntent[];

  /**
   * Cleanup. Возвращает финальные intents (обычно CANCEL_ALL).
   * Вызывается StrategyScheduler при unregister.
   */
  stop(): StrategyIntent[];

  getMetrics(): Record<string, unknown>;
}
```

### 4.2 BaseStrategy.ts (новый, опциональный)

```typescript
export abstract class BaseStrategy<TSnapshot, TAction> implements IStrategy {
  abstract readonly id: string;
  abstract readonly name: string;

  /** Извлечь типизированный snapshot из generic StrategySnapshot */
  protected abstract gather(snapshot: StrategySnapshot): TSnapshot | undefined;

  /** Чистая логика: данные + reasons → domain-specific actions */
  protected abstract decide(data: TSnapshot, reasons: ReadonlySet<TriggerReason>): TAction[];

  /** Конвертировать domain actions в StrategyIntent[] */
  protected abstract toIntents(actions: TAction[]): StrategyIntent[];

  tick(snapshot: StrategySnapshot, reasons: ReadonlySet<TriggerReason>): StrategyIntent[] {
    const data = this.gather(snapshot);
    if (!data) return [];
    const actions = this.decide(data, reasons);
    if (actions.length === 0) return [];
    return this.toIntents(actions);
  }

  async initialize(): Promise<Result<void, Error>> { return Ok(undefined); }
  stop(): StrategyIntent[] { return [{ type: 'CANCEL_ALL' }]; }
  getMetrics(): Record<string, unknown> { return {}; }
}
```

### 4.3 Удаляем из пакета

- `StrategyContext.ts` — удалить
- `ITradingAPI.ts` — удалить
- `TradingAPI.ts` — удалить (заменён ExecutionEngine)
- `StrategyRunner.ts` — удалить (заменён StrategyScheduler)
- `IStrategyRunner.ts` — удалить (заменён IStrategyScheduler)

**Тесты:**
- BaseStrategy: gather→decide→toIntents pipeline
- tick возвращает [] при undefined из gather
- tick возвращает [] при [] из decide
- stop возвращает CANCEL_ALL по умолчанию

---

## Шаг 5. ExecutionEngine

**Пакет:** `packages/application/strategy/src/ExecutionEngine.ts`

```typescript
export interface ExecutionEngineDeps {
  readonly placeOrderUseCase: PlaceOrderUseCase;
  readonly cancelOrderUseCase: CancelOrderUseCase;
  readonly orderStateStore: IOrderStateStore;
  readonly portfolioStore: IPortfolioStore;
  readonly logger: ILogger;
}

export interface ExecutionContext {
  readonly strategyId: string;
  readonly accountId: AccountId;
  readonly instrumentId: InstrumentId;
  readonly asset: AssetId;
}

export interface ExecutionReport {
  readonly placed: number;
  readonly cancelled: number;
  readonly errors: ReadonlyArray<{ intent: StrategyIntent; error: Error }>;
}

export class ExecutionEngine {
  constructor(private readonly _deps: ExecutionEngineDeps) {}

  /**
   * Нормализует и исполняет intents.
   *
   * Нормализация (dedupe):
   * 1. Если есть CANCEL_ALL → убираем все отдельные CANCEL (они дублируют)
   * 2. Dedupe CANCEL по orderId (один orderId → один cancel)
   * 3. Dedupe PLACE по key (side + price) — оставить последний
   *
   * Порядок исполнения: CANCEL_ALL → CANCEL → PLACE.
   * Cancels параллельно, places последовательно (баланс обновляется).
   * Risk — внутри PlaceOrderUseCase (не дублируем).
   */
  async execute(ctx: ExecutionContext, intents: readonly StrategyIntent[]): Promise<ExecutionReport>;
}
```

**Алгоритм execute():**
1. **Normalize** — dedupe и очистка:
   - Если есть CANCEL_ALL → удалить все отдельные CANCEL (дублирование)
   - Dedupe CANCEL по orderId (Set)
   - Dedupe PLACE по `${side}:${price}` — оставить последний
2. CANCEL_ALL → orderStateStore.getOpenOrders(strategyId) → cancelOrderUseCase для каждого
3. CANCEL → cancelOrderUseCase(orderId)
4. PLACE → orderId = crypto.randomUUID(), portfolio = portfolioStore.get(), placeOrderUseCase.execute()
5. Cancels параллельно, places последовательно
6. Собрать ExecutionReport

**Тесты:** ExecutionEngine.test.ts

---

## Шаг 6. StrategyScheduler

**Пакет:** `packages/application/strategy/src/StrategyScheduler.ts`

**Это ядро новой архитектуры.**

```typescript
export interface StrategyRegistration {
  readonly strategy: IStrategy;
  readonly instrumentId: InstrumentId;
  readonly asset: AssetId;
  readonly accountId: AccountId;
  readonly market: Market;  // Market entity целиком (для snapshot)
  readonly config?: Partial<ScheduleConfig>;
}

export interface StrategySchedulerDeps {
  readonly marketDataStore: IMarketDataStore;
  readonly orderStateStore: IOrderStateStore;
  readonly portfolioStore: IPortfolioStore;
  readonly executionEngine: ExecutionEngine;
  readonly dirtyTracker: DirtyTracker;
  readonly clock: IClock;
  readonly logger: ILogger;
}

export class StrategyScheduler {
  /** instrumentId → Set<strategyId> */
  private readonly _instrumentToStrategies = new Map<string, Set<string>>();
  /** strategyId → entry (strategy, config, lastRunMs, running, rerunRequested, market) */
  private readonly _entries = new Map<string, StrategyEntry>();
  /** Event-driven queue: стратегии ожидающие tick */
  private readonly _queue: string[] = [];
  /** Set для O(1) проверки «уже в очереди?» */
  private readonly _queued = new Set<string>();
  private _stopped = false;
  /** Timer IDs для deferred re-queue (throttled strategies) */
  private readonly _deferredTimers = new Map<string, NodeJS.Timeout>();

  constructor(deps: StrategySchedulerDeps) {
    deps.marketDataStore.setOnChange((instrumentId, reason) => {
      this._onMarketDataChanged(instrumentId, reason);
    });
  }

  async register(reg: StrategyRegistration): Promise<Result<void, Error>>;
  async unregister(strategyId: string): Promise<void>;
  start(): void;   // Запускает heartbeat таймеры, больше НЕ setInterval(5ms)
  stop(): void;
  async stopAll(): Promise<void>;
  onOrderChanged(strategyId: string, reason: TriggerReason): void;
  getMetrics(strategyId: string): Record<string, unknown> | undefined;
  async onRiskBreached(event: RiskLimitBreachedEvent): Promise<void>;
}
```

**_buildSnapshot(entry):**

```typescript
private _buildSnapshot(entry: StrategyEntry): StrategySnapshot {
  const id = entry.instrumentId;
  const now = this._deps.clock.now();
  const portfolio = this._deps.portfolioStore.get(entry.accountId);

  return {
    instrumentId: id,
    market: entry.market,
    topOfBook: this._deps.marketDataStore.getTopOfBook(id),
    bookHistory: this._deps.marketDataStore.getBookHistory(id),
    tradeTape: this._deps.marketDataStore.getTradeTape(id),
    openOrders: this._deps.orderStateStore.getOpenOrdersByInstrument(entry.strategyId, id),
    portfolio,
    nowMs: now,
  };
}
```

**Внутренний алгоритм (event-driven queue + coalescing):**

Вместо `setInterval(5ms)` который поллит все стратегии каждые 5ms,
используем event-driven очередь: события сами ставят стратегии в очередь.

### markDirty → enqueue

```
markDirty(strategyId, reason):
  dirtyTracker.markDirty(strategyId, reason)
  if strategyId NOT in _queued:
    _queued.add(strategyId)
    _queue.push(strategyId)
    _scheduleProcessing()  // queueMicrotask или setImmediate
```

### _processQueue (microtask worker)

```
_processQueue():
  while _queue is not empty AND not _stopped:
    strategyId = _queue.shift()
    _queued.delete(strategyId)

    entry = _entries.get(strategyId)
    if !entry → continue

    // ── Throttle check ──────────────────────────────
    hasPriority = dirtyTracker.hasPriorityTrigger(id, config.priorityTriggers)
    elapsed = clock.now() - entry.lastRunMs
    remaining = config.minIntervalMs - elapsed

    if remaining > 0 AND NOT hasPriority:
      // Ещё рано — отложить на remaining ms
      _deferRequeue(strategyId, remaining)
      continue

    // ── Coalescing: если уже running → запомнить и вернуться ──
    if entry.running:
      entry.rerunRequested = true
      continue

    // ── Execute ─────────────────────────────────────
    _executeTick(entry)
```

### _executeTick (coalescing pattern)

```
_executeTick(entry):
  snapshot = _buildSnapshot(entry)
  reasons = dirtyTracker.getReasons(id)
  dirtyTracker.clearDirty(id)
  entry.lastRunMs = clock.now()

  intents = entry.strategy.tick(snapshot, reasons)   // SYNC

  if intents.length === 0 → return

  entry.running = true
  executionEngine
    .execute(executionCtx, intents)
    .then(report => _logReport(id, report))
    .catch(err => _logError(id, err))
    .finally(() => {
      entry.running = false
      // ── Coalescing: новые данные пришли пока мы исполняли ──
      if entry.rerunRequested:
        entry.rerunRequested = false
        _scheduleImmediate(strategyId)  // enqueue для немедленного rerun
    })
```

### _deferRequeue

```
_deferRequeue(strategyId, delayMs):
  // Отменяем предыдущий таймер если есть (идемпотентность)
  clearTimeout(_deferredTimers.get(strategyId))
  _deferredTimers.set(strategyId, setTimeout(() => {
    _deferredTimers.delete(strategyId)
    if dirtyTracker.isDirty(strategyId):
      _enqueue(strategyId)
  }, delayMs))
```

### Heartbeat (maxIdleMs)

```
// При register: запускаем periodic timer per strategy
entry.heartbeatTimer = setInterval(() => {
  dirtyTracker.markDirty(strategyId, 'TIMER')
  _enqueue(strategyId)
}, config.maxIdleMs)
```

### Преимущества над setInterval(5ms):

| setInterval(5ms) | Event-driven queue |
|---|---|
| Поллит ВСЕ стратегии каждые 5ms | Обрабатывает ТОЛЬКО dirty стратегии |
| O(strategies × time) | O(events) |
| 200 стратегий = 40 000 checks/sec | 200 стратегий, 10 events/sec = 10 ticks/sec |
| CPU spin при idle | Zero CPU при отсутствии событий |
| Latency до 5ms (worst case) | Latency < 1ms (microtask) |
| executionPromise skip → потеря данных | Coalescing → rerun с fresh данными |

**Тесты:** StrategyScheduler.test.ts
- register / unregister lifecycle
- Dirty routing: BOOK → markDirty → enqueue → tick вызывается
- Event-driven: нет tick без dirty (zero CPU при idle)
- Throttle: minIntervalMs → deferred re-queue
- Priority: FILL → немедленный tick (bypass throttle)
- maxIdleMs: heartbeat timer → TIMER reason
- Coalescing: данные приходят во время execute → rerunRequested → rerun с fresh snapshot
- Coalescing: несколько dirty событий во время execute → один rerun (не N)
- buildSnapshot: корректные данные из stores (portfolio целиком, market целиком)
- stop/stopAll: strategy.stop() → execute(CANCEL_ALL)
- onRiskBreached: stop конкретной или всех
- Intent normalization: CANCEL_ALL + CANCEL → только CANCEL_ALL (dedupe в ExecutionEngine)

---

## Шаг 7. Интеграция

### 7.1 OrderEventBridge + Balance/Cleanup GAP fix

**Пакет:** `packages/application/strategy/src/OrderEventBridge.ts`

Мост между ORDER_* events и StrategyScheduler + **исправление GAP'ов**.

```typescript
export class OrderEventBridge {
  constructor(
    private readonly _eventBus: IEventBus,
    private readonly _scheduler: StrategyScheduler,
    private readonly _orderStateStore: IOrderStateStore,
    private readonly _portfolioService: PortfolioService,
    private readonly _orderRepo: IOrderRepository,
    private readonly _logger: ILogger,
  ) {}

  start(): void {
    // Подписка на ORDER_EVENT:
    //
    // ORDER_CANCELLED / ORDER_EXPIRED (external — от venue):
    //   1. Unreserve balance:
    //      - BUY order → portfolioService.releaseReservation(notional USDC)
    //      - SELL order → portfolioService.releaseTokenReservation(instrumentId, remainingSize)
    //   2. scheduler.onOrderChanged(strategyId, 'ORDER_UPDATE')
    //
    // ORDER_PARTIALLY_FILLED / ORDER_FILLED:
    //   1. scheduler.onOrderChanged(strategyId, 'FILL')
    //
    // ORDER_FILLED (terminal):
    //   1. Удалить ордер из repo (cleanup): orderRepo.delete(orderId)
    //      Или пометить archived — зависит от retention policy
    //
    // ORDER_ACCEPTED / ORDER_REJECTED:
    //   1. scheduler.onOrderChanged(strategyId, 'ORDER_UPDATE')
  }

  stop(): void;
}
```

**GAP 1 fix:** External cancel → unreserve balance. OrderEventBridge слушает ORDER_CANCELLED/EXPIRED и вызывает releaseReservation/releaseTokenReservation.

**GAP 2 fix:** ORDER_FILLED → orderRepo.delete(orderId). Чистим терминальные ордера сразу.

**Как отличить external cancel от internal:**
- CancelOrderUseCase уже делает unreserve + order.cancel()
- Если OrderUpdateHandler получает CANCELLED для уже cancelled order → idempotent, no-op
- Если order ещё OPEN и пришёл external cancel → OrderUpdateHandler делает order.cancel(), OrderEventBridge делает unreserve

**Тесты:** OrderEventBridge.test.ts
- External cancel BUY → unreserve USDC
- External cancel SELL → unreserve tokens
- ORDER_FILLED → delete from repo
- FILL → scheduler.onOrderChanged('FILL')
- Idempotent: уже cancelled → no double unreserve

### 7.2 FillsReconciler (новый)

**Пакет:** `packages/application/recovery/src/FillsReconciler.ts`

```typescript
export class FillsReconciler {
  constructor(
    private readonly _exchangeClient: IExchangeClient,
    private readonly _processFillUseCase: ProcessFillUseCase,
    private readonly _processedFillRepo: IProcessedFillRepository,
    private readonly _logger: ILogger,
  ) {}

  /**
   * Загружает fills из venue API с момента since.
   * Новые (не в processedFillRepo) прогоняет через ProcessFillUseCase.
   * Идемпотентно: ProcessFillUseCase проверяет markIfNotExists.
   */
  async reconcile(accountId: AccountId, since?: Timestamp): Promise<FillReconciliationReport>;
}

export interface FillReconciliationReport {
  readonly totalFromVenue: number;
  readonly alreadyProcessed: number;
  readonly newlyProcessed: number;
  readonly errors: number;
}
```

**Тесты:** FillsReconciler.test.ts

### 7.3 StateReconciliationService (periodic truth checkpoint)

**Пакет:** `packages/application/recovery/src/StateReconciliationService.ts`

```typescript
export interface StateReconciliationConfig {
  /** Интервал (ms). undefined = отключено, чисто на событиях */
  readonly intervalMs?: number;
  /** Глубина fills lookback (ms) */
  readonly fillLookbackMs: number;
}

export class StateReconciliationService {
  constructor(
    private readonly _orderReconciler: OrderReconciler,
    private readonly _fillsReconciler: FillsReconciler,
    private readonly _clock: IClock,
    private readonly _logger: ILogger,
    private readonly _config: StateReconciliationConfig,
  ) {}

  start(): void;  // No-op если intervalMs === undefined
  stop(): void;
  async reconcileOnce(accountId: AccountId): Promise<void>;
}
```

**Тесты:** StateReconciliationService.test.ts

### 7.4 Risk: системный + стратегический (разделение)

**Текущее состояние:**
- `OrderRiskChecker` — pre-trade, частично per-strategy (maxOpenOrders по strategyId)
- `DrawdownRiskMonitor` — post-trade, system-wide (весь аккаунт)

**Изменения:**

| Уровень | Компонент | Что проверяет | Когда | Реакция |
|---------|-----------|---------------|-------|---------|
| **Strategy** | OrderRiskChecker (существующий) | maxOpenOrders (per strategy), maxPositionSize (per instrument), maxOrderNotional | Pre-trade (в PlaceOrderUseCase) | Reject intent |
| **Strategy** | + добавить `minTimeToExpiryMs` | Не размещать ордера за N ms до экспирации | Pre-trade | Reject intent |
| **System** | DrawdownRiskMonitor (существующий) | Drawdown всего аккаунта от high-water mark | Post-trade (после fill) | RISK_LIMIT_BREACHED → stopAll |
| **System** | + добавить `minAvailableBalance` | Минимальный свободный USDC баланс | Pre-trade | Reject intent |

**Файлы:**
- `risk/src/OrderRiskChecker.ts` — добавить `minTimeToExpiryMs` check
- `risk/src/RiskParams.ts` — добавить `minTimeToExpiryMs?: number`

### 7.5 Supervisors

**MarketDiscoveryPublisher:**
- `StrategyRunner` → `StrategyScheduler`
- `StrategyFactory` → `(event: MarketOpenedEvent) => StrategyRegistration | undefined`
- MARKET_OPENED → `scheduler.register(registration)`

**MarketExpiryMonitor:**
- MARKET_CLOSED → `scheduler.unregister(strategyId)`

**RiskOrchestrator:**
- `runner.onRiskBreached()` → `scheduler.onRiskBreached()`

### 7.6 Удаление старого

| Файл | Действие |
|------|----------|
| `strategy/src/TradingAPI.ts` | Удалить |
| `strategy/src/ITradingAPI.ts` | Удалить |
| `strategy/src/StrategyContext.ts` | Удалить |
| `strategy/src/StrategyRunner.ts` | Удалить |
| `strategy/src/IStrategyRunner.ts` | Удалить |

Обновить `strategy/src/index.ts`.

---

## Шаг 8. Примеры стратегий + apps/bot

### 8.1 SimpleMarketMaker

```
apps/bot/src/strategies/SimpleMarketMaker.ts
```

- extends BaseStrategy<MakerData, MakerAction>
- gather: topOfBook + orders + position + portfolio.availableTokenQuantity()
- decide:
  - timeToExpiry < 60s → CANCEL_ALL + SELL всё
  - спред < minSpread → CANCEL_ALL
  - нормальный режим → котировки bid/ask с offset
- toIntents: MakerAction → StrategyIntent[]

### 8.2 MomentumStrategy

```
apps/bot/src/strategies/MomentumStrategy.ts
```

- extends BaseStrategy<MomentumData, MomentumAction>
- gather: tradeTape + topOfBook + position + portfolio
- decide: buyRatio > threshold → ENTER/EXIT
- toIntents: MomentumAction → StrategyIntent[]

### 8.3 main.ts + StrategyFactory

```
apps/bot/src/main.ts
apps/bot/src/strategyFactory.ts
```

Полный wiring — 13 шагов инициализации (см. архитектуру выше).

---

## Сводная таблица изменений

| Пакет | Действие | Детали |
|-------|----------|--------|
| `strategy` | **Переписать** | types/, IStrategy, BaseStrategy, DirtyTracker, ExecutionEngine, StrategyScheduler, OrderEventBridge |
| `market-state` | **Расширить** | MarketDataStore + recordDirect в коллекторах |
| `ports` | **Расширить** | IOrderStateStore, IMarketDataStore |
| `recovery` | **Расширить** | FillsReconciler, StateReconciliationService |
| `risk` | **Расширить** | minTimeToExpiryMs в RiskParams/OrderRiskChecker |
| `orchestrators` | **Минимально** | RiskOrchestrator: scheduler вместо runner |
| `market-supervisors` | **Минимально** | scheduler.register вместо runner.start |
| `infrastructure/backtesting` | **Расширить** | InMemoryOrderRepository + IOrderStateStore |
| `event-bus` | Без изменений | — |
| `handlers` | Без изменений | — |
| `use-cases` | Без изменений | Вызываются из ExecutionEngine |
| `balance-allocator` | Без изменений | — |
| `market-discovery` | Без изменений | — |
| `market-lifecycle` | Без изменений | — |

---

## Решённые вопросы

### 1. Order.strategyId
✅ Есть. `Order.strategyId: string | undefined`.

### 2. Несколько стратегий на одном инструменте
✅ Поддерживается. `_instrumentToStrategies: Map<string, Set<string>>`.

### 3. TokenBalance в snapshot → НЕ НУЖЕН
✅ Решено. Portfolio уже содержит всё:
- `balance` (USDC available/reserved)
- `positions` (количество токенов, средняя цена)
- `tokenReservations` (залоченные токены для SELL ордеров)
- `availableTokenQuantity(instrumentId)` — сколько токенов можно продать

### 4. Market entity в snapshot
✅ Решено. Передаём `Market` целиком вместо `timeToExpiryMs`.

### 5. Risk: два уровня
✅ Решено. Strategy-level (pre-trade в PlaceOrderUseCase) + System-level (post-trade DrawdownRiskMonitor).

### 6. AMEND удалён из StrategyIntent
✅ Решено. AMEND НЕ входит в StrategyIntent:
- Polymarket не поддерживает атомарный amend
- Cancel + Place как два отдельных intenta безопаснее
- Каждый проходит свой risk check независимо
- Нет race condition: стратегия видит результат cancel в следующем tick и решает сама

### 7. execute() fire-and-forget + coalescing
✅ By design. Результат в следующем tick через ORDER_UPDATE dirty.
Если новые данные пришли пока execute работал — coalescing pattern
запускает rerun с актуальным snapshot (вместо пропуска тика).

### 8. Event-driven scheduler (не setInterval polling)
✅ Решено. `setInterval(5ms)` заменён на event-driven queue:
- markDirty → enqueue → microtask worker
- O(events) вместо O(strategies × time)
- Zero CPU при idle
- Latency < 1ms (microtask) вместо до 5ms (poll interval)

### 9. Coalescing вместо executionPromise skip
✅ Решено. Старый подход: `if executionPromise → skip` (потеря данных).
Новый: `if running → rerunRequested = true`. После завершения execute —
немедленный rerun с актуальным snapshot.

### 10. Intent normalization в ExecutionEngine
✅ Решено. Перед исполнением intents нормализуются:
- CANCEL_ALL → удаляет все отдельные CANCEL (дублирование)
- Dedupe CANCEL по orderId
- Dedupe PLACE по `${side}:${price}`

## Исправляемые GAP'ы

### GAP 1: External cancel → unreserve balance
⚠️ → ✅ Исправляется в OrderEventBridge (шаг 7.1):
- ORDER_CANCELLED/EXPIRED → определяем side ордера
- BUY → `portfolioService.releaseReservation(notional)`
- SELL → `portfolioService.releaseTokenReservation(instrumentId, remainingSize)`

### GAP 2: Filled ордера не удаляются из repo
⚠️ → ✅ Исправляется в OrderEventBridge (шаг 7.1):
- ORDER_FILLED → `orderRepo.delete(orderId)` (немедленный cleanup)

---

## Acceptance criteria

Каждый шаг считается завершённым когда:
1. Код написан с TSDoc комментариями (русский)
2. Тесты написаны и проходят
3. `npm run build && npm test && npm run lint` — без ошибок
4. Документация в docs/ обновлена
