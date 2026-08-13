# Coordination Plan v1.0

## Polymarket — Market Coordination, Balance Management & Ongoing Reconciliation

**Версия:** 1.0
**Дата:** 2026-03-10
**Зависит от:** Master Plan v2 (Phases 0–9) — все фазы должны быть завершены
**Источник:** Анализ `polymarket-v3/src/application/services/`

---

## Контекст

После завершения Master Plan (Phases 0–9) система умеет:

- Принимать ордера, обрабатывать fills, отменять ордера
- Восстанавливать состояние при рестарте (Phase 9 Recovery)
- Запускать стратегии через `StrategyRunner`

Этот план добавляет **оркестрацию торговли** поверх готовой инфраструктуры:

| # | Что добавляем | Откуда взято |
|---|--------------|--------------|
| Phase A | Ongoing Reconciliation (периодический опрос биржи) | `OrderReconciliationService` |
| Phase B | Balance Allocator (выделение капитала на стратегию) | `BalanceAllocator` |
| Phase C | Market Lifecycle (открытие/закрытие рынков) | `MultiStrategyCoordinator.discoverMarkets()` |
| Phase D | Strategy Coordinator (координация нескольких стратегий) | `MultiStrategyCoordinator` |

---

## Архитектура после реализации

```
┌─────────────────────────────────────────────────────────────────┐
│                    APPLICATION LAYER                             │
│                                                                  │
│  @polymarket/use-cases          PlaceOrder, ProcessFill,        │
│                                 CancelOrder                      │
│                                 + ReconcileOrdersUseCase  ← NEW │
│                                 + ReconcileTradesUseCase  ← NEW │
│                                                                  │
│  @polymarket/market-lifecycle   OpenMarketUseCase        ← NEW  │
│                                 CloseMarketUseCase        ← NEW │
│                                 IRemovalPolicy            ← NEW │
│                                 ExpirationRemovalPolicy   ← NEW │
│                                                                  │
│  @polymarket/balance-allocator  BalanceAllocator          ← NEW │
│                                 IBalanceAllocator          ← NEW │
│                                                                  │
│  @polymarket/coordinator        StrategyCoordinator       ← NEW │
│                                 (tick-based, no setInterval)     │
│                                                                  │
│  @polymarket/strategy ✅        IStrategy, TradingAPI,          │
│                                 StrategyRunner                   │
│                                                                  │
│  @polymarket/orchestrators ✅   FillOrchestrator,               │
│                                 RiskOrchestrator                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Phase A: Ongoing Reconciliation

**Пакет:** расширение `@polymarket/use-cases` + `@polymarket/ports`
**Цель:** периодический polling биржи как safety net для event-driven fill detection.

> Phase 9 (Recovery) = startup reconciliation (один раз при старте).
> Phase A = ongoing reconciliation (каждые ~10 секунд, пока система работает).

### A.1 Расширить `IExchangeClient` в `@polymarket/ports`

```typescript
// packages/application/ports/src/IExchangeClient.ts — добавить:

/** Возвращает все открытые ордера аккаунта */
getOpenOrders(accountId: AccountId): Promise<Result<OpenOrderSnapshot[], TradingError>>;

/** Возвращает исполненные трейды аккаунта начиная с timestamp */
getTrades(
  accountId: AccountId,
  since?: Timestamp,
): Promise<Result<TradeSnapshot[], TradingError>>;
```

```typescript
// packages/application/ports/src/types/OpenOrderSnapshot.ts
export interface OpenOrderSnapshot {
  readonly orderId: OrderId;
  readonly accountId: AccountId;
  readonly asset: AssetId;
  readonly side: Side;
  readonly price: Price;
  readonly size: Quantity;
  readonly filledSize: Quantity;
  readonly status: 'OPEN' | 'PARTIALLY_FILLED';
  readonly createdAt: Timestamp;
}
```

```typescript
// packages/application/ports/src/types/TradeSnapshot.ts
export interface TradeSnapshot {
  readonly fillId: FillId;
  readonly orderId: OrderId;
  readonly accountId: AccountId;
  readonly asset: AssetId;
  readonly side: Side;
  readonly price: Price;
  readonly size: Quantity;
  readonly fee: FeeSnapshot;
  readonly executedAt: Timestamp;
}
```

### A.2 `ReconcileOrdersUseCase`

```typescript
// packages/application/use-cases/src/ReconcileOrdersUseCase.ts

export interface ReconcileOrdersDeps {
  orderRepo: IOrderRepository;
  exchangeClient: IExchangeClient;
  eventBus: IEventBus;
  logger: ILogger;
}

export interface ReconcileOrdersInput {
  accountId: AccountId;
}

/**
 * Алгоритм:
 * 1. Получить локальные OPEN/PARTIALLY_FILLED ордера из orderRepo
 * 2. Получить открытые ордера с биржи (exchangeClient.getOpenOrders)
 * 3. Для каждого локального ордера — если нет на бирже:
 *    a. Если filledSize изменился → publishAll(OrderFilled)
 *    b. Иначе → publishAll(OrderCancelled) [external cancellation]
 * 4. Логировать расхождения
 */
export class ReconcileOrdersUseCase {
  execute(input: ReconcileOrdersInput): Promise<Result<ReconciliationReport, TradingError>>;
}

export interface ReconciliationReport {
  readonly checkedCount: number;
  readonly filledCount: number;
  readonly externalCancelCount: number;
  readonly errorCount: number;
}
```

### A.3 `ReconcileTradesUseCase`

```typescript
// packages/application/use-cases/src/ReconcileTradesUseCase.ts

export interface ReconcileTradesInput {
  accountId: AccountId;
  since: Timestamp; // обычно — last processed fill timestamp
}

/**
 * Алгоритм:
 * 1. Получить трейды с биржи (exchangeClient.getTrades(since))
 * 2. Для каждого трейда — markIfNotExists(fillId):
 *    - false → уже обработан, skip
 *    - true  → запустить ProcessFillUseCase
 */
export class ReconcileTradesUseCase {
  execute(input: ReconcileTradesInput): Promise<Result<void, TradingError>>;
}
```

### A.4 Reconciliation Scheduler (Infrastructure)

```typescript
// packages/infrastructure/polymarket/reconciliation/ReconciliationScheduler.ts

/**
 * Запускает ReconcileOrdersUseCase + ReconcileTradesUseCase периодически.
 * НЕ использует setInterval — реагирует на StrategyTick события через IEventBus.
 * Каждые RECONCILE_EVERY_N_TICKS тиков запускает reconciliation.
 */
export class ReconciliationScheduler {
  private _tickCounter = 0;
  static readonly RECONCILE_EVERY_N_TICKS = 20; // настраиваемо

  start(): void; // subscribe to StrategyTick
  stop(): void;  // unsubscribe
}
```

**Зависимости Phase A:**

- Master Plan Phase 1 (ports) ✅
- Master Plan Phase 2 (event-bus) ✅
- Master Plan Phase 5 (use-cases) ✅
- Master Plan Phase 7 (strategy — StrategyTick event) ✅

---

## Phase B: Balance Allocator

**Пакет:** `packages/application/balance-allocator/` → `@polymarket/balance-allocator`
**Цель:** распределение капитала между активными стратегиями/рынками.

### B.1 `IBalanceAllocator` порт

```typescript
// packages/application/balance-allocator/src/IBalanceAllocator.ts

export interface AllocationResult {
  readonly marketId: MarketId;
  readonly allocatedAmount: Money; // в USDC
}

export interface AllocationStats {
  readonly totalBalance: Money;
  readonly tradingBalance: Money;     // totalBalance × tradingRatio
  readonly allocatedBalance: Money;   // сумма всех выделений
  readonly freeBalance: Money;        // tradingBalance - allocated
  readonly utilization: number;       // 0..1
  readonly activeMarkets: number;
  readonly availableSlots: number;    // до maxConcurrentMarkets
}

export interface IBalanceAllocator {
  allocateToNewMarkets(marketIds: readonly MarketId[]): AllocationResult[];
  addMarket(marketId: MarketId): Result<AllocationResult, TradingError>;
  releaseWithPnL(marketId: MarketId, realizedPnL: Money): void;
  release(marketId: MarketId): void;
  getAllocation(marketId: MarketId): Money | undefined;
  updateTotalBalance(newBalance: Money): void;
  canAddMarket(): boolean;
  getStats(): AllocationStats;
}
```

### B.2 `BalanceAllocatorConfig`

```typescript
export interface BalanceAllocatorConfig {
  /** Доля от totalBalance для торговли (0..1). Default: 0.8 */
  readonly tradingBalanceRatio: number;
  /** Минимальный капитал на рынок в USDC. Default: 50 */
  readonly minCapitalPerMarket: Money;
  /** Максимум одновременных рынков. Default: 10 */
  readonly maxConcurrentMarkets: number;
}
```

### B.3 `BalanceAllocator` (класс)

```
Алгоритм allocateToNewMarkets:
1. freeBalance = tradingBalance - sum(allocations.values)
2. newSlots = min(remainingSlots, floor(freeBalance / minCapital))
3. perMarket = freeBalance / newSlots          ← весь свободный баланс
4. Если perMarket < minCapital → вернуть []
5. Записать allocation для каждого marketId
6. Вернуть AllocationResult[]

Алгоритм releaseWithPnL:
1. allocation = allocations.get(marketId)
2. allocations.delete(marketId)
3. totalBalance += realizedPnL                 ← PnL компаундируется
```

**Зависимости Phase B:** нет зависимостей на мастер-план (чистая логика).

---

## Phase C: Market Lifecycle

**Пакет:** `packages/application/market-lifecycle/` → `@polymarket/market-lifecycle`
**Цель:** открытие/закрытие рынков, управление removal policies.

### C.1 `IRemovalPolicy` (pluggable)

```typescript
// packages/application/market-lifecycle/src/IRemovalPolicy.ts

export interface MarketContext {
  readonly marketId: MarketId;
  readonly expiresAt: Timestamp;
  readonly allocatedBalance: Money;
  readonly realizedPnL: Money;
  readonly openOrdersCount: number;
}

export interface IRemovalPolicy {
  /** Возвращает рынки к удалению */
  evaluate(markets: readonly MarketContext[]): readonly MarketId[];
}
```

### C.2 `ExpirationRemovalPolicy`

```typescript
/**
 * Удаляет рынки, которые истекают в течение следующих N минут.
 * Default: 30 минут до истечения.
 */
export class ExpirationRemovalPolicy implements IRemovalPolicy {
  constructor(private readonly _leadTimeMs: number = 30 * 60 * 1000) {}
  evaluate(markets: readonly MarketContext[]): readonly MarketId[];
}
```

### C.3 `OpenMarketUseCase`

```typescript
// packages/application/market-lifecycle/src/OpenMarketUseCase.ts

export interface OpenMarketInput {
  readonly marketId: MarketId;
  readonly strategyId: StrategyId;
  readonly accountId: AccountId;
}

/**
 * Алгоритм:
 * 1. balanceAllocator.addMarket(marketId) → AllocationResult
 * 2. Публикует MarketOpened event → StrategyRunner создаёт стратегию
 * 3. Логирует
 */
export class OpenMarketUseCase {
  execute(input: OpenMarketInput): Result<AllocationResult, TradingError>;
}
```

### C.4 `CloseMarketUseCase`

```typescript
// packages/application/market-lifecycle/src/CloseMarketUseCase.ts

export interface CloseMarketInput {
  readonly marketId: MarketId;
  readonly accountId: AccountId;
  readonly reason: 'EXPIRED' | 'MANUAL' | 'POLICY';
  readonly realizedPnL?: Money;
}

/**
 * Алгоритм:
 * 1. CancelOrderUseCase для всех открытых ордеров рынка
 * 2. balanceAllocator.releaseWithPnL(marketId, pnl)
 * 3. Публикует MarketClosed event
 */
export class CloseMarketUseCase {
  execute(input: CloseMarketInput): Promise<Result<void, TradingError>>;
}
```

### C.5 Новые события в `@polymarket/event-bus`

```typescript
// packages/application/event-bus/src/events/MarketEvents.ts

export interface MarketOpenedEvent {
  readonly type: 'MARKET_OPENED';
  readonly marketId: MarketId;
  readonly strategyId: StrategyId;
  readonly allocatedBalance: Money;
  readonly timestamp: Timestamp;
}

export interface MarketClosedEvent {
  readonly type: 'MARKET_CLOSED';
  readonly marketId: MarketId;
  readonly reason: 'EXPIRED' | 'MANUAL' | 'POLICY';
  readonly realizedPnL: Money;
  readonly timestamp: Timestamp;
}

// Добавить в ApplicationEvent union
export type ApplicationEvent =
  | ... // существующие события
  | MarketOpenedEvent
  | MarketClosedEvent;
```

**Зависимости Phase C:**

- Master Plan Phase 1 (ports — IMarketCatalog) ✅
- Master Plan Phase 2 (event-bus — ApplicationEvent) ✅
- Master Plan Phase 5 (use-cases — CancelOrderUseCase) ✅
- Phase B (BalanceAllocator) ← нужен до Phase C

---

## Phase D: Strategy Coordinator

**Пакет:** `packages/application/coordinator/` → `@polymarket/coordinator`
**Цель:** автоматическая координация нескольких стратегий, tick-based discovery.

> Строится поверх `@polymarket/strategy` (Phase 7) и `@polymarket/market-lifecycle` (Phase C).

### D.1 `StrategyCoordinatorConfig`

```typescript
export interface StrategyCoordinatorConfig {
  /** Каждые N тиков — сканировать новые рынки. Default: 50 */
  readonly discoverEveryNTicks: number;
  /** Каждые N тиков — проверять removal policy. Default: 10 */
  readonly policyCheckEveryNTicks: number;
  /** Максимум одновременных стратегий */
  readonly maxStrategies: number;
}
```

### D.2 `StrategyCoordinator`

```typescript
// packages/application/coordinator/src/StrategyCoordinator.ts

export interface StrategyCoordinatorDeps {
  marketCatalog: IMarketCatalog;
  balanceAllocator: IBalanceAllocator;
  openMarketUseCase: OpenMarketUseCase;
  closeMarketUseCase: CloseMarketUseCase;
  removalPolicy: IRemovalPolicy;
  eventBus: IEventBus;
  logger: ILogger;
}

/**
 * Координатор стратегий.
 *
 * Алгоритм (tick-based, НЕТ setInterval):
 * - Подписывается на StrategyTick
 * - Каждые discoverEveryNTicks тиков:
 *   1. marketCatalog.getActiveMarkets() → список кандидатов
 *   2. Фильтр: не истёкшие, не активные уже
 *   3. balanceAllocator.allocateToNewMarkets() → слоты
 *   4. OpenMarketUseCase для каждого нового рынка
 * - Каждые policyCheckEveryNTicks тиков:
 *   1. Собрать MarketContext для активных рынков
 *   2. removalPolicy.evaluate() → рынки к удалению
 *   3. CloseMarketUseCase для каждого
 */
export class StrategyCoordinator {
  constructor(deps: StrategyCoordinatorDeps, config: StrategyCoordinatorConfig);
  start(totalBalance: Money): void;
  stop(): void;
  getActiveMarkets(): readonly MarketId[];
  updateTotalBalance(newBalance: Money): void;
}
```

### D.3 Интеграция с `StrategyRunner` (Phase 7)

`StrategyRunner` уже умеет подписываться на события. Добавить обработку новых событий:

```typescript
// packages/application/strategy/src/StrategyRunner.ts — добавить:

// При MarketOpenedEvent → создать + запустить новую стратегию
eventBus.subscribe('MARKET_OPENED', (event) => {
  this._startStrategy(event.marketId, event.strategyId, event.allocatedBalance);
});

// При MarketClosedEvent → остановить стратегию
eventBus.subscribe('MARKET_CLOSED', (event) => {
  this._stopStrategy(event.marketId);
});
```

**Зависимости Phase D:**

- Master Plan Phase 7 (strategy — StrategyRunner) ✅
- Phase B (BalanceAllocator) ✅
- Phase C (OpenMarketUseCase, CloseMarketUseCase, события) ✅

---

## Порядок реализации

```
Phase A: Ongoing Reconciliation
  ├─ A.1  Расширить IExchangeClient (getOpenOrders, getTrades)
  ├─ A.2  ReconcileOrdersUseCase
  ├─ A.3  ReconcileTradesUseCase
  └─ A.4  ReconciliationScheduler (infrastructure)

Phase B: Balance Allocator
  ├─ B.1  IBalanceAllocator порт (в @polymarket/ports)
  ├─ B.2  BalanceAllocatorConfig
  └─ B.3  BalanceAllocator класс + тесты

Phase C: Market Lifecycle          ← требует Phase B
  ├─ C.1  IRemovalPolicy + ExpirationRemovalPolicy
  ├─ C.2  OpenMarketUseCase + CloseMarketUseCase
  ├─ C.3  MarketOpened/MarketClosed события в event-bus
  └─ C.4  Тесты

Phase D: Strategy Coordinator      ← требует Phase B, C
  ├─ D.1  StrategyCoordinator
  ├─ D.2  Интеграция с StrategyRunner
  └─ D.3  Integration tests
```

```
Граф зависимостей:
Master Plan (0–9) → Phase A (параллельно с B)
Master Plan (0–9) → Phase B
Phase B → Phase C
Phase B + Phase C → Phase D
Phase A + Phase D → Полная система ✅
```

---

## Новые пакеты

| Пакет | Путь | Зависит от |
|-------|------|-----------|
| `@polymarket/balance-allocator` | `packages/application/balance-allocator/` | `@polymarket/value-objects`, `@polymarket/ids`, `@polymarket/result` |
| `@polymarket/market-lifecycle` | `packages/application/market-lifecycle/` | `@polymarket/ports`, `@polymarket/event-bus`, `@polymarket/use-cases`, `@polymarket/balance-allocator` |
| `@polymarket/coordinator` | `packages/application/coordinator/` | `@polymarket/market-lifecycle`, `@polymarket/strategy`, `@polymarket/event-bus` |

---

## Расширения существующих пакетов

| Пакет | Что добавляем |
|-------|--------------|
| `@polymarket/ports` | `getOpenOrders()`, `getTrades()` в `IExchangeClient`; `OpenOrderSnapshot`, `TradeSnapshot` типы; `IBalanceAllocator` |
| `@polymarket/use-cases` | `ReconcileOrdersUseCase`, `ReconcileTradesUseCase` |
| `@polymarket/event-bus` | `MarketOpenedEvent`, `MarketClosedEvent` в `ApplicationEvent` union |
| `@polymarket/strategy` | Подписки на `MARKET_OPENED` / `MARKET_CLOSED` в `StrategyRunner` |

---

## Ключевые принципы (из polymarket-v3 v4.2 / v7.7.17)

1. **Tick-based, не setInterval** — `StrategyCoordinator` и `ReconciliationScheduler` реагируют на `StrategyTick`, не создают timers
2. **PnL компаундируется** — `releaseWithPnL` обновляет `totalBalance`, прибыль увеличивает торговый капитал
3. **Pluggable removal** — `IRemovalPolicy` инжектируется снаружи, легко менять стратегию ротации
4. **Reconciliation = safety net** — ongoing reconciliation дублирует event-driven fills, идемпотентен через `markIfNotExists`
5. **No global state** — `BalanceAllocator` — value object с чистой логикой, не singleton

---

## Верификация (на каждой фазе)

```bash
# В папке каждого нового пакета:
npm run build && npm test && npm run lint

# После Phase D — интеграционный тест в coordinator:
cd packages/application/coordinator
npm test
```

**Checklist финальный:**

- [ ] `IExchangeClient.getOpenOrders()` и `getTrades()` реализованы в infrastructure adapter
- [ ] `ReconcileOrdersUseCase` идемпотентен (повторный запуск не дублирует события)
- [ ] `BalanceAllocator.releaseWithPnL()` корректно компаундирует PnL
- [ ] `ExpirationRemovalPolicy` закрывает рынки за 30 минут до истечения
- [ ] `StrategyCoordinator` не использует `setInterval`
- [ ] `StrategyRunner` реагирует на `MARKET_OPENED` / `MARKET_CLOSED`
- [ ] Все тесты проходят
