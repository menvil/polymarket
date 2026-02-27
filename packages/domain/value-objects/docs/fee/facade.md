# Fee: Справочник API

Полный справочник публичного API: FeeService, FeeFormatter, FeeSerializer.

## Содержание

- [FeeService](#feeservice)
- [Fee (Core)](#fee-core)
- [FeeFormatter](#feeformatter)
- [FeeSerializer](#feeserializer)

## FeeService

**Публичный API** для создания и операций с Fee. Использует Result-based контракт (Never Throws).

### Создание

```typescript
import { FeeService } from '@polymarket/value-objects';
import { AssetIdHelpers } from '@polymarket/ids';

// Из AssetId + amount (строка, число, или Decimal)
const usdcResult = FeeService.create(AssetIdHelpers.USDC, '0.10');
if (usdcResult.ok) {
  console.log(usdcResult.value.quantity.amount().toNumber()); // 0.1
}

// Zero fee
const zero = FeeService.zero(AssetIdHelpers.USDC);
console.log(zero.isZero()); // true
```

### Сложение (Result-based, Never Throws)

```typescript
const addResult = FeeService.add(fee1, fee2);
if (!addResult.ok) {
  // addResult.error.context?.reason === FeeOperationErrorReason.ASSET_MISMATCH
  console.error('Cannot add fees:', addResult.error.message);
}
```

### Равенство

```typescript
const equal = FeeService.equals(fee1, fee2); // boolean
```

### Таблица методов

| Метод | Параметры | Возвращает | Контракт |
|-------|-----------|------------|----------|
| `create(asset, amount)` | `AssetId, number\|string\|Decimal` | `Result<Fee, InvalidFeeError>` | Never Throws |
| `zero(asset)` | `AssetId` | `Fee` | Never Throws |
| `add(fee1, fee2)` | `Fee, Fee` | `Result<Fee, FeeOperationError>` | Never Throws |
| `equals(fee1, fee2)` | `Fee, Fee` | `boolean` | Never Throws |
| `of(assetQty)` | `AssetQuantity` | `Fee` | @internal — делегирует в Fee.of() |

**Важно:** `FeeService.of()` помечен как `@internal`. Для публичного API используйте `create()`.

## Fee (Core)

**Immutable value object.** Не используйте Core напрямую в публичном коде.

### Геттеры

```typescript
const fee = FeeService.zero(AssetIdHelpers.USDC); // Fee напрямую, не Result

// AssetQuantity
const quantity = fee.quantity; // AssetQuantity

// AssetId
const asset = fee.asset; // AssetId (currency или outcome token)

// Amount
const amount = fee.quantity.amount(); // Quantity (Decimal)

// Debug
console.log(fee.toString()); // "Fee(CURRENCY:USDC, 0)"
```

### Операции Core (бросают FeeOperationError)

```typescript
// add — только для fees с одинаковым asset
const total = fee1.add(fee2);   // бросает при asset mismatch!
const isZero = fee.isZero();    // boolean
const eq = fee.equals(other);   // boolean
```

⚠️ Для публичного кода используйте `FeeService.add()` — он возвращает Result.

## FeeFormatter

**Форматирование для UI и логов.** Все методы возвращают `string` напрямую (не Result).

```typescript
import { FeeFormatter } from '@polymarket/value-objects';
```

### CURRENCY fee

```typescript
const fee = FeeService.zero(AssetIdHelpers.USDC);

FeeFormatter.toDisplay(fee);      // "0 USDC"        (amount + symbol)
FeeFormatter.toAmount(fee);       // "0"             (только amount)
FeeFormatter.toAssetSymbol(fee);  // "USDC"          (только symbol)
FeeFormatter.toDebugString(fee);  // "Fee(CURRENCY:USDC, 0)"
```

### OUTCOME_TOKEN fee

Для outcome token `toAssetSymbol` возвращает `{outcomeKey}:{shortConditionId}`:

```typescript
const tokenAsset = {
  type: 'OUTCOME_TOKEN' as const,
  conditionRef: {
    kind: 'ONCHAIN' as const,
    protocolId: 'POLYMARKET',
    chainId: 137,
    conditionId: '0x' + 'a'.repeat(64), // '0xaaaa...aaaa'
  },
  outcomeKey: 'YES',
};

const result = FeeService.create(tokenAsset, '0.1');
if (result.ok) {
  FeeFormatter.toAssetSymbol(result.value); // "YES:0xaaaa...aaaa"
  FeeFormatter.toDisplay(result.value);      // "0.1 YES:0xaaaa...aaaa"
}
// Формат: "{outcomeKey}:{conditionId.slice(0,6)}...{conditionId.slice(-4)}"
```

### Таблица методов

| Метод | Возвращает | Пример (CURRENCY) |
|-------|-----------|-------------------|
| `toDisplay(fee)` | `string` | `"0.1 USDC"` |
| `toAmount(fee)` | `string` | `"0.1"` |
| `toAssetSymbol(fee)` | `string` | `"USDC"` / `"YES:0xaaaa...aaaa"` |
| `toDebugString(fee)` | `string` | `"Fee(CURRENCY:USDC, 0.1)"` |

## FeeSerializer

**JSON сериализация.** Формат: `{ asset: AssetId, amount: string }`.

`amount` сериализуется как **string** для сохранения точности (как в MoneySerializer, AssetQuantitySerializer).

```typescript
import { FeeSerializer } from '@polymarket/value-objects';
```

### toJSON

```typescript
const fee = /* ... */;
const json = FeeSerializer.toJSON(fee);
// { asset: { type: 'CURRENCY', currency: 'USDC' }, amount: "0.1" }
```

### fromJSON

Валидирует asset так же строго, как `FeeService.create()`.

```typescript
const result = FeeSerializer.fromJSON(json);
if (result.ok) {
  console.log(result.value.quantity.amount().toNumber()); // 0.1
}
```

### fromUnknown

Для десериализации из неизвестного источника (API, DB):

```typescript
const parsed: unknown = JSON.parse('{"asset": {...}, "amount": "0.10"}');
const safeResult = FeeSerializer.fromUnknown(parsed);
if (safeResult.ok) {
  // использовать safeResult.value
}
```

### Round-trip гарантии

```typescript
const precise = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('123456789.123456789012345'))));
const json = FeeSerializer.toJSON(precise);
const result = FeeSerializer.fromJSON(json);

if (result.ok) {
  expect(result.value.equals(precise)).toBe(true); // ✅
  expect(result.value.quantity.amount().value().toString()).toBe('123456789.123456789012345'); // ✅
}
```

### Таблица методов

| Метод | Параметр | Возвращает | Контракт |
|-------|----------|------------|----------|
| `toJSON(fee)` | `Fee` | `FeeJSON` | Never Throws |
| `fromJSON(json)` | `FeeJSON` | `Result<Fee, InvalidFeeError>` | Never Throws |
| `fromUnknown(value)` | `unknown` | `Result<Fee, InvalidFeeError>` | Never Throws |
