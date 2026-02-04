# Quote Architecture

## Обзор архитектуры

Quote value object построен по паттерну **Throws+Facade** с централизованной обработкой ошибок через **errorUtils**.

## Архитектурные слои

```
┌─────────────────────────────────────────────────────────────────┐
│                         PUBLIC API                              │
│                  ("Never Throw" Contract)                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Adapters Layer (src/quote/adapters/)                           │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │  QuoteSerializer - JSON serialization/deserialization     │ │
│  │  QuoteFormatter - display formatting                      │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Facade Layer (src/quote/facade/)                               │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │  QuoteService - Result API                                │ │
│  │  - create(), bidOnly(), askOnly()                         │ │
│  │  - shift(), skew(), updateSizes()                         │ │
│  │  - getSpreadOrZero(), getMidOrNull()                      │ │
│  │  ───────────────────────────────────────────────────────  │ │
│  │  Uses errorUtils:                                         │ │
│  │  - toDecimal() - парсинг с валидацией                     │ │
│  │  - wrapOp() - автоматический opChain                      │ │
│  │  - rewrap() - сохранение root cause                       │ │
│  │  - unexpectedError() - обработка неожиданных ошибок       │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Rules Layer (src/quote/rules/)                                 │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │  ValidateQuoteSizes - размеры должны быть > 0             │ │
│  │  ValidateMinSpread - spread >= minSpread                  │ │
│  │  ValidateMaxSpread - spread <= maxSpread                  │ │
│  │  ValidateMarketCrossing - проверка crossing               │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Core Layer (src/quote/core/)                                   │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │  Quote - immutable value object                           │ │
│  │  - of() → throws QuoteInvariantViolation                  │ │
│  │  - bid(), ask(), bidSize(), askSize()                     │ │
│  │  - spreadWidth(), midPrice()                              │ │
│  │  - Инварианты:                                            │ │
│  │    * Хотя бы одна сторона определена                      │ │
│  │    * bid <= ask (для two-sided)                           │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Errors (src/quote/errors/)                                     │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │  QuoteErrorReason - typed enum (12 values)                │ │
│  │  - BOTH_SIDES_NULL, BID_GREATER_THAN_ASK                  │ │
│  │  - INVALID_FORMAT, INVALID_BID, INVALID_ASK               │ │
│  │  - INVALID_BID_SIZE, INVALID_ASK_SIZE                     │ │
│  │  - BID_SIZE_MUST_BE_POSITIVE, ASK_SIZE_MUST_BE_POSITIVE  │ │
│  │  - SPREAD_TOO_NARROW, SPREAD_TOO_WIDE                     │ │
│  │  - MARKET_CROSSING                                        │ │
│  └───────────────────────────────────────────────────────────┘ │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Core Layer

### Quote Value Object

**Файл:** `src/quote/core/Quote.ts`

**Ответственность:**

- Immutable представление котировки
- Бизнес-логика (вычисление spread, mid price, проверка crossing)
- Инварианты: хотя бы одна сторона, bid <= ask

**Интерфейс:**

```typescript
class Quote {
  // Private constructor - нельзя создать напрямую
  private constructor(
    bid: Price | null,
    ask: Price | null,
    bidSize: Quantity,
    askSize: Quantity,
    timestampMs: number
  )

  // Factory method - может бросать QuoteInvariantViolation
  public static of(
    bid: Price | null,
    ask: Price | null,
    bidSize: Quantity,
    askSize: Quantity,
    timestamp: Date | number
  ): Quote

  // Геттеры
  public bid(): Price | null
  public ask(): Price | null
  public bidSize(): Quantity
  public askSize(): Quantity
  public timestampMs(): number
  public getTimestamp(): Date

  // Проверки
  public isTwoSided(): boolean
  public hasBid(): boolean
  public hasAsk(): boolean

  // Вычисления
  public spreadWidth(): Decimal | null
  public spreadPercentage(): Decimal | null
  public mid(): Decimal | null

  // Сравнение
  public equals(other: Quote): boolean  // БЕЗ timestamp
  public equalsWithTimestamp(other: Quote): boolean  // С timestamp
}
```

**Инварианты:**

1. **Хотя бы одна сторона:** `bid !== null || ask !== null`
2. **Порядок цен:** `bid <= ask` (для двусторонних котировок)

**Исключения:**

```typescript
class QuoteInvariantViolation extends Error {
  reason: 'BOTH_SIDES_NULL' | 'BID_GREATER_THAN_ASK'
}
```

### Почему throws в Core?

1. **Локальные ошибки** — инварианты нарушаются только при создании
2. **Явный контракт** — разработчик видит, что метод может бросить
3. **Производительность** — нет лишних Result оберток во внутренней логике
4. **Facade изолирует** — все исключения перехватываются на границе API

## Facade Layer

### QuoteService

**Файл:** `src/quote/facade/QuoteService.ts`

**Ответственность:**

- Публичный API с "Never Throw" контрактом
- Преобразование Result<T, E> для всех операций
- Интеграция с errorUtils для автоматического opChain
- Валидация входных данных

**Архитектурные принципы:**

1. **Never Throw** — все методы возвращают `Result<T, InvalidQuoteError>`
2. **Automatic opChain** — каждая операция добавляется в цепочку через `wrapOp()`
3. **Root-cause preservation** — `rewrap()` сохраняет оригинальную ошибку
4. **Centralized validation** — `toDecimal()` для всех парсингов

### errorUtils интеграция

#### toDecimal()

Парсит значения с автоматической валидацией:

```typescript
const bidResult = toDecimal(
  'bidValue',
  bidValue,
  QuoteErrorReason.INVALID_FORMAT,
  InvalidQuoteError
);

if (!bidResult.ok) {
  return Err(rewrap('create', { component: 'bid' }, bidResult.error, InvalidQuoteError));
}

const bidDecimal = bidResult.value;
```

**Что делает:**

- Проверяет `number | string | Decimal`
- Конвертирует в Decimal
- Возвращает `Result<Decimal, InvalidQuoteError>`

#### wrapOp()

Автоматически добавляет операцию в opChain:

```typescript
return wrapOp('create', ctx, () => {
  // Логика создания...
  return QuoteService.createFromDecimals(bidDecimal, askDecimal, ...);
}, 'quote', InvalidQuoteError);
```

**Что делает:**

- Добавляет `'create'` в `context.opChain`
- Добавляет `ctx` в `context`
- Оборачивает неожиданные ошибки через `unexpectedError()`

#### rewrap()

Сохраняет root cause при перебрасывании:

```typescript
const bidResult = PriceService.create(bidDecimal);
if (!bidResult.ok) {
  return Err(
    rewrap(
      'createFromDecimals',
      { component: 'bid' },
      new InvalidQuoteError('Invalid bid price', {
        context: {
          reason: QuoteErrorReason.INVALID_BID,
          cause: bidResult.error
        }
      }),
      InvalidQuoteError
    )
  );
}
```

**Что делает:**

- Добавляет операцию в opChain
- Сохраняет оригинальную ошибку в `context.cause`
- Добавляет новый контекст

### Пример потока

```typescript
QuoteService.create(0.48, 0.52, 100, 150)
  ↓
  wrapOp('create', { bidValue, askValue, ... }, () => {
    ↓
    toDecimal('bidValue', 0.48, ...) → Ok(Decimal(0.48))
    ↓
    toDecimal('askValue', 0.52, ...) → Ok(Decimal(0.52))
    ↓
    toDecimal('bidSizeValue', 100, ...) → Ok(Decimal(100))
    ↓
    toDecimal('askSizeValue', 150, ...) → Ok(Decimal(150))
    ↓
    QuoteService.createFromDecimals(...)
      ↓
      wrapOp('createFromDecimals', ..., () => {
        ↓
        PriceService.create(Decimal(0.48))
          ↓ (если ошибка)
          rewrap('createFromDecimals', { component: 'bid' }, error, ...)
        ↓
        Quote.of(Price, Price, Quantity, Quantity, timestamp)
          ↓ (если QuoteInvariantViolation)
          unexpectedError(...)
      })
  })
```

**Результат opChain при ошибке:**

```json
{
  "opChain": ["create", "createFromDecimals"],
  "op": "createFromDecimals",
  "component": "bid",
  "reason": "INVALID_BID"
}
```

## Rules Layer

### Валидационные правила

**Файлы:**

- `src/quote/rules/ValidateQuoteSizes.ts`
- `src/quote/rules/ValidateMinSpread.ts`
- `src/quote/rules/ValidateMaxSpread.ts`
- `src/quote/rules/ValidateMarketCrossing.ts`

**Архитектура:**

```typescript
class ValidateXxx {
  public static check(...args): Result<void, InvalidQuoteError> {
    if (condition) {
      return Err(
        new InvalidQuoteError('...', {
          context: {
            reason: QuoteErrorReason.XXX,
            ...contextData
          }
        })
      );
    }
    return Ok(undefined);
  }
}
```

**Принципы:**

1. **Stateless** — только статические методы
2. **Single responsibility** — одно правило на класс
3. **Result API** — никогда не бросают исключения
4. **Typed errors** — используют QuoteErrorReason

### ValidateQuoteSizes

Проверяет, что размеры положительные когда есть цены.

**Логика:**

```typescript
if (bid !== null && !bidSize.isPositive()) {
  return Err(QuoteErrorReason.BID_SIZE_MUST_BE_POSITIVE);
}

if (ask !== null && !askSize.isPositive()) {
  return Err(QuoteErrorReason.ASK_SIZE_MUST_BE_POSITIVE);
}
```

### ValidateMinSpread

Проверяет минимальный spread.

**Логика:**

```typescript
if (spread.lessThan(minSpread)) {
  return Err(QuoteErrorReason.SPREAD_TOO_NARROW);
}
```

### ValidateMaxSpread

Проверяет максимальный spread.

**Логика:**

```typescript
if (spread.greaterThan(maxSpread)) {
  return Err(QuoteErrorReason.SPREAD_TOO_WIDE);
}
```

### ValidateMarketCrossing

Проверяет, что котировка не пересекает orderbook.

**Логика:**

```typescript
// Проверка bid стороны
if (quoteBid !== null && orderbookAsk !== null) {
  if (quoteBid >= orderbookAsk) {
    return Err({
      reason: QuoteErrorReason.MARKET_CROSSING,
      side: 'bid'
    });
  }
}

// Проверка ask стороны
if (quoteAsk !== null && orderbookBid !== null) {
  if (quoteAsk <= orderbookBid) {
    return Err({
      reason: QuoteErrorReason.MARKET_CROSSING,
      side: 'ask'
    });
  }
}
```

## Adapters Layer

### QuoteSerializer

**Файл:** `src/quote/adapters/QuoteSerializer.ts`

**Ответственность:**

- JSON сериализация/десериализация
- Валидация JSON структуры
- Result API для всех операций

**Методы:**

- `toJSON(quote)` → `QuoteJson`
- `fromJSON(json)` → `Result<Quote, InvalidQuoteError>`
- `toString(quote)` → `string`
- `parse(jsonString)` → `Result<Quote, InvalidQuoteError>`

### QuoteFormatter

**Файл:** `src/quote/adapters/QuoteFormatter.ts`

**Ответственность:**

- Форматирование для отображения
- Различные форматы вывода
- Never Throw — все методы безопасны

**Методы:**

- `toDisplay()` — "bid @ size / ask @ size"
- `toShort()` — "bid/ask"
- `toDetailed()` — с spread и mid
- `toTable()` — табличный формат
- `formatSpread()` — форматирование spread
- `formatMid()` — форматирование mid price

## Errors

### QuoteErrorReason

**Файл:** `src/quote/errors/QuoteErrorReason.ts`

**12 типизированных причин:**

```typescript
enum QuoteErrorReason {
  // Invariant violations
  BOTH_SIDES_NULL = 'BOTH_SIDES_NULL',
  BID_GREATER_THAN_ASK = 'BID_GREATER_THAN_ASK',

  // Parsing errors
  INVALID_FORMAT = 'INVALID_FORMAT',

  // Validation errors
  INVALID_BID = 'INVALID_BID',
  INVALID_ASK = 'INVALID_ASK',
  INVALID_BID_SIZE = 'INVALID_BID_SIZE',
  INVALID_ASK_SIZE = 'INVALID_ASK_SIZE',

  // Business rules
  BID_SIZE_MUST_BE_POSITIVE = 'BID_SIZE_MUST_BE_POSITIVE',
  ASK_SIZE_MUST_BE_POSITIVE = 'ASK_SIZE_MUST_BE_POSITIVE',
  SPREAD_TOO_NARROW = 'SPREAD_TOO_NARROW',
  SPREAD_TOO_WIDE = 'SPREAD_TOO_WIDE',
  MARKET_CROSSING = 'MARKET_CROSSING'
}
```

## Архитектурные решения

### 1. Throws+Facade Pattern

**Почему:**

- Core остаётся чистым от Result оберток
- Facade изолирует исключения
- Внутренняя производительность выше
- API безопасен для всех пользователей

### 2. Централизованный errorUtils

**Преимущества:**

- ~70% reduction кода в Facade
- Automatic opChain tracking
- Root-cause preservation
- Consistent error handling

**До:**

```typescript
public static create(...) {
  try {
    const bidDecimal = new Decimal(bidValue);
    if (bidDecimal.isNaN()) {
      return Err(new InvalidQuoteError(...));
    }
    // ... 50 lines of similar code
  } catch (error) {
    return Err(new InvalidQuoteError(...));
  }
}
```

**После:**

```typescript
public static create(...) {
  return wrapOp('create', ctx, () => {
    const bidResult = toDecimal('bidValue', bidValue, QuoteErrorReason.INVALID_FORMAT, InvalidQuoteError);
    if (!bidResult.ok) {
      return Err(rewrap('create', { component: 'bid' }, bidResult.error, InvalidQuoteError));
    }
    // ... clean logic
  }, 'quote', InvalidQuoteError);
}
```

### 3. Typed Error Reasons

**Преимущества:**

- Type-safe error handling
- IDE автодополнение
- Легко добавлять новые причины
- Централизованная документация

### 4. Separate Rules Layer

**Преимущества:**

- Single Responsibility Principle
- Переиспользование правил
- Легко тестировать
- Композиция правил

## Зависимости

```
Quote
├── Price (value object)
│   └── PriceService (facade)
├── Quantity (value object)
│   └── QuantityService (facade)
├── Decimal.js (math library)
├── @polymarket/result (Result<T, E>)
└── @polymarket/errors (InvalidQuoteError)
```

## Testing Strategy

**154 теста:**

1. **Core (37 tests):** Quote.test.ts
   - Создание через of()
   - Инварианты
   - Геттеры
   - Вычисления (spread, mid, crossing)
   - Equals

2. **Rules (26 tests):**
   - ValidateQuoteSizes: 7 tests
   - ValidateMinSpread: 4 tests
   - ValidateMaxSpread: 4 tests
   - ValidateMarketCrossing: 11 tests

3. **Facade (42 tests):** QuoteService.test.ts
   - create(), createFromDecimals()
   - bidOnly(), askOnly()
   - shift(), skew()
   - updateSizes()
   - getSpreadOrZero(), getMidOrNull()

4. **Adapters (49 tests):**
   - QuoteSerializer: 27 tests
   - QuoteFormatter: 22 tests

## Performance Considerations

### Immutability

Quote is immutable, все операции создают новые экземпляры:

```typescript
const shifted = QuoteService.shift(quote, delta);
// quote остаётся неизменным
```

### Decimal.js

Используется для точных вычислений с плавающей точкой:

```typescript
const spread = quote.spreadWidth();  // Decimal
const spreadPct = quote.spreadPercentage();  // Decimal
```

### Lazy computation

Вычисления выполняются on-demand:

```typescript
const mid = quote.midPrice();  // Вычисляется при вызове
```

## Future Extensions

Возможные расширения архитектуры:

1. **Quote History** — отслеживание изменений котировки
2. **Quote Aggregation** — агрегация котировок от разных источников
3. **Quote Streaming** — real-time updates
4. **Quote Analytics** — статистика spread, volume, etc.
5. **Custom Validators** — расширяемая система валидации

## См. также

- [README.md](./README.md) — обзор и quick start
- [facade.md](./facade.md) — детали Facade Layer
- [examples.md](./examples.md) — примеры использования
