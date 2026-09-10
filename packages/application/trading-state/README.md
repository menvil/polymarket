# @polymarket/trading-state

Оперативное состояние торгового рантайма, построенное **только** из
canonical application events.

```text
canonical Market
    ↓
TRADING_MARKET_ADMITTED
    ↓
IEventBus → TradingStateProjector → TradingHotState
                                      └── MarketRuntimeState
                                            ├── market      canonical Market
                                            ├── lifecycle   наш торговый цикл
                                            └── instruments активные данные
```

Идентичность рынка — **пара** `venueId + marketId`:

```typescript
view.getMarket(venueId, marketId);
view.getMarketForInstrument(venueId, instrumentId);
view.marketIdentities(); // [{ venueId, marketId }, …]
```

`MarketId` уникален только внутри пространства имён своей площадки, поэтому
`POLYMARKET:X` и `KALSHI:X` — два разных рынка (то же правило, что у
`Market.equals()` и ключа `MarketUniverse`).

Три вещи, которые важно не спутать:

- **`MarketUniverse`** — какие canonical рынки технически существуют;
  **`TradingHotState.markets`** — какие рынки торговый рантайм принял сам.
  Market-data по непринятому рынку намеренно игнорируется.
- **`Market.state`** — внешнее состояние рынка на площадке;
  **`MarketRuntimeState.lifecycle`** — что наш рантайм с этим рынком делает.
  Комбинация «`ACTIVE` у площадки, `TRADING_CLOSED` у нас» законна.
- **`instrumentIds()`** — структурные инструменты рынка (всегда оба);
  **`getInstrument()`** — активное тяжёлое состояние, которое освобождается
  при остановке торговли.

Подробности — в [`docs/trading-state.md`](./docs/trading-state.md).
