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
const qty1Result = SignedQuantityService.create(100);
const qty2Result = SignedQuantityService.create(-50);

if (qty1Result.ok && qty2Result.ok) {
  const qty1 = qty1Result.value;
  const qty2 = qty2Result.value;

  // Сложение
  const sum = SignedQuantityService.add(qty1, qty2);
  if (sum.ok) {
    console.log(sum.value.toNumber()); // 50
  }

  // Вычитание (результат может быть отрицательным)
  const diff = SignedQuantityService.subtract(qty1, qty2);
  if (diff.ok) {
    console.log(diff.value.toNumber()); // 150
  }

  // Умножение (factor может быть отрицательным)
  const scaled = SignedQuantityService.multiply(qty1, -0.5);
  if (scaled.ok) {
    console.log(scaled.value.toNumber()); // -50
  }

  // Деление
  const divided = SignedQuantityService.divide(qty1, 2);
  if (divided.ok) {
    console.log(divided.value.toNumber()); // 50
  }
}
```

### Операции со знаком

```typescript
const qtyResult = SignedQuantityService.create(-100);
if (qtyResult.ok) {
  const qty = qtyResult.value;

  // Абсолютное значение
  const abs = SignedQuantityService.abs(qty);
  if (abs.ok) {
    console.log(abs.value.toNumber()); // 100
  }

  // Инверсия знака
  const negated = SignedQuantityService.negate(qty);
  if (negated.ok) {
    console.log(negated.value.toNumber()); // 100
  }

  // Проверки знака
  console.log(qty.isPositive()); // false
  console.log(qty.isNegative()); // true
  console.log(qty.isZero());     // false
  console.log(qty.sign());       // -1 | 0 | 1
}
```

### Форматирование

```typescript
import { SignedQuantityFormatter } from '@polymarket/value-objects/signed-quantity';

const profitResult = SignedQuantityService.create(1500);
const lossResult = SignedQuantityService.create(-1500);

if (profitResult.ok && lossResult.ok) {
  const profit = profitResult.value;
  const loss = lossResult.value;

  // Стандартный формат с знаком
  const formatted = SignedQuantityFormatter.toString(profit, 2);
  if (formatted.ok) {
    console.log(formatted.value); // "+1500.00"
  }

  // Компактный формат
  console.log(SignedQuantityFormatter.toCompactString(loss)); // "-1500"

  // Финансовый формат (negative in parentheses)
  const financial = SignedQuantityFormatter.toFinancialString(loss, 2);
  if (financial.ok) {
    console.log(financial.value); // "(1500.00)"
  }

  // Дисплейный формат с K/M суффиксами (возвращает string напрямую, не Result)
  const display = SignedQuantityFormatter.toDisplayString(profit);
  console.log(display); // "+1.50K"

  // P&L формат для UI
  const pnl = SignedQuantityFormatter.toPnLString(profit, 2);
  if (pnl.ok) {
    console.log(pnl.value); // { value: "+1500.00", indicator: "profit" }
  }
}
```

### Сериализация

```typescript
import { SignedQuantitySerializer } from '@polymarket/value-objects/signed-quantity';

// Сериализация в JSON
const qtyResult = SignedQuantityService.create(-123.456);
if (qtyResult.ok) {
  const qty = qtyResult.value;
  const json = SignedQuantitySerializer.toJSON(qty);
  // { value: "-123.456" }
}

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
  - Возвращает абсолютное значение (всегда `Ok`)

- `negate(qty): Result<SignedQuantity, InvalidSignedQuantityError>`
  - Инверсия знака (положительное ↔ отрицательное)

#### Масштабирование и часть (Ratio-based)

- `scale(qty, rate: Ratio): Result<SignedQuantity, InvalidSignedQuantityError>`
  - Масштабирует количество на rate
  - **Требует:** `rate >= 0` — предотвращает инверсию знака
  - Ошибка: `NEGATIVE_SCALE_FACTOR` если rate < 0

- `portion(qty, rate: Ratio): Result<SignedQuantity, InvalidSignedQuantityError>`
  - Вычисляет `qty * rate`
  - Принимает любой rate (включая отрицательный)
  - Инверсия знака разрешена

#### Округление

- `roundToStep(qty, stepSize, roundingMode?): Result<SignedQuantity, InvalidSignedQuantityError>`
  - Округляет до ближайшего кратного `stepSize`
  - `stepSize`: `number | string | Decimal`, должен быть `> 0`
  - `roundingMode`: default `Decimal.ROUND_HALF_UP`
  - Корректно обрабатывает отрицательные значения

#### Процентное изменение

- `adjustBy(qty, delta: Ratio, stepSize, options?): Result<SignedQuantity, InvalidSignedQuantityError>`
  - Применяет `qty * (1 + delta)`, затем округляет до `stepSize`
  - `options.allowCrossZero` (default: `true`): при `true` — разрешает смену знака результата; при `false` — запрещает два случая:
    - переход через ноль: `positive → negative` или наоборот → ошибка `RESULT_CROSSES_ZERO`
    - движение от нуля: `qty = 0` и ненулевой результат → ошибка `CANNOT_ADJUST_ZERO` (нельзя определить направление позиции)
  - Ошибка: `RESULT_CROSSES_ZERO` при `allowCrossZero = false` и смене знака (positive→negative или наоборот)
  - Ошибка: `CANNOT_ADJUST_ZERO` при `allowCrossZero = false`, `qty = 0` и ненулевом результате
  - OK: `qty = 0` и `delta = 0` (result = 0 → идемпотентная операция)

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
- `abs(): SignedQuantity` — абсолютное значение (возвращает SignedQuantity)
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
├── rules/              # Validation Rules - переиспользуемые проверки
│   ├── ValidateFactorForSignedQuantityScale.ts   # rate >= 0 для scale()
│   ├── ValidateDeltaForAdjustByNoCrossZero.ts    # no sign flip для adjustBy()
│   ├── ValidateStepSizeForSignedQuantity.ts      # stepSize > 0 для roundToStep/adjustBy
│   └── index.ts
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
const buyResult = SignedQuantityService.create(100);
const sellResult = SignedQuantityService.create(-50);

if (buyResult.ok && sellResult.ok) {
  const buy = buyResult.value;
  const sell = sellResult.value;

  const netPosition = SignedQuantityService.add(buy, sell);
  if (netPosition.ok) {
    console.log(netPosition.value.toNumber()); // 50
  }
}
```

### P&L Calculation (прибыль/убыток)

```typescript
const pnlResult = SignedQuantityService.create(-250);
if (pnlResult.ok) {
  const pnl = pnlResult.value;

  // Форматирование для UI
  const formatted = SignedQuantityFormatter.toPnLString(pnl, 2);
  if (formatted.ok) {
    const { value, indicator } = formatted.value;
    console.log(value);      // "-250.00"
    console.log(indicator);  // "loss"

    // В React:
    // <span className={indicator}>{value}</span>
  }
}
```

### Account Balance Changes

```typescript
const depositResult = SignedQuantityService.create(1000);
const withdrawalResult = SignedQuantityService.create(-500);

if (depositResult.ok && withdrawalResult.ok) {
  const deposit = depositResult.value;
  const withdrawal = withdrawalResult.value;

  const feeResult = SignedQuantityService.create(-10);
  if (feeResult.ok) {
    const fee = feeResult.value;

    // Итоговое изменение
    const step1 = SignedQuantityService.add(deposit, withdrawal);
    if (step1.ok) {
      const step2 = SignedQuantityService.add(step1.value, fee);
      if (step2.ok) {
        const change = step2.value;
        console.log(change.toNumber()); // 490

        // Форматирование для финансового отчёта
        const formatted = SignedQuantityFormatter.toFinancialString(change, 2);
        if (formatted.ok) {
          console.log(formatted.value); // "490.00"
        }
      }
    }
  }
}
```

### Position Reversal (разворот позиции)

```typescript
// Был long 100 акций, открыл short 200
const longPositionResult = SignedQuantityService.create(100);
const shortTradeResult = SignedQuantityService.create(-200);

if (longPositionResult.ok && shortTradeResult.ok) {
  const longPosition = longPositionResult.value;
  const shortTrade = shortTradeResult.value;

  const netPositionResult = SignedQuantityService.add(longPosition, shortTrade);
  if (netPositionResult.ok) {
    const netPosition = netPositionResult.value;
    console.log(netPosition.toNumber()); // -100 (теперь short 100)

    if (netPosition.isNegative()) {
      console.log('Position reversed to short');
    }
  }
}
```

## Testing

Все операции покрыты тестами (212 тестов, включая Core, Facade, Rules, Adapters):

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
