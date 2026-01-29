# Операции округления Decimal

Базовые функции округления для Decimal значений.

## Содержание

- [roundDecimal](#rounddecimal) - Стандартное округление (half-up)
- [floorDecimal](#floordecimal) - Округление к нулю (вниз для положительных)
- [ceilDecimal](#ceildecimal) - Округление от нуля (вверх для положительных)
- [truncDecimal](#truncdecimal) - Усечение дробной части
- [Сравнение функций](#сравнение-функций)
- [Рекомендации](#рекомендации)

---

## roundDecimal

Округляет Decimal к ближайшему целому используя **standard half-up rounding**.

```typescript
function roundDecimal(value: Decimal): Decimal
```

### Режим округления: ROUND_HALF_UP

**Правило:** 0.5 всегда округляется **вверх** (от нуля).

Это **НЕ** banker's rounding (ROUND_HALF_EVEN).

### Примеры

```typescript
import Decimal from 'decimal.js';
import { roundDecimal } from '@polymarket/math';

// Положительные числа
roundDecimal(new Decimal('2.4')); // 2
roundDecimal(new Decimal('2.5')); // 3 (вверх!)
roundDecimal(new Decimal('2.6')); // 3

roundDecimal(new Decimal('3.5')); // 4 (вверх!)
roundDecimal(new Decimal('4.5')); // 5 (вверх!)

// Отрицательные числа
roundDecimal(new Decimal('-2.4')); // -2
roundDecimal(new Decimal('-2.5')); // -3 (от нуля!)
roundDecimal(new Decimal('-2.6')); // -3

// Ноль и целые числа
roundDecimal(new Decimal('0'));   // 0
roundDecimal(new Decimal('10'));  // 10
roundDecimal(new Decimal('10.0')); // 10
```

### Отличие от Banker's Rounding

**ROUND_HALF_UP (roundDecimal):**
```typescript
roundDecimal(new Decimal('2.5')); // 3 (всегда вверх)
roundDecimal(new Decimal('3.5')); // 4 (всегда вверх)
roundDecimal(new Decimal('4.5')); // 5 (всегда вверх)
```

**ROUND_HALF_EVEN (banker's rounding):**
```typescript
// Для banker's rounding используйте напрямую Decimal.js:
new Decimal('2.5').toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN); // 2 (к чётному)
new Decimal('3.5').toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN); // 4 (к чётному)
new Decimal('4.5').toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN); // 4 (к чётному)
```

### Когда использовать

- **Финансовые расчёты** где требуется стандартное округление
- **Округление денежных сумм** (например, к целому центу)
- **Большинство бизнес-приложений** (стандартный режим)

### Валидация

```typescript
import { roundDecimal } from '@polymarket/math';
import { InvalidOperandError } from '@polymarket/errors';

try {
  const result = roundDecimal(new Decimal('10.5'));
  console.log(result.toString()); // "11"
} catch (error) {
  if (InvalidOperandError.is(error)) {
    console.error('Invalid operand:', error.message);
  }
}
```

**Выбрасывает ошибки:**
- `InvalidOperandError` - если value не конечное число (NaN/Infinity)
- `ArithmeticOverflowError` - если результат не конечен

---

## floorDecimal

Округляет Decimal **к нулю** (вниз для положительных, вверх для отрицательных).

```typescript
function floorDecimal(value: Decimal): Decimal
```

### Поведение

- **Положительные числа:** Округление **вниз** (отбрасывание дробной части)
- **Отрицательные числа:** Округление **вверх** (к нулю)
- **Результат:** Ближайшее целое число **не превышающее по модулю** исходное

### Примеры

```typescript
import Decimal from 'decimal.js';
import { floorDecimal } from '@polymarket/math';

// Положительные числа (округление вниз)
floorDecimal(new Decimal('2.1')); // 2
floorDecimal(new Decimal('2.5')); // 2
floorDecimal(new Decimal('2.9')); // 2

// Отрицательные числа (округление к нулю)
floorDecimal(new Decimal('-2.1')); // -2 (к нулю!)
floorDecimal(new Decimal('-2.5')); // -2 (к нулю!)
floorDecimal(new Decimal('-2.9')); // -2 (к нулю!)

// Граничные случаи
floorDecimal(new Decimal('0'));   // 0
floorDecimal(new Decimal('10'));  // 10
floorDecimal(new Decimal('-10')); // -10
```

### Отличие от Math.floor()

**floorDecimal (округление к нулю):**
```typescript
floorDecimal(new Decimal('2.9'));  // 2
floorDecimal(new Decimal('-2.9')); // -2 (к нулю!)
```

**Math.floor() (округление к -Infinity):**
```typescript
Math.floor(2.9);  // 2
Math.floor(-2.9); // -3 (к -Infinity!)
```

### Когда использовать

- **Усечение к меньшему целому** для положительных чисел
- **Консервативные оценки** (округление в меньшую сторону)
- **Деление нацело** с остатком

---

## ceilDecimal

Округляет Decimal **от нуля** (вверх для положительных, вниз для отрицательных).

```typescript
function ceilDecimal(value: Decimal): Decimal
```

### Поведение

- **Положительные числа:** Округление **вверх**
- **Отрицательные числа:** Округление **вниз** (от нуля)
- **Результат:** Ближайшее целое число **не меньшее по модулю** исходного

### Примеры

```typescript
import Decimal from 'decimal.js';
import { ceilDecimal } from '@polymarket/math';

// Положительные числа (округление вверх)
ceilDecimal(new Decimal('2.1')); // 3
ceilDecimal(new Decimal('2.5')); // 3
ceilDecimal(new Decimal('2.9')); // 3

// Отрицательные числа (округление от нуля)
ceilDecimal(new Decimal('-2.1')); // -3 (от нуля!)
ceilDecimal(new Decimal('-2.5')); // -3 (от нуля!)
ceilDecimal(new Decimal('-2.9')); // -3 (от нуля!)

// Граничные случаи
ceilDecimal(new Decimal('0'));   // 0
ceilDecimal(new Decimal('10'));  // 10
ceilDecimal(new Decimal('-10')); // -10
```

### Отличие от Math.ceil()

**ceilDecimal (округление от нуля):**
```typescript
ceilDecimal(new Decimal('2.1'));  // 3
ceilDecimal(new Decimal('-2.1')); // -3 (от нуля!)
```

**Math.ceil() (округление к +Infinity):**
```typescript
Math.ceil(2.1);  // 3
Math.ceil(-2.1); // -2 (к +Infinity!)
```

### Когда использовать

- **Округление в большую сторону** для положительных чисел
- **Пессимистичные оценки** (округление вверх для безопасности)
- **Распределение ресурсов** (гарантия достаточности)

---

## truncDecimal

Усекает дробную часть, оставляя только целую.

```typescript
function truncDecimal(value: Decimal): Decimal
```

### Поведение

Эквивалентно `floorDecimal` — отбрасывает дробную часть.

- **Положительные:** отбрасывание дроби → округление вниз
- **Отрицательные:** отбрасывание дроби → округление к нулю

### Примеры

```typescript
import Decimal from 'decimal.js';
import { truncDecimal } from '@polymarket/math';

// Положительные числа
truncDecimal(new Decimal('2.1')); // 2
truncDecimal(new Decimal('2.9')); // 2

// Отрицательные числа
truncDecimal(new Decimal('-2.1')); // -2
truncDecimal(new Decimal('-2.9')); // -2

// Граничные случаи
truncDecimal(new Decimal('0'));   // 0
truncDecimal(new Decimal('10.0')); // 10
```

### truncDecimal === floorDecimal

**В текущей реализации** обе функции эквивалентны:

```typescript
import { equalsDecimal } from '@polymarket/math';

equalsDecimal(truncDecimal(value), floorDecimal(value)) // всегда true
```

Обе функции используют `Decimal.ROUND_DOWN` (округление к нулю).

**Важно:** Семантически `floorDecimal` должна округлять к `-Infinity` (как математическая функция `floor`), но текущая реализация округляет к нулю для совместимости с `truncDecimal`. Если реализация изменится на `Decimal.ROUND_FLOOR`, эквивалентность нарушится для отрицательных чисел. Для истинного математического floor используйте `mathFloorDecimal`.

### Когда использовать

- **Извлечение целой части** числа
- **Конвертация в целочисленный тип** (int)
- **Любой случай** где нужна только целая часть

---

## Сравнение функций

### Таблица округления положительных чисел

| Значение | roundDecimal | floorDecimal | ceilDecimal | truncDecimal |
|----------|--------------|--------------|-------------|--------------|
| 2.1      | 2            | 2            | 3           | 2            |
| 2.5      | **3**        | 2            | 3           | 2            |
| 2.9      | 3            | 2            | 3           | 2            |

### Таблица округления отрицательных чисел

| Значение | roundDecimal | floorDecimal | ceilDecimal | truncDecimal |
|----------|--------------|--------------|-------------|--------------|
| -2.1     | -2           | -2           | **-3**      | -2           |
| -2.5     | **-3**       | -2           | **-3**      | -2           |
| -2.9     | -3           | -2           | **-3**      | -2           |

### Ключевые отличия

```typescript
const value = new Decimal('2.5');

roundDecimal(value); // 3  (half-up)
floorDecimal(value); // 2  (к нулю)
ceilDecimal(value);  // 3  (от нуля)
truncDecimal(value); // 2  (отбросить дробь)
```

Для отрицательных:
```typescript
const negative = new Decimal('-2.5');

roundDecimal(negative); // -3 (от нуля для .5)
floorDecimal(negative); // -2 (к нулю)
ceilDecimal(negative);  // -3 (от нуля)
truncDecimal(negative); // -2 (отбросить дробь)
```

---

## Рекомендации

### 1. Выбирайте функцию по логике, а не по знаку

```typescript
// ✅ Хорошо: явное намерение
function roundToNearestCent(amount: Decimal): Decimal {
  return roundDecimal(amount); // Стандартное округление
}

// ❌ Плохо: неясное намерение
function roundAmount(amount: Decimal): Decimal {
  if (amount.isPositive()) {
    return ceilDecimal(amount); // Почему ceil?
  } else {
    return floorDecimal(amount); // Почему floor?
  }
}
```

### 2. Для финансов используйте roundDecimal (half-up)

```typescript
// ✅ Хорошо: стандартное округление для денег
const totalCents = roundDecimal(amount.times(100));

// ❌ Плохо: banker's rounding без явной причины
const totalCents = amount
  .times(100)
  .toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN);
```

### 3. Документируйте режим округления в критичных местах

```typescript
/**
 * Округляет цену к ближайшему центу
 *
 * Использует ROUND_HALF_UP: 0.5 всегда округляется вверх.
 * Примеры: $2.50 → $3, $3.50 → $4
 */
function roundToCent(price: Decimal): Decimal {
  const scaled = price.times(100);
  const rounded = roundDecimal(scaled);
  return rounded.dividedBy(100);
}
```

### 4. Для tick размеров используйте roundToTick

Для округления к tick size (например, 0.01, 0.05) используйте специализированные функции из `@polymarket/math/rounding`:

```typescript
import { roundToTick } from '@polymarket/math/rounding';

const price = new Decimal('0.6567');
const tickSize = new Decimal('0.01');

// ✅ Правильно: используем roundToTick
const rounded = roundToTick(price, tickSize);
// 0.66

// ❌ Неправильно: roundDecimal для tick size
const wrong = roundDecimal(price.dividedBy(tickSize))
  .times(tickSize);
// Может дать неточный результат
```

---

## Производительность

### Оптимизация 1: Избегайте повторных округлений

```typescript
// ✅ Быстро: одно округление
const result = roundDecimal(
  value.times(100).dividedBy(50)
);

// ❌ Медленно: множественные округления
const temp = roundDecimal(value.times(100));
const result = roundDecimal(temp.dividedBy(50));
```

### Оптимизация 2: Для простого усечения используйте truncDecimal

```typescript
// ✅ Быстро: truncDecimal
const intPart = truncDecimal(value);

// ❌ Медленнее: через toInteger
const intPart = new Decimal(value.toInteger());
```

---

## Интеграция с Value Objects

```typescript
import { roundDecimal, ceilDecimal } from '@polymarket/math';

class Money {
  private constructor(private readonly _cents: Decimal) {}

  /**
   * Округляет к ближайшему центу (half-up)
   */
  roundToCent(): Money {
    const rounded = roundDecimal(this._cents);
    return new Money(rounded);
  }

  /**
   * Округляет вверх к ближайшему центу
   */
  ceilToCent(): Money {
    const ceiled = ceilDecimal(this._cents);
    return new Money(ceiled);
  }
}
```

---

## Связанные модули

- [Decimal Operations](./README.md) - Арифметические операции
- [Comparison Operations](./compare.md) - Операции сравнения
- [Rounding Operations](../rounding/README.md) - Операции округления к tick size
- [Decimal.js Rounding Modes](https://mikemcl.github.io/decimal.js/#modes) - Все режимы округления Decimal.js
