# divideDecimal

Делит одно Decimal значение на другое с проверками делителя и overflow.

## Описание

Функция `divideDecimal` выполняет деление двух `Decimal` чисел с комплексной валидацией математической корректности. Это чистая математическая операция без бизнес-правил.

**Когда использовать:**

- Расчёт средней цены
- Вычисление коэффициентов и отношений
- Конвертация единиц измерения
- Любые арифметические операции с высокой точностью

**Когда НЕ использовать:**

- Если нужна бизнес-валидация результата (используйте Value Objects)
- Если нужна проверка диапазонов (это бизнес-правило, не математика)

## Сигнатура

```typescript
function divideDecimal(dividend: Decimal, divisor: Decimal): Decimal
```

### Параметры

|Параметр|Тип|Описание|
|----------|----------|----------|
|`dividend`|`Decimal`|Делимое|
|`divisor`|`Decimal`|Делитель|

### Возвращаемое значение

`Decimal` - Частное dividend / divisor

### Выбрасываемые ошибки

- **InvalidOperandError** - Если делимое не является конечным числом (NaN, Infinity, -Infinity)
- **InvalidDivisorError** - Если делитель не является конечным числом (NaN, Infinity, -Infinity)
- **DivisionByZeroError** - Если делитель равен нулю
- **ArithmeticOverflowError** - Если результат не является конечным числом (Infinity, -Infinity)

## Математические свойства

Функция не является коммутативной, но сохраняет другие свойства:

- **НЕ коммутативно:** `divideDecimal(a, b) ≠ divideDecimal(b, a)` (обычно)
- **Деление на себя:** `divideDecimal(a, a) === 1` (для любого ненулевого a)
- **Нейтральный элемент:** `divideDecimal(a, MATH_CONSTANTS.ONE) === a`
- **Обратимость:** `divideDecimal(a, b).times(b) === a`

## Примеры использования

### Базовое деление

```typescript
import Decimal from 'decimal.js';
import { divideDecimal } from '@polymarket/math';

// Целое деление
const result1 = divideDecimal(new Decimal(10), new Decimal(2));
console.log(result1.toString()); // "5"

// Деление с остатком
const result2 = divideDecimal(new Decimal(10), new Decimal(3));
console.log(result2.toFixed(3)); // "3.333"

// Отрицательные числа
const result3 = divideDecimal(new Decimal(-10), new Decimal(-2));
console.log(result3.toString()); // "5"

// Смешанные знаки
const result4 = divideDecimal(new Decimal(10), new Decimal(-2));
console.log(result4.toString()); // "-5"
```

### Высокая точность (преимущество Decimal.js)

```typescript
import Decimal from 'decimal.js';
import { divideDecimal } from '@polymarket/math';

// Проблема обычного JavaScript
console.log(1 / 3); // 0.3333333333333333 (ограниченная точность) ❌

// Решение с Decimal.js
const result = divideDecimal(new Decimal('1'), new Decimal('3'));
console.log(result.toFixed(20)); // "0.33333333333333333333" ✅
```

### Расчёт средней цены

```typescript
import Decimal from 'decimal.js';
import { divideDecimal } from '@polymarket/math';

const totalCost = new Decimal('196.29'); // Общая стоимость
const quantity = new Decimal('3'); // Количество токенов

const averagePrice = divideDecimal(totalCost, quantity);
console.log(averagePrice.toString()); // "65.43"
```

### Расчёт процентов

```typescript
import Decimal from 'decimal.js';
import { divideDecimal, multiplyDecimal } from '@polymarket/math';

const part = new Decimal('75');
const total = new Decimal('300');

// Процент от целого
const ratio = divideDecimal(part, total);
const percentage = multiplyDecimal(ratio, new Decimal('100'));
console.log(percentage.toString()); // "25"
```

### Использование констант

```typescript
import Decimal from 'decimal.js';
import { divideDecimal, MATH_CONSTANTS } from '@polymarket/math';

const value = new Decimal('84');

// Деление на единицу (нейтральный элемент)
const result1 = divideDecimal(value, MATH_CONSTANTS.ONE);
console.log(result1.toString()); // "84"

// Деление пополам
const result2 = divideDecimal(value, MATH_CONSTANTS.TWO);
console.log(result2.toString()); // "42"

// Деление на 10
const result3 = divideDecimal(value, MATH_CONSTANTS.TEN);
console.log(result3.toString()); // "8.4"
```

### Обработка ошибок деления на ноль

```typescript
import Decimal from 'decimal.js';
import { divideDecimal } from '@polymarket/math';
import { DivisionByZeroError } from '@polymarket/errors';

try {
  const result = divideDecimal(new Decimal(10), new Decimal(0));
} catch (error) {
  if (DivisionByZeroError.is(error)) {
    console.error('Cannot divide by zero');
    console.error('Context:', error.context);
    // Context: { operation: 'divide', a: '10', b: '0' }
  }
}
```

### Обработка невалидного делителя

```typescript
import Decimal from 'decimal.js';
import { divideDecimal } from '@polymarket/math';
import { InvalidDivisorError } from '@polymarket/errors';

try {
  const result = divideDecimal(new Decimal(10), new Decimal(NaN));
} catch (error) {
  if (InvalidDivisorError.is(error)) {
    console.error('Invalid divisor:', error.message);
    console.error('Context:', error.context);
    // Context: { operation: 'divide', a: '10', b: 'NaN' }
  }
}

try {
  const result = divideDecimal(new Decimal(10), new Decimal(Infinity));
} catch (error) {
  if (InvalidDivisorError.is(error)) {
    console.error('Divisor must be finite');
  }
}
```

### Обработка overflow

```typescript
import Decimal from 'decimal.js';
import { divideDecimal } from '@polymarket/math';
import { ArithmeticOverflowError } from '@polymarket/errors';

try {
  // Overflow возникает при делении огромного числа на крошечное
  // Decimal.js имеет maxE = 9e15, используем значения близкие к этой границе
  const huge = new Decimal('5e' + (Decimal.maxE - 1000));
  const tiny = new Decimal('1e-1500');

  const result = divideDecimal(huge, tiny);
} catch (error) {
  if (ArithmeticOverflowError.is(error)) {
    console.error('Division overflow:', error.message);
    console.error('Context:', error.context);
    // Context: { operation: 'divide', a: '5e8999999999999000', b: '1e-1500' }
  }
}
```

### Обработка невалидного делимого

```typescript
import Decimal from 'decimal.js';
import { divideDecimal } from '@polymarket/math';
import { InvalidOperandError } from '@polymarket/errors';

try {
  const result = divideDecimal(new Decimal(NaN), new Decimal(10));
} catch (error) {
  if (InvalidOperandError.is(error)) {
    console.error('Invalid dividend:', error.message);
    console.error('Context:', error.context);
    // Context: { operation: 'divide', a: 'NaN', b: '10', paramName: 'a', value: 'NaN' }
  }
}

try {
  const result = divideDecimal(new Decimal(Infinity), new Decimal(10));
} catch (error) {
  if (InvalidOperandError.is(error)) {
    console.error('Dividend must be finite');
  }
}
```

### Цепочка операций

```typescript
import Decimal from 'decimal.js';
import { divideDecimal, multiplyDecimal, addDecimal, MATH_CONSTANTS } from '@polymarket/math';

const totalCost = new Decimal('100');
const itemCount = new Decimal('4');
const taxRate = new Decimal('0.1'); // 10%

// (totalCost / itemCount) * (1 + taxRate)
const pricePerItem = divideDecimal(totalCost, itemCount);
const priceWithTax = multiplyDecimal(
  pricePerItem,
  addDecimal(MATH_CONSTANTS.ONE, taxRate)
);

console.log(priceWithTax.toString()); // "27.5"
```

### Конвертация единиц

```typescript
import Decimal from 'decimal.js';
import { divideDecimal } from '@polymarket/math';

// Конвертация из базовых единиц (USDC имеет 6 decimals)
const baseUnits = new Decimal('100500000'); // 100.50 USDC в базовых единицах
const divisor = new Decimal('1000000'); // 10^6

const amount = divideDecimal(baseUnits, divisor);
console.log(amount.toString()); // "100.5"
```

## Edge Cases

### Деление ноля на число

```typescript
import Decimal from 'decimal.js';
import { divideDecimal, MATH_CONSTANTS } from '@polymarket/math';

const result = divideDecimal(MATH_CONSTANTS.ZERO, new Decimal('5'));
console.log(result.toString()); // "0"
```

### Деление на единицу

```typescript
import Decimal from 'decimal.js';
import { divideDecimal, MATH_CONSTANTS } from '@polymarket/math';

const value = new Decimal('123.456');

// Деление на единицу не меняет значение
const result = divideDecimal(value, MATH_CONSTANTS.ONE);
console.log(result.equals(value)); // true
```

### Деление на себя

```typescript
import Decimal from 'decimal.js';
import { divideDecimal, MATH_CONSTANTS } from '@polymarket/math';

const value = new Decimal('42.5');

// Деление на себя даёт единицу
const result = divideDecimal(value, value);
console.log(result.equals(MATH_CONSTANTS.ONE)); // true
console.log(result.toString()); // "1"
```

### Деление отрицательных чисел

```typescript
import Decimal from 'decimal.js';
import { divideDecimal } from '@polymarket/math';

// Отрицательное / Отрицательное = Положительное
const result1 = divideDecimal(new Decimal(-10), new Decimal(-2));
console.log(result1.toString()); // "5"

// Положительное / Отрицательное = Отрицательное
const result2 = divideDecimal(new Decimal(10), new Decimal(-2));
console.log(result2.toString()); // "-5"

// Отрицательное / Положительное = Отрицательное
const result3 = divideDecimal(new Decimal(-10), new Decimal(2));
console.log(result3.toString()); // "-5"
```

### Работа с очень маленькими числами

```typescript
import Decimal from 'decimal.js';
import { divideDecimal } from '@polymarket/math';

const tiny1 = new Decimal('1e-10');
const tiny2 = new Decimal('2e-5');

const result = divideDecimal(tiny1, tiny2);
console.log(result.toString()); // "0.000005"
```

### Периодические дроби

```typescript
import Decimal from 'decimal.js';
import { divideDecimal } from '@polymarket/math';

// 1/3 = 0.333... (периодическая дробь)
const result = divideDecimal(new Decimal('1'), new Decimal('3'));
console.log(result.toFixed(10)); // "0.3333333333"

// Проверка обратимости: (1/3) * 3 = 1
const check = result.times(3);
console.log(check.toFixed(10)); // "1.0000000000"
```

## Производительность

```typescript
import Decimal from 'decimal.js';
import { divideDecimal, MATH_CONSTANTS } from '@polymarket/math';

const value = new Decimal('100');

// ✅ Хорошо: переиспользуем константы
const result1 = divideDecimal(value, MATH_CONSTANTS.TWO);

// ❌ Плохо: создаём новый Decimal каждый раз
const result2 = divideDecimal(value, new Decimal(2));
```

**Совет:** Используйте `MATH_CONSTANTS` для часто используемых делителей (1, 2, 10, 100).

## Интеграция с Value Objects

```typescript
import Decimal from 'decimal.js';
import { divideDecimal } from '@polymarket/math';
import { Price, Quantity, Money } from '@polymarket/value-objects';

// Деление внутри Value Object
class Position {
  private constructor(
    private readonly totalCost: Money,
    private readonly quantity: Quantity
  ) {}

  calculateAveragePrice(): Result<Price, ValidationError> {
    // 1. Чистая математика (core layer)
    const avgPrice = divideDecimal(
      this.totalCost.amount,
      this.quantity.value
    );

    // 2. Бизнес-валидация (domain layer)
    return Price.fromDecimal(avgPrice);
  }
}
```

## Связь с другими операциями

```typescript
import Decimal from 'decimal.js';
import { divideDecimal, multiplyDecimal } from '@polymarket/math';

const a = new Decimal(10);
const b = new Decimal(3);

// Деление
const quotient = divideDecimal(a, b); // 10 / 3 = 3.333...

// Умножение (обратная операция)
const product = multiplyDecimal(quotient, b); // 3.333... * 3 = 10

// Связь: (a / b) * b = a
console.log(product.toFixed(10)); // "10.0000000000"
console.log(product.equals(a)); // true (с учётом точности)
```

## Обработка всех типов ошибок

```typescript
import Decimal from 'decimal.js';
import { divideDecimal } from '@polymarket/math';
import {
  DivisionByZeroError,
  InvalidDivisorError,
  ArithmeticOverflowError,
} from '@polymarket/errors';

function safeDivide(a: Decimal, b: Decimal): Decimal | null {
  try {
    return divideDecimal(a, b);
  } catch (error) {
    if (DivisionByZeroError.is(error)) {
      console.error('Cannot divide by zero');
      return null;
    }

    if (InvalidDivisorError.is(error)) {
      console.error('Invalid divisor (NaN or Infinity)');
      return null;
    }

    if (ArithmeticOverflowError.is(error)) {
      console.error('Division resulted in overflow');
      return null;
    }

    // Неожиданная ошибка - пробрасываем дальше
    throw error;
  }
}

// Использование
const result1 = safeDivide(new Decimal(10), new Decimal(2)); // 5
const result2 = safeDivide(new Decimal(10), new Decimal(0)); // null (division by zero)
const result3 = safeDivide(new Decimal(10), new Decimal(NaN)); // null (invalid divisor)
```

## Сравнение с умножением

```typescript
import Decimal from 'decimal.js';
import { divideDecimal, multiplyDecimal } from '@polymarket/math';

const a = new Decimal(100);
const b = new Decimal(4);

// Деление уменьшает значение (если делитель > 1)
const quotient = divideDecimal(a, b); // 100 / 4 = 25

// Умножение увеличивает значение (если множитель > 1)
const product = multiplyDecimal(a, b); // 100 * 4 = 400

// Обратные операции
console.log(divideDecimal(product, b).equals(a)); // true
console.log(multiplyDecimal(quotient, b).equals(a)); // true
```

## См. также

- [addDecimal](./add.md) - Сложение Decimal чисел
- [subtractDecimal](./subtract.md) - Вычитание Decimal чисел
- [multiplyDecimal](./multiply.md) - Умножение Decimal чисел
- [averageDecimal](./average.md) - Среднее значение двух чисел
- [DivisionByZeroError](../../../errors/docs/value-objects/division-by-zero.md) - Ошибка деления на ноль
- [InvalidOperandError](../../../errors/docs/math/invalid-operand.md) - Ошибка невалидного операнда
- [InvalidDivisorError](../../../errors/docs/math/invalid-divisor.md) - Ошибка невалидного делителя
- [ArithmeticOverflowError](../../../errors/docs/value-objects/arithmetic-overflow.md) - Ошибка overflow
