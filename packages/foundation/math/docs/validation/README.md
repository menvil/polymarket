# Validation Utilities

Утилиты для валидации Decimal значений.

## Содержание

- [isFiniteDecimal - Проверка конечности](#isfinitedecimal)
- [isPositiveDecimal - Проверка положительности](#ispositivedecimal)
- [isNonNegativeDecimal - Проверка неотрицательности](#isnonnegativedecimal)
- [isZeroDecimal - Приблизительное сравнение с нулем](#iszerodecimal)
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

Проверяет что значение близко к нулю в пределах epsilon.

```typescript
function isZeroDecimal(value: Decimal, epsilon: Decimal): boolean
```

### Параметры

- `value` - Проверяемое значение
- `epsilon` - Максимальная допустимая разница от нуля (**обязательный параметр**)

### Возвращает

`true` если `|value| < epsilon`

### Философия

**Параметр epsilon обязателен** - нет значения по умолчанию.

Explicit лучше implicit - пользователь должен явно указывать точность.

### Примеры

```typescript
import { isZeroDecimal } from '@polymarket/math/validation';
import Decimal from 'decimal.js';

// Приблизительное сравнение с нулем
const value = new Decimal('0.0001');
const epsilon = new Decimal('0.001');

isZeroDecimal(value, epsilon); // true (|0.0001| < 0.001)

// Строгое сравнение
value.isZero(); // false (не строго ноль)
```

### Разные epsilon для разных контекстов

```typescript
const diff = new Decimal('0.0001');

// Высокая точность для числовых вычислений
const computationalPrecision = new Decimal('1e-10');
isZeroDecimal(diff, computationalPrecision); // false

// Бизнес-точность (1 цент)
const businessPrecision = new Decimal('0.01');
isZeroDecimal(diff, businessPrecision); // true
```

### Строгое vs приблизительное

```typescript
const value = new Decimal('0.0000001');

// Строгое сравнение с нулем
value.isZero(); // false (не строго ноль)

// Приблизительное сравнение
isZeroDecimal(value, new Decimal('1e-6'));  // true (близко в пределах epsilon)
isZeroDecimal(value, new Decimal('1e-8'));  // false (вне пределов epsilon)
```

### Когда использовать

#### 1. Проверка погрешности вычислений

```typescript
const a = new Decimal(10);
const b = new Decimal(3);
const result = a.dividedBy(b).times(b); // 10.000000000000002?

const diff = result.minus(a);
const precisionError = new Decimal('1e-10');

if (isZeroDecimal(diff, precisionError)) {
  // Результат равен исходному в пределах точности
}
```

#### 2. Приблизительное равенство значений

```typescript
function approximatelyEqual(
  a: Decimal,
  b: Decimal,
  tolerance: Decimal
): boolean {
  const diff = a.minus(b);
  return isZeroDecimal(diff, tolerance);
}

const price1 = new Decimal('10.5678');
const price2 = new Decimal('10.5679');
const centTolerance = new Decimal('0.01');

approximatelyEqual(price1, price2, centTolerance); // true (в пределах цента)
```

#### 3. Проверка "незначительного остатка"

```typescript
const remaining = new Decimal('0.0003');
const insignificantThreshold = new Decimal('0.001');

if (isZeroDecimal(remaining, insignificantThreshold)) {
  // Остаток незначителен, можем игнорировать
}
```

### Граничные случаи

```typescript
// Значение равно epsilon - НЕ считается близким к нулю
const value = new Decimal('0.001');
const epsilon = new Decimal('0.001');
isZeroDecimal(value, epsilon); // false (|0.001| < 0.001 = false)

// Значение чуть меньше epsilon - считается близким к нулю
const almostEpsilon = new Decimal('0.0009999');
isZeroDecimal(almostEpsilon, epsilon); // true

// Работает с отрицательными значениями
isZeroDecimal(new Decimal('-0.0005'), new Decimal('0.001')); // true
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
import { isPositiveDecimal } from '@polymarket/math/validation';
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

### 2. Для приблизительного сравнения используйте isZeroDecimal с явным epsilon

```typescript
// ✅ Хорошо: явный epsilon показывает намерение
const computationalPrecision = new Decimal('1e-10');
const businessPrecision = new Decimal('0.01');

if (isZeroDecimal(diff, computationalPrecision)) {
  // Числовая точность
}

if (isZeroDecimal(remaining, businessPrecision)) {
  // Бизнес-логика
}
```

### 3. Для строгого сравнения используйте Decimal методы

```typescript
// ✅ Хорошо: явный метод для строгого сравнения
if (value.isZero()) {
  // Строго равно нулю
}

// ✅ Хорошо: для приблизительного сравнения с isZeroDecimal
const epsilon = new Decimal('0.0001');
if (isZeroDecimal(value, epsilon)) {
  // Близко к нулю в пределах epsilon
}

// ✅ Альтернатива: прямое использование Decimal методов
if (value.abs().lessThan(epsilon)) {
  // Тот же эффект
}
```

### 4. Комбинируйте валидаторы для сложных проверок

```typescript
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
