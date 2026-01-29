# averageDecimal

Вычисляет среднее значение двух Decimal чисел.

## Описание

Функция `averageDecimal` вычисляет среднее арифметическое двух `Decimal` чисел с проверкой математической корректности. Это чистая математическая операция без бизнес-правил.

**Алгоритм:** `(a + b) / 2`

**Когда использовать:**
- Расчёт средней цены между bid и ask
- Вычисление средней точки диапазона
- Статистические расчёты
- Любые задачи требующие среднего арифметического

**Когда НЕ использовать:**
- Если нужна бизнес-валидация результата (используйте Value Objects)
- Если нужна проверка диапазонов (это бизнес-правило, не математика)
- Для более двух чисел (используйте reduce с addDecimal и divideDecimal)

## Сигнатура

```typescript
function averageDecimal(a: Decimal, b: Decimal): Decimal
```

### Параметры

| Параметр | Тип | Описание |
|----------|-----|----------|
| `a` | `Decimal` | Первое число |
| `b` | `Decimal` | Второе число |

### Возвращаемое значение

`Decimal` - Среднее значение (a + b) / 2

### Выбрасываемые ошибки

- **ArithmeticOverflowError** - Если результат не является конечным числом (Infinity, -Infinity, NaN)

## Математические свойства

Функция сохраняет следующие свойства:

- **Коммутативность:** `averageDecimal(a, b) === averageDecimal(b, a)`
- **Идемпотентность:** `averageDecimal(a, a) === a`
- **Середина интервала:** Результат всегда находится между a и b (или равен им)
- **Линейность:** `averageDecimal(ka, kb) === k * averageDecimal(a, b)`

## Примеры использования

### Базовое использование

```typescript
import Decimal from 'decimal.js';
import { averageDecimal } from '@polymarket/math';

// Среднее целых чисел
const result1 = averageDecimal(new Decimal(10), new Decimal(20));
console.log(result1.toString()); // "15"

// Среднее дробных чисел
const result2 = averageDecimal(new Decimal(0.5), new Decimal(0.7));
console.log(result2.toString()); // "0.6"

// Среднее одинаковых чисел
const result3 = averageDecimal(new Decimal(5), new Decimal(5));
console.log(result3.toString()); // "5"
```

### Высокая точность (преимущество Decimal.js)

```typescript
import Decimal from 'decimal.js';
import { averageDecimal } from '@polymarket/math';

// Проблема обычного JavaScript
console.log((0.1 + 0.3) / 2); // 0.19999999999999998 ❌

// Решение с Decimal.js
const result = averageDecimal(new Decimal('0.1'), new Decimal('0.3'));
console.log(result.toString()); // "0.2" ✅
```

### Расчёт средней цены (bid-ask spread)

```typescript
import Decimal from 'decimal.js';
import { averageDecimal } from '@polymarket/math';

const bidPrice = new Decimal('0.6543'); // YES цена покупки
const askPrice = new Decimal('0.6557'); // YES цена продажи

const midPrice = averageDecimal(bidPrice, askPrice);
console.log(midPrice.toString()); // "0.655"
```

### Расчёт средней точки диапазона

```typescript
import Decimal from 'decimal.js';
import { averageDecimal } from '@polymarket/math';

const minPrice = new Decimal('0.0001'); // Минимальная цена
const maxPrice = new Decimal('0.9999'); // Максимальная цена

const midpoint = averageDecimal(minPrice, maxPrice);
console.log(midpoint.toString()); // "0.5"
```

### Работа с отрицательными числами

```typescript
import Decimal from 'decimal.js';
import { averageDecimal } from '@polymarket/math';

// Среднее двух отрицательных
const result1 = averageDecimal(new Decimal(-10), new Decimal(-20));
console.log(result1.toString()); // "-15"

// Среднее положительного и отрицательного
const result2 = averageDecimal(new Decimal(-10), new Decimal(10));
console.log(result2.toString()); // "0"

// Среднее отрицательного и нуля
const result3 = averageDecimal(new Decimal(-10), new Decimal(0));
console.log(result3.toString()); // "-5"
```

### Использование констант

```typescript
import Decimal from 'decimal.js';
import { averageDecimal, MATH_CONSTANTS } from '@polymarket/math';

const value = new Decimal('100');

// Среднее с нулём
const result1 = averageDecimal(value, MATH_CONSTANTS.ZERO);
console.log(result1.toString()); // "50"

// Среднее с единицей
const result2 = averageDecimal(value, MATH_CONSTANTS.ONE);
console.log(result2.toString()); // "50.5"
```

### Валидация невалидных операндов

```typescript
import Decimal from 'decimal.js';
import { averageDecimal } from '@polymarket/math';
import { InvalidOperandError } from '@polymarket/errors';

try {
  // Попытка создать операнд с Infinity
  const inf = new Decimal(Infinity);
  const value = new Decimal(10);

  const result = averageDecimal(inf, value);
} catch (error) {
  if (InvalidOperandError.is(error)) {
    console.error('Invalid operand:', error.message);
    console.error('Context:', error.context);
    // Context: { a: 'Infinity', b: '10', operation: 'average' }
  }
}
```

### Цепочка операций

```typescript
import Decimal from 'decimal.js';
import { averageDecimal, multiplyDecimal } from '@polymarket/math';

const price1 = new Decimal('0.65');
const price2 = new Decimal('0.67');
const quantity = new Decimal('100');

// Использовать среднюю цену для расчёта стоимости
const avgPrice = averageDecimal(price1, price2);
const totalCost = multiplyDecimal(avgPrice, quantity);

console.log(avgPrice.toString()); // "0.66"
console.log(totalCost.toString()); // "66"
```

### Статистические расчёты

```typescript
import Decimal from 'decimal.js';
import { averageDecimal } from '@polymarket/math';

// Средняя температура за два дня
const day1Temp = new Decimal('22.5');
const day2Temp = new Decimal('23.7');

const avgTemp = averageDecimal(day1Temp, day2Temp);
console.log(avgTemp.toString()); // "23.1"
```

## Edge Cases

### Среднее одинаковых чисел (идемпотентность)

```typescript
import Decimal from 'decimal.js';
import { averageDecimal } from '@polymarket/math';

const value = new Decimal('42.5');

// Среднее числа с самим собой равно этому числу
const result = averageDecimal(value, value);
console.log(result.equals(value)); // true
console.log(result.toString()); // "42.5"
```

### Среднее нуля и числа

```typescript
import Decimal from 'decimal.js';
import { averageDecimal, MATH_CONSTANTS } from '@polymarket/math';

const value = new Decimal('10');

// Среднее с нулём = половина значения
const result = averageDecimal(value, MATH_CONSTANTS.ZERO);
console.log(result.toString()); // "5"
```

### Работа с очень маленькими числами

```typescript
import Decimal from 'decimal.js';
import { averageDecimal } from '@polymarket/math';

const tiny1 = new Decimal('0.0001');
const tiny2 = new Decimal('0.0003');

const result = averageDecimal(tiny1, tiny2);
console.log(result.toString()); // "0.0002"
```

### Работа с очень большими числами

```typescript
import Decimal from 'decimal.js';
import { averageDecimal } from '@polymarket/math';

const huge1 = new Decimal('1e6'); // 1 миллион
const huge2 = new Decimal('2e6'); // 2 миллиона

const result = averageDecimal(huge1, huge2);
console.log(result.toString()); // "1500000"
```

### Сохранение точности

```typescript
import Decimal from 'decimal.js';
import { averageDecimal } from '@polymarket/math';

const a = new Decimal('0.123456789');
const b = new Decimal('0.987654321');

const result = averageDecimal(a, b);
console.log(result.toString()); // "0.555555555"

// Проверка точности
const sum = a.plus(b);
const expected = sum.dividedBy(2);
console.log(result.equals(expected)); // true
```

## Производительность

```typescript
import Decimal from 'decimal.js';
import { averageDecimal, MATH_CONSTANTS } from '@polymarket/math';

// ✅ Хорошо: прямое использование
const result1 = averageDecimal(price1, price2);

// ❌ Плохо: лишние промежуточные шаги
const sum = price1.plus(price2);
const result2 = sum.dividedBy(MATH_CONSTANTS.TWO);
```

**Совет:** `averageDecimal` оптимизирована и читаема. Используйте её напрямую.

## Интеграция с Value Objects

```typescript
import Decimal from 'decimal.js';
import { averageDecimal } from '@polymarket/math';
import { Price } from '@polymarket/value-objects';

// Вычисление средней цены внутри Value Object
class MarketData {
  private constructor(
    private readonly bidPrice: Price,
    private readonly askPrice: Price
  ) {}

  calculateMidPrice(): Result<Price, ValidationError> {
    // 1. Чистая математика (core layer)
    const midPriceValue = averageDecimal(
      this.bidPrice.value,
      this.askPrice.value
    );

    // 2. Бизнес-валидация (domain layer)
    return Price.fromDecimal(midPriceValue);
  }
}
```

## Связь с другими операциями

```typescript
import Decimal from 'decimal.js';
import { averageDecimal, addDecimal, divideDecimal, MATH_CONSTANTS } from '@polymarket/math';

const a = new Decimal(10);
const b = new Decimal(20);

// Среднее через averageDecimal
const avg1 = averageDecimal(a, b); // 15

// Среднее через addDecimal + divideDecimal (эквивалентно)
const sum = addDecimal(a, b);
const avg2 = divideDecimal(sum, MATH_CONSTANTS.TWO); // 15

// Результаты идентичны
console.log(avg1.equals(avg2)); // true
```

## Коммутативность

```typescript
import Decimal from 'decimal.js';
import { averageDecimal } from '@polymarket/math';

const a = new Decimal('5.5');
const b = new Decimal('3.2');

// Порядок операндов не имеет значения
const result1 = averageDecimal(a, b);
const result2 = averageDecimal(b, a);

console.log(result1.equals(result2)); // true
console.log(result1.toString()); // "4.35"
console.log(result2.toString()); // "4.35"
```

## Расширение на N чисел

```typescript
import Decimal from 'decimal.js';
import { addDecimal, divideDecimal, MATH_CONSTANTS } from '@polymarket/math';

// Среднее для массива чисел
function averageMany(values: Decimal[]): Decimal {
  if (values.length === 0) {
    return MATH_CONSTANTS.ZERO;
  }

  const sum = values.reduce(
    (acc, val) => addDecimal(acc, val),
    MATH_CONSTANTS.ZERO
  );

  return divideDecimal(sum, new Decimal(values.length));
}

// Использование
const prices = [
  new Decimal('0.65'),
  new Decimal('0.67'),
  new Decimal('0.66'),
  new Decimal('0.68'),
];

const avgPrice = averageMany(prices);
console.log(avgPrice.toString()); // "0.665"
```

## Обработка NaN

```typescript
import Decimal from 'decimal.js';
import { averageDecimal } from '@polymarket/math';
import { InvalidOperandError } from '@polymarket/errors';

try {
  const nan = new Decimal(NaN);
  const value = new Decimal(10);

  const result = averageDecimal(nan, value);
} catch (error) {
  if (InvalidOperandError.is(error)) {
    console.error('Average with NaN is invalid');
    // Context: { a: 'NaN', b: '10', operation: 'average' }
  }
}
```

## См. также

- [addDecimal](./add.md) - Сложение Decimal чисел
- [divideDecimal](./divide.md) - Деление Decimal чисел
- [multiplyDecimal](./multiply.md) - Умножение Decimal чисел
- [subtractDecimal](./subtract.md) - Вычитание Decimal чисел
- [ArithmeticOverflowError](../../errors/docs/arithmetic/overflow.md) - Ошибка overflow
