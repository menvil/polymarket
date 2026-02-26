# SignedQuantity Value Object

**Знаковое количество** — immutable value object для представления количеств, которые могут быть положительными, отрицательными или нулевыми.

## 📋 Содержание

- [Обзор](#обзор)
- [Установка](#установка)
- [Основное использование](#основное-использование)
- [API Reference](#api-reference)
- [Архитектура](#архитектура)
- [Примеры](#примеры)

## Обзор

### Зачем SignedQuantity?

SignedQuantity используется для представления величин, которые могут изменять направление:

- **Position deltas**: изменения позиций (+100 купил, -50 продал)
- **Profit & Loss (P&L)**: прибыль/убыток (+500 прибыль, -200 убыток)
- **Net positions**: чистые позиции после операций
- **Account changes**: изменения баланса (+1000 депозит, -500 вывод)

### Отличия от Quantity

| Характеристика | Quantity | SignedQuantity |
|---------------|----------|----------------|
| Диапазон значений | >= 0 (только неотрицательные) | любое конечное число |
| Валидация | должно быть >= 0 | должно быть finite (не NaN, не ±Infinity) |
| Использование | абсолютные количества (акции, объёмы) | относительные изменения (дельты, P&L) |

### Инварианты

SignedQuantity гарантирует:

1. **Finite**: не NaN, не ±Infinity
2. **Normalization**: -0 → 0 (для консистентности)
3. **Immutability**: все операции возвращают новые экземпляры

## Установка

```bash
npm install @polymarket/value-objects
```

## Основное использование

### Создание SignedQuantity

```typescript
import { SignedQuantityService } from '@polymarket/value-objects/signed-quantity';

// Положительное количество
const positive = SignedQuantityService.create(10);

// Отрицательное количество
const negative = SignedQuantityService.create(-10);

// Ноль
const zero = SignedQuantityService.create(0);

// Проверка ошибок
if (positive.ok) {
  console.log(positive.value.toNumber()); // 10
} else {
  console.error(positive.error);
}
```

### Арифметические операции

```typescript
const qty1 = SignedQuantityService.create(100).value;
const qty2 = SignedQuantityService.create(-50).value;

// Сложение
const sum = SignedQuantityService.add(qty1, qty2);
// sum.value.toNumber() === 50

// Вычитание (результат может быть отрицательным)
const diff = SignedQuantityService.subtract(qty1, qty2);
// diff.value.toNumber() === 150

// Умножение (factor может быть отрицательным)
const scaled = SignedQuantityService.multiply(qty1, -0.5);
// scaled.value.toNumber() === -50

// Деление
const divided = SignedQuantityService.divide(qty1, 2);
// divided.value.toNumber() === 50
```

### Операции со знаком

```typescript
const qty = SignedQuantityService.create(-100).value;

// Абсолютное значение
const abs = SignedQuantityService.abs(qty);
// abs.value.toNumber() === 100

// Инверсия знака
const negated = SignedQuantityService.negate(qty);
// negated.value.toNumber() === 100

// Проверки знака
qty.isPositive(); // false
qty.isNegative(); // true
qty.isZero();     // false
qty.sign();       // -1 | 0 | 1
```

### Форматирование

```typescript
import { SignedQuantityFormatter } from '@polymarket/value-objects/signed-quantity';

const profit = SignedQuantityService.create(1500).value;
const loss = SignedQuantityService.create(-1500).value;

// Стандартный формат с знаком
SignedQuantityFormatter.toString(profit, 2);
// "+1500.00"

// Компактный формат
SignedQuantityFormatter.toCompactString(loss);
// "-1500"

// Финансовый формат (negative in parentheses)
SignedQuantityFormatter.toFinancialString(loss, 2);
// "(1500.00)"

// Дисплейный формат с K/M суффиксами
SignedQuantityFormatter.toDisplayString(profit);
// "+1.50K"

// P&L формат для UI
const pnl = SignedQuantityFormatter.toPnLString(profit, 2);
// { value: "+1500.00", indicator: "profit" }
```

### Сериализация

```typescript
import { SignedQuantitySerializer } from '@polymarket/value-objects/signed-quantity';

// Сериализация в JSON
const qty = SignedQuantityService.create(-123.456).value;
const json = SignedQuantitySerializer.toJSON(qty);
// { value: "-123.456" }

// Десериализация из JSON
const result = SignedQuantitySerializer.fromJSON({ value: "-123.456" });
if (result.ok) {
  console.log(result.value.toNumber()); // -123.456
}
```

## API Reference

### SignedQuantityService

**Фасад для работы со знаковыми количествами** — единая точка входа для всех операций.

#### Создание

- `create(value: number | string | Decimal): Result<SignedQuantity, InvalidSignedQuantityError>`
  - Создаёт SignedQuantity из number/string/Decimal
  - Валидирует finite (не NaN, не ±Infinity)

#### Арифметика

- `add(qty1, qty2): Result<SignedQuantity, InvalidSignedQuantityError>`
  - Складывает два количества

- `subtract(qty1, qty2): Result<SignedQuantity, InvalidSignedQuantityError>`
  - Вычитает количества (результат может быть отрицательным)

- `multiply(qty, factor): Result<SignedQuantity, InvalidSignedQuantityError>`
  - Умножает на коэффициент (factor может быть отрицательным)

- `divide(qty, divisor): Result<SignedQuantity, InvalidSignedQuantityError>`
  - Делит на делитель (проверяет деление на ноль)

#### Операции со знаком

- `abs(qty): Result<SignedQuantity, InvalidSignedQuantityError>`
  - Возвращает абсолютное значение

- `negate(qty): Result<SignedQuantity, InvalidSignedQuantityError>`
  - Инверсия знака (положительное ↔ отрицательное)

### SignedQuantity (Core)

**Immutable value object** — хранит Decimal для точности.

#### Методы

- `value(): Decimal` — возвращает Decimal значение
- `toNumber(): number` — конвертирует в number (lossy!)

**Проверки равенства:**
- `equals(other): boolean` — строгое равенство
- `isZero(): boolean` — проверка на ноль
- `isPositive(): boolean` — проверка на положительное (> 0)
- `isNegative(): boolean` — проверка на отрицательное (< 0)

**Сравнения:**
- `isLessThan(other): boolean`
- `isLessThanOrEqual(other): boolean`
- `isGreaterThan(other): boolean`
- `isGreaterThanOrEqual(other): boolean`

**Операции со знаком:**
- `sign(): -1 | 0 | 1` — возвращает знак
- `abs(): Decimal` — абсолютное значение (возвращает Decimal!)
- `neg(): SignedQuantity` — инверсия знака

#### Константы

- `SignedQuantity.ZERO` — нулевое количество
- `SignedQuantity.ONE` — единица
- `SignedQuantity.MINUS_ONE` — минус единица

### SignedQuantityFormatter

**Форматирование для отображения.**

- `toString(qty, decimals, options): Result<string, InvalidDecimalPlacesError>`
  - Формат: "+10.50", "-10.50", "0.00"
  - Options: `{ showPlusSign?: boolean }`

- `toCompactString(qty, options): string`
  - Без trailing zeros: "+10.5", "-10.5"

- `toDebugString(qty): string`
  - Для отладки: "SignedQuantity(+10)"

- `toFinancialString(qty, decimals): Result<string, InvalidDecimalPlacesError>`
  - Финансовый формат: "10.50", "(10.50)"

- `toDisplayString(qty, options): string`
  - С K/M суффиксами: "+1.50K", "-1.50M"

- `toPnLString(qty, decimals): Result<{ value, indicator }, InvalidDecimalPlacesError>`
  - P&L формат: `{ value: "+10.00", indicator: "profit" | "loss" | "neutral" }`

### SignedQuantitySerializer

**JSON сериализация/десериализация.**

- `toJSON(qty): SignedQuantityJSON`
  - Возвращает: `{ value: string }`

- `fromJSON(json: unknown): Result<SignedQuantity, InvalidSignedQuantityError>`
  - Валидирует структуру JSON
  - Парсит через SignedQuantityService.create()

## Архитектура

### Слои

```
signed-quantity/
├── core/               # Core Layer - инварианты, бизнес-логика
│   ├── SignedQuantity.ts
│   └── SignedQuantityInvariantViolation.ts
├── errors/             # Типизированные причины ошибок
│   └── SignedQuantityErrorReason.ts
├── facade/             # Facade Layer - публичный API, Result<T,E>
│   └── SignedQuantityService.ts
└── adapters/           # Adapters Layer - форматирование, сериализация
    ├── SignedQuantityFormatter.ts
    └── SignedQuantitySerializer.ts
```

### Паттерн Throws+Facade

1. **Core** бросает исключения при нарушении инвариантов
2. **Facade** ловит исключения и возвращает `Result<T, E>`
3. **Публичный код** работает только с Facade через Result

```typescript
// ❌ НЕ используй Core напрямую в публичном коде
const qty = SignedQuantity.of(new Decimal(value)); // может бросить!

// ✅ Используй Facade
const result = SignedQuantityService.create(value);
if (result.ok) {
  // работай с result.value
}
```

## Примеры

### Position Delta (изменение позиции)

```typescript
// Купил 100 акций, продал 50
const buy = SignedQuantityService.create(100).value;
const sell = SignedQuantityService.create(-50).value;

const netPosition = SignedQuantityService.add(buy, sell);
// netPosition.value.toNumber() === 50
```

### P&L Calculation (прибыль/убыток)

```typescript
const pnl = SignedQuantityService.create(-250).value;

// Форматирование для UI
const formatted = SignedQuantityFormatter.toPnLString(pnl, 2);
if (formatted.ok) {
  const { value, indicator } = formatted.value;
  console.log(value);      // "-250.00"
  console.log(indicator);  // "loss"

  // В React:
  // <span className={indicator}>{value}</span>
}
```

### Account Balance Changes

```typescript
const deposit = SignedQuantityService.create(1000).value;
const withdrawal = SignedQuantityService.create(-500).value;
const fee = SignedQuantityService.create(-10).value;

// Итоговое изменение
let change = SignedQuantityService.add(deposit, withdrawal).value;
change = SignedQuantityService.add(change, fee).value;
// change.toNumber() === 490

// Форматирование для финансового отчёта
const formatted = SignedQuantityFormatter.toFinancialString(change, 2);
// "490.00"
```

### Position Reversal (разворот позиции)

```typescript
// Был long 100 акций, открыл short 200
const longPosition = SignedQuantityService.create(100).value;
const shortTrade = SignedQuantityService.create(-200).value;

const netPosition = SignedQuantityService.add(longPosition, shortTrade).value;
// netPosition.toNumber() === -100 (теперь short 100)

if (netPosition.isNegative()) {
  console.log('Position reversed to short');
}
```

## Testing

Все операции покрыты тестами (140 тестов):

```bash
npm test -- signed-quantity
```

## См. также

- [Architecture.md](./architecture.md) — архитектурные решения
- [Examples.md](./examples.md) — расширенные примеры
- [Facade.md](./facade.md) — детали SignedQuantityService
- [Operations.md](./operations.md) — операции scale/portion/roundToStep/adjustBy

## Лицензия

MIT
