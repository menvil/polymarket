# Decimal Operations

Базовые арифметические операции с Decimal.js для высокоточных вычислений.

## Обзор

Decimal operations - это чистые математические функции для работы с `Decimal` числами. Все функции:
- ✅ **Throw на математические невозможности** (overflow, division by zero)
- ✅ **НЕ проверяют бизнес-правила** (это задача Value Objects)
- ✅ **Сохраняют математические свойства** (коммутативность, ассоциативность)
- ✅ **Используют Decimal.js** для высокой точности

## Философия

**Core Layer vs Domain Layer:**

```typescript
// ❌ Неправильно: математика проверяет бизнес-правила
function addDecimal(a: Decimal, b: Decimal): Decimal {
  if (a.isNegative() || b.isNegative()) {
    throw new Error('Negative values not allowed'); // Это бизнес-правило!
  }
  return a.plus(b);
}

// ✅ Правильно: математика = чистая функция
function addDecimal(a: Decimal, b: Decimal): Decimal {
  const result = a.plus(b);

  // Только математические невозможности
  if (!result.isFinite()) {
    throw new ArithmeticOverflowError('Overflow');
  }

  return result;
}

// Бизнес-правила - в Value Objects
class Price {
  add(other: Price): Result<Price, ValidationError> {
    const sum = addDecimal(this.value, other.value); // Математика
    return Price.fromDecimal(sum); // Бизнес-валидация
  }
}
```

## Каталог операций

### Реализовано

| Функция | Описание | Документация |
|---------|----------|--------------|
| `addDecimal(a, b)` | Сложение двух чисел | [→](./add.md) |
| `subtractDecimal(a, b)` | Вычитание чисел | [→](./subtract.md) |
| `multiplyDecimal(a, b)` | Умножение чисел | [→](./multiply.md) |
| `divideDecimal(a, b)` | Деление чисел | [→](./divide.md) |
| `averageDecimal(a, b)` | Среднее значение | [→](./average.md) |
| `equalsDecimal(a, b)` | Строгое равенство | [→](./compare.md#equalsdecimal) |
| `lessThanDecimal(a, b)` | Строгое меньше (<) | [→](./compare.md#lessthnadecimal) |
| `lessThanOrEqualDecimal(a, b)` | Меньше или равно (<=) | [→](./compare.md#lessthanorequaldecimal) |
| `greaterThanDecimal(a, b)` | Строгое больше (>) | [→](./compare.md#greaterthandecimal) |
| `greaterThanOrEqualDecimal(a, b)` | Больше или равно (>=) | [→](./compare.md#greaterthanorequaldecimal) |
| `compareDecimal(a, b)` | Сравнение (-1/0/1) | [→](./compare.md#comparedecimal) |
| `roundDecimal(value)` | Округление (half-up) | [→](./round.md#rounddecimal) |
| `roundTowardZeroDecimal(value)` | Округление к нулю | [→](./round.md#roundtowardzerodecimal) |
| `roundAwayFromZeroDecimal(value)` | Округление от нуля | [→](./round.md#roundawayfromzerodecimal) |
| `truncDecimal(value)` | Округление к нулю (усечение) | [→](./round.md#truncdecimal) |

## Общие паттерны использования

### Базовое использование

```typescript
import Decimal from 'decimal.js';
import { addDecimal } from '@polymarket/math';

const a = new Decimal('10.5');
const b = new Decimal('20.3');

const result = addDecimal(a, b);
console.log(result.toString()); // "30.8"
```

### Использование констант

```typescript
import Decimal from 'decimal.js';
import { addDecimal, MATH_CONSTANTS } from '@polymarket/math';

// ✅ Хорошо: используем константы
const incremented = addDecimal(value, MATH_CONSTANTS.ONE);
const doubled = addDecimal(value, value);

// ❌ Плохо: создаём Decimal каждый раз
const incremented2 = addDecimal(value, new Decimal(1));
```

### Обработка ошибок

```typescript
import { addDecimal } from '@polymarket/math';
import { ArithmeticOverflowError } from '@polymarket/errors';

try {
  const result = addDecimal(a, b);
  processResult(result);
} catch (error) {
  if (ArithmeticOverflowError.is(error)) {
    console.error('Math error:', error.message);
    console.error('Context:', error.context);
  }
  throw error;
}
```

### Цепочки операций

```typescript
import Decimal from 'decimal.js';
import { addDecimal, multiplyDecimal } from '@polymarket/math';

const price = new Decimal('0.65');
const quantity = new Decimal('100');
const fee = new Decimal('0.50');

// (price * quantity) + fee
const total = addDecimal(
  multiplyDecimal(price, quantity),
  fee
);
```

## Математические свойства

### Коммутативность (только для add и multiply)

```typescript
import { equalsDecimal } from '@polymarket/math';

equalsDecimal(addDecimal(a, b), addDecimal(b, a)) // ✅ Всегда true
equalsDecimal(multiplyDecimal(a, b), multiplyDecimal(b, a)) // ✅ Всегда true

!equalsDecimal(subtractDecimal(a, b), subtractDecimal(b, a)) // ❌ Обычно разные
!equalsDecimal(divideDecimal(a, b), divideDecimal(b, a)) // ❌ Обычно разные
```

### Ассоциативность (только для add и multiply)

```typescript
import { equalsDecimal } from '@polymarket/math';

// Сложение
equalsDecimal(addDecimal(addDecimal(a, b), c), addDecimal(a, addDecimal(b, c)))

// Умножение
equalsDecimal(multiplyDecimal(multiplyDecimal(a, b), c), multiplyDecimal(a, multiplyDecimal(b, c)))
```

### Нейтральные элементы

```typescript
import { equalsDecimal, MATH_CONSTANTS } from '@polymarket/math';

// Ноль для сложения
equalsDecimal(addDecimal(a, MATH_CONSTANTS.ZERO), a)

// Единица для умножения
equalsDecimal(multiplyDecimal(a, MATH_CONSTANTS.ONE), a)
```

## Точность Decimal.js

Преимущество Decimal.js над стандартным JavaScript `number`:

```typescript
// ❌ Проблема с обычными числами
console.log(0.1 + 0.2); // 0.30000000000000004

// ✅ Решение с Decimal.js
const result = addDecimal(new Decimal('0.1'), new Decimal('0.2'));
console.log(result.toString()); // "0.3"
```

## Производительность

### Оптимизация 1: Переиспользуйте константы

```typescript
// ✅ Быстро
import { MATH_CONSTANTS } from '@polymarket/math';
const result = addDecimal(value, MATH_CONSTANTS.ONE);

// ❌ Медленно
const result = addDecimal(value, new Decimal(1));
```

### Оптимизация 2: Минимизируйте преобразования

```typescript
// ✅ Хорошо: работаем с Decimal
function calculateTotal(prices: Decimal[]): Decimal {
  return prices.reduce(
    (sum, price) => addDecimal(sum, price),
    MATH_CONSTANTS.ZERO
  );
}

// ❌ Плохо: конвертируем туда-обратно
function calculateTotal(prices: number[]): number {
  return prices.reduce((sum, price) => {
    const a = new Decimal(sum);
    const b = new Decimal(price);
    return addDecimal(a, b).toNumber();
  }, 0);
}
```

## Интеграция с Value Objects

Decimal operations используются внутри Value Objects:

```typescript
// Core Layer: @polymarket/math
export function addDecimal(a: Decimal, b: Decimal): Decimal {
  // Только математика
}

// Domain Layer: @polymarket/value-objects
export class Price {
  add(other: Price): Result<Price, ValidationError> {
    const sum = addDecimal(this.value, other.value); // Используем math
    return Price.fromDecimal(sum); // Применяем бизнес-правила
  }
}
```

## См. также

- [Rounding Operations](../rounding/README.md) - Операции округления
- [Validation Utilities](../validation/README.md) - Валидация чисел
- [MATH_CONSTANTS](../../src/constants.ts) - Математические константы
- [Decimal.js Documentation](https://mikemcl.github.io/decimal.js/) - Полная документация Decimal.js
