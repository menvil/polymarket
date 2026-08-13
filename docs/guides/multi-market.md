# Multi-Market Support (runLive + runPaper)

## Обзор

Бот поддерживает одновременную торговлю на N рынках через систему слотов.
Реализовано в обоих режимах: `runLive()` (`ActiveMarketSlot`) и `runPaper()` (`PaperMarketSlot`).
Каждый слот — автономная единица с собственной стратегией, fill-историей и параметрами рынка.

## Конфигурация

```json
{
  "resources": {
    "maxConcurrentMarkets": 3,
    "minCapitalPerMarket": 10
  }
}
```

- `maxConcurrentMarkets` — максимум одновременно открытых рынков (default: 1)
- `minCapitalPerMarket` — минимальный доступный баланс USDC для открытия нового слота

## Ключевая структура данных

```typescript
interface ActiveMarketSlot {
  readonly instrumentId: InstrumentId;
  readonly marketId: MarketId;
  readonly asset: AssetId;
  readonly tokenIdStr: string;
  readonly expiresAtMs: number;
  readonly tickSize: Price;
  readonly minOrderSize: Quantity;
  readonly candidate: DiscoveredMarket | null;
  readonly strategy: IStrategy;    // уникальный экземпляр
  fillHistory: FillRecord[];       // per-slot fill tracking
  partialAccum: Map<string, PartialAccum>;
  openedAt: number;
}

const activeMarkets = new Map<string, ActiveMarketSlot>(); // key = tokenIdStr
const orderToSlot = new Map<string, string>();              // orderId → tokenIdStr
```

## Алгоритм работы

### Инициализация

1. Первый рынок создаётся при старте (fixed или discovery)
2. Для discovery + `maxConcurrentMarkets > 1`: после WS connect вызывается `fillMarketSlots()`

### Ротация рынков

1. `checkExpiredMarkets()` каждые 5 сек проверяет все слоты
2. Истёкшие слоты закрываются через `closeMarket(tokenIdStr, 'EXPIRED')`
3. `fillMarketSlots()` заполняет свободные слоты новыми кандидатами
4. Reentrancy guard `_rotationInProgress` предотвращает гонки

### Fill tracking (per-slot)

- `ORDER_CREATED` → `orderToSlot.set(orderId, tokenIdStr)` (привязка ордера к слоту)
- `ORDER_PARTIALLY_FILLED` / `ORDER_FILLED` / `ORDER_CANCELLED` → lookup слот через `orderToSlot`, запись в `slot.partialAccum` / `slot.fillHistory`

### Shutdown

- Итерация всех слотов: `printMarketSummary(slot)` + `scheduler.unregister(slot.strategy.id)`
- `activeMarkets.clear()`, `orderToSlot.clear()`

## Backward Compatibility

| Режим | Поведение |
|-------|-----------|
| `source: 'fixed'` | Один слот, без ротации — идентично старому коду |
| `source: 'discovery'` + `maxConcurrentMarkets: 1` | Один слот, ротация как раньше |
| `source: 'discovery'` + `maxConcurrentMarkets > 1` | N слотов, независимая ротация |

## Что НЕ менялось

- `ExchangeClient` — stateless, работает с любым количеством рынков
- `FillOrchestrator` — глобальный, роутинг по `Fill.orderId`
- `UserEventFeedAdapter` — глобальный, один WS user channel
- `StrategyScheduler` — уже поддерживал multi-instrument
- `Portfolio` — multi-position by design
- WS Market Channel — multi-token с debounced reconnect

## Особенности Paper-режима

- `PaperMarketSlot` — аналог `ActiveMarketSlot` без `tickSize`/`minOrderSize` (используются дефолты)
- `PaperExchangeClient.registerMarket()` — регистрирует рыночный контекст для маршрутизации ордеров по `asset`
- `PaperFillSimulator` — единый экземпляр, обрабатывает fills по всем рынкам
- Проверка капитала: `balance.available() >= minCapitalPerMarket` перед открытием слота

## Edge Cases

1. **Проверка капитала**: `openMarket()` проверяет `balance.available() >= minCapitalPerMarket`
2. **Unique strategy IDs**: `${type}-slot-${_slotCounter++}` (счётчик монотонный)
3. **Slot cleanup**: `closeMarket()` чистит `orderToSlot` для удалённого слота
