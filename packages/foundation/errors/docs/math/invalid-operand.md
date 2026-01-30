# InvalidOperandError

Ошибка невалидного операнда в математических операциях.

## Описание

Выбрасывается при попытке выполнить математическую операцию с невалидным операндом: `NaN`, `Infinity` или `-Infinity`.

Это математическая невозможность, а не бизнес-правило. Операции с такими значениями не имеют математического смысла и всегда приводят к некорректным результатам.

Используется для валидации **входных параметров** математических функций, до выполнения операции.

## Свойства

| Свойство | Значение |
|----------|----------|
| **Код** | `INVALID_OPERAND` |
| **Severity** | `low` |
| **Класс** | `InvalidOperandError` |
| **Пакет** | `@polymarket/errors` |
| **Категория** | Math |

## Когда использовать

- Валидация операндов перед выполнением математических операций
- Проверка результатов вычислений на математическую корректность
- Операции с `Decimal.js` где операнды могут быть невалидными
- Вычисление добавления, вычитания, умножения, округления

## Импорт

```typescript
import { InvalidOperandError } from '@polymarket/errors';

// Для примеров с Decimal:
import Decimal from 'decimal.js';
```

---

## Примеры использования

### 1. Базовое использование (сложение)

```typescript
import Decimal from 'decimal.js';
import { InvalidOperandError } from '@polymarket/errors';

function addDecimal(a: Decimal, b: Decimal): Decimal {
  // Валидация первого операнда
  if (!a.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `First operand must be finite, got ${ctx.operand}`,
      {
        context: {
          operand: a.toString(),
          operation: 'add',
          position: 'first'
        }
      }
    );
  }

  // Валидация второго операнда
  if (!b.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `Second operand must be finite, got ${ctx.operand}`,
      {
        context: {
          operand: b.toString(),
          operation: 'add',
          position: 'second'
        }
      }
    );
  }

  return a.plus(b);
}

// Использование
try {
  const result = addDecimal(new Decimal('100'), new Decimal('NaN'));
} catch (error) {
  if (InvalidOperandError.is(error)) {
    console.error('Invalid operand:', error.context?.operand);
    // Invalid operand: NaN
  }
}
```

### 2. Вычитание с валидацией

```typescript
import Decimal from 'decimal.js';
import { InvalidOperandError } from '@polymarket/errors';

function subtractDecimal(a: Decimal, b: Decimal): Decimal {
  if (!a.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `Minuend must be finite, got ${ctx.value}`,
      {
        context: {
          value: a.toString(),
          operation: 'subtract',
          role: 'minuend'
        }
      }
    );
  }

  if (!b.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `Subtrahend must be finite, got ${ctx.value}`,
      {
        context: {
          value: b.toString(),
          operation: 'subtract',
          role: 'subtrahend'
        }
      }
    );
  }

  return a.minus(b);
}

// Использование
const result = subtractDecimal(
  new Decimal('100'),
  new Decimal('25')
); // ✅ 75
```

### 3. Умножение с валидацией

```typescript
import Decimal from 'decimal.js';
import { InvalidOperandError } from '@polymarket/errors';

function multiplyDecimal(a: Decimal, b: Decimal): Decimal {
  if (!a.isFinite() || !b.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `Both operands must be finite, got a=${ctx.a}, b=${ctx.b}`,
      {
        context: {
          a: a.toString(),
          b: b.toString(),
          operation: 'multiply'
        }
      }
    );
  }

  return a.times(b);
}

// Использование
const result = multiplyDecimal(
  new Decimal('0.65'),
  new Decimal('100')
); // ✅ 65
```

### 4. Округление с валидацией value

```typescript
import Decimal from 'decimal.js';
import { InvalidOperandError, InvalidDecimalPlacesError } from '@polymarket/errors';

function roundToPrecision(
  value: Decimal,
  decimalPlaces: number,
  roundingMode: Decimal.Rounding
): Decimal {
  // Валидация value
  if (!value.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `Value must be finite, got ${ctx.value}`,
      {
        context: {
          value: value.toString(),
          decimalPlaces: String(decimalPlaces),
          operation: 'roundToPrecision'
        }
      }
    );
  }

  // Валидация decimalPlaces
  const decimalPlacesDecimal = new Decimal(decimalPlaces);
  if (!decimalPlacesDecimal.isFinite() ||
      decimalPlacesDecimal.isNegative() ||
      !decimalPlacesDecimal.isInteger()) {
    throw new InvalidDecimalPlacesError(
      (ctx) => `Decimal places must be a non-negative integer, got ${ctx.decimalPlaces}`,
      {
        context: {
          decimalPlaces: decimalPlacesDecimal.toString(),
          value: value.toString(),
          operation: 'roundToPrecision'
        }
      }
    );
  }

  return value.toDecimalPlaces(decimalPlaces, roundingMode);
}

// Использование
const rounded = roundToPrecision(
  new Decimal('10.567'),
  2,
  Decimal.ROUND_HALF_UP
); // ✅ 10.57
```

### 5. Вычисление среднего значения

```typescript
import Decimal from 'decimal.js';
import { InvalidOperandError } from '@polymarket/errors';

function averageDecimal(a: Decimal, b: Decimal): Decimal {
  // Валидация обоих операндов
  if (!a.isFinite() || !b.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `Both values must be finite for average calculation, got a=${ctx.a}, b=${ctx.b}`,
      {
        context: {
          a: a.toString(),
          b: b.toString(),
          operation: 'average'
        }
      }
    );
  }

  const sum = a.plus(b);
  const divisor = new Decimal(2);

  return sum.dividedBy(divisor);
}

// Использование
const avg = averageDecimal(
  new Decimal('0.65'),
  new Decimal('0.75')
); // ✅ 0.70
```

### 6. Сериализация Quantity в JSON (Value Objects)

```typescript
import { QuantityService, QuantityLossySerializer } from '@polymarket/value-objects/quantity';
import { InvalidOperandError } from '@polymarket/errors';

// Создание Quantity
const qtyResult = QuantityService.create(10.5);
if (!qtyResult.ok) {
  console.error('Failed to create quantity');
  return;
}

const qty = qtyResult.value;

// Lossy сериализация (number-based, может потерять точность для больших чисел)
const jsonResult = QuantityLossySerializer.toJSON(qty);

if (!jsonResult.ok) {
  // Если toJSON вернул ошибку - это InvalidOperandError
  // когда Quantity содержит non-finite значение (защитная проверка)
  console.error('Cannot serialize non-finite Quantity:', jsonResult.error.message);
  return;
}

// ✅ { value: 10.5 }
console.log(jsonResult.value);

// ВАЖНО: Quantity имеет Core инвариант что значение должно быть finite.
// При создании Quantity через QuantityService.create() non-finite значения
// возвращают Err с InvalidQuantityError.
//
// Проверка isFinite() внутри QuantityLossySerializer.toJSON() - это
// defensive guard для защиты от гипотетических багов в upstream коде.
// В нормальной ситуации эта проверка никогда не должна срабатывать.
```

---

## Edge Cases

### Специальные значения операндов

```typescript
import Decimal from 'decimal.js';

// NaN как операнд
addDecimal(new Decimal('NaN'), new Decimal('100'));     // ❌ InvalidOperandError
addDecimal(new Decimal('100'), new Decimal('NaN'));     // ❌ InvalidOperandError

// Infinity как операнд
addDecimal(new Decimal('Infinity'), new Decimal('100')); // ❌ InvalidOperandError
subtractDecimal(new Decimal('100'), new Decimal('-Infinity')); // ❌ InvalidOperandError

// С Decimal.js
multiplyDecimal(
  new Decimal('100'),
  new Decimal('Infinity')
);                                                        // ❌ InvalidOperandError
```

### Валидные значения

```typescript
// Сложение малых чисел
addDecimal(
  new Decimal('0.0001'),
  new Decimal('0.0002')
);                                                        // ✅ 0.0003

// Вычитание отрицательных чисел
subtractDecimal(
  new Decimal('-10'),
  new Decimal('-5')
);                                                        // ✅ -5

// Умножение на ноль
multiplyDecimal(
  new Decimal('100'),
  new Decimal('0')
);                                                        // ✅ 0

// Очень большие числа (но конечные)
addDecimal(
  new Decimal('1e100'),
  new Decimal('1e100')
);                                                        // ✅ 2e100
```

### Результат может быть невалидным

```typescript
// Даже если операнды валидные, результат может быть infinity
addDecimal(
  new Decimal('1e308'),
  new Decimal('1e308')
);                                                        // ✅ Infinity (но не ошибка операндов!)

// Это ArithmeticOverflowError, не InvalidOperandError
// Если нужна проверка результата - используйте ArithmeticOverflowError
```

---

## Обработка ошибок

### По типу ошибки

```typescript
import { InvalidOperandError } from '@polymarket/errors';

try {
  const result = addDecimal(a, b);
} catch (error) {
  if (InvalidOperandError.is(error)) {
    console.error('Invalid operand:', error.context);
    showUserMessage('Calculation error: invalid input value');
  } else {
    console.error('Unexpected error:', error);
    throw error;
  }
}
```

### По коду ошибки

```typescript
import { InvalidOperandError, TradingError } from '@polymarket/errors';

try {
  const result = averageDecimal(a, b);
} catch (error) {
  if (error instanceof TradingError) {
    if (error.code === InvalidOperandError.code) {
      logger.error('Invalid operand in average calculation', {
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
import { InvalidOperandError } from '@polymarket/errors';

function safeAdd(
  a: Decimal,
  b: Decimal,
  context: string
): Decimal | null {
  try {
    return addDecimal(a, b);
  } catch (error) {
    if (InvalidOperandError.is(error)) {
      logger.warn('Addition failed due to invalid operand', {
        context,
        a: a.toString(),
        b: b.toString(),
        error: error.toJSON()
      });
      return null;
    }
    throw error;
  }
}

// Использование
const result = safeAdd(
  userProvidedValueA,
  userProvidedValueB,
  'price-calculation'
);

if (result === null) {
  showError('Invalid input for calculation');
}
```

---

## Связанные ошибки

- [InvalidDecimalPlacesError](./invalid-decimal-places.md) - невалидное количество десятичных знаков для округления
- [InvalidDivisorError](./invalid-divisor.md) - невалидный делитель в операции деления
- [ArithmeticOverflowError](../value-objects/arithmetic-overflow.md) - результат операции вышел за пределы допустимых значений
- [InvalidTickSizeError](./invalid-tick-size.md) - невалидный размер тика для округления

## См. также

- [Math Errors](./README.md) - Обзор категории
- [Обработка ошибок](../error-handling.md) - Best practices
- [Главная документация](../README.md)
