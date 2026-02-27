# Fee: Примеры использования

Практические сценарии применения Fee Value Object.

## Содержание

- [Trading Fees](#trading-fees)
- [Settlement Fees](#settlement-fees)
- [Gas Fee Accumulation](#gas-fee-accumulation)
- [Обработка ошибок](#обработка-ошибок)
- [Сериализация](#сериализация)

## Trading Fees

### Maker + Taker fees

```typescript
import { Fee, FeeService, FeeFormatter } from '@polymarket/value-objects';
import { AssetIdHelpers } from '@polymarket/ids';
import Decimal from 'decimal.js';
import { AssetQuantity, Quantity } from '@polymarket/value-objects';

// Maker fee
const makerFee = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.01'))));

// Taker fee
const takerFee = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.02'))));

// Total fee (через Core — использовать только если оба объекта уже проверены)
const totalFee = makerFee.add(takerFee);
console.log(FeeFormatter.toDisplay(totalFee)); // "0.03 USDC"
```

### Через Facade (рекомендуется)

```typescript
import { FeeService, FeeFormatter } from '@polymarket/value-objects';
import { AssetIdHelpers } from '@polymarket/ids';

const makerResult = FeeService.create(AssetIdHelpers.USDC, '0.01');
const takerResult = FeeService.create(AssetIdHelpers.USDC, '0.02');

if (makerResult.ok && takerResult.ok) {
  const totalResult = FeeService.add(makerResult.value, takerResult.value);
  if (totalResult.ok) {
    console.log(FeeFormatter.toDisplay(totalResult.value)); // "0.03 USDC"
  }
}
```

## Settlement Fees

### Settlement fee в outcome token

```typescript
import { FeeService, FeeFormatter } from '@polymarket/value-objects';

const tokenAsset = {
  type: 'OUTCOME_TOKEN' as const,
  conditionRef: {
    kind: 'ONCHAIN' as const,
    protocolId: 'POLYMARKET',
    chainId: 137,
    conditionId: '0x' + 'a'.repeat(64),
  },
  outcomeKey: 'YES',
};

const settlementResult = FeeService.create(tokenAsset, '5');
if (settlementResult.ok) {
  console.log(FeeFormatter.toDisplay(settlementResult.value)); // "5 YES:0xaaaa...aaaa"
  console.log(FeeFormatter.toAssetSymbol(settlementResult.value)); // "YES:0xaaaa...aaaa"
}
// Формат символа: "{outcomeKey}:{conditionId.slice(0,6)}...{conditionId.slice(-4)}"
```

## Gas Fee Accumulation

```typescript
import { Fee, FeeService, FeeFormatter } from '@polymarket/value-objects';
import { AssetIdHelpers } from '@polymarket/ids';
import Decimal from 'decimal.js';
import { AssetQuantity, Quantity } from '@polymarket/value-objects';

// Накопление gas fees через несколько транзакций
let totalGas = FeeService.zero(AssetIdHelpers.USDC);

for (const tx of transactions) {
  const txGas = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal(tx.gasUsed))));
  totalGas = totalGas.add(txGas);
}

console.log(FeeFormatter.toDisplay(totalGas)); // "12.5 USDC"
```

### Через FeeService.add (безопаснее в публичном коде)

```typescript
// FeeService.create → Result<Fee, InvalidFeeError>
// FeeService.add    → Result<Fee, FeeOperationError>
// Храним накопленное Fee отдельно, чтобы не смешивать типы ошибок.
let accumulated: Fee = FeeService.zero(AssetIdHelpers.USDC);

for (const tx of transactions) {
  const txGasResult = FeeService.create(AssetIdHelpers.USDC, tx.gasUsed);
  if (!txGasResult.ok) continue;

  const addResult = FeeService.add(accumulated, txGasResult.value);
  if (addResult.ok) {
    accumulated = addResult.value;
  }
}

console.log(FeeFormatter.toDisplay(accumulated));
```

## Обработка ошибок

### ASSET_MISMATCH при сложении

```typescript
import { FeeService } from '@polymarket/value-objects';
import { FeeOperationErrorReason } from '@polymarket/value-objects';
import { AssetIdHelpers } from '@polymarket/ids';

const usdcFee = FeeService.zero(AssetIdHelpers.USDC);

const tokenAsset = {
  type: 'OUTCOME_TOKEN' as const,
  conditionRef: {
    kind: 'ONCHAIN' as const,
    protocolId: 'POLYMARKET',
    chainId: 137,
    conditionId: '0x' + 'b'.repeat(64),
  },
  outcomeKey: 'NO',
};
const tokenFeeResult = FeeService.create(tokenAsset, '1');

if (tokenFeeResult.ok) {
  // ❌ Нельзя складывать fees с разными assets
  const addResult = FeeService.add(usdcFee, tokenFeeResult.value);
  if (!addResult.ok) {
    console.error(addResult.error.context?.reason); // "ASSET_MISMATCH"
    console.error(addResult.error.context?.asset1); // { type: 'CURRENCY', currency: 'USDC' }
    console.error(addResult.error.context?.asset2); // { type: 'OUTCOME_TOKEN', ... }
  }
}
```

### INVALID_ASSET при создании

```typescript
const invalidResult = FeeService.create(
  { type: 'OUTCOME_TOKEN', conditionRef: { kind: 'OFFCHAIN' } } as any,
  '1'
);

if (!invalidResult.ok) {
  console.error(invalidResult.error.context?.reason); // "INVALID_ASSET"
}
```

### NEGATIVE_FEE

```typescript
const negativeResult = FeeService.create(AssetIdHelpers.USDC, '-1');
if (!negativeResult.ok) {
  console.error(negativeResult.error.context?.reason); // "NEGATIVE_FEE"
}
```

## Сериализация

### Сохранение и восстановление Fee

```typescript
import { FeeService, FeeSerializer, FeeFormatter } from '@polymarket/value-objects';
import { AssetIdHelpers } from '@polymarket/ids';

// Создание
const feeResult = FeeService.create(AssetIdHelpers.USDC, '123.456789');
if (!feeResult.ok) throw new Error('Failed to create fee');

// Сериализация → JSON
const json = FeeSerializer.toJSON(feeResult.value);
// { asset: { type: 'CURRENCY', currency: 'USDC' }, amount: "123.456789" }

// Десериализация из JSON
const restored = FeeSerializer.fromJSON(json);
if (restored.ok) {
  console.log(restored.value.equals(feeResult.value)); // true
  console.log(FeeFormatter.toDisplay(restored.value)); // "123.456789 USDC"
}
```

### Десериализация из API response (fromUnknown)

```typescript
import { FeeSerializer } from '@polymarket/value-objects';

const rawApiResponse: unknown = await fetchFeeFromAPI();
const result = FeeSerializer.fromUnknown(rawApiResponse);

if (!result.ok) {
  console.error('Invalid fee data from API:', result.error.message);
  // Обработать ошибку — не бросает исключение
}
```
