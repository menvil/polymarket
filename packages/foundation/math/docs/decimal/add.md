# addDecimal

Складывает два Decimal значения с проверкой overflow.

## Описание

Функция `addDecimal` выполняет сложение двух `Decimal` чисел и проверяет результат на математическую корректность. Это чистая математическая операция без бизнес-правил.

**Когда использовать:**
- Сложение цен, количеств, балансов
- Любые арифметические операции с высокой точностью
- Когда нужна защита от overflow

**Когда НЕ использовать:**
- Если нужна бизнес-валидация результата (используйте Value Objects)
- Если нужна проверка диапазонов (это бизнес-правило, не математика)

## Сигнатура

```typescript
function addDecimal(a: Decimal, b: Decimal): Decimal
```

### Параметры

| Параметр | Тип | Описание |
|----------|-----|----------|
| `a` | `Decimal` | Первое слагаемое |
| `b` | `Decimal` | Второе слагаемое |

### Возвращаемое значение

`Decimal` - Сумма a + b

### Выбрасываемые ошибки

- **ArithmeticOverflowError** - Если результат не является конечным числом (Infinity, -Infinity)

## Математические свойства

Функция сохраняет все математические свойства сложения:

- **Коммутативность:** `addDecimal(a, b) === addDecimal(b, a)`
- **Ассоциативность:** `addDecimal(addDecimal(a, b), c) === addDecimal(a, addDecimal(b, c))`
- **Нейтральный элемент:** `addDecimal(a, MATH_CONSTANTS.ZERO) === a`

## Примеры использования

### Базовое сложение

```typescript
import Decimal from 'decimal.js';
import { addDecimal } from '@polymarket/math';

// Положительные числа
const result1 = addDecimal(new Decimal(5), new Decimal(3));
console.log(result1.toString()); // "8"

// Отрицательные числа
const result2 = addDecimal(new Decimal(-5), new Decimal(-3));
console.log(result2.toString()); // "-8"

// Смешанные знаки
const result3 = addDecimal(new Decimal(10), new Decimal(-3));
console.log(result3.toString()); // "7"
```

### Высокая точность (преимущество Decimal.js)

```typescript
import Decimal from 'decimal.js';
import { addDecimal } from '@polymarket/math';

// Проблема обычного JavaScript
console.log(0.1 + 0.2); // 0.30000000000000004 ❌

// Решение с Decimal.js
const result = addDecimal(new Decimal('0.1'), new Decimal('0.2'));
console.log(result.toString()); // "0.3" ✅
```

### Сложение цен

```typescript
import Decimal from 'decimal.js';
import { addDecimal } from '@polymarket/math';

const price1 = new Decimal('0.6543'); // YES цена
const price2 = new Decimal('0.3457'); // NO цена

const total = addDecimal(price1, price2);
console.log(total.toString()); // "1" (должна быть 1.0 для Polymarket)
```

### Использование констант

```typescript
import Decimal from 'decimal.js';
import { addDecimal, MATH_CONSTANTS } from '@polymarket/math';

const value = new Decimal('42');

// С нулём (нейтральный элемент)
const result = addDecimal(value, MATH_CONSTANTS.ZERO);
console.log(result.toString()); // "42"

// Инкремент на единицу
const incremented = addDecimal(value, MATH_CONSTANTS.ONE);
console.log(incremented.toString()); // "43"
```

### Обработка overflow

```typescript
import Decimal from 'decimal.js';
import { addDecimal } from '@polymarket/math';
import { ArithmeticOverflowError } from '@polymarket/errors';

try {
  const inf = new Decimal(Infinity);
  const value = new Decimal(100);

  const result = addDecimal(inf, value);
} catch (error) {
  if (ArithmeticOverflowError.is(error)) {
    console.error('Addition overflow:', error.message);
    console.error('Context:', error.context);
    // Context: { a: 'Infinity', b: '100', result: 'Infinity' }
  }
}
```

### Цепочка операций

```typescript
import Decimal from 'decimal.js';
import { addDecimal } from '@polymarket/math';

const a = new Decimal('10.5');
const b = new Decimal('20.3');
const c = new Decimal('5.2');

// Ассоциативность позволяет группировать по-разному
const result1 = addDecimal(addDecimal(a, b), c); // (a + b) + c
const result2 = addDecimal(a, addDecimal(b, c)); // a + (b + c)

console.log(result1.toString()); // "36"
console.log(result2.toString()); // "36"
console.log(result1.equals(result2)); // true
```

## Edge Cases

### Работа с очень большими числами

```typescript
import Decimal from 'decimal.js';
import { addDecimal } from '@polymarket/math';

// Decimal.js поддерживает очень большие числа
const huge1 = new Decimal('1e100');
const huge2 = new Decimal('2e100');

const result = addDecimal(huge1, huge2);
console.log(result.toString()); // "3e+100" ✅
```

### Работа с очень маленькими числами

```typescript
import Decimal from 'decimal.js';
import { addDecimal } from '@polymarket/math';

const tiny1 = new Decimal('1e-10');
const tiny2 = new Decimal('2e-10');

const result = addDecimal(tiny1, tiny2);
console.log(result.toString()); // "3e-10" ✅
```

### Overflow при достижении Infinity

```typescript
import Decimal from 'decimal.js';
import { addDecimal } from '@polymarket/math';

// Infinity + любое число = Infinity (математическая невозможность)
const inf = new Decimal(Infinity);
const num = new Decimal(100);

// ❌ Throws ArithmeticOverflowError
addDecimal(inf, num);
```

### Сложение с нулём

```typescript
import Decimal from 'decimal.js';
import { addDecimal, MATH_CONSTANTS } from '@polymarket/math';

const value = new Decimal('123.456');

// Ноль - нейтральный элемент
const result = addDecimal(value, MATH_CONSTANTS.ZERO);
console.log(result.equals(value)); // true
```

## Производительность

```typescript
import Decimal from 'decimal.js';
import { addDecimal, MATH_CONSTANTS } from '@polymarket/math';

// ✅ Хорошо: переиспользуем константы
const result1 = addDecimal(value, MATH_CONSTANTS.ONE);

// ❌ Плохо: создаём новый Decimal каждый раз
const result2 = addDecimal(value, new Decimal(1));
```

**Совет:** Используйте `MATH_CONSTANTS` для часто используемых значений (0, 1, 2, 10, 100).

## Интеграция с Value Objects

```typescript
import Decimal from 'decimal.js';
import { addDecimal } from '@polymarket/math';
import { Price } from '@polymarket/value-objects';

// Сложение внутри Price
class Price {
  private constructor(private readonly value: Decimal) {}

  add(other: Price): Result<Price, ValidationError> {
    // 1. Чистая математика (core layer)
    const sum = addDecimal(this.value, other.value);

    // 2. Бизнес-валидация (domain layer)
    return Price.fromDecimal(sum);
  }
}
```

## Отличие от subtractDecimal

```typescript
import Decimal from 'decimal.js';
import { addDecimal, subtractDecimal } from '@polymarket/math';

const a = new Decimal(10);
const b = new Decimal(3);

// Сложение
const sum = addDecimal(a, b);       // 10 + 3 = 13

// Вычитание
const diff = subtractDecimal(a, b); // 10 - 3 = 7

// Связь: a = diff + b
const check = addDecimal(diff, b);
console.log(check.equals(a)); // true
```

## См. также

- [subtractDecimal](./subtract.md) - Вычитание Decimal чисел ✅
- [multiplyDecimal](./multiply.md) - Умножение Decimal чисел
- [divideDecimal](./divide.md) - Деление Decimal чисел
- [averageDecimal](./average.md) - Среднее значение двух чисел
- [ArithmeticOverflowError](../../errors/docs/value-objects/arithmetic-overflow.md) - Ошибка overflow
