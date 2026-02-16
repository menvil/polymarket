# Quote Value Object

## Обзор

**Quote** — value object для представления котировок маркет-мейкера (bid/ask с размерами и временной меткой).

### Ключевые особенности

- ✅ **Immutable** — все экземпляры неизменяемы
- ✅ **Type-safe** — полная типизация через TypeScript
- ✅ **Throws+Facade Architecture** — Core бросает исключения, Facade возвращает Result
- ✅ **"Never Throw" Contract** — QuoteService гарантированно не бросает исключения
- ✅ **Централизованная обработка ошибок** — через errorUtils (toDecimal, wrapOp, rewrap)
- ✅ **Automatic operation tracing** — opChain для отслеживания цепочек операций
- ✅ **Typed error reasons** — QuoteErrorReason enum (12 значений)
- ✅ **Rich domain logic** — методы вычисления spread, mid price, проверки crossing
- ✅ **Comprehensive tests** — 216 тестов (100% покрытие)

## Быстрый старт

### Установка

```bash
npm install @polymarket/value-objects
```

### Базовое использование

```typescript
import { QuoteService, QuoteFormatter } from '@polymarket/value-objects/quote';

// Создание двусторонней котировки
const result = QuoteService.create(
  0.48,  // bid
  0.52,  // ask
  100,   // bidSize
  150    // askSize
);

if (!result.ok) {
  console.error(result.error.message);
  return;
}

const quote = result.value;

// Вычисления
console.log(quote.spreadWidth());      // Decimal(0.04)
console.log(quote.spreadPercentage()); // Decimal(8.0)
console.log(quote.midPrice());         // Price(0.50)

// Форматирование
console.log(QuoteFormatter.toDisplay(quote));
// "0.4800 @ 100.00 / 0.5200 @ 150.00"

console.log(QuoteFormatter.toShort(quote));
// "0.4800/0.5200"
```

## Архитектура

Quote следует **Throws+Facade** паттерну:

```text
┌─────────────────────────────────────────────────────────────┐
│                       Public API                            │
│                    (Never Throw)                            │
├─────────────────────────────────────────────────────────────┤
│  QuoteService (Facade Layer)                                │
│  - create(), bidOnly(), askOnly()                           │
│  - shift(), skew(), updateSizes()                           │
│  - Result<Quote, InvalidQuoteError>                         │
├─────────────────────────────────────────────────────────────┤
│  Quote (Core Layer)                                         │
│  - of() → throws QuoteInvariantViolation                    │
│  - bid(), ask(), spreadWidth(), midPrice()                  │
│  - Immutable, private constructor                           │
├─────────────────────────────────────────────────────────────┤
│  Rules Layer                                                │
│  - ValidateQuoteSizes, ValidateMinSpread                    │
│  - ValidateMaxSpread, ValidateMarketCrossing                │
│  - ValidateAge (с IClock для проверки свежести)             │
│  - Result<void, InvalidQuoteError>                          │
├─────────────────────────────────────────────────────────────┤
│  Adapters Layer                                             │
│  - QuoteSerializer (JSON сериализация)                      │
│  - QuoteFormatter (форматирование)                          │
└─────────────────────────────────────────────────────────────┘
```

### Слои

1. **Core Layer** (`src/quote/core/`)
   - `Quote.ts` — основной value object
   - `QuoteInvariantViolation.ts` — исключение при нарушении инвариантов
   - Методы: `of()`, `bid()`, `ask()`, `spreadWidth()`, `midPrice()`, etc.

2. **Facade Layer** (`src/quote/facade/`)
   - `QuoteService.ts` — публичный API с Result
   - Использует errorUtils: `toDecimal()`, `wrapOp()`, `rewrap()`
   - Методы: `create()`, `bidOnly()`, `askOnly()`, `shift()`, `skew()`, etc.

3. **Rules Layer** (`src/quote/rules/`)
   - `ValidateQuoteSizes.ts` — проверка размеров
   - `ValidateMinSpread.ts` — проверка минимального spread
   - `ValidateMaxSpread.ts` — проверка максимального spread
   - `ValidateMarketCrossing.ts` — проверка пересечения с orderbook
   - `ValidateAge.ts` — проверка свежести котировки (с IClock)

4. **Adapters Layer** (`src/quote/adapters/`)
   - `QuoteSerializer.ts` — JSON сериализация/десериализация
   - `QuoteFormatter.ts` — форматирование для отображения

5. **Errors** (`src/quote/errors/`)
   - `QuoteErrorReason.ts` — enum с типизированными причинами ошибок

## API Reference

### QuoteService (Facade)

#### `create()`

Создаёт Quote из number/Decimal/string значений.

```typescript
const result = QuoteService.create(
  bidValue: Decimal | number | string | null,
  askValue: Decimal | number | string | null,
  bidSizeValue: Decimal | number | string,
  askSizeValue: Decimal | number | string,
  sourceId: MarketDataSourceId,
  instrumentId: InstrumentId,
  timestamp?: Date | Decimal | number | string
): Result<Quote, InvalidQuoteError>
```

**Пример:**

```typescript
import { KnownMarketDataSources, asInstrumentId } from '@polymarket/ids';

const result = QuoteService.create(
  0.48,                                      // bid price
  0.52,                                      // ask price
  100,                                       // bid size
  150,                                       // ask size
  KnownMarketDataSources.POLYMARKET_WS,      // source
  asInstrumentId('ETH-USD')!,                // instrument
  Date.now()                                 // timestamp (optional)
);
if (result.ok) {
  const quote = result.value;
}
```

#### `bidOnly()`

Создаёт bid-only котировку.

```typescript
const result = QuoteService.bidOnly(
  bidValue: number | Decimal,
  bidSizeValue: number | Decimal,
  timestamp?: Date | number
): Result<Quote, InvalidQuoteError>
```

**Пример:**

```typescript
const result = QuoteService.bidOnly(0.50, 100);
if (result.ok) {
  console.log(result.value.hasBid());  // true
  console.log(result.value.hasAsk());  // false
}
```

#### `askOnly()`

Создаёт ask-only котировку.

```typescript
const result = QuoteService.askOnly(
  askValue: number | Decimal,
  askSizeValue: number | Decimal,
  timestamp?: Date | number
): Result<Quote, InvalidQuoteError>
```

#### `shift()`

Сдвигает котировку на указанную дельту (сохраняет spread).

```typescript
const result = QuoteService.shift(
  quote: Quote,
  delta: Decimal
): Result<Quote, InvalidQuoteError>
```

**Пример:**

```typescript
const quoteResult = QuoteService.create(0.48, 0.52, 100, 150);
if (!quoteResult.ok) return;

// Сдвиг вверх на 0.01
const shiftResult = QuoteService.shift(quoteResult.value, new Decimal(0.01));
if (shiftResult.ok) {
  // bid: 0.49, ask: 0.53, spread остался 0.04
}
```

#### `skew()`

Независимо сдвигает bid и ask.

```typescript
const result = QuoteService.skew(
  quote: Quote,
  bidDelta: Decimal,
  askDelta: Decimal
): Result<Quote, InvalidQuoteError>
```

**Пример:**

```typescript
const quoteResult = QuoteService.create(0.48, 0.52, 100, 150);
if (!quoteResult.ok) return;

// Bid вниз на 0.01, ask вверх на 0.01
const skewResult = QuoteService.skew(
  quoteResult.value,
  new Decimal(-0.01),
  new Decimal(0.01)
);
if (skewResult.ok) {
  // bid: 0.47, ask: 0.53, spread увеличился до 0.06
}
```

#### `updateSizes()`

Обновляет размеры котировки (preserves timestamp).

```typescript
const result = QuoteService.updateSizes(
  quote: Quote,
  newBidSize: Decimal | number | string | Quantity,
  newAskSize: Decimal | number | string | Quantity
): Result<Quote, InvalidQuoteError>
```

### Timestamp Preservation & IClock

Все методы трансформации (`shift`, `skew`, `updateSizes`) **сохраняют timestamp** исходной котировки. Для обновления timestamp используйте варианты с суффиксом `WithRefresh`:

#### `shiftWithRefresh()`

Сдвигает котировку и обновляет timestamp через IClock.

```typescript
import { LiveClock } from '@polymarket/time';

const clock = new LiveClock();
const result = QuoteService.shiftWithRefresh(
  quote: Quote,
  delta: Decimal,
  clock: IClock
): Result<Quote, InvalidQuoteError>
```

**Пример:**

```typescript
import { LiveClock } from '@polymarket/time';

const clock = new LiveClock();
const result = QuoteService.shiftWithRefresh(quote, new Decimal(0.01), clock);
// Новая котировка с обновлённым timestamp
```

#### `skewWithRefresh()`

Независимо сдвигает bid и ask, обновляя timestamp.

```typescript
const result = QuoteService.skewWithRefresh(
  quote: Quote,
  bidDelta: Decimal,
  askDelta: Decimal,
  clock: IClock
): Result<Quote, InvalidQuoteError>
```

#### `updateSizesWithRefresh()`

Обновляет размеры и timestamp.

```typescript
const result = QuoteService.updateSizesWithRefresh(
  quote: Quote,
  newBidSize: Decimal | number | string | Quantity,
  newAskSize: Decimal | number | string | Quantity,
  clock: IClock
): Result<Quote, InvalidQuoteError>
```

**IClock Benefits:**

- **Production**: `LiveClock` для реального времени
- **Testing**: `PaperClock` для deterministic testing
- **Replay**: `ReplayClock` для исторических данных

**Пример в тестах:**

```typescript
import { PaperClock } from '@polymarket/time';

const clock = new PaperClock(new Date('2024-01-01T12:00:00Z'));
const result = QuoteService.shiftWithRefresh(quote, delta, clock);

// Контролируемое время для тестов
clock.tick(5000); // +5 секунд
```

#### `getSpreadOrZero()`

Возвращает spread или 0 для one-sided котировок.

```typescript
const spread: Decimal = QuoteService.getSpreadOrZero(quote);
```

#### `getMidOrNull()`

Возвращает mid price или null для one-sided котировок.

```typescript
const mid: Price | null = QuoteService.getMidOrNull(quote);
```

### Quote (Core)

#### Создание

```typescript
// ⚠️ Может бросать QuoteInvariantViolation!
const quote = Quote.of(
  bid: Price | null,
  ask: Price | null,
  bidSize: Quantity,
  askSize: Quantity,
  timestamp: Date | number
);
```

**Рекомендуется использовать `QuoteService.create()` вместо прямого создания!**

#### Геттеры

```typescript
quote.bid(): Price | null
quote.ask(): Price | null
quote.bidSize(): Quantity
quote.askSize(): Quantity
quote.timestampMs(): number
quote.getTimestamp(): Date
```

#### Проверки

```typescript
quote.isTwoSided(): boolean  // Есть и bid, и ask
quote.hasBid(): boolean      // Есть bid
quote.hasAsk(): boolean      // Есть ask
```

#### Вычисления

```typescript
// Spread между bid и ask
quote.spreadWidth(): Decimal | null  // null для one-sided

// Spread в процентах
quote.spreadPercentage(): Decimal | null  // null для one-sided

// Средняя цена
quote.mid(): Decimal | null  // null для one-sided
```

#### Сравнение

```typescript
// Сравнивает рыночные данные БЕЗ timestamp
quote.equals(other: Quote): boolean

// Строгое сравнение включая timestamp
quote.equalsWithTimestamp(other: Quote): boolean
```

### QuoteSerializer

#### `toJSON()`

```typescript
const json: QuoteJson = QuoteSerializer.toJSON(quote);
// {
//   bid: 0.48,
//   ask: 0.52,
//   bidSize: 100,
//   askSize: 150,
//   timestamp: 1234567890000
// }
```

#### `fromJSON()`

```typescript
const result = QuoteSerializer.fromJSON(json);
if (result.ok) {
  const quote = result.value;
}
```

#### `toString()`

```typescript
const jsonString = QuoteSerializer.toString(quote);
// '{"bid":0.48,"ask":0.52,"bidSize":100,"askSize":150,"timestamp":1234567890000}'
```

#### `parse()`

```typescript
const result = QuoteSerializer.parse(jsonString);
if (result.ok) {
  const quote = result.value;
}
```

### QuoteFormatter

#### `toDisplay()`

Формат: "bid @ size / ask @ size"

```typescript
QuoteFormatter.toDisplay(quote);
// "0.4800 @ 100.00 / 0.5200 @ 150.00"

QuoteFormatter.toDisplay(quote, {
  priceDecimals: 2,
  sizeDecimals: 0,
  includeTimestamp: true
});
// "0.48 @ 100 / 0.52 @ 150 [2024-01-15T12:30:00.000Z]"
```

#### `toShort()`

Формат: "bid/ask"

```typescript
QuoteFormatter.toShort(quote);
// "0.4800/0.5200"

QuoteFormatter.toShort(quote, 2);
// "0.48/0.52"
```

#### `toDetailed()`

Подробный формат с spread и mid.

```typescript
QuoteFormatter.toDetailed(quote);
// "Bid: 0.4800 @ 100.00, Ask: 0.5200 @ 150.00, Spread: 0.0400 (8.00%), Mid: 0.5000"

QuoteFormatter.toDetailed(quote, {
  includeSpread: false,
  includeMid: true
});
// "Bid: 0.4800 @ 100.00, Ask: 0.5200 @ 150.00, Mid: 0.5000"
```

#### `toTable()`

Табличный формат для консоли.

```typescript
console.log(QuoteFormatter.toTable(quote));
// Side   Price    Size
// ────────────────────────────────────────
// Bid    0.4800   100.00
// Ask    0.5200   150.00
// ────────────────────────────────────────
// Spread 0.0400   (8.00%)
// Mid    0.5000
```

#### `formatSpread()`

```typescript
QuoteFormatter.formatSpread(quote);
// "0.0400 (8.00%)"

QuoteFormatter.formatSpread(quote, false);
// "0.0400"
```

#### `formatMid()`

```typescript
QuoteFormatter.formatMid(quote);
// "0.5000"

QuoteFormatter.formatMid(quote, 2);
// "0.50"
```

#### `formatCompact()`

Компактный формат для логов и UI с ограниченным пространством.

```typescript
QuoteFormatter.formatCompact(quote);
// "0.48/0.52 @100×150"

QuoteFormatter.formatCompact(quote, 4, 2);
// "0.4800/0.5200 @100.00×150.00"
```

**Формат**: `bid/ask @bidSize×askSize`

- Цены разделены "/"
- Размеры показаны после "@" и разделены "×"
- Для one-sided котировок используется "--"
- По умолчанию: 2 десятичных знака для цен, 0 для размеров

#### `formatWithSpread()`

Формат с информацией о spread для быстрой оценки качества котировки.

```typescript
QuoteFormatter.formatWithSpread(quote);
// "0.48-0.52 (400bp, mid=0.50)"

QuoteFormatter.formatWithSpread(quote, 4);
// "0.4800-0.5200 (400bp, mid=0.5000)"
```

**Формат для two-sided**: `bid-ask (spreadBps, mid=midPrice)`

- Цены разделены "-"
- Spread показан в basis points (1bp = 0.01%)
- Mid price показан после "mid="
- Для one-sided: "0.50 (bid only)" или "0.52 (ask only)"

## Validation Rules

### ValidateQuoteSizes

Проверяет, что размеры положительные когда есть цены.

```typescript
const result = ValidateQuoteSizes.check(bid, bidSize, ask, askSize);
if (!result.ok) {
  console.error(result.error.context?.reason);
  // QuoteErrorReason.BID_SIZE_MUST_BE_POSITIVE
  // QuoteErrorReason.ASK_SIZE_MUST_BE_POSITIVE
}
```

### ValidateMinSpread

Проверяет минимальный spread.

```typescript
const result = ValidateMinSpread.check(spread, minSpread);
if (!result.ok) {
  console.error(result.error.context?.reason);
  // QuoteErrorReason.SPREAD_TOO_NARROW
}
```

### ValidateMaxSpread

Проверяет максимальный spread.

```typescript
const result = ValidateMaxSpread.check(spread, maxSpread);
if (!result.ok) {
  console.error(result.error.context?.reason);
  // QuoteErrorReason.SPREAD_TOO_WIDE
}
```

### ValidateMarketCrossing

Проверяет, что котировка не пересекает orderbook.

```typescript
const result = ValidateMarketCrossing.check(
  quoteBid, quoteAsk,
  orderbookBid, orderbookAsk
);
if (!result.ok) {
  console.error(result.error.context?.reason);
  // QuoteErrorReason.MARKET_CROSSING
  console.error(result.error.context?.side);  // 'bid' | 'ask'
}
```

### ValidateAge

Проверяет свежесть котировки через IClock.

```typescript
import { LiveClock } from '@polymarket/time';

const clock = new LiveClock();
const maxAgeMs = 5000; // 5 секунд

const result = ValidateAge.check(quote, maxAgeMs, clock);
if (!result.ok) {
  console.error(result.error.context?.reason);
  // QuoteErrorReason.QUOTE_TOO_OLD
  console.error(result.error.context?.ageMs);      // Фактический возраст
  console.error(result.error.context?.maxAgeMs);   // Максимальный возраст
}
```

**IClock для тестирования:**

```typescript
import { PaperClock } from '@polymarket/time';

const clock = new PaperClock(new Date('2024-01-01T12:00:00Z'));
const quote = QuoteService.create(0.48, 0.52, 100, 150).value;

// Перематываем время на 10 секунд вперёд
clock.tick(10000);

const result = ValidateAge.check(quote, 5000, clock);
// result.ok === false (возраст 10s > maxAge 5s)
```

**Use cases:**

- Проверка актуальности котировки перед отправкой в orderbook
- Фильтрация устаревших котировок из кэша
- Мониторинг задержек в получении данных

## Error Handling

Quote использует типизированные ошибки через `QuoteErrorReason`:

```typescript
enum QuoteErrorReason {
  BOTH_SIDES_NULL = 'BOTH_SIDES_NULL',
  BID_GREATER_THAN_ASK = 'BID_GREATER_THAN_ASK',
  INVALID_FORMAT = 'INVALID_FORMAT',
  INVALID_BID = 'INVALID_BID',
  INVALID_ASK = 'INVALID_ASK',
  INVALID_BID_SIZE = 'INVALID_BID_SIZE',
  INVALID_ASK_SIZE = 'INVALID_ASK_SIZE',
  BID_SIZE_MUST_BE_POSITIVE = 'BID_SIZE_MUST_BE_POSITIVE',
  ASK_SIZE_MUST_BE_POSITIVE = 'ASK_SIZE_MUST_BE_POSITIVE',
  SPREAD_TOO_NARROW = 'SPREAD_TOO_NARROW',
  SPREAD_TOO_WIDE = 'SPREAD_TOO_WIDE',
  MARKET_CROSSING = 'MARKET_CROSSING',
  QUOTE_TOO_OLD = 'QUOTE_TOO_OLD'
}
```

### Обработка ошибок

```typescript
const result = QuoteService.create(0.48, 0.52, 100, 150);

if (!result.ok) {
  const error = result.error;

  switch (error.context?.reason) {
    case QuoteErrorReason.BOTH_SIDES_NULL:
      console.error('Котировка должна иметь хотя бы одну сторону');
      break;

    case QuoteErrorReason.BID_GREATER_THAN_ASK:
      console.error('Bid не может быть больше ask');
      console.error('Bid:', error.context?.bidValue);
      console.error('Ask:', error.context?.askValue);
      break;

    case QuoteErrorReason.INVALID_FORMAT:
      console.error('Ошибка парсинга:', error.context?.raw);
      break;

    case QuoteErrorReason.MARKET_CROSSING:
      console.error('Котировка пересекает рынок');
      console.error('Сторона:', error.context?.side);
      break;

    default:
      console.error('Неизвестная ошибка:', error.message);
  }
}
```

### Operation Chain

Все операции автоматически отслеживаются через `opChain`:

```typescript
const result = QuoteService.shift(quote, new Decimal(0.10));

if (!result.ok) {
  // Можно увидеть всю цепочку операций
  console.error(result.error.context?.opChain);
  // ['shift', 'createFromDecimals', 'create:bid']

  console.error(result.error.context?.op);
  // 'shift'
}
```

## Примеры использования

### Создание котировок

```typescript
// Двусторонняя котировка
const twoSided = QuoteService.create(0.48, 0.52, 100, 150);

// Bid-only
const bidOnly = QuoteService.bidOnly(0.50, 100);

// Ask-only
const askOnly = QuoteService.askOnly(0.51, 200);

// С кастомным timestamp
const withTimestamp = QuoteService.create(
  0.48, 0.52, 100, 150,
  new Date('2024-01-15T12:30:00Z')
);
```

### Операции с котировками

```typescript
const quoteResult = QuoteService.create(0.48, 0.52, 100, 150);
if (!quoteResult.ok) return;

const quote = quoteResult.value;

// Сдвиг котировки
const shifted = QuoteService.shift(quote, new Decimal(0.01));

// Skew котировки
const skewed = QuoteService.skew(
  quote,
  new Decimal(-0.01),  // bid вниз
  new Decimal(0.01)    // ask вверх
);

// Обновление размеров
const withNewSizes = QuoteService.updateSizes(quote, 200, 300);
```

### Вычисления

```typescript
const quote = quoteResult.value;

// Spread
const spreadWidth = quote.spreadWidth();
console.log(spreadWidth?.toNumber());  // 0.04

const spreadPct = quote.spreadPercentage();
console.log(spreadPct?.toNumber());    // 8.0

// Mid price
const mid = quote.midPrice();
console.log(mid?.value().toNumber());  // 0.50

// Проверка crossing (через Rules layer)
import { ValidateMarketCrossing } from '@polymarket/value-objects/quote';

const crosses = ValidateMarketCrossing.crossesMarket(
  quote,
  Price.of(0.50),  // orderbook bid
  Price.of(0.51)   // orderbook ask
);
console.log(crosses);  // false
```

### Форматирование

```typescript
const quote = quoteResult.value;

// Различные форматы
console.log(QuoteFormatter.toDisplay(quote));
// "0.4800 @ 100.00 / 0.5200 @ 150.00"

console.log(QuoteFormatter.toShort(quote));
// "0.4800/0.5200"

console.log(QuoteFormatter.toDetailed(quote));
// "Bid: 0.4800 @ 100.00, Ask: 0.5200 @ 150.00, Spread: 0.0400 (8.00%), Mid: 0.5000"

console.log(QuoteFormatter.toTable(quote));
// Side   Price    Size
// ────────────────────────────────────────
// Bid    0.4800   100.00
// Ask    0.5200   150.00
// ────────────────────────────────────────
// Spread 0.0400   (8.00%)
// Mid    0.5000
```

### Сериализация

```typescript
const quote = quoteResult.value;

// В JSON
const json = QuoteSerializer.toJSON(quote);
console.log(json);
// {
//   bid: 0.48,
//   ask: 0.52,
//   bidSize: 100,
//   askSize: 150,
//   timestamp: 1234567890000
// }

// В строку
const jsonString = QuoteSerializer.toString(quote);

// Обратно в Quote
const parsed = QuoteSerializer.parse(jsonString);
if (parsed.ok) {
  // equals() сравнивает только рыночные данные (без timestamp)
  console.log(quote.equals(parsed.value));  // true

  // equalsWithTimestamp() проверяет полную идентичность
  console.log(quote.equalsWithTimestamp(parsed.value));  // true (timestamp тоже сохранён)
}
```

### Валидация

```typescript
import {
  ValidateQuoteSizes,
  ValidateMinSpread,
  ValidateMaxSpread,
  ValidateMarketCrossing
} from '@polymarket/value-objects/quote';

const quote = quoteResult.value;

// Проверка размеров
const sizesResult = ValidateQuoteSizes.check(
  quote.bid(),
  quote.bidSize(),
  quote.ask(),
  quote.askSize()
);

if (!sizesResult.ok) {
  console.error('Invalid sizes:', sizesResult.error.message);
}

// Проверка минимального spread
const minSpreadResult = ValidateMinSpread.check(
  quote.spreadWidth()!,
  new Decimal(0.01)  // минимум 1%
);

// Проверка максимального spread
const maxSpreadResult = ValidateMaxSpread.check(
  quote.spreadWidth()!,
  new Decimal(0.10)  // максимум 10%
);

// Проверка crossing
const crossingResult = ValidateMarketCrossing.check(
  quote.bid(),
  quote.ask(),
  Price.of(0.50),  // orderbook bid
  Price.of(0.51)   // orderbook ask
);

if (!crossingResult.ok) {
  console.error('Market crossing detected!');
  console.error('Side:', crossingResult.error.context?.side);
}
```

## Testing

Quote имеет 154 теста с полным покрытием:

```bash
npm test -- quote
```

Результаты:

- ✅ Quote.test.ts: 37 тестов (Core)
- ✅ ValidateQuoteSizes.test.ts: 7 тестов
- ✅ ValidateMinSpread.test.ts: 4 теста
- ✅ ValidateMaxSpread.test.ts: 4 теста
- ✅ ValidateMarketCrossing.test.ts: 11 тестов
- ✅ QuoteService.test.ts: 42 теста (Facade)
- ✅ QuoteSerializer.test.ts: 27 тестов (Adapters)
- ✅ QuoteFormatter.test.ts: 22 теста (Adapters)

## Best Practices

### ✅ DO

```typescript
// Используйте QuoteService для создания
const result = QuoteService.create(0.48, 0.52, 100, 150);
if (!result.ok) {
  // Обработка ошибки
  return;
}

// Проверяйте типы ошибок
if (result.error.context?.reason === QuoteErrorReason.BID_GREATER_THAN_ASK) {
  // Специфичная обработка
}

// Используйте форматтеры для отображения
console.log(QuoteFormatter.toDisplay(result.value));
```

### ❌ DON'T

```typescript
// Не создавайте Quote напрямую без try-catch
const quote = Quote.of(bid, ask, bidSize, askSize, timestamp);  // Может бросить!

// Не игнорируйте Result
const result = QuoteService.create(0.48, 0.52, 100, 150);
const quote = result.value;  // ❌ TypeError если result.ok === false!

// Не форматируйте вручную
console.log(`${quote.bid()?.value()}/${quote.ask()?.value()}`);  // ❌
```

## См. также

- [Architecture Guide](./architecture.md) — подробное описание архитектуры
- [Examples](./examples.md) — больше примеров использования
- [Facade Pattern](./facade.md) — детали Facade Layer
- [Error Handling](./error-handling.md) — стратегии обработки ошибок

## Changelog

### v0.1.0 (2024-01-15)

- ✅ Начальная реализация Quote value object
- ✅ Throws+Facade архитектура
- ✅ Интеграция с errorUtils (toDecimal, wrapOp, rewrap)
- ✅ QuoteErrorReason enum (12 значений)
- ✅ 4 валидационных правила
- ✅ QuoteSerializer и QuoteFormatter
- ✅ 154 теста с полным покрытием
