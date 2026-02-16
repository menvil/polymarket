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
  PARSING = 'parsing',                 // Ошибка парсинга входных данных
  CORE_INVARIANT = 'core_invariant',   // Нарушение инварианта домена
  RULE_VALIDATION = 'rule_validation', // Нарушение бизнес-правила
  MATH_OPERATION = 'math_operation',   // Ошибка математической операции
  SERVICE_CALL = 'service_call',       // Ошибка из вложенного сервиса
  DEVELOPER_MISUSE = 'developer_misuse', // Developer mistake (TypeError, etc)
  UNEXPECTED = 'unexpected'            // Неожиданная runtime ошибка
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

#### DEVELOPER_MISUSE

**Когда**: Неправильное использование API (developer mistake)

**Примеры**:

- `TypeError`: передан `null`/`undefined` вместо объекта
- `TypeError`: вызов метода на `null`
- Нарушение контракта API (неправильный тип аргумента)

**Контекст**:

```typescript
{
  source: ErrorSource.DEVELOPER_MISUSE,
  reason: 'MISUSE',
  cause: {
    name: "TypeError",
    message: "Cannot read property 'amount' of null"
  }
}
```

**Отличие от UNEXPECTED**:

- **DEVELOPER_MISUSE** - баг в коде разработчика (неправильное использование API)
- **UNEXPECTED** - runtime ошибка вне контроля разработчика (network, disk, etc)

#### UNEXPECTED

**Когда**: Неожиданная runtime ошибка (не баг разработчика)

**Примеры**:

- Network errors
- File system errors
- Неизвестные exceptions из внешних библиотек

**Контекст**:

```typescript
{
  source: ErrorSource.UNEXPECTED,
  cause: {
    name: "NetworkError",
    message: "Request timeout"
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

**Строгий типовой контракт**:

Гарантирует `Result<T, TError>` - всегда возвращает ошибку типа TError:

- **Same-type TradingError** (instanceof ErrorConstructor) → rewrap с сохранением типа
- **Foreign TradingError** (другой тип TradingError):
  - Если это expected math error (ArithmeticOverflowError, InvalidOperandError и т.д.) → expectedMathError + rewrap (классификация: math_operation)
  - Иначе → unexpectedError + rewrap, с сохранением оригинальных данных в полях `originalErrorName`, `originalErrorCode`, `originalErrorContext`
- **Expected math errors (non-TradingError)** → expectedMathError + rewrap
- **Core invariant violations** → coreInvariantError + rewrap
- **TypeError** → developerMisuseError + rewrap
- **Unexpected errors** → unexpectedError + rewrap

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

Создает ошибку для ожидаемых math-ошибок (ArithmeticOverflowError, InvalidOperandError, DivisionByZeroError, InvalidRoundingModeError).

**Сигнатура**:

```typescript
function expectedMathError<TError extends DomainError>(
  e: Error,
  ErrorConstructor: ErrorConstructor<TError>
): TError
```

**Что делает**:

- Классифицирует ошибку как ErrorSource.MATH_OPERATION
- Сохраняет полный cause с stack trace
- Фабрика ТОЛЬКО добавляет семантику (source, cause)
- Трассировка (service, op, opChain) добавляется через rewrap в wrapOp

**Пример**:

```typescript
// Внутри wrapOp:
if (isExpectedMathError(e)) {
  const factoryError = expectedMathError(e, InvalidMoneyError);
  return Err(rewrap('MoneyService', 'multiply', ctx, factoryError, InvalidMoneyError));
}
```

### unexpectedError()

Обрабатывает неожиданные ошибки с полным контекстом.

**Сигнатура**:

```typescript
function unexpectedError<TError extends DomainError>(
  e: unknown,
  ErrorConstructor: ErrorConstructor<TError>
): TError
```

**Что делает**:

- Классифицирует ошибку как ErrorSource.UNEXPECTED
- Сохраняет полный cause с stack trace
- Обрабатывает любой тип thrown значения (Error, string, object, etc.)
- Фабрика ТОЛЬКО добавляет семантику (source, cause)
- Трассировка (service, op, opChain) добавляется через rewrap в wrapOp

**Пример**:

```typescript
// Внутри wrapOp:
const factoryError = unexpectedError(e, InvalidQuoteError);
return Err(rewrap('QuoteService', 'create', ctx, factoryError, InvalidQuoteError));
```

### currencyMismatchError()

Создает стандартизированную ошибку несовпадения валют.

**Сигнатура**:

```typescript
function currencyMismatchError<TError extends DomainError>(
  expected: string,
  actual: string,
  reasonEnum: string,
  ErrorConstructor: ErrorConstructor<TError>
): TError
```

**Что делает**:

- Классифицирует ошибку как ErrorSource.RULE_VALIDATION
- Добавляет reason, expected, actual в контекст
- Создает стандартизированное сообщение: "Currency mismatch: expected X, got Y"
- Фабрика ТОЛЬКО добавляет семантику (source, reason, expected, actual)
- Трассировка (service, op, opChain) добавляется через rewrap если нужно

**Пример**:

```typescript
if (!a.hasSameCurrency(b)) {
  return Err(currencyMismatchError(
    a.currency(),
    b.currency(),
    MoneyErrorReason.CURRENCY_MISMATCH,
    InvalidMoneyError
  ));
}
```

## Helper функции

### isExpectedMathError()

Проверяет, является ли ошибка ожидаемой math-ошибкой.

```typescript
function isExpectedMathError(e: unknown): e is Error
```

**Whitelist**:

- ArithmeticOverflowError
- InvalidOperandError
- DivisionByZeroError
- InvalidRoundingModeError

### isCoreInvariantViolation()

Проверяет, является ли ошибка Core invariant violation.

```typescript
function isCoreInvariantViolation(e: unknown): e is Error & { reason: string }
```

**Поддерживаемые типы**:

- PriceInvariantViolation
- QuantityInvariantViolation
- MoneyInvariantViolation
- BalanceInvariantViolation
- TokenBalanceInvariantViolation
- SpreadInvariantViolation
- QuoteInvariantViolation
- RatioInvariantViolation

### toCause()

Извлекает структурированный cause из любой ошибки.

```typescript
function toCause(e: unknown): { name: string; message: string; stack?: string }
```

## Единая модель трассировки ошибок

### Принцип разделения ответственности

В пакете `@polymarket/errors` используется чёткое разделение ответственности между функциями обработки ошибок:

**rewrap() отвечает за трассировку:**

- `service` - имя сервиса, где произошла ошибка
- `op` - операция, которая выполнялась
- `opChain` - цепочка вызовов через сервисы

**Фабрики (factories) отвечают за семантику:**

- `source` - источник ошибки (ErrorSource enum)
- `reason` - причина ошибки (domain-specific)
- `context` - дополнительный контекст (значения, параметры)

### Правило одного прохода

**ВАЖНО**: Каждая ошибка обогащается трассировкой ОДИН РАЗ через `rewrap()`.

❌ **Неправильно** (двойная упаковка):

```typescript
// Фабрика создаёт ошибку с service/op
const err = coreInvariantError('PriceService', 'create', ctx, e, InvalidPriceError);
// rewrap добавляет service/op снова
return Err(rewrap('PriceService', 'create', ctx, err, InvalidPriceError));
```

✅ **Правильно** (один проход):

```typescript
// Фабрика создаёт ошибку только с reason/source/cause
const err = coreInvariantError(e, InvalidPriceError);
// rewrap добавляет service/op один раз
return Err(rewrap('PriceService', 'create', ctx, err, InvalidPriceError));
```

### Поток обработки ошибок

```
[Входные данные]
     ↓
[toDecimal()] → source=PARSING, reason=INVALID_FORMAT
     ↓
[Price.of()] → бросает PriceInvariantViolation
     ↓
[coreInvariantError()] → source=CORE_INVARIANT, reason=OUT_OF_RANGE_HIGH
     ↓
[rewrap()] → добавляет service="PriceService", op="create", opChain=["PriceService.create"]
     ↓
[Result<Price, InvalidPriceError>]
```

### Сохранение root-данных

При переупаковке через `rewrap()` сохраняются **root-поля**:

- `cause` - оригинальная причина ошибки
- `reason` - исходная причина из domain
- `raw` - первичные невалидные данные
- `source` - источник ошибки (не перезаписывается)

**Origin-данные сохраняются** (данные первого TradingError в цепочке):

- `firstTradingErrorTimestamp` - timestamp первого TradingError (ISO string)
- `firstTradingErrorStack` - stack trace первого TradingError
- `originalName` - name первого TradingError
- `originalCode` - code первого TradingError

**Root cause данные** (исходный exception, не TradingError):

- `cause.stack` - stack trace исходного exception (root cause)
- `cause.message` - сообщение исходного exception
- `cause.name` - name исходного exception

**Обновляются на каждом rewrap**:

- `timestamp` - время создания новой ошибки
- `stack` - стек места где произошёл rewrap
- `name` - имя типа новой ошибки
- `code` - код новой ошибки (если изменился)
- `service`/`op`/`opChain` - обогащаются на каждом уровне

Это позволяет увидеть:

- **Что пошло не так** (cause, reason, raw, source) - сохраняется
- **Root cause** (cause.stack исходного exception) - сохраняется в cause
- **Первый TradingError** (firstTradingErrorTimestamp, firstTradingErrorStack, originalName, originalCode) - сохраняется
- **Где это произошло** (service, op, opChain) - накапливается в цепочке
- **Текущее состояние** (timestamp, stack, name) - обновляется

## См. также

- [errorUtils.ts](../src/utils/errorUtils.ts) - реализация утилит
- [ErrorSource.ts](../src/ErrorSource.ts) - enum источников ошибок
- [README.md](../README.md) - основная документация @polymarket/errors
