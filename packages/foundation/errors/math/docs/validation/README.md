# Validation Utilities

Утилиты для валидации Decimal значений.

## Содержание

- [isFiniteDecimal - Проверка конечности](#isfinitedecimal)
- [isPositiveDecimal - Проверка положительности](#ispositivedecimal)
- [isNonNegativeDecimal - Проверка неотрицательности](#isnonnegativedecimal)
- [isZeroDecimal - Строгое сравнение с нулем](#iszerodecimal)
- [Примеры использования](#примеры-использования)

---

## isFiniteDecimal

Проверяет что значение конечное (не NaN и не ±Infinity).

```typescript
function isFiniteDecimal(value: Decimal): boolean
```

### Примеры

```typescript
import { isFiniteDecimal } from '@polymarket/math/validation';
import Decimal from 'decimal.js';

isFiniteDecimal(new Decimal(10));       // true
isFiniteDecimal(new Decimal(-10));      // true
isFiniteDecimal(new Decimal(0));        // true
isFiniteDecimal(new Decimal(1.5));      // true

isFiniteDecimal(new Decimal(NaN));      // false
isFiniteDecimal(new Decimal(Infinity)); // false
isFiniteDecimal(new Decimal(-Infinity)); // false
```

### Когда использовать

- **Валидация входных данных** перед арифметическими операциями
- **Проверка результатов** внешних API
- **Guard clauses** в функциях

```typescript
import Decimal from 'decimal.js';
import { isFiniteDecimal } from '@polymarket/math/validation';

function processValue(value: Decimal): Decimal {
  if (!isFiniteDecimal(value)) {
    throw new Error('Value must be finite');
  }
  // ... дальнейшая обработка
}
```

---

## isPositiveDecimal

Проверяет что значение строго положительное (> 0).

```typescript
function isPositiveDecimal(value: Decimal): boolean
```

### Примеры

```typescript
import { isPositiveDecimal } from '@polymarket/math/validation';
import Decimal from 'decimal.js';

isPositiveDecimal(new Decimal(10));      // true
isPositiveDecimal(new Decimal(0.1));     // true
isPositiveDecimal(new Decimal('1e-10')); // true

isPositiveDecimal(new Decimal(0));       // false (ноль НЕ положителен)
isPositiveDecimal(new Decimal(-10));     // false
isPositiveDecimal(new Decimal(-0.1));    // false
```

### Отличие от isNonNegativeDecimal

**Ключевое отличие:** Отношение к нулю.

```typescript
const zero = new Decimal(0);

isPositiveDecimal(zero);    // false (> 0)
isNonNegativeDecimal(zero); // true  (>= 0)
```

### Когда использовать

- **Валидация цены** - цена должна быть > 0
- **Валидация количества** - количество должно быть > 0
- **Валидация делителя** - делитель должен быть != 0

```typescript
import Decimal from 'decimal.js';
import { isPositiveDecimal } from '@polymarket/math/validation';

class Price {
  static fromDecimal(value: Decimal): Result<Price, ValidationError> {
    if (!isPositiveDecimal(value)) {
      return Err(new ValidationError('Price must be positive'));
    }
    return Ok(new Price(value));
  }
}
```

---

## isNonNegativeDecimal

Проверяет что значение неотрицательное (>= 0).

```typescript
function isNonNegativeDecimal(value: Decimal): boolean
```

### Примеры

```typescript
import { isNonNegativeDecimal } from '@polymarket/math/validation';
import Decimal from 'decimal.js';

isNonNegativeDecimal(new Decimal(10));   // true
isNonNegativeDecimal(new Decimal(0.1));  // true
isNonNegativeDecimal(new Decimal(0));    // true (ключевое отличие!)

isNonNegativeDecimal(new Decimal(-10));  // false
isNonNegativeDecimal(new Decimal(-0.1)); // false
```

### Сравнение с isPositiveDecimal

| Значение | isPositiveDecimal | isNonNegativeDecimal |
|----------|-------------------|----------------------|
| 10       | ✅ true           | ✅ true              |
| 0.1      | ✅ true           | ✅ true              |
| 0        | ❌ false          | ✅ true              |
| -0.1     | ❌ false          | ❌ false             |
| -10      | ❌ false          | ❌ false             |

### Когда использовать

- **Валидация баланса** - баланс может быть 0
- **Валидация накопленного значения** - может начинаться с 0
- **Валидация счётчика** - может быть 0

```typescript
class Balance {
  static fromDecimal(value: Decimal): Result<Balance, ValidationError> {
    if (!isNonNegativeDecimal(value)) {
      return Err(new ValidationError('Balance cannot be negative'));
    }
    return Ok(new Balance(value));
  }
}
```

---

## isZeroDecimal

Проверяет что значение строго равно нулю.

```typescript
function isZeroDecimal(value: Decimal): boolean
```

### Параметры

- `value` - Проверяемое значение

### Возвращает

`true` если значение строго равно 0

### Примеры

```typescript
import { isZeroDecimal } from '@polymarket/math/validation';
import Decimal from 'decimal.js';

// Строгое сравнение с нулем
isZeroDecimal(new Decimal(0));        // true
isZeroDecimal(new Decimal('0.0'));    // true
isZeroDecimal(new Decimal('-0'));     // true

isZeroDecimal(new Decimal('0.0001')); // false
isZeroDecimal(new Decimal('1e-10'));  // false
```

### Приблизительное сравнение

Для приблизительного сравнения с нулем используйте `value.abs().lessThan(epsilon)`:

```typescript
const value = new Decimal('0.0001');
const epsilon = new Decimal('0.001');

// Строгое сравнение
isZeroDecimal(value); // false

// Приблизительное сравнение
value.abs().lessThan(epsilon); // true
```

---

## Примеры использования

### Валидация перед арифметикой

```typescript
import { isFiniteDecimal, isPositiveDecimal } from '@polymarket/math/validation';
import { divideDecimal } from '@polymarket/math';
import Decimal from 'decimal.js';

function safeDivide(a: Decimal, b: Decimal): Result<Decimal, ValidationError> {
  if (!isFiniteDecimal(a) || !isFiniteDecimal(b)) {
    return Err(new ValidationError('Operands must be finite'));
  }

  if (!isPositiveDecimal(b)) {
    return Err(new ValidationError('Divisor must be positive'));
  }

  try {
    return Ok(divideDecimal(a, b));
  } catch (error) {
    return Err(new ValidationError('Division failed'));
  }
}
```

### Value Object с валидацией

```typescript
import { isPositiveDecimal, isFiniteDecimal } from '@polymarket/math/validation';
import Decimal from 'decimal.js';

class Quantity {
  private constructor(private readonly _value: Decimal) {}

  static fromDecimal(value: Decimal): Result<Quantity, ValidationError> {
    if (!isFiniteDecimal(value)) {
      return Err(new ValidationError('Quantity must be finite'));
    }

    if (!isPositiveDecimal(value)) {
      return Err(new ValidationError('Quantity must be positive'));
    }

    return Ok(new Quantity(value));
  }

  value(): Decimal {
    return this._value;
  }
}
```

### Проверка незначительной разницы

```typescript
import { subtractDecimal } from '@polymarket/math';
import Decimal from 'decimal.js';

function pricesMatch(
  price1: Decimal,
  price2: Decimal,
  tickSize: Decimal
): boolean {
  const diff = subtractDecimal(price1, price2).abs();

  // Разница меньше tick size считается незначительной
  return diff.lessThan(tickSize);
}

const p1 = new Decimal('10.567');
const p2 = new Decimal('10.568');
const tick = new Decimal('0.01');

pricesMatch(p1, p2, tick); // true (разница 0.001 < 0.01)
```

### Guard clauses в функциях

```typescript
import { isNonNegativeDecimal } from '@polymarket/math/validation';
import Decimal from 'decimal.js';

function calculateFee(amount: Decimal, feeRate: Decimal): Decimal {
  // Guard 1: amount должен быть неотрицательным
  if (!isNonNegativeDecimal(amount)) {
    throw new Error('Amount cannot be negative');
  }

  // Guard 2: feeRate должен быть неотрицательным
  if (!isNonNegativeDecimal(feeRate)) {
    throw new Error('Fee rate cannot be negative');
  }

  // Оптимизация: если amount близок к нулю, комиссия = 0
  const negligibleThreshold = new Decimal('0.0001');
  if (amount.abs().lessThan(negligibleThreshold)) {
    return new Decimal(0);
  }

  return amount.times(feeRate);
}
```

---

## Best Practices

### 1. Используйте правильную функцию для контекста

```typescript
// ❌ Плохо: isNonNegativeDecimal когда нужен isPositiveDecimal
class Price {
  constructor(value: Decimal) {
    if (!isNonNegativeDecimal(value)) {  // Разрешает 0!
      throw new Error('Invalid price');
    }
  }
}

// ✅ Хорошо: isPositiveDecimal для цены
class Price {
  constructor(value: Decimal) {
    if (!isPositiveDecimal(value)) {  // Запрещает 0
      throw new Error('Price must be positive');
    }
  }
}
```

### 2. Для строгого сравнения используйте isZeroDecimal или Decimal методы

```typescript
// ✅ Хорошо: строгое сравнение с isZeroDecimal
if (isZeroDecimal(value)) {
  // Строго равно нулю
}

// ✅ Альтернатива: прямое использование Decimal метода
if (value.isZero()) {
  // Строго равно нулю
}
```

### 3. Для приблизительного сравнения используйте Decimal методы

```typescript
// ✅ Хорошо: явный epsilon показывает намерение
const computationalPrecision = new Decimal('1e-10');
const businessPrecision = new Decimal('0.01');

// Приблизительное сравнение для числовой точности
if (diff.abs().lessThan(computationalPrecision)) {
  // Близко к нулю в пределах вычислительной точности
}

// Приблизительное сравнение для бизнес-логики
if (remaining.abs().lessThan(businessPrecision)) {
  // Близко к нулю в пределах бизнес-точности (1 цент)
}

// ✅ Альтернатива с использованием .lt() (короткая форма)
const epsilon = new Decimal('0.0001');
if (value.abs().lt(epsilon)) {
  // Близко к нулю в пределах epsilon
}
```

### 4. Комбинируйте валидаторы для сложных проверок

```typescript
import Decimal from 'decimal.js';
import { isFiniteDecimal, isPositiveDecimal } from '@polymarket/math/validation';

function validatePrice(value: Decimal): Result<void, ValidationError> {
  // Проверка 1: Конечность
  if (!isFiniteDecimal(value)) {
    return Err(new ValidationError('Price must be finite'));
  }

  // Проверка 2: Положительность
  if (!isPositiveDecimal(value)) {
    return Err(new ValidationError('Price must be positive'));
  }

  // Все проверки прошли
  return Ok(undefined);
}
```

---

## Связанные модули

- [Decimal Operations](../decimal/README.md) - Арифметические операции
- [Rounding Operations](../rounding/README.md) - Операции округления
