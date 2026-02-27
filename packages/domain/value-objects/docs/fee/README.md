# Fee Value Object

Fee представляет комиссию (fee) в любом активе: Currency (USDC) или OutcomeToken.

## Обзор

Fee является wrapper над `AssetQuantity` с дополнительными инвариантами и семантикой комиссии. Используется для представления trading fees, settlement fees, gas fees и withdrawal fees.

**Ключевые характеристики:**
- Immutable value object
- Всегда non-negative (>= 0)
- Точная арифметика через Decimal.js
- Типизированные assets (Currency или OutcomeToken)

## Инварианты

Fee гарантирует следующие инварианты:

1. **Non-negative**: `amount >= 0` (гарантируется через Quantity инвариант)
2. **Finite**: `amount` не может быть NaN или Infinity
3. **Immutable**: все операции возвращают новые экземпляры
4. **Asset frozen**: asset иммутабелен после создания

## API

### Создание Fee

```typescript
import { Fee, AssetQuantity, Quantity } from '@polymarket/value-objects';
import { AssetIdHelpers } from '@polymarket/ids';
import Decimal from 'decimal.js';

// Из AssetQuantity
const qty = Quantity.of(new Decimal('0.10'));
const assetQty = AssetQuantity.usdc(qty);
const fee = Fee.of(assetQty);

// Zero fee
const zeroFee = Fee.zero(AssetIdHelpers.USDC);
console.log(zeroFee.isZero()); // true
```

### Операции

```typescript
// Сложение fees (только с одинаковым asset)
const fee1 = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
const fee2 = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.05'))));
const total = fee1.add(fee2);
console.log(total.quantity.amount().toNumber()); // 0.15

// ❌ Нельзя складывать fees с разными assets
const usdcFee = Fee.zero(AssetIdHelpers.USDC);
const tokenFee = Fee.zero(someTokenAsset);
// usdcFee.add(tokenFee); // Throws FeeOperationError

// Проверка равенства
if (fee1.equals(fee2)) {
  console.log('Одинаковые комиссии');
}

// Проверка нулевой комиссии
if (fee.isZero()) {
  console.log('No fee');
}
```

### Геттеры

```typescript
// Получить AssetQuantity
const quantity = fee.quantity; // AssetQuantity
const amount = fee.quantity.amount(); // Quantity

// Получить AssetId
const asset = fee.asset; // AssetId (currency или outcome token)

// Отладочная строка
console.log(fee.toString()); // "Fee(CURRENCY:USDC, 0.1)"
```

## Error Handling

Fee.add() может бросить `FeeOperationError` если assets не совпадают:

```typescript
import { FeeOperationError, FeeOperationErrorReason } from '@polymarket/value-objects';

try {
  const total = usdcFee.add(tokenFee);
} catch (e) {
  if (e instanceof FeeOperationError && e.context?.reason === FeeOperationErrorReason.ASSET_MISMATCH) {
    console.error('Cannot add fees with different assets');
    console.error('Asset 1:', e.context.asset1);
    console.error('Asset 2:', e.context.asset2);
  }
}
```

### Error Reasons

```typescript
enum FeeErrorReason {
  ASSET_MISMATCH = 'ASSET_MISMATCH',      // Попытка сложить fees с разными assets
  NEGATIVE_FEE = 'NEGATIVE_FEE',          // Отрицательная комиссия (не допускается)
  INVALID_QUANTITY = 'INVALID_QUANTITY'   // Невалидный AssetQuantity
}
```

## Сериализация

### JSON формат

```typescript
import { FeeSerializer } from '@polymarket/value-objects';

// Сериализация
const fee = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
const json = FeeSerializer.toJSON(fee);
// { asset: { type: 'CURRENCY', currency: 'USDC' }, amount: "0.1" }

// Десериализация
const result = FeeSerializer.fromJSON(json);
if (result.ok) {
  console.log(result.value.quantity.amount().toNumber()); // 0.1
}

// Десериализация из unknown (с валидацией)
const parsed: unknown = JSON.parse('{"asset": {...}, "amount": "0.10"}');
const safeResult = FeeSerializer.fromUnknown(parsed);
if (safeResult.ok) {
  // использовать safeResult.value
}
```

**Важно:** `amount` сериализуется как **string** для сохранения точности (как в MoneySerializer, AssetQuantitySerializer).

### Round-trip гарантии

```typescript
// Precision сохраняется через сериализацию
const precise = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('123456789.123456789012345'))));
const json = FeeSerializer.toJSON(precise);
const result = FeeSerializer.fromJSON(json);

if (result.ok) {
  expect(result.value.equals(precise)).toBe(true); // ✅
  expect(result.value.quantity.amount().value().toString()).toBe('123456789.123456789012345'); // ✅
}
```

## Форматирование

```typescript
import { FeeFormatter } from '@polymarket/value-objects';

const fee = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));

// Display формат (amount + symbol)
FeeFormatter.toDisplay(fee);      // "0.1 USDC"

// Только amount
FeeFormatter.toAmount(fee);       // "0.1"

// Только asset symbol
FeeFormatter.toAssetSymbol(fee);  // "USDC"

// Для отладки
FeeFormatter.toDebugString(fee);  // "Fee(CURRENCY:USDC, 0.1)"
```

### Outcome Token форматирование

```typescript
// Для outcome token - короткий формат condition ID
const tokenFee = Fee.of(new AssetQuantity(tokenAsset, qty));
FeeFormatter.toAssetSymbol(tokenFee);  // "UP:0x1234...cdef"
FeeFormatter.toDisplay(tokenFee);      // "0.1 UP:0x1234...cdef"
```

## FeeService (Facade)

FeeService предоставляет thin wrapper над Fee core:

```typescript
import { FeeService } from '@polymarket/value-objects';

// Создание Fee (Result-based)
const createResult = FeeService.create(AssetIdHelpers.USDC, 0.10);
if (!createResult.ok) {
  console.error('Failed to create fee:', createResult.error.message);
}

// Другие методы
const fee = FeeService.of(assetQty); // для internal use
const zero = FeeService.zero(AssetIdHelpers.USDC);
const equal = FeeService.equals(fee1, fee2);

// Сложение (Result-based, Never Throws)
const addResult = FeeService.add(fee1, fee2);
if (!addResult.ok) {
  console.error('Failed to add fees:', addResult.error.context?.reason);
}
```

**Важно:**
- `FeeService.create()` и `FeeService.add()` используют Result pattern (Never Throws)
- `FeeService.of()` marked @internal - для публичного API используйте `create()`
- Fee.add() может бросить FeeOperationError при asset mismatch

## Использование

### Trading Fees

```typescript
// Maker fee
const makerFee = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.01'))));

// Taker fee
const takerFee = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.02'))));

// Total fee
const totalFee = makerFee.add(takerFee);
console.log(FeeFormatter.toDisplay(totalFee)); // "0.03 USDC"
```

### Settlement Fees

```typescript
// Settlement fee в outcome token
const settlementFee = Fee.of(new AssetQuantity(tokenAsset, Quantity.of(new Decimal('5'))));
console.log(FeeFormatter.toDisplay(settlementFee)); // "5 UP:0x1234...cdef"
```

### Gas Fees

```typescript
// Gas fee accumulation
let totalGas = Fee.zero(AssetIdHelpers.USDC);

for (const tx of transactions) {
  const txGas = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal(tx.gasUsed))));
  totalGas = totalGas.add(txGas);
}

console.log(FeeFormatter.toDisplay(totalGas)); // "12.5 USDC"
```

## Отличия от AssetQuantity

| Аспект | AssetQuantity | Fee |
|--------|---------------|-----|
| **Семантика** | Общее количество актива | Комиссия (специализированное значение) |
| **Операции** | add, subtract, multiplyBy, divideBy | add (только для fees) |
| **Валидация add** | Проверяет asset match | Проверяет asset match + бросает FeeOperationError |
| **Use cases** | Позиции, балансы, любые количества | Trading fees, gas fees, settlement fees |

**Когда использовать Fee:**
- ✅ Trading fees (maker/taker)
- ✅ Settlement fees
- ✅ Gas fees
- ✅ Withdrawal fees
- ✅ Любые комиссии в системе

**Когда использовать AssetQuantity:**
- ✅ Позиции (holdings)
- ✅ Балансы
- ✅ Объёмы сделок
- ✅ Любые другие количества активов

## Архитектура

Fee следует 3-слойной архитектуре:

```
┌─────────────────────────────────┐
│         Facade Layer            │  FeeService (public API)
│  Result-based для create/add    │  Validates and delegates to core
├─────────────────────────────────┤
│          Core Layer             │  Fee (business logic)
│      Throws on violation        │  Immutable, pure functions
├─────────────────────────────────┤
│        Adapters Layer           │  FeeFormatter, FeeSerializer
│    I/O, formatting, parsing     │  Result-based для deserializers
└─────────────────────────────────┘
```

**Core Layer (Fee):**
- Бросает исключения при нарушении инвариантов
- Простая бизнес-логика
- Immutable операции

**Facade Layer (FeeService):**
- Публичный API с валидацией
- Result-based для create() и add() (Never Throws)
- Делегирует в core
- Fee.of() marked @internal

**Adapters Layer:**
- FeeFormatter: форматирование для UI/logs
- FeeSerializer: JSON сериализация (Result-based)

## См. также

- [AssetQuantity](../asset-quantity/README.md) - базовый VO для количеств активов
- [Money](../money/README.md) - для денежных сумм с валютой
- [Quantity](../quantity/README.md) - для неотрицательных количеств
