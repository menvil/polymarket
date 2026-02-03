# Quote Facade Layer

## Обзор

Facade Layer предоставляет **"Never Throw"** API для работы с котировками через `QuoteService`.

## Зачем нужен Facade?

### Проблема

Core Layer (Quote) использует throws для инвариантов:

```typescript
// ⚠️ Может бросить QuoteInvariantViolation
const quote = Quote.of(bid, ask, bidSize, askSize, timestamp);
```

### Решение

Facade оборачивает все операции в Result<T, E>:

```typescript
// ✅ Никогда не бросает
const result = QuoteService.create(0.48, 0.52, 100, 150);

if (!result.ok) {
  // Обработка ошибки
  console.error(result.error.message);
  return;
}

const quote = result.value;
```

## QuoteService API

### Создание котировок

#### create()

Создаёт Quote из number значений.

```typescript
public static create(
  bidValue: number | null,
  askValue: number | null,
  bidSizeValue: number,
  askSizeValue: number,
  timestamp?: Date | number
): Result<Quote, InvalidQuoteError>
```

**Внутренняя логика:**

1. Парсинг через `toDecimal()`:

   ```typescript
   const bidResult = toDecimal('bidValue', bidValue, QuoteErrorReason.INVALID_FORMAT, InvalidQuoteError);
   ```

2. Создание Price через `PriceService.create()`:

   ```typescript
   const bidResult = PriceService.create(bidDecimal);
   if (!bidResult.ok) {
     return Err(rewrap('create', { component: 'bid' }, bidResult.error, InvalidQuoteError));
   }
   ```

3. Создание Quantity через `QuantityService.create()`:

   ```typescript
   const bidSizeResult = QuantityService.create(bidSizeDecimal);
   ```

4. Валидация размеров:

   ```typescript
   const sizeValidation = ValidateQuoteSizes.check(bid, bidSize, ask, askSize);
   ```

5. Создание Quote через Core:

   ```typescript
   try {
     const quote = Quote.of(bid, ask, bidSize, askSize, timestampMs);
     return Ok(quote);
   } catch (error) {
     return Err(unexpectedError(error, 'quote', InvalidQuoteError));
   }
   ```

**opChain при ошибке:**

```json
{
  "opChain": ["create", "createFromDecimals"],
  "op": "create",
  "component": "bid"
}
```

#### createFromDecimals()

Создаёт Quote из Decimal значений.

```typescript
public static createFromDecimals(
  bidValue: Decimal | null,
  askValue: Decimal | null,
  bidSizeValue: Decimal,
  askSizeValue: Decimal,
  timestamp?: Date | number
): Result<Quote, InvalidQuoteError>
```

**Использование:**

```typescript
import Decimal from 'decimal.js';

const result = QuoteService.createFromDecimals(
  new Decimal(0.48),
  new Decimal(0.52),
  new Decimal(100),
  new Decimal(150)
);
```

#### bidOnly()

Создаёт bid-only котировку.

```typescript
public static bidOnly(
  bidValue: number | Decimal,
  bidSizeValue: number | Decimal,
  timestamp?: Date | number
): Result<Quote, InvalidQuoteError>
```

**Внутренняя логика:**

```typescript
// Преобразование в Decimal если нужно
const bidDecimal = typeof bidValue === 'number'
  ? toDecimal('bidValue', bidValue, ...)
  : bidValue;

// Создание через createFromDecimals с ask = null
return QuoteService.createFromDecimals(
  bidDecimal,
  null,           // ask = null
  bidSizeDecimal,
  new Decimal(0), // askSize = 0
  timestamp
);
```

#### askOnly()

Создаёт ask-only котировку.

```typescript
public static askOnly(
  askValue: number | Decimal,
  askSizeValue: number | Decimal,
  timestamp?: Date | number
): Result<Quote, InvalidQuoteError>
```

### Операции с котировками

#### shift()

Сдвигает котировку на дельту (сохраняет spread).

```typescript
public static shift(
  quote: Quote,
  delta: Decimal
): Result<Quote, InvalidQuoteError>
```

**Алгоритм:**

1. Если есть bid → `newBid = bid + delta`
2. Если есть ask → `newAsk = ask + delta`
3. Sizes остаются прежними
4. Создание новой котировки через `createFromDecimals()`

**Пример:**

```typescript
// quote: bid=0.48, ask=0.52, spread=0.04
const shifted = QuoteService.shift(quote, new Decimal(0.01));
// shifted: bid=0.49, ask=0.53, spread=0.04 (сохранился!)
```

**opChain при ошибке:**

```json
{
  "opChain": ["shift", "createFromDecimals"],
  "op": "shift",
  "delta": 0.01
}
```

#### skew()

Независимо сдвигает bid и ask.

```typescript
public static skew(
  quote: Quote,
  bidDelta: Decimal,
  askDelta: Decimal
): Result<Quote, InvalidQuoteError>
```

**Алгоритм:**

1. Если есть bid → `newBid = bid + bidDelta`
2. Если есть ask → `newAsk = ask + askDelta`
3. Sizes остаются прежними
4. Создание новой котировки через `createFromDecimals()`

**Пример:**

```typescript
// quote: bid=0.48, ask=0.52, spread=0.04
const skewed = QuoteService.skew(
  quote,
  new Decimal(-0.01),  // bid вниз
  new Decimal(0.01)    // ask вверх
);
// skewed: bid=0.47, ask=0.53, spread=0.06 (увеличился!)
```

#### updateSizes()

Обновляет размеры котировки.

```typescript
public static updateSizes(
  quote: Quote,
  newBidSize: number | Quantity,
  newAskSize: number | Quantity
): Result<Quote, InvalidQuoteError>
```

**Алгоритм:**

1. Преобразование sizes в Quantity если нужно
2. Создание новой котировки с новыми sizes
3. Prices остаются прежними

**Пример:**

```typescript
// quote: bid=0.48@100, ask=0.52@150
const updated = QuoteService.updateSizes(quote, 200, 300);
// updated: bid=0.48@200, ask=0.52@300 (только sizes изменились)
```

### Utility методы

#### getSpreadOrZero()

Возвращает spread или 0 для one-sided котировок.

```typescript
public static getSpreadOrZero(quote: Quote): Decimal
```

**Логика:**

```typescript
const spread = quote.spreadWidth();
return spread ?? new Decimal(0);
```

**Пример:**

```typescript
const twoSided = QuoteService.create(0.48, 0.52, 100, 150).value;
console.log(QuoteService.getSpreadOrZero(twoSided).toNumber());  // 0.04

const bidOnly = QuoteService.bidOnly(0.50, 100).value;
console.log(QuoteService.getSpreadOrZero(bidOnly).toNumber());   // 0
```

#### getMidOrNull()

Возвращает mid price или null для one-sided котировок.

```typescript
public static getMidOrNull(quote: Quote): Price | null
```

**Логика:**

```typescript
return quote.midPrice();
```

**Пример:**

```typescript
const twoSided = QuoteService.create(0.48, 0.52, 100, 150).value;
console.log(QuoteService.getMidOrNull(twoSided)?.value().toNumber());  // 0.50

const bidOnly = QuoteService.bidOnly(0.50, 100).value;
console.log(QuoteService.getMidOrNull(bidOnly));  // null
```

## errorUtils Integration

### toDecimal()

Парсинг с автоматической валидацией.

**Сигнатура:**

```typescript
toDecimal<E extends DomainError>(
  field: string,
  value: unknown,
  reason: string,
  ErrorClass: new (message: string, options?: any) => E
): Result<Decimal, E>
```

**Использование в create():**

```typescript
const bidResult = toDecimal(
  'bidValue',                       // имя поля
  bidValue,                         // значение
  QuoteErrorReason.INVALID_FORMAT,  // причина ошибки
  InvalidQuoteError                 // класс ошибки
);

if (!bidResult.ok) {
  // bidResult.error.context?.reason === 'INVALID_FORMAT'
  // bidResult.error.context?.raw === { field: 'bidValue', value: bidValue }
  return Err(rewrap('create', { component: 'bid' }, bidResult.error, InvalidQuoteError));
}

const bidDecimal = bidResult.value;
```

**Что проверяет:**

- `typeof value === 'number'` → `new Decimal(value)`
- `typeof value === 'string'` → парсинг строки
- `value instanceof Decimal` → используется как есть
- `isNaN`, `!isFinite` → ошибка

### wrapOp()

Автоматический opChain для операций.

**Сигнатура:**

```typescript
wrapOp<T, E extends DomainError>(
  op: string,
  context: Record<string, unknown>,
  fn: () => Result<T, E>,
  component: string,
  ErrorClass: new (message: string, options?: any) => E
): Result<T, E>
```

**Использование в create():**

```typescript
return wrapOp('create', ctx, () => {
  // Парсинг и валидация...
  const bidResult = toDecimal('bidValue', bidValue, ...);
  if (!bidResult.ok) {
    return Err(rewrap('create', { component: 'bid' }, bidResult.error, InvalidQuoteError));
  }

  // Создание через createFromDecimals...
  return QuoteService.createFromDecimals(bidDecimal, askDecimal, ...);
}, 'quote', InvalidQuoteError);
```

**Что делает:**

1. Добавляет `op` в `context.opChain`
2. Добавляет `context` в error context
3. Оборачивает неожиданные исключения через `unexpectedError()`

### rewrap()

Сохранение root cause при перебрасывании ошибки.

**Сигнатура:**

```typescript
rewrap<E extends DomainError>(
  op: string,
  additionalContext: Record<string, unknown>,
  error: E,
  ErrorClass: new (message: string, options?: any) => E
): E
```

**Использование при создании Price:**

```typescript
const bidResult = PriceService.create(bidDecimal);
if (!bidResult.ok) {
  return Err(
    rewrap(
      'createFromDecimals',              // текущая операция
      { component: 'bid' },              // доп. контекст
      new InvalidQuoteError('Invalid bid price', {
        context: {
          reason: QuoteErrorReason.INVALID_BID,
          cause: bidResult.error         // root cause
        }
      }),
      InvalidQuoteError
    )
  );
}
```

**Результат:**

```json
{
  "message": "Invalid bid price",
  "context": {
    "reason": "INVALID_BID",
    "component": "bid",
    "opChain": ["create", "createFromDecimals"],
    "op": "createFromDecimals",
    "cause": {
      "message": "Price out of range",
      "context": {
        "reason": "OUT_OF_RANGE",
        "value": 1.5
      }
    }
  }
}
```

### unexpectedError()

Обработка неожиданных исключений (QuoteInvariantViolation).

**Сигнатура:**

```typescript
unexpectedError<E extends DomainError>(
  error: unknown,
  component: string,
  ErrorClass: new (message: string, options?: any) => E,
  additionalContext?: Record<string, unknown>
): E
```

**Использование при создании Quote:**

```typescript
try {
  const quote = Quote.of(bid, ask, bidSize, askSize, timestampMs);
  return Ok(quote);
} catch (error) {
  if (error instanceof QuoteInvariantViolation) {
    return Err(
      new InvalidQuoteError(error.message, {
        context: {
          reason: error.reason as QuoteErrorReason,
          component: 'quote',
          op: 'createFromDecimals'
        }
      })
    );
  }

  return Err(unexpectedError(error, 'quote', InvalidQuoteError));
}
```

## Error Flow Examples

### Успешный случай

```typescript
QuoteService.create(0.48, 0.52, 100, 150)
  ↓
  wrapOp('create', { bidValue, askValue, ... })
    ↓
    toDecimal('bidValue', 0.48) → Ok(Decimal(0.48))
    toDecimal('askValue', 0.52) → Ok(Decimal(0.52))
    toDecimal('bidSizeValue', 100) → Ok(Decimal(100))
    toDecimal('askSizeValue', 150) → Ok(Decimal(150))
    ↓
    createFromDecimals(...)
      ↓
      wrapOp('createFromDecimals', ...)
        ↓
        PriceService.create(0.48) → Ok(Price(0.48))
        PriceService.create(0.52) → Ok(Price(0.52))
        QuantityService.create(100) → Ok(Quantity(100))
        QuantityService.create(150) → Ok(Quantity(150))
        ↓
        ValidateQuoteSizes.check(...) → Ok(undefined)
        ↓
        Quote.of(...) → Quote
        ↓
        Ok(Quote)
    ↓
  Ok(Quote)
```

### Ошибка парсинга

```typescript
QuoteService.create('invalid', 0.52, 100, 150)
  ↓
  wrapOp('create', { bidValue: 'invalid', ... })
    ↓
    toDecimal('bidValue', 'invalid')
      ↓
      Err(InvalidQuoteError {
        message: 'Invalid decimal format',
        context: {
          reason: 'INVALID_FORMAT',
          raw: { field: 'bidValue', value: 'invalid' }
        }
      })
    ↓
    rewrap('create', { component: 'bid' }, error)
      ↓
      Err(InvalidQuoteError {
        message: 'Invalid decimal format',
        context: {
          reason: 'INVALID_FORMAT',
          raw: { field: 'bidValue', value: 'invalid' },
          component: 'bid',
          opChain: ['create'],
          op: 'create'
        }
      })
```

### Ошибка в Price

```typescript
QuoteService.create(1.5, 0.52, 100, 150)  // 1.5 > MAX_PRICE
  ↓
  wrapOp('create', ...)
    ↓
    toDecimal('bidValue', 1.5) → Ok(Decimal(1.5))
    ↓
    createFromDecimals(Decimal(1.5), ...)
      ↓
      wrapOp('createFromDecimals', ...)
        ↓
        PriceService.create(Decimal(1.5))
          ↓
          Err(InvalidPriceError {
            message: 'Price out of range',
            context: {
              reason: 'OUT_OF_RANGE',
              value: 1.5
            }
          })
        ↓
        rewrap('createFromDecimals', { component: 'bid' },
          new InvalidQuoteError('Invalid bid price', {
            context: {
              reason: 'INVALID_BID',
              cause: InvalidPriceError
            }
          })
        )
        ↓
        Err(InvalidQuoteError {
          message: 'Invalid bid price',
          context: {
            reason: 'INVALID_BID',
            component: 'bid',
            opChain: ['create', 'createFromDecimals'],
            op: 'createFromDecimals',
            cause: InvalidPriceError { ... }
          }
        })
```

### Ошибка инварианта

```typescript
QuoteService.create(0.60, 0.40, 100, 150)  // bid > ask
  ↓
  wrapOp('create', ...)
    ↓
    toDecimal('bidValue', 0.60) → Ok(Decimal(0.60))
    toDecimal('askValue', 0.40) → Ok(Decimal(0.40))
    ↓
    createFromDecimals(Decimal(0.60), Decimal(0.40), ...)
      ↓
      wrapOp('createFromDecimals', ...)
        ↓
        PriceService.create(0.60) → Ok(Price(0.60))
        PriceService.create(0.40) → Ok(Price(0.40))
        ↓
        ValidateQuoteSizes.check(...) → Ok(undefined)
        ↓
        Quote.of(Price(0.60), Price(0.40), ...)
          ↓
          throw QuoteInvariantViolation {
            message: 'Bid 0.60 cannot be greater than ask 0.40',
            reason: 'BID_GREATER_THAN_ASK'
          }
        ↓
        catch (QuoteInvariantViolation)
        ↓
        Err(InvalidQuoteError {
          message: 'Bid 0.60 cannot be greater than ask 0.40',
          context: {
            reason: 'BID_GREATER_THAN_ASK',
            component: 'quote',
            op: 'createFromDecimals',
            bidValue: 0.60,
            askValue: 0.40
          }
        })
```

## Best Practices

### ✅ DO

```typescript
// Всегда используйте QuoteService, а не Quote.of()
const result = QuoteService.create(0.48, 0.52, 100, 150);

// Проверяйте Result
if (!result.ok) {
  // Обработка ошибки
  return;
}

// Проверяйте типы ошибок
if (result.error.context?.reason === QuoteErrorReason.BID_GREATER_THAN_ASK) {
  // Специфичная обработка
}

// Используйте opChain для диагностики
console.error(result.error.context?.opChain);  // ['create', 'createFromDecimals']
```

### ❌ DON'T

```typescript
// Не создавайте Quote напрямую
const quote = Quote.of(bid, ask, bidSize, askSize, timestamp);  // Может бросить!

// Не игнорируйте Result
const result = QuoteService.create(0.48, 0.52, 100, 150);
const quote = result.value;  // TypeError если result.ok === false!

// Не пишите свой error handling
try {
  const quote = Quote.of(...);
} catch (error) {
  // Плохо - нет opChain, нет typed errors
}
```

## Performance

### Оптимизации

1. **Lazy validation** — валидация только при создании
2. **No Result in Core** — внутренние операции без оберток
3. **Reusable errorUtils** — централизованная логика
4. **Typed errors** — быстрая проверка через enum

### Benchmarks

```typescript
// Create: ~0.05ms
const result = QuoteService.create(0.48, 0.52, 100, 150);

// Shift: ~0.03ms
const shifted = QuoteService.shift(quote, new Decimal(0.01));

// Skew: ~0.03ms
const skewed = QuoteService.skew(quote, delta1, delta2);
```

## См. также

- [README.md](./README.md) — обзор и API reference
- [architecture.md](./architecture.md) — архитектура
- [examples.md](./examples.md) — примеры использования
