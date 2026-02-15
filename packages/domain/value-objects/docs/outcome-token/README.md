# OutcomeToken Value Object — Полная документация

> Иммутабельный value object для представления tokenized positions в on-chain prediction markets Polymarket

## 📋 Содержание

1. [Введение](#введение)
2. [Быстрый старт](#быстрый-старт)
3. [Архитектура](#архитектура)
4. [Слои системы](#слои-системы)
5. [API Reference](#api-reference)
6. [Примеры использования](#примеры-использования)
7. [Ограничения](#ограничения)

---

## Введение

**OutcomeToken** — это value object для работы с tokenized positions в on-chain prediction markets. Модуль построен на архитектуре **Throws+Facade** с чётким разделением на 4 слоя.

### Ключевые особенности

✅ **Type-safe** — все операции возвращают `Result<T, E>`, нет runtime `undefined`
✅ **Иммутабельный** — защита через `Object.freeze()`, невозможно нарушить инварианты
✅ **Single Source of Truth** — AssetId как единственный источник данных
✅ **Type Narrowing** — Facade принимает `ConditionRef` (union type) и проверяет что это `OnChainConditionRef`
✅ **Layered Architecture** — чёткое разделение ответственности
✅ **100% Test Coverage** — все слои покрыты тестами
✅ **Безопасная десериализация** — валидация значений (не только типов) в `fromJSON()`

### Что такое Outcome Token

**Outcome token** — это ERC-1155 токен который представляет позицию в конкретном исходе (outcome) условия (condition). Например, "UP" или "DOWN" токен для рынка "BTC > $100k on 2025-12-31".

**⚠️ ВАЖНО**: OutcomeToken только для **on-chain** markets! Off-chain venues (KALSHI, PREDICTIT) не имеют tokenized positions.

### Когда использовать OutcomeToken

- Идентификация tokenized position в on-chain market
- Получение conditionRef и outcomeKey из AssetId
- Сериализация/десериализация outcome tokens
- Сравнение двух outcome tokens на равенство

### OutcomeToken vs TokenBalance vs AssetQuantity

| Аспект | OutcomeToken | TokenBalance | AssetQuantity |
| -------- | -------------- | -------------- | --------------- |
| **Что представляет** | Идентификатор токена | Баланс конкретного токена | Универсальное количество актива |
| **Содержит количество** | ❌ Нет | ✅ Да (Decimal) | ✅ Да (Decimal) |
| **Содержит account** | ❌ Нет | ✅ Да (AccountId) | ❌ Нет |
| **Использование** | Идентификация токена | Балансы пользователей | Количества в ордерах |

---

## Быстрый старт

### Установка

```bash
npm install @polymarket/value-objects
```

### Базовое использование

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

// Создание OutcomeToken
const result = OutcomeTokenService.create(onChainRef, BinaryOutcome.UP);
if (!result.ok) {
  console.error(result.error.message);
  console.error(result.error.context?.reason);  // Типизированная причина
  return;
}

const token = result.value;
console.log(token.outcomeKey());       // "UP"
console.log(token.conditionRef());     // { kind: 'ONCHAIN', ... }
console.log(token.assetId());          // { type: 'OUTCOME_TOKEN', ... }
```

### Type Narrowing в Facade

Facade принимает `ConditionRef` (union type) и проверяет что это `OnChainConditionRef`:

```typescript
import { OutcomeTokenService } from '@polymarket/value-objects/outcome-token';
import { OutcomeTokenErrorReason } from '@polymarket/value-objects/outcome-token';
import type { ConditionRef } from '@polymarket/ids';

// Может быть on-chain или off-chain
const ref: ConditionRef = getConditionRefFromApi();

const result = OutcomeTokenService.create(ref, BinaryOutcome.UP);
if (!result.ok) {
  if (result.error.context?.reason === OutcomeTokenErrorReason.NOT_ONCHAIN_CONDITION) {
    console.error('OutcomeToken requires on-chain condition');
  }
}
```

### Сериализация/Десериализация

```typescript
import { OutcomeTokenSerializer } from '@polymarket/value-objects/outcome-token';

// Десериализация из JSON
const json = {
  conditionRef: {
    kind: 'ONCHAIN',
    protocolId: 'POLYMARKET_CTF',
    chainId: 137,
    conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  },
  outcomeKey: 'UP'
};

const result = OutcomeTokenSerializer.fromJSON(json);
if (result.ok) {
  console.log(result.value.outcomeKey());  // "UP"
}

// Сериализация в JSON
const tokenResult = OutcomeTokenService.create(onChainRef, BinaryOutcome.UP);
if (tokenResult.ok) {
  const serialized = OutcomeTokenSerializer.toJSON(tokenResult.value);
  console.log(JSON.stringify(serialized, null, 2));
}
```

### Сравнение

```typescript
const token1Result = OutcomeTokenService.create(onChainRef, BinaryOutcome.UP);
const token2Result = OutcomeTokenService.create(onChainRef, BinaryOutcome.UP);
const token3Result = OutcomeTokenService.create(onChainRef, BinaryOutcome.DOWN);

if (token1Result.ok && token2Result.ok && token3Result.ok) {
  OutcomeTokenService.equals(token1Result.value, token2Result.value);  // → true
  OutcomeTokenService.equals(token1Result.value, token3Result.value);  // → false
}
```

---

## Архитектура

OutcomeToken построен на архитектуре **Throws+Facade** с 4 слоями:

```text
┌─────────────────────────────────────────────────────────────┐
│                     ADAPTERS LAYER                          │
│  OutcomeTokenSerializer, OutcomeTokenFormatter              │
│  (Граница системы: JSON ↔ Domain)                          │
└─────────────────────────────────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────┐
│                     FACADE LAYER                            │
│  OutcomeTokenService                                        │
│  (Публичный API: never throws, Result<T, E>)               │
│  (Type Narrowing: ConditionRef → OnChainConditionRef)      │
└─────────────────────────────────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────┐
│                     CORE LAYER                              │
│  OutcomeToken (Domain Model)                                │
│  (Инварианты: AssetId type === 'OUTCOME_TOKEN')           │
│  (Single Source of Truth: AssetId)                         │
└─────────────────────────────────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────┐
│                     ERRORS LAYER                            │
│  InvalidOutcomeTokenError, OutcomeTokenErrorReason          │
│  (Типизированные ошибки)                                    │
└─────────────────────────────────────────────────────────────┘
```

### Принципы архитектуры

1. **Core доверяет типам** — никаких дублирований проверок в core
2. **Facade валидирует входные данные** — type narrowing для union types
3. **Adapters валидируют значения** — не только типы, но и форматы
4. **Errors типизированы** — `OutcomeTokenErrorReason` enum вместо строк
5. **Single Source of Truth** — AssetId как единственный источник данных

---

## Слои системы

### 1. Core Layer — [Подробнее](./core.md)

Чистый domain model с инвариантами:

- `OutcomeToken` — value object с AssetId как Single Source of Truth
- `OutcomeTokenInvariantViolation` — domain exception для нарушения инвариантов

**Ключевые решения:**

- AssetId защищён через `Object.freeze()` (deep freeze для вложенных объектов)
- `OutcomeTokenAssetId` тип для узкого типа (Extract<AssetId, { type: 'OUTCOME_TOKEN' }>)
- Единая точка проверки type в `fromAssetId()` фабрике
- Accessor'ы без проверок — доверяют типу OutcomeTokenAssetId

### 2. Facade Layer — [Подробнее](./facade.md)

Публичный API с error handling:

- `OutcomeTokenService.create()` — создание с type narrowing
- `OutcomeTokenService.equals()` — безопасное сравнение

**Контракт "Never Throw":**

- ВСЕ методы ГАРАНТИРОВАННО возвращают `Result<T, E>`
- НИКОГДА не бросают исключения

**Type Narrowing:**

- Принимает `ConditionRef` (union: OnChainConditionRef | OffChainConditionRef)
- Проверяет `kind === 'ONCHAIN'` ОДИН РАЗ в facade
- Core доверяет типу `OnChainConditionRef`

### 3. Adapters Layer — [Подробнее](./adapters.md)

Граница системы (JSON ↔ Domain):

- `OutcomeTokenSerializer` — сериализация/десериализация с валидацией значений
- `OutcomeTokenFormatter` — человекочитаемое представление

**Ключевые решения:**

- `fromJSON()` принимает `unknown` и делает полную валидацию
- Валидация ЗНАЧЕНИЙ, не только типов (protocolId format, chainId range, conditionId format)
- Использование валидаторов из `@polymarket/ids`: `asOnChainProtocolId()`, `parseChainId()`, `parseConditionId()`

### 4. Errors Layer

Типизированные ошибки:

- `InvalidOutcomeTokenError` — доменная ошибка с контекстом
- `OutcomeTokenErrorReason` — enum для дифференциации ошибок

**Возможные причины:**

- `NOT_ONCHAIN_CONDITION` — conditionRef не является OnChainConditionRef
- `INVALID_FORMAT` — невалидный формат JSON
- `INVALID_CONDITION_REF` — невалидный condition reference (format/type)
- `INVALID_OUTCOME_KEY` — невалидный outcome key
- `INVALID_ASSET_ID_TYPE` — AssetId имеет неправильный type
- `UNEXPECTED` — неожиданная ошибка (внутренний баг)

---

## API Reference

### OutcomeTokenService (Facade)

```typescript
class OutcomeTokenService {
  // Создать OutcomeToken с type narrowing
  static create(
    conditionRef: ConditionRef,
    outcomeKey: OutcomeKey,
    source?: ErrorSource
  ): Result<OutcomeToken, InvalidOutcomeTokenError>

  // Сравнить два OutcomeToken
  static equals(a: OutcomeToken, b: OutcomeToken): boolean
}
```

### OutcomeToken (Core)

```typescript
class OutcomeToken {
  // Фабрики
  static fromAssetId(assetId: AssetId): OutcomeToken  // throws
  static of(conditionRef: OnChainConditionRef, outcomeKey: OutcomeKey): OutcomeToken  // throws

  // Accessor'ы (чистые, без проверок)
  assetId(): OutcomeTokenAssetId
  conditionRef(): OnChainConditionRef
  outcomeKey(): OutcomeKey
  equals(other: OutcomeToken): boolean
}
```

### OutcomeTokenSerializer (Adapters)

```typescript
class OutcomeTokenSerializer {
  // Десериализация с полной валидацией
  static fromJSON(
    json: unknown,
    source?: ErrorSource
  ): Result<OutcomeToken, InvalidOutcomeTokenError>

  // Сериализация
  static toJSON(token: OutcomeToken): OutcomeTokenJSON
}
```

### OutcomeTokenFormatter (Adapters)

```typescript
class OutcomeTokenFormatter {
  // Человекочитаемое представление
  static format(token: OutcomeToken): string
}
```

---

## Примеры использования

### Пример 1: Создание OutcomeToken

```typescript
import { OutcomeTokenService } from '@polymarket/value-objects/outcome-token';
import { BinaryOutcome, KnownOnChainProtocols } from '@polymarket/ids';
import type { OnChainConditionRef } from '@polymarket/ids';

const onChainRef: OnChainConditionRef = {
  kind: 'ONCHAIN',
  protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
  chainId: 137,
  conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as any
};

const result = OutcomeTokenService.create(onChainRef, BinaryOutcome.UP);
if (!result.ok) {
  console.error(`Failed to create OutcomeToken: ${result.error.message}`);
  console.error(`Reason: ${result.error.context?.reason}`);
  return;
}

const token = result.value;
console.log(`Created token for outcome: ${token.outcomeKey()}`);
```

### Пример 2: Type Narrowing

```typescript
import { OutcomeTokenService, OutcomeTokenErrorReason } from '@polymarket/value-objects/outcome-token';
import type { ConditionRef } from '@polymarket/ids';

function createTokenSafely(ref: ConditionRef, outcomeKey: string) {
  const result = OutcomeTokenService.create(ref, outcomeKey as any);

  if (!result.ok) {
    const reason = result.error.context?.reason;

    if (reason === OutcomeTokenErrorReason.NOT_ONCHAIN_CONDITION) {
      console.error('OutcomeToken requires on-chain condition');
    } else if (reason === OutcomeTokenErrorReason.INVALID_OUTCOME_KEY) {
      console.error('Invalid outcome key format');
    } else {
      console.error('Unexpected error:', result.error.message);
    }

    return null;
  }

  return result.value;
}
```

### Пример 3: Десериализация с обработкой ошибок

```typescript
import { OutcomeTokenSerializer, OutcomeTokenErrorReason } from '@polymarket/value-objects/outcome-token';

function parseTokenFromApi(data: unknown) {
  const result = OutcomeTokenSerializer.fromJSON(data);

  if (!result.ok) {
    const reason = result.error.context?.reason;

    switch (reason) {
      case OutcomeTokenErrorReason.INVALID_FORMAT:
        console.error('Invalid JSON format');
        break;
      case OutcomeTokenErrorReason.INVALID_CONDITION_REF:
        console.error('Invalid conditionRef format');
        break;
      case OutcomeTokenErrorReason.NOT_ONCHAIN_CONDITION:
        console.error('Only on-chain conditions supported');
        break;
      default:
        console.error('Unexpected error:', result.error.message);
    }

    return null;
  }

  return result.value;
}
```

### Пример 4: Round-trip сериализация

```typescript
import { OutcomeTokenService, OutcomeTokenSerializer } from '@polymarket/value-objects/outcome-token';

const tokenResult = OutcomeTokenService.create(onChainRef, BinaryOutcome.UP);
if (!tokenResult.ok) return;

const token = tokenResult.value;

// Serialize
const json = OutcomeTokenSerializer.toJSON(token);
const jsonString = JSON.stringify(json);

// Deserialize
const deserializeResult = OutcomeTokenSerializer.fromJSON(JSON.parse(jsonString));
if (!deserializeResult.ok) {
  console.error('Failed to deserialize');
  return;
}

const deserializedToken = deserializeResult.value;

// Verify equality
const areEqual = OutcomeTokenService.equals(token, deserializedToken);
console.log(`Tokens equal: ${areEqual}`);  // → true
```

---

## Ограничения

### ⚠️ Только on-chain markets

OutcomeToken работает ТОЛЬКО с on-chain markets (POLYMARKET_CTF, UMAAMI_PREDICTION_CTF). Off-chain venues (KALSHI, PREDICTIT) не поддерживаются — они не имеют tokenized positions.

```typescript
// ✅ OK
const onChainRef: OnChainConditionRef = {
  kind: 'ONCHAIN',
  protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
  chainId: 137,
  conditionId: '0x...'
};

// ❌ ERROR
const offChainRef: OffChainConditionRef = {
  kind: 'OFFCHAIN',
  venueId: 'KALSHI',
  marketId: 'ABC-123'
};

const result = OutcomeTokenService.create(offChainRef, BinaryOutcome.UP);
// → Err(NOT_ONCHAIN_CONDITION)
```

### ⚠️ Не содержит количества

OutcomeToken — это только идентификатор токена. Для работы с количествами используй:

- `TokenBalance` — баланс конкретного токена (с account)
- `AssetQuantity` — универсальное количество актива

```typescript
// ✅ OutcomeToken — только идентификатор
const tokenResult = OutcomeTokenService.create(onChainRef, BinaryOutcome.UP);
if (tokenResult.ok) {
  console.log(tokenResult.value.outcomeKey());  // "UP"
  // НЕТ количества!
}

// ✅ TokenBalance — идентификатор + количество + account
const qtyResult = QuantityService.create(100);
const balanceResult = TokenBalanceService.create(
  tokenResult.value,  // OutcomeToken
  qtyResult.value,    // Quantity
  accountId,          // AccountId
  venueId             // VenueId
);

// ✅ AssetQuantity — универсальное количество
const quantityResult = AssetQuantityService.createOutcomeToken(
  onChainRef,
  BinaryOutcome.UP,
  100
);
```

### ⚠️ Иммутабельность

OutcomeToken защищён через `Object.freeze()`. Попытка мутации бросит исключение в strict mode:

```typescript
const tokenResult = OutcomeTokenService.create(onChainRef, BinaryOutcome.UP);
if (!tokenResult.ok) return;

const token = tokenResult.value;

// ❌ TypeError: Cannot add property ..., object is not extensible
(token as any).newField = 'value';

// ❌ TypeError: Cannot assign to read only property
const assetId = token.assetId();
(assetId as any).type = 'CURRENCY';

// ❌ TypeError: Cannot assign to read only property
const ref = token.conditionRef();
(ref as any).chainId = 1;
```

---

## См. также

- [Архитектура](./architecture.md) — детали архитектурных решений
- [Core Layer](./core.md) — domain model и инварианты
- [Facade Layer](./facade.md) — публичный API и type narrowing
- [Adapters Layer](./adapters.md) — сериализация и валидация
- [Примеры](./examples.md) — полные примеры использования

---

## Миграция

OutcomeToken — новый модуль, миграция не требуется.

Если вы используете старый код с прямым созданием AssetId:

```typescript
// ❌ Старый способ (direct AssetId creation)
import { AssetIdHelpers } from '@polymarket/ids';

const assetId = AssetIdHelpers.fromOutcomeToken(onChainRef, BinaryOutcome.UP);

// ✅ Новый способ (через OutcomeToken)
import { OutcomeTokenService } from '@polymarket/value-objects/outcome-token';

const result = OutcomeTokenService.create(onChainRef, BinaryOutcome.UP);
if (result.ok) {
  const assetId = result.value.assetId();
}
```
