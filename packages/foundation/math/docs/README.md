# @polymarket/math - Документация

Чистые математические операции с Decimal.js для торговой системы Polymarket.

## Содержание

- [Decimal Operations](./decimal/README.md) - Арифметические операции
- [Rounding Operations](./rounding/README.md) - Операции округления к tick size
- [Validation Utilities](./validation/README.md) - Валидация чисел

## Быстрая навигация

### Реализованные функции

| Функция | Категория | Описание | Документация |
|---------|-----------|----------|--------------|
| `addDecimal(a, b)` | Decimal | Сложение двух чисел | [→](./decimal/add.md) |
| `subtractDecimal(a, b)` | Decimal | Вычитание чисел | [→](./decimal/subtract.md) |
| `multiplyDecimal(a, b)` | Decimal | Умножение чисел | [→](./decimal/multiply.md) |
| `divideDecimal(a, b)` | Decimal | Деление чисел | [→](./decimal/divide.md) |
| `averageDecimal(a, b)` | Decimal | Среднее значение | [→](./decimal/average.md) |
| `compareDecimal(a, b)` | Decimal | Сравнение чисел | [→](./decimal/compare.md) |
| `equalsDecimal(a, b)` | Decimal | Строгое равенство | [→](./decimal/compare.md#equalsdecimal) |
| `lessThan/greaterThan...` | Decimal | Операторы сравнения | [→](./decimal/compare.md) |
| `roundDecimal(value)` | Decimal | Округление half-up | [→](./decimal/round.md) |
| `floor/ceil/truncDecimal` | Decimal | Округление к/от нуля | [→](./decimal/round.md) |
| `roundToTick(value, tickSize, mode?)` | Rounding | Округление к tick size | [→](./rounding/README.md#roundtotick) |
| `floorToTick(value, tickSize)` | Rounding | Floor к tick size | [→](./rounding/README.md#floortotick) |
| `ceilToTick(value, tickSize)` | Rounding | Ceil к tick size | [→](./rounding/README.md#ceiltotick) |
| `mathFloorToTick(value, tickSize)` | Rounding | Math floor к tick | [→](./rounding/README.md#mathfloortotick) |
| `mathCeilToTick(value, tickSize)` | Rounding | Math ceil к tick | [→](./rounding/README.md#mathceiltotick) |
| `roundToPrecision(value, places, mode?)` | Rounding | Округление до N знаков | [→](./rounding/README.md#roundtoprecision) |
| `isFiniteDecimal(value)` | Validation | Проверка конечности | [→](./validation/README.md#isfinitedecimal) |
| `isPositiveDecimal(value)` | Validation | Проверка > 0 | [→](./validation/README.md#ispositivedecimal) |
| `isNonNegativeDecimal(value)` | Validation | Проверка >= 0 | [→](./validation/README.md#isnonnegativedecimal) |

## Философия пакета

### Core Layer - Чистая математика

`@polymarket/math` находится на **Core Layer** архитектуры и предоставляет чистые математические функции:

```
┌─────────────────────────────────────┐
│  Application Layer                  │  ← Бизнес-логика приложения
├─────────────────────────────────────┤
│  Domain Layer (Value Objects)       │  ← Result pattern, бизнес-валидация
├─────────────────────────────────────┤
│  Core Layer (@polymarket/math)      │  ← Чистые функции, throw на невозможности
└─────────────────────────────────────┘
```

**Что делает Core Layer:**
- ✅ Чистые математические операции
- ✅ Throw на математические невозможности (overflow, division by zero)
- ✅ Высокая точность с Decimal.js
- ✅ Без зависимости от бизнес-контекста

**Что НЕ делает Core Layer:**
- ❌ Не проверяет бизнес-правила (min/max значения)
- ❌ Не использует Result pattern (это для Domain Layer)
- ❌ Не зависит от других domain concepts

### Пример разделения ответственности

```typescript
// ❌ Неправильно: математика проверяет бизнес-правила
function addDecimal(a: Decimal, b: Decimal): Decimal {
  if (a.isNegative()) {
    throw new Error('Negative values not allowed'); // Бизнес-правило!
  }
  return a.plus(b);
}

// ✅ Правильно: математика = чистая функция
function addDecimal(a: Decimal, b: Decimal): Decimal {
  const result = a.plus(b);
  if (!result.isFinite()) {
    throw new ArithmeticOverflowError('Overflow'); // Математическая невозможность
  }
  return result;
}

// Бизнес-правила - в Value Objects (Domain Layer)
class Price {
  private constructor(private readonly value: Decimal) {}

  static fromDecimal(value: Decimal): Result<Price, ValidationError> {
    // Бизнес-валидация: цена должна быть в [0.0001, 0.9999]
    if (value.lessThan(0.0001) || value.greaterThan(0.9999)) {
      return Err(new InvalidPriceError('Price out of range'));
    }
    return Ok(new Price(value));
  }

  add(other: Price): Result<Price, ValidationError> {
    // Используем чистую математику из Core Layer
    const sum = addDecimal(this.value, other.value);

    // Применяем бизнес-правила в Domain Layer
    return Price.fromDecimal(sum);
  }
}
```

## Принципы дизайна

### 1. Throw vs Result

**В @polymarket/math используется throw:**
```typescript
// Математическая невозможность = throw
function divideDecimal(a: Decimal, b: Decimal): Decimal {
  if (!b.isFinite() || b.isZero()) {
    throw new InvalidDivisorError('Cannot divide by zero or non-finite');
  }
  return a.dividedBy(b);
}
```

**В Value Objects используется Result:**
```typescript
// Бизнес-правило = Result
class Price {
  divide(divisor: Price): Result<Price, ValidationError> {
    try {
      const result = divideDecimal(this.value, divisor.value);
      return Price.fromDecimal(result); // Может вернуть Err
    } catch (error) {
      if (InvalidDivisorError.is(error)) {
        return Err(new ValidationError('Division failed'));
      }
      throw error;
    }
  }
}
```

### 2. Чистые функции

Все функции в `@polymarket/math`:
- Не имеют побочных эффектов
- Детерминированные (одинаковый вход → одинаковый выход)
- Легко тестируются
- Легко композируются

```typescript
// ✅ Чистая функция
function addDecimal(a: Decimal, b: Decimal): Decimal {
  return a.plus(b);
}

// ❌ НЕ чистая функция
let counter = 0;
function addDecimalWithLogging(a: Decimal, b: Decimal): Decimal {
  counter++; // Побочный эффект
  console.log('Adding:', a, b); // Побочный эффект
  return a.plus(b);
}
```

### 3. Математические свойства

Функции сохраняют математические свойства:

```typescript
// Коммутативность сложения
addDecimal(a, b) === addDecimal(b, a)

// Ассоциативность сложения
addDecimal(addDecimal(a, b), c) === addDecimal(a, addDecimal(b, c))

// Нейтральный элемент
addDecimal(a, MATH_CONSTANTS.ZERO) === a
```

## Использование

### Установка

```bash
npm install @polymarket/math
```

### Импорты

```typescript
// Отдельные функции
import { addDecimal, divideDecimal } from '@polymarket/math';

// Константы
import { MATH_CONSTANTS } from '@polymarket/math';

// Из подмодулей
import { addDecimal } from '@polymarket/math/decimal';
import { roundToTick } from '@polymarket/math/rounding';
```

### Базовый пример

```typescript
import Decimal from 'decimal.js';
import { addDecimal, MATH_CONSTANTS } from '@polymarket/math';

const price = new Decimal('0.65');
const increment = MATH_CONSTANTS.ONE;

const newPrice = addDecimal(price, increment);
console.log(newPrice.toString()); // "1.65"
```

## Интеграция с другими пакетами

### @polymarket/errors

Математические функции используют ошибки из `@polymarket/errors`:

```typescript
import { addDecimal } from '@polymarket/math';
import { ArithmeticOverflowError } from '@polymarket/errors';

try {
  const result = addDecimal(new Decimal(Infinity), new Decimal(100));
} catch (error) {
  if (ArithmeticOverflowError.is(error)) {
    console.error('Math error:', error.context);
  }
}
```

**Используемые ошибки:**
- `ArithmeticOverflowError` - результат операции = Infinity
- `InvalidDivisorError` - делитель NaN/Infinity
- `DivisionByZeroError` - деление на ноль
- `InvalidTickSizeError` - tick size <= 0 или не конечен

### @polymarket/value-objects

Value Objects используют math функции для вычислений:

```typescript
import { addDecimal } from '@polymarket/math';
import { Price } from '@polymarket/value-objects';

class Price {
  add(other: Price): Result<Price, ValidationError> {
    // 1. Чистая математика (Core Layer)
    const sum = addDecimal(this.value, other.value);

    // 2. Бизнес-валидация (Domain Layer)
    return Price.fromDecimal(sum);
  }
}
```

## Best Practices

### 1. Используйте константы

```typescript
// ✅ Хорошо
import { MATH_CONSTANTS } from '@polymarket/math';
const result = addDecimal(value, MATH_CONSTANTS.ONE);

// ❌ Плохо
const result = addDecimal(value, new Decimal(1));
```

### 2. Обрабатывайте ошибки

```typescript
// ✅ Хорошо
try {
  const result = divideDecimal(a, b);
} catch (error) {
  if (InvalidDivisorError.is(error)) {
    // Специфичная обработка
  }
  throw error;
}

// ❌ Плохо
const result = divideDecimal(a, b); // Может упасть
```

### 3. Минимизируйте преобразования

```typescript
// ✅ Хорошо: работаем с Decimal
function sum(values: Decimal[]): Decimal {
  return values.reduce(addDecimal, MATH_CONSTANTS.ZERO);
}

// ❌ Плохо: конвертируем туда-обратно
function sum(values: number[]): number {
  return values.reduce((a, b) =>
    addDecimal(new Decimal(a), new Decimal(b)).toNumber(), 0
  );
}
```

## Дальнейшее изучение

- [Decimal Operations](./decimal/README.md) - Полная документация арифметических операций
- [addDecimal](./decimal/add.md) - Детальная документация по сложению
- [Decimal.js Docs](https://mikemcl.github.io/decimal.js/) - Документация Decimal.js
