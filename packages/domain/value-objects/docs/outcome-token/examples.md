# OutcomeToken — Примеры использования

> Полные примеры использования OutcomeToken value object

## 📋 Содержание

1. [Базовое использование](#базовое-использование)
2. [Type Narrowing](#type-narrowing)
3. [Сериализация](#сериализация)
4. [Обработка ошибок](#обработка-ошибок)
5. [Интеграция с другими value objects](#интеграция-с-другими-value-objects)

---

## Базовое использование

### Пример 1: Создание OutcomeToken

```typescript
import { OutcomeTokenService } from '@polymarket/value-objects/outcome-token';
import { BinaryOutcome, KnownOnChainProtocols, type OnChainConditionRef } from '@polymarket/ids';

// On-chain condition reference
const onChainRef: OnChainConditionRef = {
  kind: 'ONCHAIN',
  protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
  chainId: 137,  // Polygon
  conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as any
};

// Создание UP token
const upResult = OutcomeTokenService.create(onChainRef, BinaryOutcome.UP);
if (!upResult.ok) {
  console.error(`Failed to create UP token: ${upResult.error.message}`);
  return;
}

const upToken = upResult.value;
console.log(`UP token outcomeKey: ${upToken.outcomeKey()}`);
console.log(`UP token chainId: ${upToken.conditionRef().chainId}`);

// Создание DOWN token
const downResult = OutcomeTokenService.create(onChainRef, BinaryOutcome.DOWN);
if (!downResult.ok) {
  console.error(`Failed to create DOWN token: ${downResult.error.message}`);
  return;
}

const downToken = downResult.value;
console.log(`DOWN token outcomeKey: ${downToken.outcomeKey()}`);

// Сравнение
const same = OutcomeTokenService.equals(upToken, upToken);
console.log(`upToken equals upToken: ${same}`);  // → true

const different = OutcomeTokenService.equals(upToken, downToken);
console.log(`upToken equals downToken: ${different}`);  // → false
```

### Пример 2: Работа с AssetId

```typescript
import { OutcomeTokenService } from '@polymarket/value-objects/outcome-token';
import { BinaryOutcome } from '@polymarket/ids';

const result = OutcomeTokenService.create(onChainRef, BinaryOutcome.UP);
if (!result.ok) return;

const token = result.value;

// Получить AssetId
const assetId = token.assetId();
console.log(`AssetId type: ${assetId.type}`);  // "OUTCOME_TOKEN"

// AssetId содержит всю информацию
console.log(`ConditionRef from AssetId:`, assetId.conditionRef);
console.log(`OutcomeKey from AssetId: ${assetId.outcomeKey}`);

// Извлечь через accessor'ы
const conditionRef = token.conditionRef();
const outcomeKey = token.outcomeKey();

console.log(`Protocol: ${conditionRef.protocolId}`);
console.log(`Chain: ${conditionRef.chainId}`);
console.log(`Condition: ${conditionRef.conditionId}`);
console.log(`Outcome: ${outcomeKey}`);
```

---

## Type Narrowing

### Пример 3: Обработка union type

```typescript
import { OutcomeTokenService, OutcomeTokenErrorReason } from '@polymarket/value-objects/outcome-token';
import type { ConditionRef } from '@polymarket/ids';

function createTokenSafely(ref: ConditionRef, outcomeKey: string) {
  // ref может быть on-chain или off-chain
  const result = OutcomeTokenService.create(ref, outcomeKey as any);

  if (!result.ok) {
    const reason = result.error.context?.reason;

    // Type-safe проверка причины
    if (reason === OutcomeTokenErrorReason.NOT_ONCHAIN_CONDITION) {
      console.error('OutcomeToken requires on-chain condition');
      console.error(`Got: ${ref.kind}`);
    } else if (reason === OutcomeTokenErrorReason.INVALID_OUTCOME_KEY) {
      console.error('Invalid outcome key format');
      console.error(`Got: ${outcomeKey}`);
    } else {
      console.error('Unexpected error:', result.error.message);
    }

    return null;
  }

  return result.value;
}

// ✅ On-chain condition — создаётся успешно
const onChainRef: OnChainConditionRef = {
  kind: 'ONCHAIN',
  protocolId: 'POLYMARKET_CTF' as any,
  chainId: 137 as any,
  conditionId: '0xaaaa...' as any
};
const token1 = createTokenSafely(onChainRef, 'UP');

// ❌ Off-chain condition — возвращает NOT_ONCHAIN_CONDITION
const offChainRef: OffChainConditionRef = {
  kind: 'OFFCHAIN',
  venueId: 'KALSHI' as any,
  marketId: 'ABC-123'
};
const token2 = createTokenSafely(offChainRef, 'UP');  // → null
```

### Пример 4: Валидация перед созданием

```typescript
import { OutcomeTokenService } from '@polymarket/value-objects/outcome-token';
import type { ConditionRef } from '@polymarket/ids';

function createOutcomeTokenIfValid(
  ref: ConditionRef,
  outcomeKey: string
): OutcomeToken | null {
  // Pre-validation: проверка что это on-chain
  if (ref.kind !== 'ONCHAIN') {
    console.error('Only on-chain conditions supported');
    return null;
  }

  // После проверки TypeScript знает: ref это OnChainConditionRef
  const result = OutcomeTokenService.create(ref, outcomeKey as any);

  if (!result.ok) {
    console.error(`Failed to create token: ${result.error.message}`);
    return null;
  }

  return result.value;
}
```

---

## Сериализация

### Пример 5: Round-trip сериализация

```typescript
import {
  OutcomeTokenService,
  OutcomeTokenSerializer
} from '@polymarket/value-objects/outcome-token';
import { BinaryOutcome } from '@polymarket/ids';

// Создание токена
const tokenResult = OutcomeTokenService.create(onChainRef, BinaryOutcome.UP);
if (!tokenResult.ok) {
  console.error('Failed to create token');
  return;
}

const originalToken = tokenResult.value;

// Сериализация
const json = OutcomeTokenSerializer.toJSON(originalToken);
console.log('Serialized:', JSON.stringify(json, null, 2));

// Десериализация
const deserializeResult = OutcomeTokenSerializer.fromJSON(json);
if (!deserializeResult.ok) {
  console.error('Failed to deserialize');
  return;
}

const deserializedToken = deserializeResult.value;

// Проверка равенства
const areEqual = OutcomeTokenService.equals(originalToken, deserializedToken);
console.log(`Tokens equal: ${areEqual}`);  // → true

// Сравнение полей
console.log(`Original outcomeKey: ${originalToken.outcomeKey()}`);
console.log(`Deserialized outcomeKey: ${deserializedToken.outcomeKey()}`);
console.log(`Original chainId: ${originalToken.conditionRef().chainId}`);
console.log(`Deserialized chainId: ${deserializedToken.conditionRef().chainId}`);
```

### Пример 6: Парсинг API ответа

```typescript
import {
  OutcomeTokenSerializer,
  OutcomeTokenErrorReason
} from '@polymarket/value-objects/outcome-token';

async function fetchOutcomeTokenFromApi(url: string) {
  const response = await fetch(url);
  const data: unknown = await response.json();

  // Парсинг с валидацией
  const result = OutcomeTokenSerializer.fromJSON(data);

  if (!result.ok) {
    const reason = result.error.context?.reason;

    switch (reason) {
      case OutcomeTokenErrorReason.INVALID_FORMAT:
        console.error('Invalid JSON format from API');
        console.error('Details:', result.error.context?.details);
        break;

      case OutcomeTokenErrorReason.INVALID_CONDITION_REF:
        console.error('Invalid conditionRef format from API');
        break;

      case OutcomeTokenErrorReason.NOT_ONCHAIN_CONDITION:
        console.error('API returned off-chain condition (not supported)');
        break;

      default:
        console.error('Unexpected error:', result.error.message);
    }

    return null;
  }

  return result.value;
}

// Использование
const token = await fetchOutcomeTokenFromApi('https://api.example.com/token/123');
if (token) {
  console.log(`Loaded token: ${token.outcomeKey()}`);
}
```

---

## Обработка ошибок

### Пример 7: Детальная обработка ошибок

```typescript
import {
  OutcomeTokenService,
  OutcomeTokenErrorReason
} from '@polymarket/value-objects/outcome-token';
import { ErrorSource } from '@polymarket/errors';

function createTokenWithErrorHandling(
  conditionRef: ConditionRef,
  outcomeKey: string,
  source: ErrorSource = ErrorSource.USER_INPUT
) {
  const result = OutcomeTokenService.create(conditionRef, outcomeKey as any, source);

  if (!result.ok) {
    const error = result.error;
    const reason = error.context?.reason;
    const details = error.context?.details;

    console.error('=== OutcomeToken Creation Failed ===');
    console.error(`Message: ${error.message}`);
    console.error(`Reason: ${reason}`);
    console.error(`Source: ${error.context?.source}`);
    console.error(`Details:`, details);

    // Специфичная обработка по причине
    switch (reason) {
      case OutcomeTokenErrorReason.NOT_ONCHAIN_CONDITION:
        console.error('→ OutcomeToken requires on-chain condition');
        console.error('→ Use TokenBalance or other value objects for off-chain');
        break;

      case OutcomeTokenErrorReason.INVALID_OUTCOME_KEY:
        console.error('→ Invalid outcome key format');
        console.error('→ Expected: UP, DOWN, or other valid OutcomeKey');
        break;

      case OutcomeTokenErrorReason.INVALID_ASSET_ID_TYPE:
        console.error('→ AssetId type mismatch (internal bug)');
        break;

      case OutcomeTokenErrorReason.UNEXPECTED:
        console.error('→ Unexpected error occurred');
        console.error('→ This may be an internal bug, please report');
        if (details && 'errorStack' in details) {
          console.error('Stack trace:', details.errorStack);
        }
        break;

      default:
        console.error('→ Unknown error reason');
    }

    return null;
  }

  return result.value;
}
```

### Пример 8: Fallback стратегия

```typescript
import { OutcomeTokenService, OutcomeTokenErrorReason } from '@polymarket/value-objects/outcome-token';
import { BinaryOutcome } from '@polymarket/ids';

function createTokenOrDefault(
  conditionRef: ConditionRef,
  outcomeKey: string
): OutcomeToken | null {
  const result = OutcomeTokenService.create(conditionRef, outcomeKey as any);

  if (!result.ok) {
    const reason = result.error.context?.reason;

    // Для NOT_ONCHAIN_CONDITION не можем создать fallback
    if (reason === OutcomeTokenErrorReason.NOT_ONCHAIN_CONDITION) {
      console.error('Cannot create OutcomeToken for off-chain condition');
      return null;
    }

    // Для INVALID_OUTCOME_KEY можем попробовать default
    if (reason === OutcomeTokenErrorReason.INVALID_OUTCOME_KEY) {
      console.warn(`Invalid outcomeKey '${outcomeKey}', trying default 'UP'`);

      // Предполагаем что ref это OnChainConditionRef (иначе ошибка была бы NOT_ONCHAIN_CONDITION)
      if (conditionRef.kind === 'ONCHAIN') {
        const fallbackResult = OutcomeTokenService.create(conditionRef, BinaryOutcome.UP);
        if (fallbackResult.ok) {
          console.warn('→ Using fallback UP token');
          return fallbackResult.value;
        }
      }
    }

    // Других fallback стратегий нет
    return null;
  }

  return result.value;
}
```

---

## Интеграция с другими value objects

### Пример 9: OutcomeToken + TokenBalance

```typescript
import { OutcomeTokenService } from '@polymarket/value-objects/outcome-token';
import { TokenBalanceService } from '@polymarket/value-objects/token-balance';
import { QuantityService } from '@polymarket/value-objects/quantity';
import { BinaryOutcome, KnownVenues, accountIdFromWallet, parseWalletAddress } from '@polymarket/ids';

// Создание OutcomeToken
const tokenResult = OutcomeTokenService.create(onChainRef, BinaryOutcome.UP);
if (!tokenResult.ok) {
  console.error('Failed to create token');
  return;
}

const token = tokenResult.value;

// Создание Quantity
const qtyResult = QuantityService.create(100);
if (!qtyResult.ok) {
  console.error('Failed to create quantity');
  return;
}

// Создание AccountId
const walletAddress = parseWalletAddress('0x1234567890123456789012345678901234567890')!;
const accountId = accountIdFromWallet(walletAddress);

// Создание TokenBalance для этого токена
const balanceResult = TokenBalanceService.create(
  token,              // OutcomeToken
  qtyResult.value,    // available Quantity
  Quantity.ZERO,      // reserved Quantity (0 для нового баланса)
  accountId,          // AccountId
  KnownVenues.POLYMARKET  // VenueId
);

if (!balanceResult.ok) {
  console.error('Failed to create balance');
  return;
}

const balance = balanceResult.value;

console.log(`Account balance:`);
console.log(`- Token: ${balance.token().outcomeKey()}`);
console.log(`- Available: ${balance.available().toString()}`);
console.log(`- Reserved: ${balance.reserved().toString()}`);
console.log(`- Total: ${balance.total().toString()}`);
console.log(`- Venue: ${balance.venueId()}`);
```

### Пример 10: OutcomeToken + AssetQuantity

```typescript
import { AssetQuantityService } from '@polymarket/value-objects/asset-quantity';
import { BinaryOutcome } from '@polymarket/ids';

// Создание AssetQuantity для outcome token напрямую
const quantityResult = AssetQuantityService.createOutcomeToken(
  onChainRef,
  BinaryOutcome.UP,
  50  // amount
);

if (!quantityResult.ok) {
  console.error('Failed to create asset quantity');
  return;
}

const quantity = quantityResult.value;

console.log(`Asset quantity:`);
console.log(`- Asset type: ${quantity.asset().type}`);
console.log(`- Amount: ${quantity.amount().toNumber()}`);
console.log(`- Is outcome token: ${quantity.isOutcomeToken()}`);
```

### Пример 11: Полная торговая операция

```typescript
import { OutcomeTokenService } from '@polymarket/value-objects/outcome-token';
import { TokenBalanceService } from '@polymarket/value-objects/token-balance';
import { QuantityService } from '@polymarket/value-objects/quantity';
import { AssetQuantityService } from '@polymarket/value-objects/asset-quantity';
import { BinaryOutcome, KnownVenues, accountIdFromWallet, parseWalletAddress } from '@polymarket/ids';

// Создание UP и DOWN токенов
const upTokenResult = OutcomeTokenService.create(onChainRef, BinaryOutcome.UP);
const downTokenResult = OutcomeTokenService.create(onChainRef, BinaryOutcome.DOWN);

if (!upTokenResult.ok || !downTokenResult.ok) {
  console.error('Failed to create tokens');
  return;
}

const upToken = upTokenResult.value;
const downToken = downTokenResult.value;

// Создание AccountId
const walletAddress = parseWalletAddress('0x1234567890123456789012345678901234567890')!;
const accountId = accountIdFromWallet(walletAddress);
const venueId = KnownVenues.POLYMARKET;

// Создание количеств
const qty100Result = QuantityService.create(100);
const qty50Result = QuantityService.create(50);

if (!qty100Result.ok || !qty50Result.ok) {
  console.error('Failed to create quantities');
  return;
}

// Балансы пользователя
const upBalanceResult = TokenBalanceService.create(
  upToken,
  qty100Result.value,  // available
  Quantity.ZERO,  // reserved
  accountId,
  venueId
);

const downBalanceResult = TokenBalanceService.create(
  downToken,
  qty50Result.value,  // available
  Quantity.ZERO,  // reserved
  accountId,
  venueId
);

if (!upBalanceResult.ok || !downBalanceResult.ok) {
  console.error('Failed to create balances');
  return;
}

const upBalance = upBalanceResult.value;
const downBalance = downBalanceResult.value;

// Вывод балансов
console.log('=== User Balances ===');
console.log(`UP tokens (available): ${upBalance.available().toString()}`);
console.log(`UP tokens (total): ${upBalance.total().toString()}`);
console.log(`DOWN tokens (available): ${downBalance.available().toString()}`);
console.log(`DOWN tokens (total): ${downBalance.total().toString()}`);

// Торговое количество - используем createOutcomeToken напрямую
const tradeQuantityResult = AssetQuantityService.createOutcomeToken(
  onChainRef,
  BinaryOutcome.UP,
  10  // amount
);

if (tradeQuantityResult.ok) {
  console.log(`\nTrade quantity: ${tradeQuantityResult.value.amount().toNumber()} UP tokens`);
}
```

---

## См. также

- [README](./README.md) — обзор и быстрый старт
- [Architecture](./architecture.md) — архитектурные решения
- [Core Layer](./core.md) — domain model
- [Facade Layer](./facade.md) — публичный API
- [Adapters Layer](./adapters.md) — сериализация
