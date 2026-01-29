# Операции сравнения Decimal

Функции для строгого сравнения Decimal значений.

## Содержание

- [compareDecimal](#comparedecimal) - Трёхстороннее сравнение (-1/0/1)
- [equalsDecimal](#equalsdecimal) - Строгое равенство
- [lessThanDecimal](#lessthandecimal) - Строгое меньше (<)
- [lessThanOrEqualDecimal](#lessthanorequaldecimal) - Меньше или равно (<=)
- [greaterThanDecimal](#greaterthandecimal) - Строгое больше (>)
- [greaterThanOrEqualDecimal](#greaterthanorequaldecimal) - Больше или равно (>=)
- [Приблизительное сравнение](#приблизительное-сравнение)

---

## compareDecimal

Трёхстороннее сравнение двух Decimal значений.

```typescript
function compareDecimal(a: Decimal, b: Decimal): -1 | 0 | 1
```

### Возвращаемое значение

- `-1` если `a < b`
- `0` если `a === b` (строго равны)
- `1` если `a > b`

### Примеры

```typescript
import Decimal from 'decimal.js';
import { compareDecimal } from '@polymarket/math';

const a = new Decimal('10.5');
const b = new Decimal('20.3');
const c = new Decimal('10.5');

compareDecimal(a, b); // -1 (a < b)
compareDecimal(b, a); // 1  (b > a)
compareDecimal(a, c); // 0  (a === c)
```

### Использование в сортировке

```typescript
const prices = [
  new Decimal('0.65'),
  new Decimal('0.50'),
  new Decimal('0.75'),
];

// Сортировка по возрастанию
prices.sort(compareDecimal);
// [0.50, 0.65, 0.75]

// Сортировка по убыванию
prices.sort((a, b) => compareDecimal(b, a));
// [0.75, 0.65, 0.50]
```

### Особенности

**Строгое сравнение:**
```typescript
const a = new Decimal('0.1');
const b = new Decimal('0.10');
const c = new Decimal('0.100');

compareDecimal(a, b); // 0 (одинаковое математическое значение)
compareDecimal(a, c); // 0 (одинаковое математическое значение)
```

**Валидация невалидных операндов:**
```typescript
import Decimal from 'decimal.js';
import { compareDecimal } from '@polymarket/math';
import { InvalidOperandError } from '@polymarket/errors';

try {
  const nan = new Decimal(NaN);
  const num = new Decimal(10);

  compareDecimal(nan, num); // ❌ Throws InvalidOperandError
} catch (error) {
  if (InvalidOperandError.is(error)) {
    console.error('Cannot compare NaN:', error.message);
    // Context: { a: 'NaN', b: '10', operation: 'compare' }
  }
}
```

---

## equalsDecimal

Строгая проверка равенства двух Decimal значений.

```typescript
function equalsDecimal(a: Decimal, b: Decimal): boolean
```

### Выбрасываемые ошибки

- **InvalidOperandError** - Если операнды не являются конечными числами (NaN, Infinity, -Infinity)

### Примеры

```typescript
import Decimal from 'decimal.js';
import { equalsDecimal } from '@polymarket/math';

const a = new Decimal('10.5');
const b = new Decimal('10.5');
const c = new Decimal('10.50');
const d = new Decimal('10.6');

equalsDecimal(a, b); // true  (одинаковые значения)
equalsDecimal(a, c); // true  (0.5 === 0.50 математически)
equalsDecimal(a, d); // false (разные значения)
```

### Строгое vs приблизительное

**Строгое равенство (equalsDecimal):**
```typescript
const a = new Decimal('0.65');
const b = new Decimal('0.6500000000001');

equalsDecimal(a, b); // false (строго неравны)
```

**Приблизительное равенство (ручная реализация):**
```typescript
function approximatelyEquals(
  a: Decimal,
  b: Decimal,
  epsilon: Decimal
): boolean {
  const diff = a.minus(b).abs();
  return diff.lessThan(epsilon);
}

const a = new Decimal('0.65');
const b = new Decimal('0.6500000000001');
const epsilon = new Decimal('0.0001');

approximatelyEquals(a, b, epsilon); // true (близко в пределах epsilon)
```

### Связь с compareDecimal

**Гарантия согласованности:**
```typescript
equalsDecimal(a, b) === true <=> compareDecimal(a, b) === 0
```

Пример:
```typescript
const a = new Decimal('10.5');
const b = new Decimal('10.5');

// Оба способа дают одинаковый результат
console.log(equalsDecimal(a, b));       // true
console.log(compareDecimal(a, b) === 0); // true
```

---

## lessThanDecimal

Проверяет что `a` строго меньше `b`.

```typescript
function lessThanDecimal(a: Decimal, b: Decimal): boolean
```

### Примеры

```typescript
import Decimal from 'decimal.js';
import { lessThanDecimal } from '@polymarket/math';

const a = new Decimal('10');
const b = new Decimal('20');
const c = new Decimal('10');

lessThanDecimal(a, b); // true  (10 < 20)
lessThanDecimal(b, a); // false (20 не < 10)
lessThanDecimal(a, c); // false (10 не < 10, равны)
```

### Использование в валидации

```typescript
import { lessThanDecimal } from '@polymarket/math';

function validatePrice(price: Decimal, maxPrice: Decimal): boolean {
  // Цена должна быть строго меньше максимальной
  return lessThanDecimal(price, maxPrice);
}

const price = new Decimal('0.65');
const max = new Decimal('0.9999');

validatePrice(price, max); // true
```

### Связь с compareDecimal

```typescript
lessThanDecimal(a, b) === (compareDecimal(a, b) === -1)
```

---

## lessThanOrEqualDecimal

Проверяет что `a` меньше или равно `b`.

```typescript
function lessThanOrEqualDecimal(a: Decimal, b: Decimal): boolean
```

### Примеры

```typescript
import Decimal from 'decimal.js';
import { lessThanOrEqualDecimal } from '@polymarket/math';

const a = new Decimal('10');
const b = new Decimal('20');
const c = new Decimal('10');

lessThanOrEqualDecimal(a, b); // true  (10 <= 20)
lessThanOrEqualDecimal(b, a); // false (20 не <= 10)
lessThanOrEqualDecimal(a, c); // true  (10 <= 10, равны)
```

### Отличие от lessThanDecimal

**Ключевое отличие:** Отношение к равенству.

```typescript
const a = new Decimal('10');
const b = new Decimal('10');

lessThanDecimal(a, b);        // false (не строго меньше)
lessThanOrEqualDecimal(a, b); // true  (равны, значит <=)
```

### Связь с compareDecimal

```typescript
lessThanOrEqualDecimal(a, b) === (compareDecimal(a, b) <= 0)
```

---

## greaterThanDecimal

Проверяет что `a` строго больше `b`.

```typescript
function greaterThanDecimal(a: Decimal, b: Decimal): boolean
```

### Примеры

```typescript
import Decimal from 'decimal.js';
import { greaterThanDecimal } from '@polymarket/math';

const a = new Decimal('20');
const b = new Decimal('10');
const c = new Decimal('20');

greaterThanDecimal(a, b); // true  (20 > 10)
greaterThanDecimal(b, a); // false (10 не > 20)
greaterThanDecimal(a, c); // false (20 не > 20, равны)
```

### Использование в guard clauses

```typescript
import { greaterThanDecimal, MATH_CONSTANTS } from '@polymarket/math';

function processPositiveValue(value: Decimal): void {
  // Guard: значение должно быть > 0
  if (!greaterThanDecimal(value, MATH_CONSTANTS.ZERO)) {
    throw new Error('Value must be positive');
  }

  // ... дальнейшая обработка
}
```

### Связь с compareDecimal

```typescript
greaterThanDecimal(a, b) === (compareDecimal(a, b) === 1)
```

---

## greaterThanOrEqualDecimal

Проверяет что `a` больше или равно `b`.

```typescript
function greaterThanOrEqualDecimal(a: Decimal, b: Decimal): boolean
```

### Примеры

```typescript
import Decimal from 'decimal.js';
import { greaterThanOrEqualDecimal } from '@polymarket/math';

const a = new Decimal('20');
const b = new Decimal('10');
const c = new Decimal('20');

greaterThanOrEqualDecimal(a, b); // true  (20 >= 10)
greaterThanOrEqualDecimal(b, a); // false (10 не >= 20)
greaterThanOrEqualDecimal(a, c); // true  (20 >= 20, равны)
```

### Отличие от greaterThanDecimal

**Ключевое отличие:** Отношение к равенству.

```typescript
const a = new Decimal('10');
const b = new Decimal('10');

greaterThanDecimal(a, b);        // false (не строго больше)
greaterThanOrEqualDecimal(a, b); // true  (равны, значит >=)
```

### Связь с compareDecimal

```typescript
greaterThanOrEqualDecimal(a, b) === (compareDecimal(a, b) >= 0)
```

---

## Приблизительное сравнение

**Важно:** Все встроенные функции сравнения **строгие**. Для приблизительного сравнения нужна явная реализация.

### Когда нужно приблизительное сравнение

1. **Проверка результатов вычислений:**
   ```typescript
   const a = new Decimal(10);
   const b = new Decimal(3);
   const result = a.dividedBy(b).times(b);

   // Может быть 10.000000000000002 вместо строго 10
   const diff = result.minus(a).abs();
   const epsilon = new Decimal('1e-10');

   diff.lessThan(epsilon); // true (приблизительно равны)
   ```

2. **Бизнес-логика с допуском:**
   ```typescript
   function priceMatchesWithTolerance(
     price1: Decimal,
     price2: Decimal,
     tickSize: Decimal
   ): boolean {
     const diff = price1.minus(price2).abs();
     return diff.lessThan(tickSize);
   }

   const p1 = new Decimal('0.567');
   const p2 = new Decimal('0.568');
   const tick = new Decimal('0.01');

   priceMatchesWithTolerance(p1, p2, tick); // true (разница < tick)
   ```

### Реализация approximatelyEquals

```typescript
/**
 * Приблизительное равенство с явным epsilon
 *
 * @param a - Первое значение
 * @param b - Второе значение
 * @param epsilon - Максимальная допустимая разница
 * @returns true если |a - b| < epsilon
 *
 * @example
 * ```typescript
 * const a = new Decimal('0.65');
 * const b = new Decimal('0.6500001');
 * const epsilon = new Decimal('0.0001');
 *
 * approximatelyEquals(a, b, epsilon); // true
 * equalsDecimal(a, b); // false (строго неравны)
 * ```
 */
function approximatelyEquals(
  a: Decimal,
  b: Decimal,
  epsilon: Decimal
): boolean {
  const diff = a.minus(b).abs();
  return diff.lessThan(epsilon);
}
```

### Почему epsilon должен быть явным

**Философия:** Явный лучше неявного.

```typescript
// ❌ Плохо: неясно какой epsilon
if (approximatelyEquals(a, b)) {
  // Что считается "близко"?
}

// ✅ Хорошо: явно видна точность
const epsilon = new Decimal('1e-12'); // Высокая точность
if (approximatelyEquals(a, b, epsilon)) {
  // Близко в пределах погрешности
}
```

---

## Таблица сравнения функций

| Функция | Условие | compareDecimal | Использование |
|---------|---------|----------------|---------------|
| `equalsDecimal(a, b)` | a === b | === 0 | Проверка равенства |
| `lessThanDecimal(a, b)` | a < b | === -1 | Валидация min/max |
| `lessThanOrEqualDecimal(a, b)` | a <= b | <= 0 | Проверка диапазона |
| `greaterThanDecimal(a, b)` | a > b | === 1 | Guard clauses |
| `greaterThanOrEqualDecimal(a, b)` | a >= b | >= 0 | Проверка диапазона |
| `compareDecimal(a, b)` | — | -1/0/1 | Сортировка |

---

## Best Practices

### 1. Используйте правильную функцию для контекста

```typescript
// ✅ Хорошо: lessThanOrEqual для диапазона включительно
function isInRange(value: Decimal, min: Decimal, max: Decimal): boolean {
  return greaterThanOrEqualDecimal(value, min) &&
         lessThanOrEqualDecimal(value, max);
}

// ❌ Плохо: lessThan для диапазона включительно
function isInRange(value: Decimal, min: Decimal, max: Decimal): boolean {
  return greaterThanDecimal(value, min) && // Исключает min!
         lessThanDecimal(value, max);      // Исключает max!
}
```

### 2. Для строгого сравнения используйте встроенные функции

```typescript
// ✅ Хорошо: встроенная функция
if (equalsDecimal(a, b)) {
  // Строго равны
}

// ❌ Плохо: приблизительное сравнение для строгой проверки
const epsilon = new Decimal('1e-100'); // Слишком мал
if (approximatelyEquals(a, b, epsilon)) {
  // Запутанно
}
```

### 3. Для приблизительного сравнения явно указывайте epsilon

```typescript
// ✅ Хорошо: явный epsilon показывает намерение
const tickSize = new Decimal('0.01');
if (approximatelyEquals(price1, price2, tickSize)) {
  // Близко в пределах tick size
}

// ❌ Плохо: неявный epsilon
if (approximatelyEquals(price1, price2)) {
  // Какая точность?
}
```

### 4. Используйте compareDecimal для сортировки

```typescript
// ✅ Хорошо: компактно и читаемо
prices.sort(compareDecimal);

// ❌ Плохо: verbose и медленнее
prices.sort((a, b) => {
  if (lessThanDecimal(a, b)) return -1;
  if (greaterThanDecimal(a, b)) return 1;
  return 0;
});
```

---

## Производительность

### Оптимизация 1: Избегайте повторных вычислений

```typescript
// ✅ Быстро: одно вычисление
const cmp = compareDecimal(a, b);
if (cmp === 0) {
  // равны
} else if (cmp === -1) {
  // a < b
}

// ❌ Медленно: два вызова
if (equalsDecimal(a, b)) {
  // равны
} else if (lessThanDecimal(a, b)) {
  // a < b
}
```

### Оптимизация 2: Используйте встроенные методы Decimal.js

```typescript
// ✅ Быстро: встроенный метод
if (value.isZero()) {
  // Строго ноль
}

// ❌ Медленнее: через сравнение
if (equalsDecimal(value, MATH_CONSTANTS.ZERO)) {
  // Строго ноль
}
```

---

## Интеграция с Value Objects

```typescript
import { equalsDecimal, compareDecimal, lessThanDecimal } from '@polymarket/math';

class Price {
  private constructor(private readonly _value: Decimal) {}

  /**
   * Строгое равенство цен
   */
  equals(other: Price): boolean {
    return equalsDecimal(this._value, other._value);
  }

  /**
   * Сравнение для сортировки
   */
  compare(other: Price): -1 | 0 | 1 {
    return compareDecimal(this._value, other._value);
  }

  /**
   * Проверка что цена меньше другой
   */
  isLessThan(other: Price): boolean {
    return lessThanDecimal(this._value, other._value);
  }
}

// Использование
const prices = [price1, price2, price3];
prices.sort((a, b) => a.compare(b));
```

---

## Связанные модули

- [Decimal Operations](./README.md) - Арифметические операции
- [Rounding Operations](../rounding/README.md) - Операции округления
- [Validation Utilities](../validation/README.md) - Валидация чисел
