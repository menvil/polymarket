# @polymarket/trade-tape

Лента рыночных трейдов (`TradeTape`) и stateless-калькулятор метрик потока ордеров
(`TradeFlowCalculator`/`TradeFlowMetrics`) для Polymarket. Bounded context: market
microstructure — не accounting (не знает о `Fill`/`Order`/`Portfolio`/`VenueTradeId`).

## Почему это сделано так?

### `TradeTape` — тонкая обёртка над `RollingWindow<TapeRecord>` (Этап 2)

До Этапа 2 миграции `TradeTape` содержала собственную ретеншн-логику (вытеснение по
`maxAgeMs`/`maxCount`), почти дословно продублированную ещё в двух местах кодовой базы:
`OrderBookHistory` (`@polymarket/order-book`) и
`CryptoMarketDataStore.pruneAndCap()` (`application/market-state`). Три независимые
реализации одного и того же паттерна ("append + evict by age/count") — сигнал настоящей
абстракции, а не преждевременного обобщения. Абстракция вынесена в
`@polymarket/rolling-window` (`RollingWindow<T>`, Этап 1); `TradeTape` — первый
потребитель, мигрировавший на неё (Этап 2).

`TradeTape.create()` и раньше бросал `RangeError` на той же проверке, что уже
`Result`-based `RollingWindow.create()` — прямая подстановка без изменения семантики
валидации. По ADR (`docs/architecture/boundary-contract.md`, Решение 2) throw легитимен
только внутри `value-objects`; `trade-tape` им не является.

Что изменилось для потребителей:

- `TradeTape.create(policy, clock)` теперь возвращает `Result<TradeTape, ValidationError>`
  вместо throw.
- `evictBefore(cutoffMs)` **удалён полностью** — 0 реальных вызывающих в репозитории
  (только собственный TSDoc-пример и упоминание в докблоке `OrderBookHistory`). Мёртвый
  публичный API не сохраняется ради обратной совместимости, которой не от кого сохранять.
- `getLatest()` и `getLast(n)` — новые публичные методы. Оба уже существовали в
  `RollingWindow` и достаются бесплатно через делегирование — не прятать без причины.
- Внутреннее поле временной метки (`record.timestamp.toNumber()`) больше не вычисляется
  вручную в 4 местах `TradeTape.ts` — единственная точка теперь `getTimestampMs` в вызове
  `RollingWindow.create()`.

`TradeTapeCollector` (`application/market-state/src/TradeTapeCollector.ts`) — единственный
реальный вызывающий `TradeTape.create()` в проде (лениво, при первом трейде инструмента).
Конструктор коллектора теперь **сам** вызывает `TradeTape.create(_config, _deps.clock)` и
бросает `RangeError` при невалидном конфиге — то есть невалидная политика хранения падает
при старте приложения, а не молча проходит и падает только на первом живом трейде (был
разрыв: раньше конструктор проверял лишь "оба поля не заданы", а диапазоны `maxCount`/
`maxAgeMs` проверялись только внутри лениво вызываемого `TradeTape.create()`). Тот же
"surface at construction" паттерн применён к `BookDepthCollector` (Этап 2, п.1) —
согласованность между двумя структурно похожими коллекторами.

### `TradeFlowMetrics` — VO-поля вместо `Decimal` (Этап 2)

Публичная граница `TradeFlowCalculator.compute()` типизирована через VO
(`Quantity`/`Ratio`/`Price`/`Money`) — по ADR (Решение 1) `Decimal` легитимен только
внутри `value-objects`/`math`, не на публичных сигнатурах остальных пакетов.

| Поле | Было | Стало |
|---|---|---|
| `buyVolume`/`sellVolume`/`totalVolume` | `Decimal` | `Quantity` |
| `orderFlowImbalance` | `Decimal` | `Ratio` (допускает отрицательные значения без нижней границы — подходит без изменений) |
| `vwap` | `Decimal \| undefined` | `Price \| undefined` |
| `totalNotional` | `Decimal` | `Money` (валюта `'USDC'` — все рынки Polymarket USDC-settled) |
| `tradeCount` | `number` | `number` (не менялось — целый счётчик, VO не нужен) |

Единственный внешний потребитель — `apps/bot/src/strategies/PairedCexCrowdStrategy.ts` —
потребовал одной правки: `metrics.vwap.mul(100).toNumber()` → `metrics.vwap.value().mul(100).toNumber()`
(у `Price` нет `.mul()`, нужно сначала распаковать `.value(): Decimal`). Остальные поля не
потребовали правок на вызывающей стороне — `Quantity`/`Ratio`/`Money` core-классы
зеркалируют `.toNumber()`/`.isZero()` API самого `Decimal` напрямую.

**Внутренняя реализация `TradeFlowCalculator.compute()` намеренно осталась на голом
`Decimal`** (накопление `buyVolume`/`totalNotional`/... через `addDecimal`/`divideDecimal`
из `@polymarket/math`) — правило ADR про запрет `Decimal` на границе применяется к тому,
что пересекает публичную сигнатуру (уже полностью VO-типизирована), не к внутренней
реализации. Прямой прецедент того же рода решения — `PlaceOrderUseCase.ts:1372`
(`price.value().times(size.value())`), оставленный как есть до отдельного
`OrderNotional`-хелпера в Этапе 7 даже в commit-critical коде исполнения ордеров.

## Публичный API

```typescript
import { TradeTape } from '@polymarket/trade-tape';
import { LiveClock } from '@polymarket/time';

const clock = new LiveClock();
const result = TradeTape.create({ maxCount: 1000, maxAgeMs: 300_000 }, clock);
if (!result.ok) {
  throw result.error; // ValidationError
}
const tape = result.value;

tape.append({ price, size, side: 'BUY', timestamp });

tape.getAll();                    // readonly TapeRecord[] — все записи
tape.getLatest();                 // TapeRecord | undefined — самая новая
tape.getLast(10);                 // readonly TapeRecord[] — последние 10
tape.getWindow(fromMs, toMs);     // readonly TapeRecord[] — записи в [fromMs, toMs]
tape.getRecent(60_000);           // readonly TapeRecord[] — записи за последние 60с
tape.size();                      // number
tape.isEmpty();                   // boolean
```

`TradeFlowCalculator` — stateless, единственный статический метод:

```typescript
import { TradeFlowCalculator } from '@polymarket/trade-tape';

const metrics = TradeFlowCalculator.compute(tape.getRecent(60_000));

metrics.buyVolume.toNumber();          // Quantity
metrics.sellVolume.toNumber();         // Quantity
metrics.totalVolume.toNumber();        // Quantity
metrics.orderFlowImbalance.toNumber(); // Ratio, [-1, +1]
metrics.vwap?.toNumber();              // Price | undefined
metrics.totalNotional.toNumber();      // Money (USDC)
metrics.tradeCount;                    // number
```

Для пустого входа (`compute([])`) — все VO нулевые (`.isZero() === true`), `vwap`
`undefined`, `tradeCount === 0`.

## Пример кода (актуальный!)

```typescript
import { TradeTape, TradeFlowCalculator } from '@polymarket/trade-tape';
import { LiveClock } from '@polymarket/time';

const clock = new LiveClock();
const tapeResult = TradeTape.create({ maxCount: 5000, maxAgeMs: 600_000 }, clock);
if (!tapeResult.ok) {
  throw tapeResult.error;
}
const tape = tapeResult.value;

// На каждый входящий трейд из WS-потока:
tape.append({ price, size, side, timestamp });

// В стратегии — метрики за последнюю минуту:
const recent = tape.getRecent(60_000);
const metrics = TradeFlowCalculator.compute(recent);

if (metrics.orderFlowImbalance.toNumber() > 0.3) {
  // сильное давление покупателей
  const vwapNum = metrics.vwap?.toNumber();
}
```

## Зависимости

- `@polymarket/rolling-window` — retention buffer, на котором построен `TradeTape`
- `@polymarket/result`, `@polymarket/errors` — `Result`/`ValidationError` для `create()`
- `@polymarket/value-objects` — `Price`/`Quantity`/`Ratio`/`Money`/`Timestamp`/`Side`
- `@polymarket/time` — `IClock`
- `@polymarket/math` — `addDecimal`/`subtractDecimal`/`divideDecimal`/`isZeroDecimal`
  (внутренняя реализация `TradeFlowCalculator.compute()`)
- `@polymarket/ids` — объявлена, но не используется в текущей публичной поверхности пакета
