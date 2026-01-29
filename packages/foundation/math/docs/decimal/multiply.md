# multiplyDecimal

Умножает два Decimal значения с проверкой overflow.

## Описание

Функция `multiplyDecimal` выполняет умножение двух `Decimal` чисел и проверяет результат на математическую корректность. Это чистая математическая операция без бизнес-правил.

**Когда использовать:**
- Расчёт стоимости (цена × количество)
- Вычисление процентов и комиссий
- Масштабирование значений
- Любые арифметические операции с высокой точностью

**Когда НЕ использовать:**
- Если нужна бизнес-валидация результата (используйте Value Objects)
- Если нужна проверка диапазонов (это бизнес-правило, не математика)

## Сигнатура

```typescript
function multiplyDecimal(a: Decimal, b: Decimal): Decimal
```

### Параметры

| Параметр | Тип | Описание |
|----------|-----|----------|
| `a` | `Decimal` | Первый множитель |
| `b` | `Decimal` | Второй множитель |

### Возвращаемое значение

`Decimal` - Произведение a * b

### Выбрасываемые ошибки

- **InvalidOperandError** - Если операнды не являются конечными числами (NaN, Infinity, -Infinity)
- **ArithmeticOverflowError** - Если результат не является конечным числом (Infinity, -Infinity)

## Математические свойства

Функция сохраняет все математические свойства умножения:

- **Коммутативность:** `multiplyDecimal(a, b) === multiplyDecimal(b, a)`
- **Ассоциативность:** `multiplyDecimal(multiplyDecimal(a, b), c) === multiplyDecimal(a, multiplyDecimal(b, c))`
- **Нейтральный элемент:** `multiplyDecimal(a, MATH_CONSTANTS.ONE) === a`
- **Свойство нуля:** `multiplyDecimal(a, MATH_CONSTANTS.ZERO) === MATH_CONSTANTS.ZERO`
- **Дистрибутивность:** `multiplyDecimal(a, addDecimal(b, c)) === addDecimal(multiplyDecimal(a, b), multiplyDecimal(a, c))`

**Важно:** Ассоциативность и дистрибутивность могут нарушаться при ограниченной точности `Decimal.js`, так как каждая операция округляется согласно настроенной `precision`. При стандартных настройках (precision = 20) эти свойства сохраняются для большинства практических случаев. Коммутативность и свойства нейтрального элемента/нуля гарантированы всегда.

## Примеры использования

### Базовое умножение

```typescript
import Decimal from 'decimal.js';
import { multiplyDecimal } from '@polymarket/math';

// Положительные числа
const result1 = multiplyDecimal(new Decimal(5), new Decimal(3));
console.log(result1.toString()); // "15"

// Отрицательные числа
const result2 = multiplyDecimal(new Decimal(-5), new Decimal(-3));
console.log(result2.toString()); // "15"

// Смешанные знаки
const result3 = multiplyDecimal(new Decimal(5), new Decimal(-3));
console.log(result3.toString()); // "-15"
```

### Высокая точность (преимущество Decimal.js)

```typescript
import Decimal from 'decimal.js';
import { multiplyDecimal } from '@polymarket/math';

// Проблема обычного JavaScript
console.log(0.1 * 0.2); // 0.020000000000000004 ❌

// Решение с Decimal.js
const result = multiplyDecimal(new Decimal('0.1'), new Decimal('0.2'));
console.log(result.toString()); // "0.02" ✅
```

### Расчёт стоимости позиции

```typescript
import Decimal from 'decimal.js';
import { multiplyDecimal } from '@polymarket/math';

const price = new Decimal('0.6543'); // Цена YES токена
const quantity = new Decimal('100'); // Количество

const totalCost = multiplyDecimal(price, quantity);
console.log(totalCost.toString()); // "65.43"
```

### Расчёт комиссий

```typescript
import Decimal from 'decimal.js';
import { multiplyDecimal } from '@polymarket/math';

const orderValue = new Decimal('1000');
const feeRate = new Decimal('0.02'); // 2%

const fee = multiplyDecimal(orderValue, feeRate);
console.log(fee.toString()); // "20"

const netValue = orderValue.minus(fee);
console.log(netValue.toString()); // "980"
```

### Использование констант

```typescript
import Decimal from 'decimal.js';
import { multiplyDecimal, MATH_CONSTANTS } from '@polymarket/math';

const value = new Decimal('42');

// Умножение на ноль (нулевой элемент)
const result1 = multiplyDecimal(value, MATH_CONSTANTS.ZERO);
console.log(result1.toString()); // "0"

// Умножение на единицу (нейтральный элемент)
const result2 = multiplyDecimal(value, MATH_CONSTANTS.ONE);
console.log(result2.toString()); // "42"

// Удвоение
const result3 = multiplyDecimal(value, MATH_CONSTANTS.TWO);
console.log(result3.toString()); // "84"
```

### Обработка overflow

```typescript
import Decimal from 'decimal.js';
import { multiplyDecimal } from '@polymarket/math';
import { InvalidOperandError } from '@polymarket/errors';

try {
  const inf = new Decimal(Infinity);
  const value = new Decimal(100);

  // ❌ Throws InvalidOperandError
  const result = multiplyDecimal(inf, value);
} catch (error) {
  if (InvalidOperandError.is(error)) {
    console.error('Invalid operand:', error.message);
    console.error('Context:', error.context);
    // Context: { a: 'Infinity', b: '100', operation: 'multiply' }
  }
}
```

### Цепочка операций

```typescript
import Decimal from 'decimal.js';
import { multiplyDecimal, addDecimal } from '@polymarket/math';

const price = new Decimal('0.65');
const quantity = new Decimal('100');
const taxRate = new Decimal('0.1'); // 10%

// (price * quantity) + (price * quantity * taxRate)
const subtotal = multiplyDecimal(price, quantity);
const tax = multiplyDecimal(subtotal, taxRate);
const total = addDecimal(subtotal, tax);

console.log(total.toString()); // "71.5"
```

### Масштабирование значений

```typescript
import Decimal from 'decimal.js';
import { multiplyDecimal } from '@polymarket/math';

// Конвертация в базовые единицы (USDC имеет 6 decimals)
const amount = new Decimal('100.50'); // $100.50
const multiplier = new Decimal('1000000'); // 10^6

const baseUnits = multiplyDecimal(amount, multiplier);
console.log(baseUnits.toString()); // "100500000"
```

## Edge Cases

### Работа с очень большими числами

```typescript
import Decimal from 'decimal.js';
import { multiplyDecimal } from '@polymarket/math';

// Decimal.js поддерживает очень большие числа
const huge1 = new Decimal('1e50');
const huge2 = new Decimal('2e50');

const result = multiplyDecimal(huge1, huge2);
console.log(result.toString()); // "2e+100" ✅
```

### Работа с очень маленькими числами

```typescript
import Decimal from 'decimal.js';
import { multiplyDecimal } from '@polymarket/math';

const tiny1 = new Decimal('1e-10');
const tiny2 = new Decimal('2e-10');

const result = multiplyDecimal(tiny1, tiny2);
console.log(result.toString()); // "2e-20" ✅
```

### Валидация невалидных операндов

```typescript
import Decimal from 'decimal.js';
import { multiplyDecimal } from '@polymarket/math';
import { InvalidOperandError } from '@polymarket/errors';

try {
  // Попытка создать операнд с Infinity
  const inf = new Decimal(Infinity);
  const num = new Decimal(100);

  // ❌ Throws InvalidOperandError
  multiplyDecimal(inf, num);
} catch (error) {
  if (InvalidOperandError.is(error)) {
    console.error('Invalid operand:', error.message);
    // Context: { a: 'Infinity', b: '100', operation: 'multiply' }
  }
}
```

### Умножение на нуль

```typescript
import Decimal from 'decimal.js';
import { multiplyDecimal, MATH_CONSTANTS } from '@polymarket/math';

const value = new Decimal('123.456');

// Ноль - поглощающий элемент
const result = multiplyDecimal(value, MATH_CONSTANTS.ZERO);
console.log(result.equals(MATH_CONSTANTS.ZERO)); // true
console.log(result.toString()); // "0"
```

### Умножение отрицательных чисел

```typescript
import Decimal from 'decimal.js';
import { multiplyDecimal } from '@polymarket/math';

// Отрицательное * Отрицательное = Положительное
const result1 = multiplyDecimal(new Decimal(-5), new Decimal(-3));
console.log(result1.toString()); // "15"

// Положительное * Отрицательное = Отрицательное
const result2 = multiplyDecimal(new Decimal(5), new Decimal(-3));
console.log(result2.toString()); // "-15"

// Отрицательное * Положительное = Отрицательное
const result3 = multiplyDecimal(new Decimal(-5), new Decimal(3));
console.log(result3.toString()); // "-15"
```

## Производительность

```typescript
import Decimal from 'decimal.js';
import { multiplyDecimal, MATH_CONSTANTS } from '@polymarket/math';

// ✅ Хорошо: переиспользуем константы
const result1 = multiplyDecimal(value, MATH_CONSTANTS.TWO);

// ❌ Плохо: создаём новый Decimal каждый раз
const result2 = multiplyDecimal(value, new Decimal(2));
```

**Совет:** Используйте `MATH_CONSTANTS` для часто используемых значений (0, 1, 2, 10, 100).

## Интеграция с Value Objects

```typescript
import Decimal from 'decimal.js';
import { multiplyDecimal } from '@polymarket/math';
import { Price, Quantity } from '@polymarket/value-objects';

// Умножение внутри Value Object
class Position {
  private constructor(
    private readonly price: Price,
    private readonly quantity: Quantity
  ) {}

  calculateValue(): Result<Money, ValidationError> {
    // 1. Чистая математика (core layer)
    const value = multiplyDecimal(this.price.value, this.quantity.value);

    // 2. Бизнес-валидация (domain layer)
    return Money.fromDecimal(value);
  }
}
```

## Связь с другими операциями

```typescript
import Decimal from 'decimal.js';
import { multiplyDecimal, divideDecimal } from '@polymarket/math';

const a = new Decimal(10);
const b = new Decimal(3);

// Умножение
const product = multiplyDecimal(a, b);     // 10 * 3 = 30

// Деление (обратная операция)
const quotient = divideDecimal(product, b); // 30 / 3 = 10

// Связь: a = (a * b) / b
console.log(quotient.equals(a)); // true
```

## Дистрибутивность умножения

```typescript
import Decimal from 'decimal.js';
import { multiplyDecimal, addDecimal } from '@polymarket/math';

const a = new Decimal('2');
const b = new Decimal('3');
const c = new Decimal('4');

// a * (b + c)
const left = multiplyDecimal(a, addDecimal(b, c)); // 2 * (3 + 4) = 14

// (a * b) + (a * c)
const right = addDecimal(
  multiplyDecimal(a, b),
  multiplyDecimal(a, c)
); // (2 * 3) + (2 * 4) = 14

console.log(left.equals(right)); // true
```

## См. также

- [addDecimal](./add.md) - Сложение Decimal чисел
- [subtractDecimal](./subtract.md) - Вычитание Decimal чисел
- [divideDecimal](./divide.md) - Деление Decimal чисел *(в разработке)*
- [averageDecimal](./average.md) - Среднее значение двух чисел *(в разработке)*
- [ArithmeticOverflowError](../../errors/docs/value-objects/arithmetic-overflow.md) - Ошибка overflow
