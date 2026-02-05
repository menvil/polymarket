# Error Handling Utilities

Централизованные утилиты для обработки ошибок в Polymarket.

## Обзор

Пакет `@polymarket/errors` предоставляет набор утилит для унифицированной обработки ошибок:

- **ErrorSource** - enum для классификации источника ошибки
- **wrapOp()** - автоматическое оборачивание операций в try-catch
- **rewrap()** - переупаковка ошибок с сохранением root-контекста
- **toDecimal()** - безопасная конвертация в Decimal с error handling
- **expectedMathError()** - создание ошибок для ожидаемых математических исключений
- **unexpectedError()** - обработка неожиданных ошибок

## ErrorSource - Источник ошибки

Каждая ошибка помечается явным `source` полем для быстрой диагностики:

```typescript
enum ErrorSource {
  PARSING = 'parsing',              // Ошибка парсинга входных данных
  CORE_INVARIANT = 'core_invariant', // Нарушение инварианта домена
  RULE_VALIDATION = 'rule_validation', // Нарушение бизнес-правила
  MATH_OPERATION = 'math_operation',  // Ошибка математической операции
  SERVICE_CALL = 'service_call',     // Ошибка из вложенного сервиса
  UNEXPECTED = 'unexpected'          // Неожиданная ошибка (catch-all)
}
```

### Когда использовать каждый источник

#### PARSING
**Когда**: Невалидные входные данные (не число, не строка, некорректный формат)

**Примеры**:
- `"abc"` вместо числа
- `undefined` или `null` вместо Decimal
- Некорректный формат строки

**Контекст**:
```typescript
{
  source: ErrorSource.PARSING,
  raw: {
    field: "amount",
    value: "abc"
  },
  cause: { /* оригинальная ошибка */ }
}
```

#### CORE_INVARIANT
**Когда**: Данные прошли парсинг, но нарушают фундаментальное правило домена

**Примеры**:
- Отрицательная цена
- Отрицательное количество
- Недопустимое значение (0 для price)

**Контекст**:
```typescript
{
  source: ErrorSource.CORE_INVARIANT,
  reason: "PRICE_MUST_BE_POSITIVE",
  raw: {
    field: "value",
    value: "0"
  }
}
```

#### RULE_VALIDATION
**Когда**: Объект валиден, но не проходит бизнес-проверку

**Примеры**:
- quantity < minSize
- Несоответствие tick size
- Несовпадение валют

**Контекст**:
```typescript
{
  source: ErrorSource.RULE_VALIDATION,
  reason: "QUANTITY_BELOW_MIN_SIZE",
  actual: "0.5",
  minSize: "1.0"
}
```

#### MATH_OPERATION
**Когда**: Операция из @polymarket/math выбросила ошибку

**Примеры**:
- Arithmetic overflow
- Division by zero
- Invalid operand (NaN, Infinity)

**Контекст**:
```typescript
{
  source: ErrorSource.MATH_OPERATION,
  operation: "multiply",
  lhs: "999999999999",
  rhs: "2",
  cause: { /* ArithmeticOverflowError */ }
}
```

#### UNEXPECTED
**Когда**: Неожиданное исключение (TypeError, ReferenceError, и т.д.)

**Примеры**:
- Программная ошибка
- Незапланированное исключение
- Баг в коде

**Контекст**:
```typescript
{
  source: ErrorSource.UNEXPECTED,
  cause: {
    name: "TypeError",
    message: "Cannot read property 'foo' of undefined"
  }
}
```

## Root Fields Protection

Следующие поля **защищены** и не перезаписываются при rewrap:

- **`source`** - источник первичной ошибки (ErrorSource)
- **`service`** - имя сервиса, где произошла первичная ошибка
- **`cause`** - вложенная ошибка (если есть)
- **`reason`** - причина нарушения инварианта/правила
- **`raw`** - сырые данные, вызвавшие ошибку

Это гарантирует сохранение первопричины через всю цепочку вызовов.

## opChain - Цепочка операций

Поле `opChain` показывает **полный путь** вызовов в формате `ServiceName.operation`:

```typescript
{
  opChain: [
    "QuoteService.create",        // 1. Точка входа
    "QuoteService.createPrice",   // 2. Helper внутри сервиса
    "PriceService.create"         // 3. Вложенный сервис (место ошибки)
  ]
}
```

Это позволяет:
- Определить точку входа пользователя (первый элемент)
- Найти место возникновения ошибки (последний элемент)
- Понять путь через вложенные вызовы (промежуточные элементы)

## Основные функции

### wrapOp()

Оборачивает операцию в try-catch с автоматической обработкой ошибок.

**Сигнатура**:
```typescript
function wrapOp<T, TError extends DomainError>(
  serviceName: string,
  op: string,
  ctx: Record<string, unknown>,
  fn: () => Result<T, TError>,
  ErrorConstructor: ErrorConstructor<TError>
): Result<T, TError>
```

**Что делает**:
1. Выполняет `fn()`
2. Если `Result.Err` → автоматически rewrap с добавлением `serviceName.op` в opChain
3. Если exception → классифицирует и создает ошибку с правильным source

**Пример**:
```typescript
return wrapOp(
  'MoneyService',
  'add',
  { a: a.amount().toString(), b: b.amount().toString() },
  () => {
    const sum = addDecimal(a.amount(), b.amount());
    return createFromDecimal(sum, a.currency(), 'add', {});
  },
  InvalidMoneyError
);
```

### rewrap()

Переупаковывает ошибку, сохраняя root fields и добавляя новый контекст.

**Сигнатура**:
```typescript
function rewrap<TError extends DomainError>(
  serviceName: string,
  op: string,
  ctx: Record<string, unknown>,
  err: TError,
  ErrorConstructor: ErrorConstructor<TError>
): TError
```

**Порядок мерджа контекста**:
1. **inner** (err.context) - база из вложенной ошибки
2. **ctx** - операционные поля (amount, factor, divisor) - перетирают inner
3. **op + opChain** - строит цепочку операций, НЕ теряя внутренний op
4. **preserve root-полей**: cause, reason, raw (первопричина не перетирается)

**Пример**:
```typescript
const innerError = new InvalidMoneyError('Parse failed', {
  context: {
    reason: 'INVALID_FORMAT',
    raw: { field: 'value', value: 'abc' }
  }
});

const wrappedError = rewrap(
  'MoneyService',
  'create',
  { currency: 'USDC' },
  innerError,
  InvalidMoneyError
);

// wrappedError.context = {
//   service: 'MoneyService',
//   op: 'create',
//   opChain: ['MoneyService.create'],
//   currency: 'USDC',
//   reason: 'INVALID_FORMAT',  // сохранён из inner
//   raw: { field: 'value', value: 'abc' }  // сохранён из inner
// }
```

### toDecimal()

Безопасная конвертация `number | string | Decimal` в Decimal с автоматическим ErrorSource.PARSING.

**Сигнатура**:
```typescript
function toDecimal<TError extends DomainError>(
  field: string,
  input: number | string | Decimal,
  reasonEnum: string,
  ErrorConstructor: ErrorConstructor<TError>
): Result<Decimal, TError>
```

**Что делает**:
- Нормализует вход (primitives напрямую, объекты через toString())
- Корректно работает с двумя копиями decimal.js
- При ошибке → TError с source: PARSING, raw: { field, value }, cause

**Пример**:
```typescript
const result = toDecimal(
  'amount',
  '123.45',
  MoneyErrorReason.INVALID_FORMAT,
  InvalidMoneyError
);

if (result.ok) {
  console.log(result.value); // Decimal(123.45)
}
```

### expectedMathError()

Создает ошибку для ожидаемых math-ошибок (ArithmeticOverflowError, InvalidOperandError, DivisionByZeroError).

**Сигнатура**:
```typescript
function expectedMathError<TError extends DomainError>(
  serviceName: string,
  op: string,
  ctx: Record<string, unknown>,
  e: Error,
  ErrorConstructor: ErrorConstructor<TError>
): TError
```

**Пример**:
```typescript
try {
  return multiplyDecimal(amount, factor);
} catch (e) {
  if (isExpectedMathError(e)) {
    return Err(expectedMathError(
      'MoneyService',
      'multiply',
      { amount: amount.toString(), factor: factor.toString() },
      e,
      InvalidMoneyError
    ));
  }
}
```

### unexpectedError()

Обрабатывает неожиданные ошибки с полным контекстом.

**Сигнатура**:
```typescript
function unexpectedError<TError extends DomainError>(
  serviceName: string,
  op: string,
  ctx: Record<string, unknown>,
  e: unknown,
  ErrorConstructor: ErrorConstructor<TError>
): TError
```

**Пример**:
```typescript
try {
  // ... операция
} catch (e) {
  return Err(unexpectedError(
    'QuoteService',
    'create',
    { timestamp, bid, ask },
    e,
    InvalidQuoteError
  ));
}
```

### currencyMismatchError()

Создает стандартизированную ошибку несовпадения валют.

**Сигнатура**:
```typescript
function currencyMismatchError<TError extends DomainError>(
  op: string,
  expected: string,
  actual: string,
  reasonEnum: string,
  ErrorConstructor: ErrorConstructor<TError>
): TError
```

**Пример**:
```typescript
if (!a.hasSameCurrency(b)) {
  return Err(currencyMismatchError(
    'add',
    a.currency(),
    b.currency(),
    MoneyErrorReason.CURRENCY_MISMATCH,
    InvalidMoneyError
  ));
}
```

## Helper функции

### isExpectedMathError()

Проверяет является ли ошибка ожидаемой math-ошибкой.

```typescript
function isExpectedMathError(e: unknown): e is Error
```

**Whitelist**:
- ArithmeticOverflowError
- InvalidOperandError
- DivisionByZeroError

### isCoreInvariantViolation()

Проверяет является ли ошибка Core invariant violation.

```typescript
function isCoreInvariantViolation(e: unknown): e is Error & { reason: string }
```

**Поддерживаемые типы**:
- PriceInvariantViolation
- QuantityInvariantViolation
- MoneyInvariantViolation
- BalanceInvariantViolation
- SpreadInvariantViolation
- QuoteInvariantViolation

### toCause()

Извлекает структурированный cause из любой ошибки.

```typescript
function toCause(e: unknown): { name: string; message: string; stack?: string }
```

## См. также

- [errorUtils.ts](/src/utils/errorUtils.ts) - реализация утилит
- [ErrorSource.ts](/src/ErrorSource.ts) - enum источников ошибок
- [README.md](/README.md) - основная документация @polymarket/errors
