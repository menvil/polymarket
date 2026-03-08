# AssetQuantity Value Object

**AssetQuantity** — иммутабельный value object, представляющий количество актива (USDC или outcome token).

## Описание

AssetQuantity комбинирует:

- **AssetId** — идентификатор актива (currency или outcome token)
- **Quantity** — количество актива (non-negative, finite)

## Быстрый старт

```typescript
import { AssetQuantityService } from '@polymarket/value-objects/asset-quantity';
import { AssetId, BinaryOutcome } from '@polymarket/ids';
import { Ratio } from '@polymarket/value-objects/ratio';
import { isErr } from '@polymarket/result';

// Создание USDC quantity
const usdcResult = AssetQuantityService.createUsdc(100);
if (isErr(usdcResult)) {
  console.error(usdcResult.error.message);
  return;
}

const usdcQty = usdcResult.value;
console.log(usdcQty.amount().toNumber());  // 100
console.log(usdcQty.isCurrency());         // true

// Создание outcome token quantity
const tokenResult = AssetQuantityService.createOutcomeToken(
  conditionRef,
  BinaryOutcome.UP,
  50
);

if (tokenResult.ok) {
  console.log(tokenResult.value.isOutcomeToken()); // true
}
```

## Операции с Ratio

### portion() — Вычисление доли

Вычисляет долю (portion) от количества актива.

**Семантика:** "Сколько актива составляет доля `rate` от количества `assetQty`"

**Формула:** `result.amount = assetQty.amount * rate`

**Use cases:**

- **Fee calculation**: `portion(orderQty, Ratio.fromPercent(2))` → 2% trading fee
- **Allocation**: `portion(totalQty, Ratio.fromDecimal(0.3))` → 30% allocation
- **Partial fill**: `portion(orderQty, Ratio.fromDecimal(0.5))` → 50% filled

```typescript
import { AssetQuantityService } from '@polymarket/value-objects/asset-quantity';
import { Ratio } from '@polymarket/value-objects/ratio';
import Decimal from 'decimal.js';

// Fee calculation: 2% от 1000 USDC
const orderQty = AssetQuantityService.createUsdc(1000);
if (!orderQty.ok) return;

const feeRate = Ratio.of(new Decimal(0.02)); // 2%
const feeResult = AssetQuantityService.portion(orderQty.value, feeRate);

if (feeResult.ok) {
  console.log(feeResult.value.amount().toNumber()); // 20 USDC
  console.log(feeResult.value.isCurrency());        // true (сохраняется asset)
}

// Allocation: 30% от 5000 outcome tokens
const totalTokens = AssetQuantityService.createOutcomeToken(
  conditionRef,
  BinaryOutcome.UP,
  5000
);
if (!totalTokens.ok) return;

const allocRate = Ratio.of(new Decimal(0.3)); // 30%
const allocResult = AssetQuantityService.portion(totalTokens.value, allocRate);

if (allocResult.ok) {
  console.log(allocResult.value.amount().toNumber()); // 1500 tokens
  console.log(allocResult.value.isOutcomeToken());    // true
}

// Partial fill: 50% от 200 tokens
const orderTokens = AssetQuantityService.createOutcomeToken(
  conditionRef,
  BinaryOutcome.DOWN,
  200
);
if (!orderTokens.ok) return;

const fillRate = Ratio.of(new Decimal(0.5)); // 50%
const filledResult = AssetQuantityService.portion(orderTokens.value, fillRate);

if (filledResult.ok) {
  console.log(filledResult.value.amount().toNumber()); // 100 tokens
}
```

**Возможные ошибки:**

- `INVALID_AMOUNT` — результат отрицательный (если rate < 0) или превышает максимум

## Основные методы

### Создание

#### `createUsdc(amountValue)`

Создаёт AssetQuantity для USDC из числа или строки.

```typescript
const result = AssetQuantityService.createUsdc(100.5);
if (result.ok) {
  console.log(result.value.amount().toNumber()); // 100.5
  console.log(result.value.isCurrency());        // true
}
```

#### `createOutcomeToken(conditionRef, outcomeKey, amountValue)`

Создаёт AssetQuantity для outcome token из числа или строки.

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

#### `create(asset, amount)`

Создаёт AssetQuantity из AssetId и Quantity.

```typescript
const assetId = AssetIdHelpers.USDC;
const qty = expectOk(QuantityService.create(100));

const result = AssetQuantityService.create(assetId, qty);
if (!result.ok) {
  console.error(result.error.message);
}
```

### Проверки

#### `isZero(assetQty)`

Проверяет что количество нулевое.

```typescript
const zeroQty = expectOk(AssetQuantityService.createUsdc(0));
const isZero = AssetQuantityService.isZero(zeroQty); // true
```

#### `isPositive(assetQty)`

Проверяет что количество положительное.

```typescript
const qty = expectOk(AssetQuantityService.createUsdc(100));
const isPositive = AssetQuantityService.isPositive(qty); // true
```

## Инварианты

- **AssetId** — должен быть валидным (currency или outcome token)
- **Quantity** — должен быть валидным (non-negative, finite, <= MAX_AMOUNT)
- **Иммутабельность** — все поля readonly, для изменений создавайте новый AssetQuantity

## Архитектура

AssetQuantity следует layered architecture:

- **Core** (`src/asset-quantity/core/`) — AssetQuantity class с defensive copy
- **Facade** (`src/asset-quantity/facade/`) — AssetQuantityService с Result<T, E>
- **Errors** (`src/asset-quantity/errors/`) — InvalidAssetQuantityError, AssetQuantityErrorReason
- **Adapters** (`src/asset-quantity/adapters/`) — парсеры, форматеры

### Never Throw Contract

**Facade методы** (создание/модификация) **ГАРАНТИРОВАННО возвращают Result** и **НИКОГДА не бросают исключения**.

```typescript
// ✅ Facade НИКОГДА не бросает
const result = AssetQuantityService.createUsdc(value);
if (!result.ok) {
  console.error(result.error.message);
}

// ❌ Core может бросить (только для внутреннего использования)
const assetQty = new AssetQuantity(asset, amount); // может бросить
```

## Интеграция с другими Value Objects

- **Quantity** — для представления amount
- **Ratio** — для операций portion()
- **AssetId** — для идентификации актива (currency/token)
- **TokenBalance** — использует OutcomeToken + Quantity (похожая структура)

## Примеры использования

### Fee calculation workflow

```typescript
// 1. Order: 1000 USDC
const orderQty = AssetQuantityService.createUsdc(1000);
if (!orderQty.ok) return;

// 2. Calculate 2% fee
const feeRate = Ratio.of(new Decimal(0.02));
const feeResult = AssetQuantityService.portion(orderQty.value, feeRate);
if (!feeResult.ok) return;

console.log(feeResult.value.amount().toNumber()); // 20 (2% fee)

// 3. Fee имеет тот же asset
console.log(AssetIdHelpers.equals(
  feeResult.value.asset(),
  orderQty.value.asset()
)); // true
```

### Allocation workflow

```typescript
const total = AssetQuantityService.createUsdc(10000);
if (!total.ok) return;

// Allocation 1: 30%
const alloc1 = AssetQuantityService.portion(total.value, Ratio.of(new Decimal(0.3)));
console.log(alloc1.ok && alloc1.value.amount().toNumber()); // 3000

// Allocation 2: 50%
const alloc2 = AssetQuantityService.portion(total.value, Ratio.of(new Decimal(0.5)));
console.log(alloc2.ok && alloc2.value.amount().toNumber()); // 5000

// Allocation 3: 20%
const alloc3 = AssetQuantityService.portion(total.value, Ratio.of(new Decimal(0.2)));
console.log(alloc3.ok && alloc3.value.amount().toNumber()); // 2000

// Sum = 100% = 10000 ✓
```

## Тесты

**96 тестов**, включая:

- 17 тестов для `portion()` операций
- Тесты для USDC и OutcomeToken
- Edge cases (zero, large, small amounts)
- Integration scenarios (fee calculation, allocation)

```bash
npm test -- AssetQuantity
```

## См. также

- **[Facade API](./facade.md)** — подробная документация AssetQuantityService
- **[Ratio](../ratio/README.md)** — документация по Ratio value object
- **[Quantity](../quantity/README.md)** — документация по Quantity value object
