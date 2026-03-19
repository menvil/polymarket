# Strategy Engine: Reactive Scheduling

## Обзор

Strategy Engine — реактивная event-driven архитектура для торговых стратегий.
Стратегии НЕ подписываются на события напрямую. Вместо этого:

```
Exchange WS → EventAdapters → EventBus → State Stores → DirtyTracker → Scheduler → strategy.tick(snapshot) → intents → ExecutionEngine
```

## Ключевые модули

### Шаг 1: Типы (`strategy/src/types/`)

| Тип | Описание |
|-----|----------|
| `TriggerReason` | `'BOOK' \| 'TRADE' \| 'FILL' \| 'ORDER_UPDATE' \| 'TIMER'` |
| `StrategyIntent` | `PLACE \| CANCEL \| CANCEL_ALL` (декларативные намерения) |
| `StrategySnapshot` | Readonly snapshot: market data + orders + portfolio + timing |
| `ScheduleConfig` | `minIntervalMs`, `priorityTriggers`, `maxIdleMs` |

### Шаг 2: State Stores

#### MarketDataStore (`market-state/src/MarketDataStore.ts`)
Фасад над BookDepthCollector + TradeTapeCollector:
- Подписывается на `BOOK_UPDATED`, `BOOK_DEPTH`, `TRADE_RECEIVED`
- Хранит TopOfBook per instrumentId
- Вызывает `onChange(instrumentId, reason)` для SchedulerКоллекторы получили `recordDirect()` метод для записи без дублирования EventBus подписки.

#### IOrderStateStore (`ports/src/IOrderStateStore.ts`)
Синхронный интерфейс чтения ордеров:
```typescript
interface IOrderStateStore {
  getOpenOrders(strategyId): readonly Order[];
  getOpenOrdersByInstrument(strategyId, instrumentId): readonly Order[];
  getOrder(orderId): Order | undefined;
}
```
Реализуется `InMemoryOrderRepository` (sync — Map under the hood).

### Шаг 3: DirtyTracker (`strategy/src/DirtyTracker.ts`)
Накапливает `TriggerReason` per strategy между тиками. Методы: `markDirty`, `isDirty`, `getReasons`, `clearDirty`, `hasPriorityTrigger`, `remove`.

### Шаг 4: IStrategy + BaseStrategy
```typescript
interface IStrategy {
  readonly id: string;
  readonly name: string;
  initialize(): Promise<Result<void, Error>>;
  tick(snapshot, reasons): StrategyIntent[];  // sync!
  stop(): StrategyIntent[];
  getMetrics(): Record<string, unknown>;
}
```

`BaseStrategy<TData, TAction>` — gather → decide → toIntents pipeline.

### Шаг 5: ExecutionEngine
Нормализует и исполняет intents:
1. Нормализация: CANCEL_ALL поглощает CANCELs, dedupe CANCEL по orderId, dedupe PLACE по `side:price`
2. Порядок: CANCEL_ALL → CANCEL (параллельно) → PLACE (последовательно)

### Шаг 6: StrategyScheduler
Event-driven queue с coalescing:
- `markDirty → enqueue → microtask worker`
- Throttle: `minIntervalMs` (пропускается для priority triggers)
- Coalescing: если strategy running → `rerunRequested = true`
- Heartbeat: `setInterval(maxIdleMs)` → TIMER reason
- Zero CPU при idle

## Архитектурные решения

### Почему event-driven queue, а не setInterval polling
- O(events) вместо O(strategies × time)
- Zero CPU при idle
- Latency < 1ms (microtask)

### Почему нет AMEND в StrategyIntent
Polymarket не поддерживает атомарный amend. Cancel + Place — два отдельных intent'а.
Race condition между cancel и place, risk check на новый place может не пройти.

### Почему coalescing вместо skip
Если стратегия running и пришли новые данные → rerun с fresh snapshot после execute.
Гарантирует что стратегия увидит все данные, без потери событий.

## Шаг 7: Интеграция

### OrderEventBridge (`strategy/src/OrderEventBridge.ts`)
Мост между Order domain events и StrategyScheduler:
- Подписывается на 6 типов событий: ORDER_ACCEPTED, ORDER_REJECTED, ORDER_CANCELLED, ORDER_EXPIRED, ORDER_PARTIALLY_FILLED, ORDER_FILLED
- Роутит в `scheduler.onOrderChanged(strategyId, reason)`
- Для терминальных событий (CANCELLED, EXPIRED, FILLED): `orderRepo.delete(orderId)`
- НЕ делает unreserve (это ответственность CancelOrderUseCase / handlers)

### FillsReconciler (`recovery/src/FillsReconciler.ts`)
Загружает fills из venue API, дедуплицирует через `processedFillRepo.markIfNotExists(fillId)`,
делегирует новые fills в `IVenueFillProcessor`. Возвращает `FillReconciliationReport`.

### StateReconciliationService (`recovery/src/StateReconciliationService.ts`)
Периодическая сверка: OrderReconciler + FillsReconciler в одном `reconcileOnce()`.
Config: `{ intervalMs, fillLookbackMs }`.

### Risk: minTimeToExpiryMs
Добавлена проверка #0 (до maxOpenOrders): если `timeToExpiryMs < minTimeToExpiryMs` → TOO_CLOSE_TO_EXPIRY.

### Удалённые файлы
Удалены legacy-файлы из strategy пакета:
- StrategyContext, ITradingAPI, TradingAPI, StrategyRunner, IStrategyRunner

## Шаг 8: Примеры стратегий + apps/bot

### SimpleMarketMaker (`apps/bot/src/strategies/SimpleMarketMaker.ts`)
- `extends BaseStrategy<MakerData, MakerAction>`
- gather: topOfBook + orders + position + balance + timeToExpiry
- decide:
  - timeToExpiry < exitThresholdMs → CANCEL_ALL + SELL позицию
  - spread < minSpread → CANCEL_ALL
  - нормальный режим → bid/ask котировки с offset от mid
- toIntents: MakerAction → StrategyIntent[]

### MomentumStrategy (`apps/bot/src/strategies/MomentumStrategy.ts`)
- `extends BaseStrategy<MomentumData, MomentumAction>`
- gather: tradeTape → buyRatio + topOfBook + position
- decide: buyRatio > threshold → ENTER, buyRatio < threshold → EXIT
- toIntents: MomentumAction → StrategyIntent[]

### StrategyFactory (`apps/bot/src/strategyFactory.ts`)
Фабрика: `createStrategy({ type: 'market-maker' | 'momentum', params })`.
Дефолтные конфигурации: `DEFAULT_MARKET_MAKER_CONFIG`, `DEFAULT_MOMENTUM_CONFIG`.

### main.ts (`apps/bot/src/main.ts`)
13 шагов инициализации:
1. Clock + Logger
2. EventBus
3. MockExchangeClient
4. InMemoryOrderRepository + InMemoryPortfolioStore + InMemoryProcessedFillRepository
5. OrderService + PortfolioService + LedgerService
6. OrderRiskChecker (с параметрами)
7. PlaceOrderUseCase + CancelOrderUseCase + ProcessFillUseCase
8. BookDepthCollector + TradeTapeCollector + MarketDataStore
9. ExecutionEngine
10. StrategyScheduler
11. OrderEventBridge
12. Portfolio init + Strategy factory + register
13. Start + graceful shutdown (SIGINT/SIGTERM)

### Переменные окружения
| Переменная | Описание | По умолчанию |
|-----------|----------|-------------|
| `TOKEN_ID` | ID токена (обязательно) | — |
| `MARKET_ID` | ID рынка (обязательно) | — |
| `STRATEGY` | Тип стратегии | `market-maker` |
| `ACCOUNT_ID` | ID аккаунта | `venue:POLYMARKET:dev-account` |
| `INITIAL_BALANCE` | Начальный баланс USDC | `1000` |
| `EXPIRATION_MS` | Время экспирации (epoch ms) | +24 часа |
