# Math Errors

Ошибки для математических операций в торговой системе Polymarket.

## Обзор

Math Errors представляют математические невозможности и проблемы валидации в низкоуровневых операциях:

- **Деление** - операции с невалидными делителями
- **Округление** - операции с tick size
- **Арифметика** - базовые математические функции с `Decimal.js`

Это математические невозможности, а не бизнес-правила. Эти ошибки возникают на уровне чистых математических функций (core layer) до применения бизнес-логики.

Все math errors имеют:

- **Severity:** `low` (проблемы валидации данных не критичны)
- **Статический код:** `ErrorClass.code` (для удобства)
- **Предназначение:** throw (математические невозможности)

---

## Каталог ошибок

### Математические операции

|Код|Класс|Когда использовать|Документация|
|-----|-------|-------------------|--------------|
|`INVALID_OPERAND`|InvalidOperandError|Операнд NaN/Infinity|[→](./invalid-operand.md)|
|`INVALID_DECIMAL_PLACES`|InvalidDecimalPlacesError|Decimal places < 0, не целое, не конечно|[→](./invalid-decimal-places.md)|
|`INVALID_DIVISOR`|InvalidDivisorError|Деление на NaN/Infinity|[→](./invalid-divisor.md)|
|`INVALID_TICK_SIZE`|InvalidTickSizeError|Tick size <= 0 или не конечен|[→](./invalid-tick-size.md)|

---

## Общие паттерны использования

### 1. InvalidDivisorError (деление)

```typescript
import Decimal from 'decimal.js';
import { InvalidDivisorError } from '@polymarket/errors';

function safeDivide(dividend: Decimal, divisor: Decimal): Decimal {
  // Проверяем что делитель конечен
  if (!divisor.isFinite()) {
    throw new InvalidDivisorError(
      (ctx) => `Divisor must be finite, got ${ctx.divisor}`,
      {
        context: {
          divisor: divisor.toString(),
          dividend: dividend.toString()
        }
      }
    );
  }

  // Примечание: для проверки на ноль используйте DivisionByZeroError
  // из value-objects (не входит в math errors)
  return dividend.dividedBy(divisor);
}

// Использование
const result = safeDivide(
  new Decimal('100'),
  new Decimal('0.5')
); // ✅ 200
```

### 2. InvalidDecimalPlacesError (форматирование)

```typescript
import Decimal from 'decimal.js';
import { InvalidDecimalPlacesError } from '@polymarket/errors';

function formatDecimal(value: Decimal, decimals: number): string {
  // Валидация decimals параметра
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 100) {
    throw new InvalidDecimalPlacesError(
      (ctx) => `Decimal places must be an integer between 0 and 100, got ${ctx.decimalPlaces}`,
      {
        context: {
          decimalPlaces: String(decimals),
          value: value.toString(),
          operation: 'formatDecimal'
        }
      }
    );
  }

  return value.toFixed(decimals);
}

// Использование
const value = new Decimal(10.5);
const formatted = formatDecimal(value, 2); // ✅ "10.50"
```

### 3. InvalidTickSizeError (округление)

```typescript
import Decimal from 'decimal.js';
import { InvalidTickSizeError } from '@polymarket/errors';

function roundToTickSize(value: Decimal, tickSize: Decimal): Decimal {
  // Валидация tick size
  if (!tickSize.isFinite()) {
    throw new InvalidTickSizeError(
      (ctx) => `Tick size must be finite, got ${ctx.tickSize}`,
      {
        context: { tickSize: tickSize.toString(), value: value.toString() }
      }
    );
  }

  if (tickSize.isNegative() || tickSize.isZero()) {
    throw new InvalidTickSizeError(
      (ctx) => `Tick size must be positive, got ${ctx.tickSize}`,
      {
        context: { tickSize: tickSize.toString(), value: value.toString() }
      }
    );
  }

  // Округление: (value / tickSize).round() * tickSize
  return value.dividedBy(tickSize).round().times(tickSize);
}

// Использование
const rounded = roundToTickSize(
  new Decimal('10.567'),
  new Decimal('0.01')
); // ✅ 10.57
```

---

## Архитектура

### Math vs Value Objects Errors

**Math Errors (низкий уровень - Core Layer):**

- Чистые математические операции
- Не знают о бизнес-правилах
- Только проверка математической валидности (finite, positive, non-zero)
- Используются в `@polymarket/math` пакете
- **Всегда throw** (математические невозможности)

**Value Objects Errors (средний уровень - Domain Layer):**

- Бизнес-валидация (диапазоны, форматы)
- Создание и валидация domain objects (Price, Quantity, Money)
- Используются в `@polymarket/value-objects` пакете
- **Result pattern** (бизнес-правила)

**Пример:**

```typescript
// 1️⃣ Core Layer: Math operations (throw на математические невозможности)
import { divideDecimal } from '@polymarket/math';
import { InvalidDivisorError } from '@polymarket/errors';

function average(a: Decimal, b: Decimal): Decimal {
  const sum = a.plus(b);
  const divisor = new Decimal(2);

  // ❌ throw: делитель математически невалидный (NaN/Infinity)
  return divideDecimal(sum, divisor);
}

// 2️⃣ Domain Layer: Value Objects (Result для бизнес-валидации)
import { Price } from '@polymarket/value-objects';
import { InvalidPriceError } from '@polymarket/errors';

const priceResult = Price.fromNumber(0.65);
// ✅ Result: цена не в бизнес-диапазоне [0.0001, 0.9999]

priceResult.match({
  ok: (price) => console.log('Valid price'),
  err: (error) => console.error('Business rule violation:', error.message)
});
```

---

## Best Practices

### 1. Когда использовать Math Errors

✅ **Используйте Math Errors:**

- В чистых математических функциях (`add`, `subtract`, `divide`, `round`)
- При валидации математических параметров (делитель, tick size)
- Когда проверяете математическую корректность (`isFinite()`, `isPositive()`)
- В `@polymarket/math` пакете

❌ **НЕ используйте Math Errors:**

- Для бизнес-валидации (используйте Value Objects Errors)
- Для проверки бизнес-диапазонов (min/max цены, quantity limits)
- В domain/application layers (только в core layer)

### 2. Severity Guidelines

Все Math Errors имеют **severity: low** потому что:

- Это проблемы валидации на уровне ввода
- Не критичны для системы (система не упадёт)
- Обычно возникают из-за некорректного пользовательского ввода
- Легко обрабатываются показом ошибки пользователю

### 3. Context Guidelines

Всегда включайте в context:

- **Параметры операции:** `divisor`, `dividend`, `tickSize`, `value`
- **Результат (если есть):** `result`, `normalized`
- **Дополнительный контекст:** `operation`, `reason`

```typescript
// ✅ Хорошо
{
  divisor: divisor.toString(),
  dividend: dividend.toString(),
  operation: 'average'
}

// ❌ Плохо
{
  x: divisor.toString(), // Неясное имя
  // Нет dividend для контекста
}
```

### 4. Message Guidelines

- **Динамические сообщения:** Используйте для включения значений из context
- **Активный залог:** "Divisor must be finite" вместо "The divisor is not finite"
- **Конкретные значения:** Показывайте что получили: "got NaN", "got -0.01"

```typescript
// ✅ Хорошо
throw new InvalidDivisorError(
  (ctx) => `Divisor must be finite, got ${ctx.divisor}`,
  { context: { divisor: 'NaN' } }
);

// ❌ Плохо
throw new InvalidDivisorError('Invalid divisor'); // Нет деталей
```

---

## Интеграция с другими пакетами

### `@polymarket/math`

Math errors используются в пакете `@polymarket/math` для валидации параметров математических операций:

```typescript
// packages/foundation/math/src/operations/divide.ts
import Decimal from 'decimal.js';
import { InvalidDivisorError, InvalidOperandError } from '@polymarket/errors';

export function divideDecimal(dividend: Decimal, divisor: Decimal): Decimal {
  // Валидация операндов (math errors)
  if (!dividend.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `Dividend must be finite, got ${ctx.dividend}`,
      {
        context: { dividend: dividend.toString(), divisor: divisor.toString(), operation: 'divide' }
      }
    );
  }

  if (!divisor.isFinite()) {
    throw new InvalidDivisorError(
      (ctx) => `Divisor must be finite, got ${ctx.divisor}`,
      {
        context: { divisor: divisor.toString(), dividend: dividend.toString() }
      }
    );
  }

  // Примечание: проверка на ноль (DivisionByZeroError) выполняется
  // на уровне value objects, а не здесь
  return dividend.dividedBy(divisor);
}
```

### `@polymarket/value-objects`

Value objects используют math operations и обрабатывают их ошибки:

```typescript
// packages/domain/value-objects/src/Price.ts
import { divideDecimal, roundToTickSize } from '@polymarket/math';
import { InvalidDivisorError, InvalidTickSizeError } from '@polymarket/errors';
import { Result } from '@polymarket/result';

export class Price {
  // ...

  divide(divisor: Price): Result<Price, InvalidDivisorError | InvalidPriceError> {
    try {
      const result = divideDecimal(this.value, divisor.value);
      return Price.fromDecimal(result);
    } catch (error) {
      if (InvalidDivisorError.is(error)) {
        return Result.err(error);
      }
      throw error;
    }
  }

  roundToTickSize(tickSize: Decimal): Result<Price, InvalidTickSizeError | InvalidPriceError> {
    try {
      const rounded = roundToTickSize(this.value, tickSize);
      return Price.fromDecimal(rounded);
    } catch (error) {
      if (InvalidTickSizeError.is(error)) {
        return Result.err(error);
      }
      throw error;
    }
  }
}
```

---

## Связанные ошибки

Из других категорий:

### Value Objects Errors

- [DivisionByZeroError](../value-objects/division-by-zero.md) - деление на ноль (конкретный случай InvalidDivisorError)
- [ArithmeticOverflowError](../value-objects/arithmetic-overflow.md) - результат операции вышел за пределы
- [InvalidPriceError](../value-objects/invalid-price.md) - бизнес-валидация цен
- [InvalidQuantityError](../value-objects/invalid-quantity.md) - бизнес-валидация количества

---

## См. также

- [Обработка ошибок](../error-handling.md) - Best practices для error handling
- [Value Objects Errors](../value-objects/README.md) - Ошибки бизнес-валидации
- [Главная документация](../README.md) - Обзор всей системы ошибок
