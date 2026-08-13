# @polymarket/orchestrators — Слой оркестрации

## Обзор

Пакет связывает `IEventBus` с use-cases.
Каждый оркестратор — единственный компонент с одной ответственностью.

| Оркестратор | Что делает |
|-------------|------------|
| `FillOrchestrator` | `FILL_RECEIVED` → `ProcessFillUseCase.execute(fill)`; `FILL_FAILED` → откат Portfolio + очистка in-flight флагов |
| `OrderUpdateOrchestrator` | `ORDER_UPDATE_RECEIVED` → `UpdateOrderStatusUseCase.execute(...)` |

## Зависимости

```
FillOrchestrator
  ├── IEventBus (subscribe FILL_RECEIVED, FILL_FAILED)
  ├── ProcessFillUseCase (IFillProcessor)
  ├── IOrderStateStore (очистка in-flight флагов при FILL_FAILED)
  └── IFillReverter (откат Portfolio при FILL_FAILED)

OrderUpdateOrchestrator
  ├── IEventBus (subscribe ORDER_UPDATE_RECEIVED)
  └── UpdateOrderStatusUseCase (IOrderStatusUpdater)
```

## Почему нет MarketDataOrchestrator?

`BOOK_UPDATED` / `BOOK_DEPTH` — стратегии подписываются **напрямую** через `ctx.api.subscribe()` (Phase 7 `TradingAPI`).
Промежуточный оркестратор создал бы publish-loop: `infrastructure → EventBus → Orchestrator → EventBus`.

## Паттерн использования

```typescript
const fillOrch = new FillOrchestrator({
  eventBus,
  processFill,
  orderStateStore,
  portfolioService,
  logger,
});
const orderUpdateOrch = new OrderUpdateOrchestrator({ eventBus, updateOrderStatus, logger });

// При старте:
fillOrch.register();
orderUpdateOrch.register();

// При graceful shutdown:
fillOrch.unregister();
orderUpdateOrch.unregister();
```

## Идемпотентность register()

Повторный вызов `register()` без предварительного `unregister()` безопасен:
оркестратор сначала отписывается от предыдущей подписки, затем регистрирует новую.
