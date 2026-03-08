# Fee Value Object

Fee представляет комиссию в любом активе: Currency (USDC) или OutcomeToken.

## Обзор

Fee является wrapper над `AssetQuantity` с дополнительными инвариантами и семантикой комиссии. Используется для представления trading fees, settlement fees, gas fees и withdrawal fees.

**Ключевые характеристики:**

- Immutable value object
- Всегда non-negative (>= 0)
- Точная арифметика через Decimal.js
- Типизированные assets (Currency или OutcomeToken)

## Инварианты

1. **Non-negative**: `amount >= 0` (гарантируется через Quantity инвариант)
2. **Finite**: `amount` не может быть NaN или Infinity
3. **Immutable**: все операции возвращают новые экземпляры
4. **Asset frozen**: asset иммутабелен после создания
5. **Valid asset**: структура AssetId прошла полную валидацию (включая `conditionRef` и `outcomeKey` для OUTCOME_TOKEN)

## Быстрый старт

```typescript
import { FeeService, FeeFormatter } from '@polymarket/value-objects';
import { AssetIdHelpers } from '@polymarket/ids';

// CURRENCY fee
const usdcResult = FeeService.create(AssetIdHelpers.USDC, '0.10');
if (usdcResult.ok) {
  console.log(FeeFormatter.toDisplay(usdcResult.value)); // "0.1 USDC"
}

// Zero fee
const zeroFee = FeeService.zero(AssetIdHelpers.USDC);
console.log(zeroFee.isZero()); // true

// Сложение (Result-based, Never Throws)
const fee1Result = FeeService.create(AssetIdHelpers.USDC, '0.10');
const fee2Result = FeeService.create(AssetIdHelpers.USDC, '0.05');
if (fee1Result.ok && fee2Result.ok) {
  const addResult = FeeService.add(fee1Result.value, fee2Result.value);
  if (addResult.ok) {
    console.log(FeeFormatter.toDisplay(addResult.value)); // "0.15 USDC"
  }
}

// OUTCOME_TOKEN fee
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
const tokenResult = FeeService.create(tokenAsset, '5');
if (tokenResult.ok) {
  console.log(FeeFormatter.toDisplay(tokenResult.value)); // "5 YES:0xaaaa...aaaa"
}
```

## Связанные разделы

- [architecture.md](./architecture.md) — 3-слойная архитектура, error reasons, правила валидации AssetId, сравнение с AssetQuantity
- [facade.md](./facade.md) — полный справочник API: FeeService, FeeFormatter, FeeSerializer
- [examples.md](./examples.md) — практические сценарии: trading fees, settlement fees, gas accumulation, error handling, сериализация

## См. также

- [AssetQuantity](../asset-quantity/README.md) — базовый VO для количеств активов
- [Money](../money/README.md) — для денежных сумм с валютой
- [Quantity](../quantity/README.md) — для неотрицательных количеств
