# Структура ошибок в Value Objects

> **📚 Общая документация**: Для полной документации по error handling утилитам см.
> [@polymarket/errors/docs/error-utilities.md](../../foundation/errors/docs/error-utilities.md)

Этот документ описывает **специфику использования error handling в Value Objects**.

## Обзор

Все сервисы value objects используют единую структуру ошибок с явным отслеживанием источника и цепочки вызовов. Это позволяет быстро определить:

- **Где** произошла ошибка (какой сервис)
- **Что** пошло не так (источник ошибки)
- **Как** туда попали (цепочка вызовов)

## ErrorSource - Источник ошибки

> **Примечание**: `ErrorSource` теперь в `@polymarket/errors`.
> Полное описание см. в [@polymarket/errors/docs/error-utilities.md](../../foundation/errors/docs/error-utilities.md)

Каждая ошибка помечается явным `source` полем:

```typescript
import { ErrorSource } from '@polymarket/errors';

// ErrorSource.PARSING - ошибка парсинга входных данных
// ErrorSource.CORE_INVARIANT - нарушение инварианта домена
// ErrorSource.RULE_VALIDATION - нарушение бизнес-правила
// ErrorSource.MATH_OPERATION - ошибка математической операции
// ErrorSource.UNEXPECTED - неожиданная ошибка (catch-all)
```

## Root Fields - Поля контекста

Следующие поля **защищены** и не перезаписываются при rewrap:

- **`source`** - источник первичной ошибки (ErrorSource)
- **`service`** - имя сервиса, где произошла первичная ошибка
- **`cause`** - вложенная ошибка (если есть)
- **`reason`** - причина нарушения инварианта/правила
- **`raw`** - сырые данные, вызвавшие ошибку

## opChain - Цепочка операций

Поле `opChain` показывает **полный путь** вызовов в формате `ServiceName.operation`:

```json
{
  "opChain": [
    "QuoteService.create",
    "QuoteService.createPrice",
    "PriceService.create"
  ]
}
```

Это позволяет понять:

- Первая операция - точка входа пользователя
- Последняя операция - место возникновения ошибки
- Промежуточные - путь через вложенные вызовы

## Примеры ошибок по источникам

### 1. PARSING - Ошибка парсинга

**Когда**: Невалидные входные данные (не число, не строка, некорректный формат)

```typescript
QuoteService.create('invalid_timestamp', 0.52, 100, 150);

// Ошибка:
{
  message: "Unexpected error during QuoteService create",
  context: {
    service: "QuoteService",
    source: "parsing",
    op: "create",
    opChain: ["QuoteService.create"],
    raw: {
      field: "timestamp",
      value: "invalid_timestamp"
    },
    cause: {
      name: "InvalidQuoteError",
      message: "Invalid input for toDecimal"
    }
  }
}
```

**Как читать**:

- `source: "parsing"` → проблема во входных данных
- `raw.field` → какое поле проблемное
- `raw.value` → что именно было передано

### 2. CORE_INVARIANT - Нарушение инварианта

**Когда**: Данные прошли парсинг, но нарушают инвариант домена (цена ≤ 0, отрицательное количество)

```typescript
PriceService.create(Decimal.fromNumber(0));

// Ошибка:
{
  message: "Price must be positive",
  context: {
    service: "PriceService",
    source: "core_invariant",
    op: "create",
    opChain: ["PriceService.create"],
    reason: "PRICE_MUST_BE_POSITIVE",
    raw: {
      field: "value",
      value: "0"
    }
  }
}
```

**Как читать**:

- `source: "core_invariant"` → нарушение фундаментального правила домена
- `reason` → код причины (enum из Core)
- Нет `cause` → это первичная ошибка, а не цепочка

### 3. RULE_VALIDATION - Нарушение бизнес-правила

**Когда**: Объект валиден, но не проходит бизнес-проверку (quantity < minSize, tick size mismatch)

```typescript
QuantityService.validateStepSize(
  Quantity.of(Decimal.fromNumber(0.05)),
  Decimal.fromNumber(0.1)
);

// Ошибка:
{
  message: "Quantity must be multiple of stepSize",
  context: {
    service: "QuantityService",
    source: "rule_validation",
    op: "validateStepSize",
    opChain: ["QuantityService.validateStepSize"],
    reason: "QUANTITY_NOT_MULTIPLE_OF_STEP_SIZE",
    actual: "0.05",
    stepSize: "0.1"
  }
}
```

**Как читать**:

- `source: "rule_validation"` → бизнес-правило не выполнено
- `reason` → код правила (enum из Rules)
- Контекст содержит actual/expected значения для отладки

### 4. MATH_OPERATION - Ошибка математики

**Когда**: Операция из @polymarket/math выбросила ошибку (overflow, деление на 0)

```typescript
MoneyService.multiply(
  Money.of(Decimal.MAX_VALUE, 'USDC'),
  Decimal.fromNumber(2)
);

// Ошибка:
{
  message: "Overflow during MoneyService multiply",
  context: {
    service: "MoneyService",
    source: "math_operation",
    op: "multiply",
    opChain: ["MoneyService.multiply"],
    operation: "multiply",
    lhs: "9999999999999999999",
    rhs: "2",
    cause: {
      name: "InvalidMoneyError",
      message: "[decimal-light] Overflow: result exceeds MAX_VALUE"
    }
  }
}
```

**Как читать**:

- `source: "math_operation"` → проблема в @polymarket/math
- `cause` → оригинальная ошибка из decimal-light
- Контекст содержит операнды для воспроизведения

### 5. SERVICE_CALL - Ошибка из вложенного сервиса

**Когда**: Facade вызывает другой Facade, и тот возвращает ошибку

```typescript
QuoteService.create(
  Decimal.fromNumber(1234567890),
  0, // ← invalid price
  100,
  150
);

// Ошибка:
{
  message: "Unexpected error during QuoteService create",
  context: {
    service: "PriceService",  // ← первичный источник
    source: "core_invariant", // ← первичная причина
    op: "create",
    opChain: [
      "QuoteService.create",
      "QuoteService.createPrice",
      "PriceService.create"  // ← здесь произошла ошибка
    ],
    component: "bid",
    reason: "PRICE_MUST_BE_POSITIVE",
    cause: {
      name: "InvalidPriceError",
      message: "Price must be positive"
    }
  }
}
```

**Как читать**:

- `service: "PriceService"` → ошибка из PriceService (защищенное поле)
- `source: "core_invariant"` → первичная причина (защищенное поле)
- `opChain` → путь: QuoteService → createPrice helper → PriceService
- `cause` → вложенная ошибка из PriceService

### 6. UNEXPECTED - Неожиданная ошибка

**Когда**: Ошибка, которую не ожидали (например, исключение в try/catch)

```typescript
// Внутри Facade:
try {
  // ... код, который может выбросить TypeError
} catch (error) {
  return Err(unexpectedError(
    QuoteService.SERVICE_NAME,
    'create',
    { timestamp, bid, ask },
    error,
    InvalidQuoteError
  ));
}

// Ошибка:
{
  message: "Unexpected error during QuoteService create",
  context: {
    service: "QuoteService",
    source: "unexpected",
    op: "create",
    opChain: ["QuoteService.create"],
    timestamp: "1234567890",
    bid: "0.52",
    ask: "0.53",
    cause: {
      name: "TypeError",
      message: "Cannot read property 'foo' of undefined"
    }
  }
}
```

**Как читать**:

- `source: "unexpected"` → это не валидационная ошибка
- `cause` → оригинальное исключение (TypeError, ReferenceError и т.д.)
- Нужно разбираться в коде, это баг

## Паттерны использования

### 1. Определение источника проблемы

```typescript
const result = QuoteService.create(timestamp, bid, ask, size);

if (!result.ok) {
  const { source, service, opChain } = result.error.context || {};

  switch (source) {
    case ErrorSource.PARSING:
      // Проблема во входных данных - проверь raw.field и raw.value
      break;

    case ErrorSource.CORE_INVARIANT:
      // Нарушение инварианта - проверь reason
      break;

    case ErrorSource.RULE_VALIDATION:
      // Бизнес-правило не выполнено - проверь reason и actual/expected
      break;

    case ErrorSource.MATH_OPERATION:
      // Overflow или другая math ошибка - проверь cause
      break;

    case ErrorSource.SERVICE_CALL:
      // Проблема во вложенном сервисе - смотри service и opChain
      break;

    case ErrorSource.UNEXPECTED:
      // Неожиданное исключение - смотри cause, это баг
      break;
  }
}
```

### 2. Трассировка вложенных вызовов

```typescript
// opChain показывает полный путь:
[
  "QuoteService.create",        // 1. Точка входа
  "QuoteService.createPrice",   // 2. Helper внутри QuoteService
  "PriceService.create"         // 3. Вложенный сервис (место ошибки)
]

// service = "PriceService" - первичный источник
// source = "core_invariant" - первичная причина
```

### 3. Отладка production ошибок

```typescript
// В логах видим:
{
  "error": {
    "name": "InvalidQuoteError",
    "message": "Unexpected error during QuoteService create",
    "context": {
      "service": "PriceService",
      "source": "core_invariant",
      "opChain": ["QuoteService.create", "QuoteService.createPrice", "PriceService.create"],
      "reason": "PRICE_MUST_BE_POSITIVE",
      "component": "bid",
      "raw": { "field": "value", "value": "0" }
    }
  }
}

// Читаем:
// 1. opChain[0] - пользователь вызвал QuoteService.create
// 2. opChain[1] - внутри вызвался helper createPrice
// 3. opChain[2] - helper вызвал PriceService.create
// 4. service - ошибка произошла в PriceService
// 5. source - нарушение инварианта (core_invariant)
// 6. reason - конкретная причина: цена должна быть положительной
// 7. component - это был bid
// 8. raw - передали значение "0"
```

## Root Fields Protection

При rewrap следующие поля **не перезаписываются**:

```typescript
// В PriceService возникла ошибка:
{
  service: "PriceService",
  source: "core_invariant",
  reason: "PRICE_MUST_BE_POSITIVE"
}

// QuoteService делает rewrap:
rewrap(
  QuoteService.SERVICE_NAME,
  'create',
  { component: 'bid' },  // ← новый контекст
  priceError,
  InvalidQuoteError
);

// Результат - root поля сохранены:
{
  service: "PriceService",       // ← не изменилось
  source: "core_invariant",      // ← не изменилось
  reason: "PRICE_MUST_BE_POSITIVE", // ← не изменилось
  op: "create",                  // ← обновилось
  opChain: [
    "QuoteService.create",
    "QuoteService.createPrice",
    "PriceService.create"
  ],
  component: "bid"               // ← добавилось
}
```

## Автоматическое извлечение valueName

Helper `getValueName()` автоматически извлекает имя value object из конструктора ошибки:

```typescript
// InvalidPriceError → "price"
// InvalidQuantityError → "quantity"
// InvalidQuoteError → "quote"

getValueName(InvalidPriceError);  // "price"
getValueName(InvalidMoneyError);  // "money"
```

Это устраняет дублирование в вызовах errorUtils.

## См. также

- [@polymarket/errors/docs/error-utilities.md](../../foundation/errors/docs/error-utilities.md) - полная документация по error handling утилитам
- [QuoteService.ts](/src/quote/facade/QuoteService.ts) - пример использования в Value Objects Facade
- [NAMING-CONVENTIONS.md](./NAMING-CONVENTIONS.md) - naming conventions для value objects
