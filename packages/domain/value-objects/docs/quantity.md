# Quantity Value Object

## Описание

**Quantity** — value object представляющий количество/размер акций на рынках предсказаний.

### Характеристики

- **Immutable (Неизменяемый)**: все операции возвращают новый экземпляр
- **Type-safe**: используется Result<T, E> для явной обработки ошибок
- **Валидируемый**: неотрицательные значения с минимальным размером (MIN_SIZE)
- **Tick-aware**: поддержка округления до размера тика
- **Market data support**: отдельный метод для рыночных данных без проверки MIN_SIZE

### Диапазон значений

```typescript
Минимум для ордеров: 1 (по умолчанию, configurable per market)
Минимум для market data: 0
```

**Почему два типа создания?**

- `fromValue()` - для создания ордеров, проверяет MIN_SIZE
- `fromMarketData()` - для входящих данных с биржи, где могут быть частичные исполнения < MIN_SIZE

## Factory Methods

### `fromValue(value: number | string | Decimal, minSize?: number): Result<Quantity, InvalidQuantityError>`

Создаёт Quantity для ордера с валидацией минимального размера.

**Параметры:**
- `value` - количество (может быть number, string или Decimal для точных вычислений)
- `minSize` - минимальный размер (по умолчанию 1)

**Валидация:**
- Значение должно быть >= 0
- Значение должно быть >= minSize (по умолчанию 1)
- Отклоняет NaN и Infinity

```typescript
import { unwrap } from '@polymarket/result';

// Валидное количество (>= MIN_SIZE)
const result = Quantity.fromValue(10);
if (result.ok) {
  const qty = result.value;
  console.log(qty.value); // 10
} else {
  console.error(result.error.message);
}

// Используя unwrap для краткости
const qty = unwrap(Quantity.fromValue(10));

// С кастомным minSize из market info
const marketMinSize = 5;
const qty2 = unwrap(Quantity.fromValue(10, marketMinSize));

// Ноль разрешен только с minSize=0
const zero = unwrap(Quantity.fromValue(0, 0));

// Невалидные значения возвращают Err
const invalid1 = Quantity.fromValue(-10);      // Error: отрицательное
const invalid2 = Quantity.fromValue(0.5);      // Error: < MIN_SIZE (1)
const invalid3 = Quantity.fromValue(0);        // Error: < MIN_SIZE (1)
const invalid4 = Quantity.fromValue(NaN);      // Error: не число
const invalid5 = Quantity.fromValue(Infinity); // Error: не конечное
```

### `fromMarketData(value: number): Result<Quantity, InvalidQuantityError>`

Создаёт Quantity из рыночных данных без проверки MIN_SIZE.

```typescript
import { unwrap } from '@polymarket/result';

// Для частичного исполнения с биржи
const result = Quantity.fromMarketData(0.07);
if (result.ok) {
  console.log(result.value.value); // 0.07
}

// Или используя unwrap
const filled = unwrap(Quantity.fromMarketData(37.5));

// Валидация только неотрицательности
const valid = unwrap(Quantity.fromMarketData(0));    // OK
const invalid = Quantity.fromMarketData(-1);          // Error
```

### `zero(): Quantity`

Создаёт нулевое количество (удобный статический метод).

```typescript
const empty = Quantity.zero();
console.log(empty.value); // 0
console.log(empty.isZero()); // true
```

## Операции округления

### `toTick(tickSize?: number): Result<Quantity, InvalidQuantityError>`

Округляет к ближайшему tick size.

```typescript
import { unwrap } from '@polymarket/result';

const qty = unwrap(Quantity.fromValue(10.567));

// Возвращает Result
const result = qty.toTick(0.1);
if (result.ok) {
  console.log(result.value.value); // 10.6
}

// Или используя unwrap
const rounded = unwrap(qty.toTick(0.1));
console.log(rounded.value); // 10.6

// Округление к tick size по умолчанию (0.01)
const defaultRounded = unwrap(qty.toTick());
console.log(defaultRounded.value); // 10.57
```

### `floorToTick(tickSize?: number): Result<Quantity, InvalidQuantityError>`

Округляет вниз до tick size.

```typescript
import { unwrap } from '@polymarket/result';

const qty = unwrap(Quantity.fromValue(10.569));

// Возвращает Result
const result = qty.floorToTick(0.1);
if (result.ok) {
  console.log(result.value.value); // 10.5
}

// Или используя unwrap
const floored = unwrap(qty.floorToTick(0.1));
console.log(floored.value); // 10.5
```

### `ceilToTick(tickSize?: number): Result<Quantity, InvalidQuantityError>`

Округляет вверх до tick size.

```typescript
import { unwrap } from '@polymarket/result';

const qty = unwrap(Quantity.fromValue(10.531));

// Возвращает Result
const result = qty.ceilToTick(0.1);
if (result.ok) {
  console.log(result.value.value); // 10.6
}

// Или используя unwrap
const ceiled = unwrap(qty.ceilToTick(0.1));
console.log(ceiled.value); // 10.6
```

## Арифметические операции

### `add(other: Quantity): Result<Quantity, ArithmeticOverflowError>`

Складывает количества.

```typescript
const q1 = unwrap(Quantity.fromValue(10));
const q2 = unwrap(Quantity.fromValue(5));

const sumResult = q1.add(q2);
if (sumResult.ok) {
  console.log(sumResult.value.value); // 15
}

// Или используя unwrap
const sum = unwrap(q1.add(q2));
console.log(sum.value); // 15

// Ошибка при overflow
const huge1 = unwrap(Quantity.fromValue(Number.MAX_VALUE));
const huge2 = unwrap(Quantity.fromValue(Number.MAX_VALUE));
const overflowResult = huge1.add(huge2);
if (!overflowResult.ok) {
  console.error('Overflow:', overflowResult.error.message);
}
```

### `subtract(other: Quantity): Result<Quantity, InvalidQuantityError>`

Вычитает количества.

```typescript
const q1 = unwrap(Quantity.fromValue(10));
const q2 = unwrap(Quantity.fromValue(3));

const diffResult = q1.subtract(q2);
if (diffResult.ok) {
  console.log(diffResult.value.value); // 7
}

// Или используя unwrap
const diff = unwrap(q1.subtract(q2));
console.log(diff.value); // 7

// Ошибка при отрицательном результате
const small = unwrap(Quantity.fromValue(5));
const large = unwrap(Quantity.fromValue(10));
small.subtract(large); // Throws Error

// Ноль разрешен
const same = unwrap(Quantity.fromValue(10));
const zero = same.subtract(same);
console.log(zero.value); // 0
```

### `multiply(factor: number): Quantity`

Умножает на коэффициент.

```typescript
const qty = unwrap(Quantity.fromValue(10));

const doubled = qty.multiply(2);
console.log(doubled.value); // 20

const half = qty.multiply(0.5);
console.log(half.value); // 5

// Ноль разрешен
const zero = qty.multiply(0);
console.log(zero.value); // 0

// Ошибки
qty.multiply(-1);   // RangeError: отрицательный factor
qty.multiply(NaN);  // RangeError: не число
```

### `divide(divisor: number): Quantity`

Делит на делитель.

```typescript
const qty = unwrap(Quantity.fromValue(10));

const half = qty.divide(2);
console.log(half.value); // 5

// Ошибки
qty.divide(0);      // Error: деление на ноль
qty.divide(-2);     // Error: отрицательный делитель
qty.divide(NaN);    // Error: не число
```

## Сравнение

### `isGreaterThan(other: Quantity): boolean`

```typescript
const q1 = unwrap(Quantity.fromValue(15));
const q2 = unwrap(Quantity.fromValue(10));

console.log(q1.isGreaterThan(q2)); // true
console.log(q2.isGreaterThan(q1)); // false
```

### `isLessThan(other: Quantity): boolean`

```typescript
const q1 = unwrap(Quantity.fromValue(10));
const q2 = unwrap(Quantity.fromValue(15));

console.log(q1.isLessThan(q2)); // true
console.log(q2.isLessThan(q1)); // false
```

### `equals(other: Quantity): boolean`

Проверяет равенство с учётом epsilon для floating-point.

```typescript
const q1 = unwrap(Quantity.fromValue(10));
const q2 = unwrap(Quantity.fromValue(10));
const q3 = unwrap(Quantity.fromValue(15));

console.log(q1.equals(q2)); // true
console.log(q1.equals(q3)); // false

// Epsilon handling
const q4 = unwrap(Quantity.fromValue(10));
const q5 = unwrap(Quantity.fromValue(10 + 1e-5));
console.log(q4.equals(q5)); // true (в пределах EPSILON)
```

### `isZero(): boolean`

```typescript
const zero = Quantity.zero();
console.log(zero.isZero()); // true

const nonZero = unwrap(Quantity.fromValue(10));
console.log(nonZero.isZero()); // false

// Epsilon handling
const tiny = unwrap(Quantity.fromMarketData(1e-5));
console.log(tiny.isZero()); // true
```

### `isPositive(): boolean`

```typescript
const positive = unwrap(Quantity.fromValue(10));
console.log(positive.isPositive()); // true

const zero = Quantity.zero();
console.log(zero.isPositive()); // false
```

## Утилиты

### `toString(decimals?: number): string`

```typescript
const qty = unwrap(Quantity.fromValue(10.567));

console.log(qty.toString());   // "10.57" (default: 2 decimals)
console.log(qty.toString(0));  // "11"
console.log(qty.toString(1));  // "10.6"
console.log(qty.toString(3));  // "10.567"
```

### Статический геттер

```typescript
console.log(Quantity.minSize); // 1
```

### `isValid(value: number, minSize?: number): boolean`

```typescript
// Валидные количества
console.log(Quantity.isValid(10));    // true
console.log(Quantity.isValid(0));     // true (ноль всегда валиден)
console.log(Quantity.isValid(1000));  // true

// Невалидные количества
console.log(Quantity.isValid(-10));   // false
console.log(Quantity.isValid(NaN));   // false
console.log(Quantity.isValid(Infinity)); // false

// С minSize
console.log(Quantity.isValid(5, 10));  // false (< minSize)
console.log(Quantity.isValid(10, 10)); // true
console.log(Quantity.isValid(0, 10));  // true (ноль разрешен)
```

## Примеры использования

### 1. Расчёт размера ордера с округлением

```typescript
import { unwrap } from '@polymarket/result';
import { Quantity } from '@polymarket/value-objects';

function calculateOrderSize(
  desiredSize: number,
  marketTickSize: number,
  marketMinSize: number
): Quantity {
  // Создать количество с валидацией minSize
  const qty = unwrap(Quantity.fromValue(desiredSize, marketMinSize));

  // Округлить к tick size рынка
  const rounded = unwrap(qty.floorToTick(marketTickSize));

  return rounded;
}

// Использование
const orderSize = calculateOrderSize(10.567, 0.1, 1);
console.log(orderSize.value); // 10.5
```

### 2. Обработка частичных исполнений

```typescript
import { unwrap } from '@polymarket/result';
import { Quantity } from '@polymarket/value-objects';

class Order {
  constructor(
    public readonly originalSize: Quantity,
    public readonly filled: Quantity = Quantity.zero()
  ) {}

  // Обработка частичного исполнения с биржи (возвращает новый Order)
  applyFill(fillSize: number): Order {
    // Используем fromMarketData так как биржа может прислать < MIN_SIZE
    const fillQty = unwrap(Quantity.fromMarketData(fillSize));
    const newFilled = unwrap(this.filled.add(fillQty));

    return new Order(this.originalSize, newFilled);
  }

  getRemainingSize(): Quantity {
    return unwrap(this.originalSize.subtract(this.filled));
  }

  isFilled(): boolean {
    return this.filled.equals(this.originalSize);
  }
}

// Использование
const order = new Order(unwrap(Quantity.fromValue(100)));

const updatedOrder = order.applyFill(37.5);  // Частичное исполнение (новый Order)
console.log(updatedOrder.getRemainingSize().value); // 62.5

const fullyFilled = updatedOrder.applyFill(62.5);  // Оставшаяся часть (новый Order)
console.log(fullyFilled.isFilled()); // true
```

### 3. Position sizing с риск-менеджментом

```typescript
import { unwrap } from '@polymarket/result';
import { Quantity } from '@polymarket/value-objects';

function calculatePositionSize(
  portfolioSize: Quantity,
  riskPercentage: number,
  entryPrice: number,
  stopLossPrice: number,
  tickSize: number
): Quantity {
  // Риск на сделку
  const riskAmount = unwrap(portfolioSize.multiply(riskPercentage / 100));

  // Размер риска на единицу
  const riskPerUnit = Math.abs(entryPrice - stopLossPrice);

  // Максимальный размер позиции
  const maxSize = unwrap(riskAmount.divide(riskPerUnit));

  // Округлить к tick size
  return unwrap(maxSize.floorToTick(tickSize));
}

// Использование
const portfolio = unwrap(Quantity.fromValue(10000));
const positionSize = calculatePositionSize(
  portfolio,
  2,      // 2% риска на сделку
  0.65,   // Entry price
  0.60,   // Stop loss
  0.1     // Tick size
);

console.log(positionSize.value); // Размер позиции с учётом риска
```

### 4. Агрегация рыночных данных

```typescript
import { unwrap } from '@polymarket/result';
import { Quantity } from '@polymarket/value-objects';

interface Trade {
  size: number;
  price: number;
}

function calculateVWAP(trades: Trade[]): number {
  let totalQuantity = Quantity.zero();
  let totalValue = 0;

  for (const trade of trades) {
    // Используем fromMarketData так как это рыночные данные
    const qty = unwrap(Quantity.fromMarketData(trade.size));
    const value = qty.value * trade.price;

    totalQuantity = totalQuantity.add(qty);
    totalValue += value;
  }

  if (totalQuantity.isZero()) {
    return 0;
  }

  return totalValue / totalQuantity.value;
}

// Использование
const trades = [
  { size: 10.5, price: 0.65 },
  { size: 5.3, price: 0.66 },
  { size: 15.2, price: 0.64 }
];

const vwap = calculateVWAP(trades);
console.log(`VWAP: ${vwap.toFixed(4)}`);
```

## Best Practices

### ✅ DO

```typescript
import { unwrap } from '@polymarket/result';

// ✅ Используйте fromValue для создания ордеров
const orderQty = unwrap(Quantity.fromValue(10, marketMinSize));

// ✅ Используйте fromMarketData для входящих данных
const fillQty = unwrap(Quantity.fromMarketData(37.5));

// ✅ Округляйте к tick size перед отправкой ордера
const rounded = unwrap(qty.floorToTick(marketTickSize));

// ✅ Проверяйте валидность перед созданием
if (Quantity.isValid(userInput, marketMinSize)) {
  const qty = unwrap(Quantity.fromValue(userInput, marketMinSize));
}

// ✅ Используйте Quantity.zero() для инициализации
let filled = Quantity.zero();
```

### ❌ DON'T

```typescript
// ❌ НЕ игнорируйте Result
const qty = Quantity.fromValue(10); // Type error!

// ❌ НЕ создавайте Quantity напрямую
const qty = new Quantity(10); // Constructor is private!

// ❌ НЕ изменяйте существующий Quantity
qty.value = 20; // Error: readonly property

// ❌ НЕ используйте fromValue для market data (проверяет MIN_SIZE!)
const fill = unwrap(Quantity.fromValue(0.07)); // Error: < MIN_SIZE!
// Используйте:
const fill = unwrap(Quantity.fromMarketData(0.07)); // ✅

// ❌ НЕ игнорируйте Result в арифметике
const sum = q1.add(q2);  // Returns Result, handle it!
// Используйте:
const sum = unwrap(q1.add(q2)); // ✅
```

## Архитектурные решения

### Почему два метода создания?

1. **fromValue**: для ордеров, проверяет MIN_SIZE - гарантирует что ордер соответствует требованиям рынка
2. **fromMarketData**: для данных с биржи - допускает частичные исполнения < MIN_SIZE

### Почему неотрицательные значения?

1. **Семантика**: количество акций не может быть отрицательным
2. **Безопасность**: предотвращает логические ошибки в расчётах
3. **Направление**: для short позиций используется отдельный флаг side='SELL', не отрицательное количество

### Почему методы экземпляра возвращают Result?

1. **Безопасность**: все ошибки явно обрабатываются через Result
2. **Предсказуемость**: overflow и другие ошибки не скрываются, а возвращаются как Err
3. **Консистентность**: единый подход для всех методов - как factory, так и операций

### Почему tick size awareness?

1. **Реальность рынков**: биржи требуют округления к минимальному шагу
2. **Корректность ордеров**: неокруглённые ордера будут отклонены
3. **Гибкость**: разные рынки имеют разные tick sizes

## TypeScript Types

```typescript
type QuantityValue = number; // >= 0

interface QuantityOperations {
  // Округление
  toTick(tickSize?: number): Result<Quantity, InvalidQuantityError>;
  floorToTick(tickSize?: number): Result<Quantity, InvalidQuantityError>;
  ceilToTick(tickSize?: number): Result<Quantity, InvalidQuantityError>;

  // Арифметика
  add(other: Quantity): Result<Quantity, ArithmeticOverflowError>;
  subtract(other: Quantity): Result<Quantity, InvalidQuantityError>;
  multiply(factor: number): Result<Quantity, InvalidQuantityError | ArithmeticOverflowError>;
  divide(divisor: number): Quantity;

  // Сравнение
  isGreaterThan(other: Quantity): boolean;
  isLessThan(other: Quantity): boolean;
  equals(other: Quantity): boolean;
  isZero(): boolean;
  isPositive(): boolean;

  // Утилиты
  toString(decimals?: number): string;
}
```

## Связь с другими Value Objects

- **Price**: Quantity × Price = Value (денежная стоимость позиции)
- **Quote**: содержит Quantity для bidSize и askSize
- **Money**: Quantity безразмерное, Money имеет валюту

## См. также

- [Price](./price.md) - цены на рынках предсказаний
- [Quote](./quote.md) - котировки с количествами
- [Money](./money.md) - денежные суммы
- [Result<T, E>](../../foundation/result/README.md) - обработка ошибок
