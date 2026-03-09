# AssetQuantity Facade Layer

> AssetQuantityService — единая точка входа с Result<T, E>

## Содержание

1. [Обзор](#обзор)
2. [AssetQuantityService API](#assetquantityservice-api)
3. [Never Throw Contract](#never-throw-contract)
4. [Error Handling](#error-handling)
5. [Примеры](#примеры)

---

## Обзор

**AssetQuantityService** — Facade слой, который:

- Оборачивает все операции в `Result<T, E>`
- Ловит все исключения (из Core и dependencies)
- Никогда не бросает исключения
- Предоставляет удобные методы создания (createUsdc, createOutcomeToken)
- Поддерживает операции с Ratio (portion)

---

## AssetQuantityService API

### Создание

#### `create(asset, amount)`

Создаёт AssetQuantity из AssetId и Quantity.

**Сигнатура:**

```typescript
public static create(
  asset: AssetId,
  amount: Quantity
): Result<AssetQuantity, InvalidAssetQuantityError>
```

**Процесс:**

1. Выполняет defensive copy через конструктор AssetQuantity
2. Конструктор проверяет Object.isFrozen(asset) и пересоздаёт AssetId если нужно
3. Возвращает Result

**Ошибки:**

- Если AssetIdHelpers.fromOutcomeToken() вернёт ошибку (для OUTCOME_TOKEN) — ошибка перехватывается и возвращается как Result.Err

**Пример:**

```typescript
const assetId = AssetIdHelpers.USDC;
const qty = expectOk(QuantityService.create(100));

const result = AssetQuantityService.create(assetId, qty);
if (!result.ok) {
  console.error(result.error.message);
}
```

---

#### `createUsdc(amountValue)`

Создаёт AssetQuantity для USDC из числа или строки.

**Сигнатура:**

```typescript
public static createUsdc(
  amountValue: number | string | Decimal
): Result<AssetQuantity, InvalidAssetQuantityError>
```

**Процесс:**

1. Парсит amountValue через QuantityService.create()
2. Создаёт AssetQuantity с AssetIdHelpers.USDC
3. Возвращает Result

**Ошибки:**

- `INVALID_AMOUNT` — если QuantityService.create() вернул ошибку

**Пример:**

```typescript
const result = AssetQuantityService.createUsdc(100.5);
if (result.ok) {
  console.log(result.value.amount().toNumber()); // 100.5
  console.log(result.value.isCurrency());        // true
}
```

---

#### `createOutcomeToken(conditionRef, outcomeKey, amountValue)`

Создаёт AssetQuantity для outcome token из числа или строки.

**Сигнатура:**

```typescript
public static createOutcomeToken(
  conditionRef: OnChainConditionRef,
  outcomeKey: OutcomeKey,
  amountValue: number | string | Decimal
): Result<AssetQuantity, InvalidAssetQuantityError>
```

**Процесс:**

1. Парсит amountValue через QuantityService.create()
2. Создаёт AssetQuantity через AssetQuantity.outcomeToken() (использует AssetIdHelpers.fromOutcomeToken)
3. Ловит ошибки валидации от AssetIdHelpers.fromOutcomeToken()
4. Возвращает Result

**Ошибки:**

- `INVALID_AMOUNT` — если QuantityService.create() вернул ошибку
- `INVALID_ASSET` — если AssetIdHelpers.fromOutcomeToken() вернул ошибку валидации (ошибка перехватывается и возвращается как Result.Err)

**Пример:**

```typescript
const result = AssetQuantityService.createOutcomeToken(
  conditionRef,
  BinaryOutcome.UP,
  50.25
);
if (result.ok) {
  console.log(result.value.amount().toNumber()); // 50.25
  console.log(result.value.isOutcomeToken());    // true
}
```

---

### Проверки

#### `isZero(assetQty)`

Проверяет что количество нулевое.

**Сигнатура:**

```typescript
public static isZero(assetQty: AssetQuantity): boolean
```

**Процесс:**

- Делегирует к assetQty.isZero()
- Never throws

**Пример:**

```typescript
const zeroQty = expectOk(AssetQuantityService.createUsdc(0));
const isZero = AssetQuantityService.isZero(zeroQty); // true
```

---

#### `isPositive(assetQty)`

Проверяет что количество положительное.

**Сигнатура:**

```typescript
public static isPositive(assetQty: AssetQuantity): boolean
```

**Процесс:**

- Делегирует к assetQty.isPositive()
- Never throws

**Пример:**

```typescript
const qty = expectOk(AssetQuantityService.createUsdc(100));
const isPositive = AssetQuantityService.isPositive(qty); // true
```

---

### Операции с Ratio

#### `portion(assetQty, rate)`

Вычисляет долю (portion) от AssetQuantity.

**Сигнатура:**

```typescript
public static portion(
  assetQty: AssetQuantity,
  rate: Ratio
): Result<AssetQuantity, InvalidAssetQuantityError>
```

**Семантика:**

"Сколько актива составляет доля `rate` от количества `assetQty`"

**Формула:**

```
result.amount = assetQty.amount * rate
```

**Asset сохраняется:**

Результат имеет тот же asset (currency/token) что и исходный.

**Use cases:**

- **Fee calculation**: `portion(orderQty, Ratio.fromPercent(2))` → 2% trading fee
- **Allocation**: `portion(totalQty, Ratio.fromDecimal(0.3))` → 30% allocation
- **Partial fill**: `portion(orderQty, Ratio.fromDecimal(0.5))` → 50% filled

**Процесс:**

1. Multiply: `assetQty.amount().value() * rate.toDecimal()`
2. Create Quantity через QuantityService.create()
3. Create AssetQuantity с тем же asset

**Ошибки:**

- `INVALID_AMOUNT` — результат отрицательный (если rate < 0) или превышает максимум

**Пример:**

```typescript
// Fee calculation: 2% от 1000 USDC
const orderQty = expectOk(AssetQuantityService.createUsdc(1000));
const feeRate = Ratio.of(new Decimal(0.02)); // 2%

const feeResult = AssetQuantityService.portion(orderQty, feeRate);
if (feeResult.ok) {
  console.log(feeResult.value.amount().toNumber()); // 20 USDC
  console.log(feeResult.value.asset());             // Same asset as orderQty
}

// Allocation: 30% от 5000 tokens
const totalTokens = expectOk(AssetQuantityService.createOutcomeToken(
  conditionRef, BinaryOutcome.UP, 5000
));
const allocRate = Ratio.of(new Decimal(0.3)); // 30%

const allocResult = AssetQuantityService.portion(totalTokens, allocRate);
if (allocResult.ok) {
  console.log(allocResult.value.amount().toNumber()); // 1500 tokens
}
```

---

## Never Throw Contract

**Контракт "Never Throw":**

Методы создания/модификации **ГАРАНТИРОВАННО возвращают Result** и **НИКОГДА не бросают исключения**.

Утилитарные методы (equals, isZero, isPositive) возвращают простые типы (boolean).

```typescript
// ✅ Facade НИКОГДА не бросает
const result = AssetQuantityService.createUsdc(value);
if (!result.ok) {
  console.error(result.error.message);
}

// ✅ Даже с invalid input
const invalidResult = AssetQuantityService.createUsdc(NaN);
console.log(invalidResult.ok); // false

// ✅ Утилиты безопасные
const qty = expectOk(AssetQuantityService.createUsdc(100));
const isZero = AssetQuantityService.isZero(qty); // false, never throws
```

---

## Error Handling

### Facade Error Contract

Любой Err из Facade содержит:

- **context.op** — название операции (верхний уровень)
- **context.cause** — для core/math исключений: `{ name, message, stack? }`
- **context.source** — источник ошибки (ErrorSource)
- **context** — дополнительная информация (входные данные, reason если применимо, etc)

### Error Reasons

```typescript
export enum AssetQuantityErrorReason {
  INVALID_ASSET = 'INVALID_ASSET',
  INVALID_AMOUNT = 'INVALID_AMOUNT',
}
```

### Примеры обработки ошибок

```typescript
const result = AssetQuantityService.createUsdc(value);

if (!result.ok) {
  const error = result.error;

  console.error(`Operation: ${error.context?.op}`);
  console.error(`Reason: ${error.context?.reason}`);
  console.error(`Message: ${error.message}`);

  if (error.context?.reason === AssetQuantityErrorReason.INVALID_AMOUNT) {
    // Обработка ошибки invalid amount
  }
}
```

---

## Примеры

### Fee Calculation Workflow

```typescript
import { AssetQuantityService } from '@polymarket/value-objects/asset-quantity';
import { Ratio } from '@polymarket/value-objects/ratio';
import Decimal from 'decimal.js';

// 1. Order: 1000 USDC
const orderQty = AssetQuantityService.createUsdc(1000);
if (!orderQty.ok) return;

// 2. Calculate 2% fee
const feeRate = Ratio.of(new Decimal(0.02));
const feeResult = AssetQuantityService.portion(orderQty.value, feeRate);
if (!feeResult.ok) return;

console.log(feeResult.value.amount().toNumber()); // 20 (2% fee)

// 3. Fee должен иметь тот же asset
expect(AssetIdHelpers.equals(
  feeResult.value.asset(),
  orderQty.value.asset()
)).toBe(true);
```

### Allocation Workflow

```typescript
const total = AssetQuantityService.createUsdc(10000);
if (!total.ok) return;

// Allocation 1: 30%
const alloc1 = AssetQuantityService.portion(total.value, Ratio.of(new Decimal(0.3)));
expect(alloc1.ok && alloc1.value.amount().toNumber()).toBe(3000);

// Allocation 2: 50%
const alloc2 = AssetQuantityService.portion(total.value, Ratio.of(new Decimal(0.5)));
expect(alloc2.ok && alloc2.value.amount().toNumber()).toBe(5000);

// Allocation 3: 20%
const alloc3 = AssetQuantityService.portion(total.value, Ratio.of(new Decimal(0.2)));
expect(alloc3.ok && alloc3.value.amount().toNumber()).toBe(2000);

// Sum должен быть 100% = 10000 ✓
```

### Edge Cases

```typescript
// Zero rate
const qty = AssetQuantityService.createUsdc(100);
if (!qty.ok) return;

const rate = Ratio.of(new Decimal(0));
const result = AssetQuantityService.portion(qty.value, rate);

expect(result.ok).toBe(true);
if (result.ok) {
  expect(result.value.amount().toNumber()).toBe(0);
  expect(result.value.isZero()).toBe(true);
}

// 100% rate (весь amount)
const fullRate = Ratio.of(new Decimal(1));
const fullResult = AssetQuantityService.portion(qty.value, fullRate);

expect(fullResult.ok).toBe(true);
if (fullResult.ok) {
  expect(fullResult.value.amount().toNumber()).toBe(100);
}

// Negative rate (фэйлится)
const negativeRate = Ratio.of(new Decimal(-0.1));
const negativeResult = AssetQuantityService.portion(qty.value, negativeRate);

expect(negativeResult.ok).toBe(false); // Quantity не допускает negative
if (!negativeResult.ok) {
  expect(negativeResult.error.message).toContain('Invalid result amount');
}
```

---

## См. также

- **[AssetQuantity README](./README.md)** — обзор и примеры использования
- **[Ratio](../ratio/README.md)** — документация по Ratio value object
- **[Quantity](../quantity/README.md)** — документация по Quantity value object
