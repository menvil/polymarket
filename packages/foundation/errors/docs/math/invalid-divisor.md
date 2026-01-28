# InvalidDivisorError

Ошибка невалидного делителя в математических операциях.

## Описание

Выбрасывается при попытке деления на невалидное значение: `NaN`, `Infinity` или `-Infinity`.
Это математическая невозможность, а не бизнес-правило. Деление на такие значения не имеет математического смысла и всегда приводит к некорректным результатам.

В отличие от деления на ноль (`DivisionByZeroError`), эта ошибка возникает когда делитель технически существует, но не является валидным конечным числом.

## Свойства

| Свойство | Значение |
|----------|----------|
| **Код** | `INVALID_DIVISOR` |
| **Severity** | `low` |
| **Класс** | `InvalidDivisorError` |
| **Пакет** | `@polymarket/errors` |
| **Категория** | Math |

## Когда использовать

- Реализация операции деления в математических функциях
- Валидация делителя перед выполнением деления
- Операции с `Decimal.js` где делитель может быть невалидным
- Вычисление средних значений, процентов, коэффициентов

## Импорт

```typescript
import { InvalidDivisorError } from '@polymarket/errors';

// Для примеров с Decimal:
import Decimal from 'decimal.js';
```

---

## Примеры использования

### 1. Базовое использование (throw)

```typescript
import { InvalidDivisorError } from '@polymarket/errors';

function divide(dividend: number, divisor: number): number {
  if (!Number.isFinite(divisor)) {
    throw new InvalidDivisorError(
      (ctx) => `Divisor must be finite, got ${ctx.divisor}`,
      {
        code: InvalidDivisorError.code,
        context: { divisor, dividend }
      }
    );
  }

  if (divisor === 0) {
    throw new DivisionByZeroError('Cannot divide by zero');
  }

  return dividend / divisor;
}

// Использование
try {
  const result = divide(100, NaN);
} catch (error) {
  if (InvalidDivisorError.is(error)) {
    console.error('Invalid divisor:', error.context?.divisor);
    // Invalid divisor: NaN
  }
}
```

### 2. С Decimal.js (рекомендуется)

```typescript
import Decimal from 'decimal.js';
import { InvalidDivisorError } from '@polymarket/errors';

function divideDecimal(dividend: Decimal, divisor: Decimal): Decimal {
  // Проверяем что делитель конечен
  if (!divisor.isFinite()) {
    throw new InvalidDivisorError(
      (ctx) => `Divisor must be finite, got ${ctx.divisor}`,
      {
        code: InvalidDivisorError.code,
        context: {
          divisor: divisor.toString(),
          dividend: dividend.toString()
        }
      }
    );
  }

  // Проверяем деление на ноль
  if (divisor.isZero()) {
    throw new DivisionByZeroError(
      'Cannot divide by zero',
      {
        code: DivisionByZeroError.code,
        context: { dividend: dividend.toString() }
      }
    );
  }

  return dividend.dividedBy(divisor);
}

// Использование
const result = divideDecimal(
  new Decimal('100'),
  new Decimal('0.5')
); // ✅ 200
```

### 3. Вычисление среднего значения

```typescript
import Decimal from 'decimal.js';
import { InvalidDivisorError } from '@polymarket/errors';

function average(a: Decimal, b: Decimal): Decimal {
  const sum = a.plus(b);
  const divisor = new Decimal(2);

  if (!divisor.isFinite()) {
    throw new InvalidDivisorError(
      'Divisor for average must be finite',
      {
        code: InvalidDivisorError.code,
        context: { divisor: divisor.toString() }
      }
    );
  }

  return sum.dividedBy(divisor);
}

// Использование
const avg = average(
  new Decimal('0.65'),
  new Decimal('0.75')
); // ✅ 0.70
```

### 4. Округление к tick size

```typescript
import Decimal from 'decimal.js';
import { InvalidDivisorError, InvalidTickSizeError } from '@polymarket/errors';

function roundToTickSize(value: Decimal, tickSize: Decimal): Decimal {
  // Валидация tick size
  if (!tickSize.isFinite() || tickSize.isNegative() || tickSize.isZero()) {
    throw new InvalidTickSizeError(
      (ctx) => `Tick size must be finite and positive, got ${ctx.tickSize}`,
      {
        code: InvalidTickSizeError.code,
        context: { tickSize: tickSize.toString(), value: value.toString() }
      }
    );
  }

  // Деление на tick size
  const divided = value.dividedBy(tickSize);

  if (!divided.isFinite()) {
    throw new InvalidDivisorError(
      (ctx) => `Division by tick size resulted in non-finite value: ${ctx.result}`,
      {
        code: InvalidDivisorError.code,
        context: {
          value: value.toString(),
          tickSize: tickSize.toString(),
          result: divided.toString()
        }
      }
    );
  }

  // Округляем и умножаем обратно
  return divided.round().times(tickSize);
}

// Использование
const rounded = roundToTickSize(
  new Decimal('10.567'),
  new Decimal('0.01')
); // ✅ 10.57
```

### 5. Вычисление процента

```typescript
import Decimal from 'decimal.js';
import { InvalidDivisorError } from '@polymarket/errors';

function calculatePercentage(part: Decimal, total: Decimal): Decimal {
  if (!total.isFinite()) {
    throw new InvalidDivisorError(
      (ctx) => `Total must be finite for percentage calculation, got ${ctx.total}`,
      {
        code: InvalidDivisorError.code,
        context: {
          part: part.toString(),
          total: total.toString()
        }
      }
    );
  }

  if (total.isZero()) {
    throw new DivisionByZeroError(
      'Cannot calculate percentage with zero total',
      {
        code: DivisionByZeroError.code,
        context: { part: part.toString() }
      }
    );
  }

  return part.dividedBy(total).times(100);
}

// Использование
const percentage = calculatePercentage(
  new Decimal('25'),
  new Decimal('100')
); // ✅ 25%
```

---

## Edge Cases

### Специальные значения делителя

```typescript
import Decimal from 'decimal.js';

// NaN как делитель
divide(100, NaN);              // ❌ InvalidDivisorError

// Infinity как делитель
divide(100, Infinity);         // ❌ InvalidDivisorError
divide(100, -Infinity);        // ❌ InvalidDivisorError

// С Decimal.js
divideDecimal(
  new Decimal('100'),
  new Decimal('Infinity')
);                             // ❌ InvalidDivisorError

divideDecimal(
  new Decimal('100'),
  new Decimal('NaN')
);                             // ❌ InvalidDivisorError
```

### Валидные значения

```typescript
// Деление на малое число (но конечное)
divide(100, 0.0001);           // ✅ 1,000,000

// Деление на отрицательное число
divide(100, -5);               // ✅ -20

// Деление на дробь
divideDecimal(
  new Decimal('100'),
  new Decimal('0.333333')
);                             // ✅ ~300.00030...

// Деление на очень большое число
divide(100, 1e308);            // ✅ ~1e-306
```

### Результат деления может быть невалидным

```typescript
// Даже если делитель валидный, результат может быть infinity
divide(1e308, 1e-308);         // ✅ Infinity (но не ошибка деления!)

// Это нормальный результат, не ошибка делителя
// Если нужна проверка результата - используйте ArithmeticOverflowError
```

---

## Обработка ошибок

### По типу ошибки

```typescript
import { InvalidDivisorError } from '@polymarket/errors';

try {
  const result = divide(dividend, divisor);
} catch (error) {
  if (InvalidDivisorError.is(error)) {
    console.error('Invalid divisor:', error.context);
    showUserMessage('Calculation error: divisor is not a valid number');
  } else {
    console.error('Unexpected error:', error);
    throw error;
  }
}
```

### По коду ошибки

```typescript
import { InvalidDivisorError, TradingError } from '@polymarket/errors';

try {
  const result = calculatePercentage(part, total);
} catch (error) {
  if (error instanceof TradingError) {
    if (error.code === InvalidDivisorError.code) {
      logger.error('Invalid divisor in percentage calculation', {
        error: error.toJSON()
      });
      return null;
    }
  }
  throw error;
}
```

### С логированием

```typescript
import { InvalidDivisorError } from '@polymarket/errors';

function safeDivide(
  dividend: Decimal,
  divisor: Decimal,
  context: string
): Decimal | null {
  try {
    return divideDecimal(dividend, divisor);
  } catch (error) {
    if (InvalidDivisorError.is(error)) {
      logger.warn('Division failed due to invalid divisor', {
        context,
        divisor: divisor.toString(),
        dividend: dividend.toString(),
        error: error.toJSON()
      });
      return null;
    }
    throw error;
  }
}

// Использование
const result = safeDivide(
  new Decimal('100'),
  userProvidedDivisor,
  'price-calculation'
);

if (result === null) {
  showError('Invalid input for calculation');
}
```

---

## Связанные ошибки

- [DivisionByZeroError](../value-objects/division-by-zero.md) - деление на ноль (конкретный случай невалидного делителя)
- [ArithmeticOverflowError](../value-objects/arithmetic-overflow.md) - результат операции вышел за пределы допустимых значений
- [InvalidTickSizeError](./invalid-tick-size.md) - невалидный размер тика для округления

## См. также

- [Math Errors](./README.md) - Обзор категории
- [Обработка ошибок](../error-handling.md) - Best practices
- [Главная документация](../README.md)
