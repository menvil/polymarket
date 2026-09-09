# @polymarket/trading-state

Оперативное состояние торгового рантайма, построенное **только** из
canonical application events.

```text
canonical Application Events → IEventBus → TradingStateProjector → TradingHotState
```

Подробности — в [`docs/trading-state.md`](./docs/trading-state.md).
