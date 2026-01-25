# Percentage Value Object

## Описание

**Percentage** — неизменяемый value object для представления процентных значений с высокой точностью вычислений.

Использует `decimal.js` для финансовых расчётов и `Result<T, E>` для Railway-Oriented Programming.

## Основные характеристики

- ✅ **Неизменяемость** — все операции возвращают новые экземпляры
- ✅ **Высокая точность** — использует Decimal.js (без проблем floating point)
- ✅ **Безопасность типов** — явная обработка ошибок через Result
- ✅ **Поддержка отрицательных значений** — для PnL, изменений цен
- ✅ **Защита от overflow** — явные ошибки вместо silent clamping
- ✅ **Множественные представления** — проценты, дроби, базисные пункты

## Диапазон значений

```typescript
MIN: -1,000,000%
MAX: +1,000,000%
```

Этого достаточно для любых реальных финансовых сценариев.

## Создание (Factory Methods)

### fromValue(value: number | string | Decimal)

Создать из числа, строки или Decimal (шкала 0-100).

```typescript
import { Percentage } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

// Из числа
const fee = Percentage.fromValue(2.5);  // 2.5%
const gain = Percentage.fromValue(15);  // 15%
const loss = Percentage.fromValue(-10); // -10% (убыток)

// Из строки (с % или без)
const pct1 = Percentage.fromValue("25.5");  // 25.5%
const pct2 = Percentage.fromValue("25.5%"); // 25.5%
const pct3 = Percentage.fromValue("-10%");  // -10%

// Из Decimal (для высокой точности)
const precise = Percentage.fromValue(new Decimal('2.5'));  // 2.5%

// Обработка результата
fee.match({
  ok: (pct) => console.log(pct.getValue()), // 2.5
  err: (error) => console.error(error)
});
```

**Отклоняет:**
- `NaN`
- `Infinity` / `-Infinity`
- Значения вне диапазона [-1e6, 1e6]

### fromDecimal(decimal: number)

Создать из десятичной дроби (шкала 0-1).

```typescript
const pct = Percentage.fromDecimal(0.5);   // 50%
const fee = Percentage.fromDecimal(0.025); // 2.5%
```

**Алгоритм:**
1. Преобразует дробь в проценты: `decimal * 100`
2. Пример: `0.5` → `50%`

### fromString(value: string)

Создать из строки (с `%` или без).

```typescript
const pct1 = Percentage.fromString("25.5");  // 25.5%
const pct2 = Percentage.fromString("25.5%"); // 25.5%
const pct3 = Percentage.fromString("-10%");  // -10%
```

### fromBasisPoints(bps: number)

Создать из базисных пунктов (100 bp = 1%).

```typescript
const pct = Percentage.fromBasisPoints(250); // 2.5%
const fee = Percentage.fromBasisPoints(50);  // 0.5%
```

**Алгоритм:**
1. Преобразует bp в проценты: `bps / 100`
2. Пример: `250 bp` → `2.5%`

### zero() / oneHundred()

Создать константы.

```typescript
const zero = Percentage.zero();          // 0%
const full = Percentage.oneHundred();    // 100%
```

## Математические операции

Все операции возвращают `Result<Percentage, Error>` и **не изменяют** исходные объекты.

### add(other: Percentage)

Сложение процентов.

```typescript
import { unwrap } from '@polymarket/result';

const fee = unwrap(Percentage.fromValue(2.5));
const gain = unwrap(Percentage.fromValue(15));

const total = fee.add(gain);
total.match({
  ok: (pct) => console.log(pct.getValue()), // 17.5
  err: (error) => console.error('Overflow!')
});
```

**Ошибки:**
- `ArithmeticOverflowError` — результат > 1e6 или < -1e6

**Проблема старой версии:**
```typescript
// ❌ СТАРАЯ ВЕРСИЯ (опасно!)
const a = Percentage.fromValue(999999);
const b = Percentage.fromValue(10);
const sum = a.add(b); // Молча возвращает 1_000_000% (clamped)! Баг скрыт!

// ✅ НОВАЯ ВЕРСИЯ (безопасно!)
const sum = a.add(b);
sum.match({
  ok: (pct) => console.log(pct), // Не выполнится
  err: (error) => console.error('Overflow detected! Result exceeds MAX_PERCENTAGE (1_000_000%)') // Явная ошибка!
});
```

### subtract(other: Percentage)

Вычитание процентов.

```typescript
const total = unwrap(Percentage.fromValue(17.5));
const fee = unwrap(Percentage.fromValue(2.5));

const net = total.subtract(fee);
net.match({
  ok: (pct) => console.log(pct.getValue()), // 15
  err: (error) => console.error(error)
});
```

**Разрешает отрицательный результат:**
```typescript
const p1 = unwrap(Percentage.fromValue(5));
const p2 = unwrap(Percentage.fromValue(10));

const diff = p1.subtract(p2);
diff.match({
  ok: (pct) => {
    console.log(pct.getValue());    // -5
    console.log(pct.isNegative());  // true
  },
  err: (error) => console.error(error)
});
```

### multiply(factor: number | Decimal)

Умножение на коэффициент.

```typescript
const base = unwrap(Percentage.fromValue(10));

const doubled = base.multiply(2);
doubled.match({
  ok: (pct) => console.log(pct.getValue()), // 20
  err: (error) => console.error('Overflow')
});
```

### divide(divisor: number | Decimal)

Деление на коэффициент.

```typescript
const total = unwrap(Percentage.fromValue(20));

const half = total.divide(2);
half.match({
  ok: (pct) => console.log(pct.getValue()), // 10
  err: (error) => console.error('Division by zero')
});
```

**Ошибки:**
- `DivisionByZeroError` — деление на 0

### of(value: number | Decimal)

Применить процент к значению.

```typescript
const fee = unwrap(Percentage.fromValue(2.5)); // 2.5%
const orderValue = 1000;

const feeAmount = fee.of(orderValue); // Decimal(25)
console.log(feeAmount.toNumber()); // 25
```

**Алгоритм:**
1. Преобразует процент в дробь: `2.5% → 0.025`
2. Умножает на значение: `1000 * 0.025 = 25`

## Преобразования

### toDecimalFraction()

Преобразовать в десятичную дробь (0-1).

```typescript
const pct = unwrap(Percentage.fromValue(50)); // 50%
const decimal = pct.toDecimalFraction(); // Decimal(0.5)
```

### toBasisPoints()

Преобразовать в базисные пункты.

```typescript
const pct = unwrap(Percentage.fromValue(2.5)); // 2.5%
const bps = pct.toBasisPoints(); // Decimal(250)
```

### getValue()

Получить как number (шкала 0-100).

```typescript
const pct = unwrap(Percentage.fromValue(25.5));
console.log(pct.getValue()); // 25.5
```

### toDecimal()

Получить как Decimal (высокая точность).

```typescript
const pct = unwrap(Percentage.fromValue(25.5));
console.log(pct.toDecimal().toString()); // "25.5"
```

## Сравнение

Все методы сравнения используют Decimal.js для точности.

```typescript
const p1 = unwrap(Percentage.fromValue(10));
const p2 = unwrap(Percentage.fromValue(5));

p1.equals(p2);              // false
p1.greaterThan(p2);         // true
p1.lessThan(p2);            // false
p1.greaterThanOrEqual(p2);  // true
p1.lessThanOrEqual(p2);     // false
```

**Точность decimal.js:**
```typescript
const p1 = unwrap(Percentage.fromString('10.1'));
const p2 = unwrap(Percentage.fromString('10.10'));

p1.equals(p2); // true (decimal.js сравнивает значения, не строки)
```

## Утилиты

### isZero() / isPositive() / isNegative()

Проверка знака.

```typescript
const zero = Percentage.zero();
const gain = unwrap(Percentage.fromValue(10));
const loss = unwrap(Percentage.fromValue(-5));

zero.isZero();       // true
gain.isPositive();   // true
gain.isNegative();   // false
loss.isNegative();   // true
```

### abs()

Абсолютное значение.

```typescript
const loss = unwrap(Percentage.fromValue(-10));
const absLoss = loss.abs();

console.log(absLoss.getValue()); // 10
console.log(loss.getValue());    // -10 (оригинал не изменён)
```

### negate()

Изменить знак.

```typescript
const gain = unwrap(Percentage.fromValue(10));
const loss = gain.negate();

console.log(loss.getValue()); // -10
```

### toString(decimals?: number)

Форматирование с символом `%`.

```typescript
const pct = unwrap(Percentage.fromValue(25.5));

console.log(pct.toString());    // "25.50%"
console.log(pct.toString(1));   // "25.5%"
console.log(pct.toString(4));   // "25.5000%"
```

### toFixedString(decimals?: number)

Форматирование без символа `%`.

```typescript
const pct = unwrap(Percentage.fromValue(25.5));

console.log(pct.toFixedString());    // "25.50"
console.log(pct.toFixedString(3));   // "25.500"
```

## Примеры использования

### Расчёт комиссий

```typescript
import { Percentage } from '@polymarket/value-objects';
import { unwrap } from '@polymarket/result';

const tradingFee = unwrap(Percentage.fromValue(0.25)); // 0.25%
const orderSize = 10000; // USDC

const feeAmount = tradingFee.of(orderSize);
console.log(feeAmount.toNumber()); // 25 USDC
```

### PnL расчёты (Profit & Loss)

```typescript
const entryPrice = 100;
const exitPrice = 95;

const change = ((exitPrice - entryPrice) / entryPrice) * 100;
const pnl = unwrap(Percentage.fromValue(change)); // -5%

if (pnl.isNegative()) {
  console.log(`Убыток: ${pnl.abs().toString()}`); // "Убыток: 5.00%"
}
```

### Композиция операций

```typescript
const initialFee = unwrap(Percentage.fromValue(2));   // 2%
const discount = unwrap(Percentage.fromValue(0.5));   // 0.5%

const finalFee = initialFee.subtract(discount);
finalFee.match({
  ok: (fee) => console.log(`Итоговая комиссия: ${fee.toString()}`), // "Итоговая комиссия: 1.50%"
  err: (error) => console.error('Calculation error')
});
```

### Проблема 0.1 + 0.2 = 0.3

```typescript
// ❌ С обычным number (проблема floating point)
const p1 = 0.1 + 0.2; // 0.30000000000000004

// ✅ С Percentage + Decimal.js (точно!)
const pct1 = unwrap(Percentage.fromDecimal(0.1)); // 10%
const pct2 = unwrap(Percentage.fromDecimal(0.2)); // 20%
const sum = unwrap(pct1.add(pct2));

console.log(sum.toDecimal().toString()); // "30" (точно!)
```

## Архитектурные улучшения

### Что было исправлено

| Проблема старой версии | Решение новой версии |
|------------------------|----------------------|
| ❌ Exceptions вместо Result | ✅ Result<T, E> для Railway-Oriented Programming |
| ❌ Number (floating point) | ✅ Decimal.js для точности |
| ❌ Silent clamping (скрытые баги) | ✅ Явные ошибки overflow/underflow |
| ❌ Публичный `value` field | ✅ Приватное поле + геттеры |
| ❌ Только [0, 100%] | ✅ Поддержка отрицательных значений |
| ❌ EPSILON для сравнения | ✅ Точное сравнение через Decimal.js |
| ❌ Обычный Error при делении | ✅ Типизированный DivisionByZeroError |

### Пример опасного поведения старой версии

```typescript
// ❌ СТАРАЯ ВЕРСИЯ
const a = unwrap(Percentage.fromValue(999999));
const b = unwrap(Percentage.fromValue(10));
const sum = a.add(b); // Молча возвращает 1000000% (silent clamping)
// БАГ! Пользователь думает что 999999% + 10% = 1000000%, а на самом деле это overflow!

// ✅ НОВАЯ ВЕРСИЯ
const sum = a.add(b);
sum.match({
  ok: (pct) => console.log(pct), // Не выполнится
  err: (error) => {
    // ArithmeticOverflowError: "Addition overflow: 999999 + 10 = 1000009 exceeds max 1000000"
    console.error('Overflow detected! Fix your logic!');
  }
});
```

## Ошибки

### InvalidPercentageError

Выбрасывается при создании невалидного процента.

```typescript
import { InvalidPercentageError } from '@polymarket/errors';

const result = Percentage.fromValue(NaN);

result.match({
  ok: (pct) => console.log(pct),
  err: (error) => {
    if (error instanceof InvalidPercentageError) {
      console.error(error.message); // "Percentage cannot be NaN"
      console.error(error.code);    // "INVALID_PERCENTAGE"
      console.error(error.context); // { value: NaN, reason: 'NaN' }
    }
  }
});
```

### ArithmeticOverflowError

Выбрасывается при переполнении арифметических операций.

```typescript
import { ArithmeticOverflowError } from '@polymarket/errors';

const p1 = unwrap(Percentage.fromValue(999999));
const p2 = unwrap(Percentage.fromValue(10));

const result = p1.add(p2);

result.match({
  ok: (pct) => console.log(pct),
  err: (error) => {
    if (error instanceof ArithmeticOverflowError) {
      console.error(error.message);
      // "Addition overflow: 999999 + 10 = 1000009 exceeds max 1000000"
    }
  }
});
```

### DivisionByZeroError

Выбрасывается при делении на ноль.

```typescript
import { DivisionByZeroError } from '@polymarket/errors';

const pct = unwrap(Percentage.fromValue(10));
const result = pct.divide(0);

result.match({
  ok: (pct) => console.log(pct),
  err: (error) => {
    if (error instanceof DivisionByZeroError) {
      console.error(error.message);
      // "Cannot divide percentage 10 by zero"
    }
  }
});
```

## Тесты

Percentage покрыт 95 unit-тестами:

```bash
npm test -- Percentage.test.ts
```

**Категории тестов:**
- ✅ Фабричные методы (25 тестов)
- ✅ Математические операции (23 теста)
- ✅ Преобразования (5 тестов)
- ✅ Сравнение (16 тестов)
- ✅ Утилиты (20 тестов)
- ✅ Граничные случаи (6 тестов)

## Best Practices

### ✅ DO: Используйте unwrap() для упрощения

```typescript
import { unwrap } from '@polymarket/result';

// Короткий синтаксис
const fee = unwrap(Percentage.fromValue(2.5));
console.log(fee.getValue()); // 2.5
```

### ✅ DO: Обрабатывайте ошибки явно

```typescript
const result = Percentage.fromValue(value);

result.match({
  ok: (pct) => processPercentage(pct),
  err: (error) => logError(error)
});
```

### ✅ DO: Используйте Decimal для точности

```typescript
const pct = unwrap(Percentage.fromValue(10));
const amount = new Decimal('1000.123456789');

const result = pct.of(amount); // Decimal точность сохранена
```

### ❌ DON'T: Не игнорируйте Result

```typescript
// ❌ ПЛОХО
const pct = Percentage.fromValue(value); // Result игнорируется

// ✅ ХОРОШО
const result = Percentage.fromValue(value);
if (!result.ok) {
  throw result.error;
}
const pct = result.value;
```

### ❌ DON'T: Не мутируйте объекты

```typescript
// ❌ ПЛОХО (не скомпилируется)
pct.value = 20; // Error: Cannot assign to 'value' because it is a read-only property

// ✅ ХОРОШО
const newPct = unwrap(pct.multiply(2));
```

## TypeScript типы

```typescript
// Результаты всегда Result<T, E>
type CreateResult = Result<Percentage, InvalidPercentageError>;
type MathResult = Result<Percentage, ArithmeticOverflowError>;
type DivideResult = Result<Percentage, DivisionByZeroError>;

// Геттеры
getValue(): number
toDecimal(): Decimal
toDecimalFraction(): Decimal
toBasisPoints(): Decimal

// Операции
add(other: Percentage): Result<Percentage, ArithmeticOverflowError>
subtract(other: Percentage): Result<Percentage, ArithmeticOverflowError>
multiply(factor: number | Decimal): Result<Percentage, ArithmeticOverflowError>
divide(divisor: number | Decimal): Result<Percentage, DivisionByZeroError>
of(value: number | Decimal): Decimal

// Сравнение
equals(other: Percentage): boolean
greaterThan(other: Percentage): boolean
lessThan(other: Percentage): boolean
greaterThanOrEqual(other: Percentage): boolean
lessThanOrEqual(other: Percentage): boolean

// Утилиты
isZero(): boolean
isPositive(): boolean
isNegative(): boolean
abs(): Percentage
negate(): Percentage
toString(decimals?: number): string
toFixedString(decimals?: number): string
```

## Связанные value objects

- **[Money](./money.md)** — денежные суммы
- **[Price](./price.md)** — цены на рынке предсказаний
- **[Quantity](./quantity.md)** — количество акций

## См. также

- [Decimal.js Documentation](https://mikemcl.github.io/decimal.js/)
- [Railway-Oriented Programming](https://fsharpforfunandprofit.com/rop/)
- [Value Objects Pattern](https://martinfowler.com/bliki/ValueObject.html)
