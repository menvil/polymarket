# subtractDecimal

Вычитает одно Decimal значение из другого с проверкой overflow.

## Описание

Функция `subtractDecimal` выполняет вычитание двух `Decimal` чисел и проверяет результат на математическую корректность. Это чистая математическая операция без бизнес-правил.

**Важно:** Функция **разрешает отрицательные результаты** - это математически корректно. Проверка на неотрицательность (например, для Quantity) - это бизнес-правило, которое должно выполняться в Value Objects.

## Сигнатура

```typescript
function subtractDecimal(a: Decimal, b: Decimal): Decimal
```

### Параметры

|Параметр|Тип|Описание|
|----------|----------|----------|
|`a`|`Decimal`|Уменьшаемое (из чего вычитаем)|
|`b`|`Decimal`|Вычитаемое (что вычитаем)|

### Возвращаемое значение

`Decimal` - Разность a - b

### Выбрасываемые ошибки

- **InvalidOperandError** - Если операнды не являются конечными числами (NaN, Infinity, -Infinity)
- **ArithmeticOverflowError** - Если результат не является конечным числом (Infinity, -Infinity)

## Математические свойства

### НЕ коммутативно

В отличие от сложения, вычитание **не коммутативно**:

```typescript
subtractDecimal(a, b) !== subtractDecimal(b, a) // Обычно разные значения
```

### Обратная операция к сложению

```typescript
// a - b + b = a
const diff = subtractDecimal(a, b);
const restored = addDecimal(diff, b);
// restored === a
```

### Нейтральный элемент - ноль

```typescript
subtractDecimal(a, MATH_CONSTANTS.ZERO) === a
```

## Примеры использования

### Базовое вычитание

```typescript
import Decimal from 'decimal.js';
import { subtractDecimal } from '@polymarket/math';

// Положительный результат
const result1 = subtractDecimal(new Decimal(10), new Decimal(3));
console.log(result1.toString()); // "7"

// Отрицательный результат (математически валидно!)
const result2 = subtractDecimal(new Decimal(3), new Decimal(10));
console.log(result2.toString()); // "-7"

// Вычитание отрицательных чисел
const result3 = subtractDecimal(new Decimal(-5), new Decimal(-3));
console.log(result3.toString()); // "-2"
```

### Высокая точность

```typescript
import Decimal from 'decimal.js';
import { subtractDecimal } from '@polymarket/math';

// Проблема обычного JavaScript
console.log(0.3 - 0.1); // 0.19999999999999998 ❌

// Решение с Decimal.js
const result = subtractDecimal(new Decimal('0.3'), new Decimal('0.1'));
console.log(result.toString()); // "0.2" ✅
```

### Вычисление спреда

```typescript
import Decimal from 'decimal.js';
import { subtractDecimal } from '@polymarket/math';

const askPrice = new Decimal('0.65'); // Цена продажи
const bidPrice = new Decimal('0.63'); // Цена покупки

// Спред = ask - bid
const spread = subtractDecimal(askPrice, bidPrice);
console.log(spread.toString()); // "0.02" (2%)
```

### Вычисление прибыли/убытка

```typescript
import Decimal from 'decimal.js';
import { subtractDecimal } from '@polymarket/math';

const exitPrice = new Decimal('0.75');
const entryPrice = new Decimal('0.65');

// PnL = exitPrice - entryPrice
const pnl = subtractDecimal(exitPrice, entryPrice);
console.log(pnl.toString()); // "0.1" (прибыль 10%)

// Убыток (отрицательное значение)
const exitLoss = new Decimal('0.55');
const loss = subtractDecimal(exitLoss, entryPrice);
console.log(loss.toString()); // "-0.1" (убыток 10%)
```

### Использование с константами

```typescript
import Decimal from 'decimal.js';
import { subtractDecimal, MATH_CONSTANTS } from '@polymarket/math';

const price = new Decimal('10.5');

// Вычитание нуля (нейтральный элемент)
const unchanged = subtractDecimal(price, MATH_CONSTANTS.ZERO);
console.log(unchanged.toString()); // "10.5"

// Декремент на единицу
const decremented = subtractDecimal(price, MATH_CONSTANTS.ONE);
console.log(decremented.toString()); // "9.5"
```

### Проверка инварианта: a - b + b = a

```typescript
import Decimal from 'decimal.js';
import { subtractDecimal, addDecimal } from '@polymarket/math';

const a = new Decimal('10.5');
const b = new Decimal('3.2');

// Вычитаем и добавляем обратно
const diff = subtractDecimal(a, b);
const restored = addDecimal(diff, b);

console.log(restored.equals(a)); // true
```

### Вычитание из самого себя

```typescript
import Decimal from 'decimal.js';
import { subtractDecimal, MATH_CONSTANTS } from '@polymarket/math';

const value = new Decimal('42');

// a - a = 0
const result = subtractDecimal(value, value);
console.log(result.equals(MATH_CONSTANTS.ZERO)); // true
```

### Валидация невалидных операндов

```typescript
import Decimal from 'decimal.js';
import { subtractDecimal } from '@polymarket/math';
import { InvalidOperandError } from '@polymarket/errors';

try {
  // Попытка создать операнд с Infinity
  const inf = new Decimal(Infinity);
  const value = new Decimal(100);

  // ❌ Throws InvalidOperandError
  const result = subtractDecimal(inf, value);
} catch (error) {
  if (InvalidOperandError.is(error)) {
    console.error('Invalid operand:', error.message);
    console.error('Context:', error.context);
    // Context: { a: 'Infinity', b: '100', operation: 'subtract' }
  }
}
```

## Edge Cases

### Отрицательные результаты разрешены

```typescript
import Decimal from 'decimal.js';
import { subtractDecimal } from '@polymarket/math';

// Математически корректно - результат может быть отрицательным
const result = subtractDecimal(new Decimal(5), new Decimal(10));
console.log(result.toString()); // "-5" ✅

// Бизнес-валидация (например, Quantity >= 0) - в Value Objects
class Quantity {
  subtract(other: Quantity): Result<Quantity, ValidationError> {
    const diff = subtractDecimal(this.value, other.value);

    // Бизнес-правило: количество не может быть отрицательным
    if (diff.isNegative()) {
      return Err(new ValidationError('Insufficient quantity'));
    }

    return Quantity.fromDecimal(diff);
  }
}
```

### Работа с очень маленькими числами

```typescript
import Decimal from 'decimal.js';
import { subtractDecimal } from '@polymarket/math';

const tiny1 = new Decimal('3e-10');
const tiny2 = new Decimal('1e-10');

const result = subtractDecimal(tiny1, tiny2);
console.log(result.toString()); // "2e-10" ✅
```

### Вычитание нуля

```typescript
import Decimal from 'decimal.js';
import { subtractDecimal, MATH_CONSTANTS } from '@polymarket/math';

const value = new Decimal('123.456');

// Вычитание нуля не меняет значение
const result = subtractDecimal(value, MATH_CONSTANTS.ZERO);
console.log(result.equals(value)); // true
```

### НЕ коммутативно

```typescript
import Decimal from 'decimal.js';
import { subtractDecimal } from '@polymarket/math';

const a = new Decimal(10);
const b = new Decimal(3);

const forward = subtractDecimal(a, b);   // 10 - 3 = 7
const backward = subtractDecimal(b, a);  // 3 - 10 = -7

console.log(forward.toString());  // "7"
console.log(backward.toString()); // "-7"
console.log(forward.equals(backward)); // false
```

## Отличие от addDecimal

### Коммутативность

```typescript
// Сложение коммутативно
addDecimal(a, b) === addDecimal(b, a) // ✅ Всегда true

// Вычитание НЕ коммутативно
subtractDecimal(a, b) !== subtractDecimal(b, a) // ❌ Обычно разные
```

### Связь между операциями

```typescript
import Decimal from 'decimal.js';
import { addDecimal, subtractDecimal } from '@polymarket/math';

const a = new Decimal(10);
const b = new Decimal(3);

// a - b + b = a
const diff = subtractDecimal(a, b);
const sum = addDecimal(diff, b);
console.log(sum.equals(a)); // true

// a + b - b = a
const sum2 = addDecimal(a, b);
const diff2 = subtractDecimal(sum2, b);
console.log(diff2.equals(a)); // true
```

## Использование в Value Objects

### Price

```typescript
import Decimal from 'decimal.js';
import { subtractDecimal } from '@polymarket/math';

class Price {
  private constructor(private readonly value: Decimal) {}

  subtract(other: Price): Result<Price, ValidationError> {
    // Чистая математика
    const diff = subtractDecimal(this.value, other.value);

    // Бизнес-валидация
    return Price.fromDecimal(diff);
  }

  // Вычисление спреда
  spreadTo(other: Price): Decimal {
    // Спред всегда положительный (abs)
    const diff = subtractDecimal(this.value, other.value);
    return diff.abs();
  }
}
```

### Money

```typescript
import Decimal from 'decimal.js';
import { subtractDecimal } from '@polymarket/math';

class Money {
  private constructor(
    private readonly amount: Decimal,
    private readonly currency: string
  ) {}

  subtract(other: Money): Result<Money, MoneyError> {
    // Проверка валюты
    if (this.currency !== other.currency) {
      return Err(new CurrencyMismatchError('Cannot subtract different currencies'));
    }

    // Математика
    const diff = subtractDecimal(this.amount, other.amount);

    // Money может быть отрицательным (долг)
    return Ok(new Money(diff, this.currency));
  }
}
```

### Quantity (НЕ отрицательное)

```typescript
import Decimal from 'decimal.js';
import { subtractDecimal } from '@polymarket/math';

class Quantity {
  private constructor(private readonly value: Decimal) {}

  subtract(other: Quantity): Result<Quantity, ValidationError> {
    // Математика
    const diff = subtractDecimal(this.value, other.value);

    // Бизнес-правило: Quantity не может быть отрицательным
    if (diff.isNegative()) {
      return Err(new ValidationError(
        (ctx) => `Insufficient quantity: ${ctx.current} - ${ctx.subtract} = ${ctx.result}`,
        {
          context: {
            current: this.value.toString(),
            subtract: other.value.toString(),
            result: diff.toString(),
          },
        }
      ));
    }

    return Quantity.fromDecimal(diff);
  }
}
```

## См. также

- [addDecimal](./add.md) - Сложение Decimal чисел
- [multiplyDecimal](./multiply.md) - Умножение Decimal чисел
- [divideDecimal](./divide.md) - Деление Decimal чисел
- [ArithmeticOverflowError](../../errors/docs/value-objects/arithmetic-overflow.md) - Ошибка overflow
