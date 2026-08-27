# AssetPrice Value Object

**AssetPrice** — цена ВНЕШНЕГО актива (`BTC/USD`, `ETH/USD`, ...) с
произвольной положительной точностью.

## Почему это сделано так

### Проблема

`Price` — цена outcome-токена рынка предсказаний, и её инвариант — жёсткий
диапазон `[0.0001, 0.9999]`:

```typescript
PriceService.create('0.42');      // ok — 42% вероятности
PriceService.create('79341.36');  // Err — OUT_OF_RANGE_HIGH
```

Это правильный инвариант: цена outcome-токена вне `0..1` бессмысленна. Но
Polymarket RTDS (а завтра — и CEX-фиды) присылает цены базовых активов:

```text
btcusdt   79341.36626633028
btc/usd   79338.5
eth/usd    3021.5
```

Пропустить их через `Price` НЕЛЬЗЯ — конструктор обязан их отвергнуть. Это не
неудобство, а два разных домена, случайно использующих слово «цена».

### Решение

Минимальный source-agnostic VO: **положительный `Decimal` без верхней
границы**.

Что в нём НАМЕРЕННО отсутствует:

- источник (Binance/Chainlink/биржа) — это провенанс НАБЛЮДЕНИЯ, а не свойство
  числа; он живёт в событии `REFERENCE_PRICE_UPDATED`;
- валюта котировки — RTDS/CEX котируют пару своим символом, символ хранится
  рядом с наблюдением;
- окно усреднения — свойство ПОТОКА, не значения.

Благодаря этому тот же VO переиспользует будущий CEX Semantic Adapter: заводить
`PolymarketReferencePrice` в Domain было бы прямой ошибкой слоя.

## Инварианты

| Инвариант | Причина |
| --- | --- |
| не `NaN` | значение обязано быть числом |
| конечное | `Infinity` не цена |
| строго `> 0` | цена актива существует только положительной |

Верхней границы **нет** — это и есть ключевое отличие от `Price`.

## Архитектура

Та же двухслойная схема, что у остальных VO пакета:

```text
Core    AssetPrice.of(Decimal)      → БРОСАЕТ AssetPriceInvariantViolation
Facade  AssetPriceService.create()  → возвращает Result, НИКОГДА не бросает
```

Класс нарушения инвариантов несёт стабильный маркер
`kind = 'INVARIANT_VIOLATION'` — по нему `wrapOp` распознаёт его и сохраняет
типизированную `reason` в `InvalidAssetPriceError.context.reason`.

## Использование

```typescript
import { AssetPriceService } from '@polymarket/value-objects';

const result = AssetPriceService.create('79341.36626633028');

if (result.ok) {
  console.log(result.value.value().toString()); // "79341.36626633028"
} else {
  console.error(result.error.context?.['reason']); // NOT_POSITIVE | NAN | ...
}
```

## Точность

Десятичная строка источника парсится НАПРЯМУЮ в `Decimal`:

```typescript
const raw = '78376.356031481042173952';

const result = AssetPriceService.create(raw);
if (result.ok) {
  result.value.value().toString(); // ровно raw
}
String(Number(raw));               // уже НЕ raw
```

Поэтому semantic-адаптеры обязаны передавать сюда исходную строку vendor-а, а
не результат `Number(...)` / `parseFloat(...)`.

## Причины ошибок

```typescript
enum AssetPriceErrorReason {
  NAN,            // значение NaN
  NON_FINITE,     // Infinity / -Infinity
  NOT_POSITIVE,   // <= 0
  INVALID_FORMAT, // строка не парсится
}
```

## Связанные контракты

- `REFERENCE_PRICE_UPDATED` (`@polymarket/application-events`) — наблюдение
  референсной цены с провенансом и видом потока (`SPOT` / `TWAP(window)`);
- `PolymarketSemanticAdapter`
  (`@polymarket/polymarket-semantic-adapter`) — первый производитель таких
  наблюдений.
