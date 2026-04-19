# CEX Multiplex Exchange Watcher

## Почему это сделано так?

Предыдущая архитектура (`CcxtSymbolWatcher`) создавала отдельный ccxt.pro-инстанс
и отдельное WebSocket-соединение **на каждую пару × поток**. Для конфигурации
с 6 парами × 2 потока это 12 одновременных WS-соединений на одну биржу.

Это упиралось в публичные rate-лимиты бирж:

- **OKX** — до ~30 коннектов/IP в секунду + лимит sub-операций на соединение.
  На холодном старте отдавала `50011 Too Many Requests` — задачи уходили в
  бесконечный цикл рестартов.
- **Bybit** — 500 коннектов на IP за 5 минут + валидация `depth ∈ {1,50,200,1000}`
  на spot. С `obDepth: 10` каждая подписка падала с `"for spot markets limit
  can be one of [1,50,200,1000]"`.
- **Binance / Coinbase / Kraken** — тоже имеют квоты, которые дешевле не трогать.

## Решение

Один `CcxtExchangeWatcher` на биржу с **мультиплексной подпиской** через
`watchOrderBookForSymbols` / `watchTradesForSymbols`. Все символы одной биржи
шарят одно WS-соединение на поток.

### Алгоритм шагами

1. `CexCollectorService` создаёт по одному `CcxtExchangeWatcher` на биржу
   (вместо одного на каждую пару).
2. Внутри вотчера — два независимых `RestartingTask`:
   - `<exchange>:orderbook` — отдельный ccxt.pro instance + свой WS;
   - `<exchange>:trades` — отдельный ccxt.pro instance + свой WS.
   Сбой одного потока не валит другой.
3. Для OB выбирается лучший доступный метод:
   - `multiplex` — `watchOrderBookForSymbols(symbols, depth)` (предпочтительно);
   - `watch-per-symbol` — `watchOrderBook(sym, depth)` per-symbol в одном instance
     (fallback, если биржа не поддерживает multiplex);
   - `fetch` — REST polling (если явно задано `obMethod: 'fetch'`).
4. Для trades — `watchTradesForSymbols(symbols)` или per-symbol fallback.
5. `depth` нормализуется под whitelist биржи (bybit spot: 10→50, coinbase: →50).
6. Плановые рестарты (`restartIntervalMs`, default 30 мин) по-прежнему работают,
   но теперь это 2 реконнекта на биржу вместо 2N.

### Blast radius рестартов

| Событие                      | Раньше (per-symbol)         | Теперь (multiplex)         |
|------------------------------|-----------------------------|----------------------------|
| Плановый рестарт             | 2N реконнектов              | 2 реконнекта               |
| Разрыв сети                  | 2N параллельных реконнектов | 2 реконнекта               |
| Hung OB у одной пары         | рестарт одной пары          | рестарт всего OB-стрима    |
| Ошибка подписки на пару      | рестарт одной пары          | рестарт всего OB-стрима, cooldown в `RestartingTask` если символ битый |

Tradeoff: падение по одному символу затрагивает все символы того же потока
на той же бирже. Взамен мы больше не упираемся в rate-лимиты и имеем на порядок
меньше реконнектов под нагрузкой.

## Пример использования

```typescript
import { CcxtExchangeWatcher } from '@polymarket/cex-market-data';

const watcher = new CcxtExchangeWatcher({
  exchangeId: 'okx',
  exchangeType: 'spot',
  symbols: ['BTC/USD', 'ETH/USD', 'SOL/USD'],
  depth: 10,
  watchOrderbook: true,
  watchTrades: true,
  restartIntervalMs: 30 * 60_000,
  onRecord: (symbol, record) => console.log(symbol, record),
  logger,
});
watcher.start();
// ...
await watcher.stop();
```

## Whitelist глубины стакана

Список допустимых значений `depth` для спотовых бирж задан в
`SPOT_DEPTH_WHITELIST` в `src/CcxtExchangeWatcher.ts`. Для бирж не в списке
`depth` пробрасывается как есть.

| Биржа      | Whitelist (spot)    |
|------------|---------------------|
| bybit      | `[1, 50, 200, 1000]`|
| coinbase   | `[50]`              |

Если запрошенное значение не в списке — берётся **ближайшее большее** (то есть
данных не меньше, чем просили; downstream может сам слайснуть до нужной глубины).