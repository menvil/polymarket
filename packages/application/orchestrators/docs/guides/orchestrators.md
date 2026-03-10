# @polymarket/orchestrators — Слой оркестрации

## Обзор

Пакет связывает `IEventBus` с use-cases и `IStrategyRunner`.
Каждый оркестратор — единственный компонент с одной ответственностью.

| Оркестратор | Что делает |
|-------------|------------|
| `FillOrchestrator` | `FILL_RECEIVED` → `ProcessFillUseCase.execute(fill)` |
| `RiskOrchestrator` | `RISK_LIMIT_BREACHED` → `IStrategyRunner.onRiskBreached(event)` |

## Зависимости

```
FillOrchestrator
  ├── IEventBus (subscribe FILL_RECEIVED)
  └── ProcessFillUseCase

RiskOrchestrator
  ├── IEventBus (subscribe RISK_LIMIT_BREACHED)
  └── IStrategyRunner (реализуется StrategyRunner в Phase 7)
```

## Почему нет MarketDataOrchestrator?

`BOOK_UPDATED` / `BOOK_DEPTH` — стратегии подписываются **напрямую** через `ctx.api.subscribe()` (Phase 7 `TradingAPI`).
Промежуточный оркестратор создал бы publish-loop: `infrastructure → EventBus → Orchestrator → EventBus`.

## Паттерн использования

```typescript
const fillOrch = new FillOrchestrator({ eventBus, processFill, logger });
const riskOrch = new RiskOrchestrator({ eventBus, strategyRunner, logger });

// При старте:
fillOrch.register();
riskOrch.register();

// При graceful shutdown:
fillOrch.unregister();
riskOrch.unregister();
```

## IStrategyRunner

Определён в этом пакете (не в `@polymarket/strategy`) для развязки mutual dependency.
Phase 7 (`StrategyRunner`) реализует этот интерфейс.

```typescript
export interface IStrategyRunner {
  onRiskBreached(event: RiskLimitBreachedEvent): Promise<void>;
}
```

## Идемпотентность register()

Повторный вызов `register()` без предварительного `unregister()` безопасен:
оркестратор сначала отписывается от предыдущей подписки, затем регистрирует новую.
