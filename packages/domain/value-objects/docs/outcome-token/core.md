# OutcomeToken Core Layer — Domain Model

> Чистая domain логика с гарантией инвариантов

## 📋 Содержание

1. [Обзор](#обзор)
2. [OutcomeToken класс](#outcometoken-класс)
3. [Фабрики](#фабрики)
4. [Accessor методы](#accessor-методы)
5. [Инварианты](#инварианты)
6. [Иммутабельность](#иммутабельность)
7. [Тестирование](#тестирование)

---

## Обзор

Core Layer содержит чистую domain логику для OutcomeToken:

- **OutcomeToken** — value object с AssetId как Single Source of Truth
- **OutcomeTokenInvariantViolation** — domain exception для нарушения инвариантов

**Ключевые принципы**:
- Доверяет TypeScript типам (нет дублирования проверок)
- AssetId как единственный источник данных
- Может бросать domain exceptions (facade их ловит)
- Accessor'ы без проверок (инварианты гарантированы constructor'ом)

---

## OutcomeToken класс

### Структура

```typescript
type OutcomeTokenAssetId = Extract<AssetId, { type: 'OUTCOME_TOKEN' }>;

export class OutcomeToken {
  // Private constructor — доверяет типу OutcomeTokenAssetId
  private constructor(private readonly _assetId: OutcomeTokenAssetId) {}

  // Фабрики (public static methods)
  public static fromAssetId(assetId: AssetId): OutcomeToken { /* ... */ }
  public static of(conditionRef: OnChainConditionRef, outcomeKey: OutcomeKey): OutcomeToken { /* ... */ }

  // Accessor'ы (чистые, без проверок)
  public assetId(): OutcomeTokenAssetId { /* ... */ }
  public conditionRef(): OnChainConditionRef { /* ... */ }
  public outcomeKey(): OutcomeKey { /* ... */ }

  // Операции
  public equals(other: OutcomeToken): boolean { /* ... */ }
}
```

### Private Constructor

Constructor принимает **узкий тип** `OutcomeTokenAssetId`:

```typescript
type OutcomeTokenAssetId = Extract<AssetId, { type: 'OUTCOME_TOKEN' }>;

private constructor(private readonly _assetId: OutcomeTokenAssetId) {
  // Никаких проверок — доверяем типу OutcomeTokenAssetId
}
```

**Почему private?**
- Гарантирует что создание идёт через фабрики (fromAssetId, of)
- Фабрики валидируют инварианты ПЕРЕД вызовом constructor
- Constructor доверяет типу и не дублирует проверки

**Почему OutcomeTokenAssetId (узкий тип)?**
- `Extract<>` извлекает только AssetId с type === 'OUTCOME_TOKEN'
- TypeScript **гарантирует** что _assetId.type === 'OUTCOME_TOKEN'
- Accessor'ы могут обращаться к conditionRef/outcomeKey без проверок

---

## Фабрики

### fromAssetId() — создание из AssetId

**Единственная точка проверки type:**

```typescript
public static fromAssetId(assetId: AssetId): OutcomeToken {
  // Type narrowing: проверяем что assetId типа OUTCOME_TOKEN
  if (assetId.type !== 'OUTCOME_TOKEN') {
    throw new OutcomeTokenInvariantViolation(
      'OutcomeToken requires AssetId of type OUTCOME_TOKEN',
      { assetId }
    );
  }

  // Defensive copy + freeze: пересоздаём AssetId через AssetIdHelpers
  // Это гарантирует иммутабельность даже если входной assetId был mutable
  const frozenAssetId = AssetIdHelpers.fromOutcomeToken(
    assetId.conditionRef,
    assetId.outcomeKey
  );

  return new OutcomeToken(frozenAssetId as OutcomeTokenAssetId);
}
```

**Использование:**

```typescript
import { AssetIdHelpers } from '@polymarket/ids';
import { OutcomeToken } from '@polymarket/value-objects/outcome-token';

const assetId = AssetIdHelpers.fromOutcomeToken(onChainRef, BinaryOutcome.UP);
const token = OutcomeToken.fromAssetId(assetId);  // ✅

const currencyAssetId = AssetIdHelpers.fromCurrency('USDC');
const token2 = OutcomeToken.fromAssetId(currencyAssetId);  // ❌ Throws
```

**Defensive Copy:**
- fromAssetId() делает defensive copy через AssetIdHelpers.fromOutcomeToken()
- Это защищает от мутации входного assetId (например, из parseAssetId)
- Даже если входной assetId mutable, OutcomeToken получит frozen copy

**Когда использовать:**
- В infrastructure/adapters слое (например, десериализация)
- Когда уже есть готовый AssetId

### of() — создание из domain объектов

**Автоматически создаёт AssetId:**

```typescript
public static of(
  conditionRef: OnChainConditionRef,
  outcomeKey: OutcomeKey
): OutcomeToken {
  // Создаём AssetId из conditionRef + outcomeKey
  const assetId = AssetIdHelpers.fromOutcomeToken(conditionRef, outcomeKey);

  // Делегируем валидацию в fromAssetId()
  return OutcomeToken.fromAssetId(assetId);
}
```

**Использование:**

```typescript
import { OutcomeToken } from '@polymarket/value-objects/outcome-token';
import { BinaryOutcome, type OnChainConditionRef } from '@polymarket/ids';

const onChainRef: OnChainConditionRef = {
  kind: 'ONCHAIN',
  protocolId: 'POLYMARKET_CTF' as any,
  chainId: 137 as any,
  conditionId: '0x...' as any
};

const token = OutcomeToken.of(onChainRef, BinaryOutcome.UP);  // ✅
```

**Когда использовать:**
- В domain/application слое
- Когда есть conditionRef и outcomeKey

**Может бросить:**
- `Error` из AssetIdHelpers.fromOutcomeToken() если outcomeKey невалидный
- `OutcomeTokenInvariantViolation` из fromAssetId() если AssetId создан некорректно

---

## Accessor методы

### assetId() — полный идентификатор

```typescript
public assetId(): OutcomeTokenAssetId {
  return this._assetId;
}
```

**Возвращает:**
- OutcomeTokenAssetId (узкий тип, type === 'OUTCOME_TOKEN' гарантировано)

**Пример:**

```typescript
const token = OutcomeToken.of(onChainRef, BinaryOutcome.UP);
const assetId = token.assetId();

console.log(assetId.type);          // "OUTCOME_TOKEN"
console.log(assetId.conditionRef);  // { kind: 'ONCHAIN', ... }
console.log(assetId.outcomeKey);    // "UP"
```

### conditionRef() — on-chain condition reference

```typescript
public conditionRef(): OnChainConditionRef {
  // Никаких проверок — доверяем типу OutcomeTokenAssetId
  return this._assetId.conditionRef;
}
```

**Возвращает:**
- OnChainConditionRef (протокол, chain, condition ID)

**Пример:**

```typescript
const token = OutcomeToken.of(onChainRef, BinaryOutcome.UP);
const ref = token.conditionRef();

console.log(ref.kind);         // "ONCHAIN"
console.log(ref.protocolId);   // "POLYMARKET_CTF"
console.log(ref.chainId);      // 137
console.log(ref.conditionId);  // "0x..."
```

**Почему нет проверок:**
- Поле `_assetId` имеет тип `OutcomeTokenAssetId`
- TypeScript **гарантирует** что `_assetId.conditionRef` существует
- Проверка в fromAssetId() гарантирует инвариант

### outcomeKey() — outcome key

```typescript
public outcomeKey(): OutcomeKey {
  // Никаких проверок — доверяем типу OutcomeTokenAssetId
  return this._assetId.outcomeKey;
}
```

**Возвращает:**
- OutcomeKey (UP, DOWN, etc)

**Пример:**

```typescript
const token = OutcomeToken.of(onChainRef, BinaryOutcome.UP);
const key = token.outcomeKey();

if (key === BinaryOutcome.UP) {
  console.log('This is an UP token');
} else if (key === BinaryOutcome.DOWN) {
  console.log('This is a DOWN token');
}
```

---

## equals() — сравнение

```typescript
public equals(other: OutcomeToken): boolean {
  return assetIdEquals(this._assetId, other._assetId);
}
```

**Сравнивает:**
- AssetId полностью (type, conditionRef, outcomeKey)

**Пример:**

```typescript
const token1 = OutcomeToken.of(onChainRef, BinaryOutcome.UP);
const token2 = OutcomeToken.of(onChainRef, BinaryOutcome.UP);
const token3 = OutcomeToken.of(onChainRef, BinaryOutcome.DOWN);

token1.equals(token2);  // → true (same conditionRef, same outcomeKey)
token1.equals(token3);  // → false (different outcomeKey)
```

**Детали:**
- Использует `assetIdEquals()` из `@polymarket/ids`
- Deep comparison conditionRef (protocolId, chainId, conditionId)
- String comparison outcomeKey

---

## Инварианты

OutcomeToken гарантирует следующие инварианты:

### Инвариант 1: AssetId type === 'OUTCOME_TOKEN'

**Проверяется в:** `fromAssetId()` фабрике

```typescript
public static fromAssetId(assetId: AssetId): OutcomeToken {
  if (assetId.type !== 'OUTCOME_TOKEN') {
    throw new OutcomeTokenInvariantViolation(
      'OutcomeToken requires AssetId of type OUTCOME_TOKEN',
      { assetId }
    );
  }
  return new OutcomeToken(assetId);
}
```

**Гарантия:**
- После создания `_assetId.type === 'OUTCOME_TOKEN'` ВСЕГДА
- Accessor'ы не проверяют (доверяют типу OutcomeTokenAssetId)

### Инвариант 2: conditionRef всегда существует

**Гарантируется:** TypeScript типом `OutcomeTokenAssetId`

```typescript
type OutcomeTokenAssetId = Extract<AssetId, { type: 'OUTCOME_TOKEN' }>;
```

**Как работает:**
- `Extract<>` извлекает только AssetId с type === 'OUTCOME_TOKEN'
- TypeScript знает что этот тип имеет поле `conditionRef`
- `conditionRef()` accessor может вернуть поле без проверок

### Инвариант 3: outcomeKey всегда существует

**Гарантируется:** TypeScript типом `OutcomeTokenAssetId`

```typescript
type OutcomeTokenAssetId = Extract<AssetId, { type: 'OUTCOME_TOKEN' }>;
```

**Как работает:**
- Аналогично Инварианту 2
- TypeScript знает что этот тип имеет поле `outcomeKey`
- `outcomeKey()` accessor может вернуть поле без проверок

---

## Иммутабельность

### Object.freeze() защита

OutcomeToken использует `Object.freeze()` для runtime иммутабельности:

```typescript
// В AssetIdHelpers.fromOutcomeToken()
function deepFreezeAssetId(asset: AssetId): AssetId {
  if (asset.type === 'OUTCOME_TOKEN') {
    // Freeze вложенный conditionRef
    Object.freeze(asset.conditionRef);
  }

  // Freeze сам AssetId
  return Object.freeze(asset);
}
```

**Гарантии:**
- Невозможно мутировать AssetId после создания
- Невозможно мутировать вложенный conditionRef
- Попытка мутации бросит TypeError в strict mode

### Smoke test

```typescript
const token = OutcomeToken.of(onChainRef, BinaryOutcome.UP);
const assetId = token.assetId();

// ❌ Throws TypeError: Cannot assign to read only property
(assetId as any).type = 'CURRENCY';

// ❌ Throws TypeError: Cannot assign to read only property
const ref = token.conditionRef();
(ref as any).chainId = 999;
```

### Defensive copy

AssetIdHelpers создаёт **frozen copy** входного conditionRef:

```typescript
export const AssetIdHelpers = {
  fromOutcomeToken(conditionRef: OnChainConditionRef, outcomeKey: OutcomeKey): AssetId {
    // Создаём FROZEN COPY вместо использования входного conditionRef
    const frozenConditionRef: OnChainConditionRef = Object.freeze({
      kind: 'ONCHAIN' as const,
      protocolId: conditionRef.protocolId,
      chainId: conditionRef.chainId,
      conditionId: conditionRef.conditionId,
    });

    return deepFreezeAssetId({
      type: 'OUTCOME_TOKEN',
      conditionRef: frozenConditionRef,
      outcomeKey: validated,
    });
  }
};
```

**Гарантия:**
- Входной `conditionRef` не мутируется
- AssetId содержит frozen copy

---

## Тестирование

### Unit тесты

```typescript
describe('OutcomeToken Core', () => {
  const testConditionRef: OnChainConditionRef = {
    kind: 'ONCHAIN',
    protocolId: 'POLYMARKET_CTF' as any,
    chainId: 137 as any,
    conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as any,
  };

  it('should create OutcomeToken from AssetId', () => {
    const assetId = AssetIdHelpers.fromOutcomeToken(testConditionRef, BinaryOutcome.UP);
    const token = OutcomeToken.fromAssetId(assetId);

    expect(token.outcomeKey()).toBe('UP');
    expect(token.conditionRef().chainId).toBe(137);
  });

  it('should create OutcomeToken from conditionRef + outcomeKey', () => {
    const token = OutcomeToken.of(testConditionRef, BinaryOutcome.DOWN);

    expect(token.outcomeKey()).toBe('DOWN');
    expect(token.conditionRef().kind).toBe('ONCHAIN');
  });

  it('should throw for CURRENCY AssetId', () => {
    const currencyAssetId = AssetIdHelpers.fromCurrency('USDC');

    expect(() => OutcomeToken.fromAssetId(currencyAssetId)).toThrow(
      OutcomeTokenInvariantViolation
    );
  });

  it('should compare tokens for equality', () => {
    const token1 = OutcomeToken.of(testConditionRef, BinaryOutcome.UP);
    const token2 = OutcomeToken.of(testConditionRef, BinaryOutcome.UP);
    const token3 = OutcomeToken.of(testConditionRef, BinaryOutcome.DOWN);

    expect(token1.equals(token2)).toBe(true);
    expect(token1.equals(token3)).toBe(false);
  });
});
```

### Smoke тесты иммутабельности

```typescript
describe('OutcomeToken Immutability', () => {
  it('should freeze AssetId', () => {
    const token = OutcomeToken.of(testConditionRef, BinaryOutcome.UP);
    const assetId = token.assetId();

    expect(Object.isFrozen(assetId)).toBe(true);

    expect(() => {
      (assetId as any).type = 'CURRENCY';
    }).toThrow(TypeError);
  });

  it('should deep freeze conditionRef', () => {
    const token = OutcomeToken.of(testConditionRef, BinaryOutcome.UP);
    const ref = token.conditionRef();

    expect(Object.isFrozen(ref)).toBe(true);

    expect(() => {
      (ref as any).chainId = 999;
    }).toThrow(TypeError);
  });

  it('should not mutate input conditionRef (defensive copy)', () => {
    const inputRef = { ...testConditionRef };
    const token = OutcomeToken.of(inputRef, BinaryOutcome.UP);

    // Пытаемся мутировать входной параметр
    (inputRef as any).chainId = 999;

    // Токен не изменился (использует frozen copy)
    expect(token.conditionRef().chainId).toBe(137);
  });

  it('should create frozen copy in fromAssetId() - mutation of input does not affect token', () => {
    // Create mutable AssetId (simulating parseAssetId behavior)
    const mutableAssetId = {
      type: 'OUTCOME_TOKEN' as const,
      conditionRef: {
        kind: 'ONCHAIN' as const,
        protocolId: testConditionRef.protocolId,
        chainId: testConditionRef.chainId,
        conditionId: testConditionRef.conditionId,
      },
      outcomeKey: BinaryOutcome.UP,
    };

    // Create token from mutable AssetId
    const token = OutcomeToken.fromAssetId(mutableAssetId);

    // Mutate input AssetId
    (mutableAssetId.conditionRef as any).chainId = 999;
    (mutableAssetId as any).outcomeKey = 'MUTATED';

    // Token should NOT be affected (defensive copy was made)
    expect(token.conditionRef().chainId).toBe(137);
    expect(token.outcomeKey()).toBe('UP');
  });
});
```

---

## OutcomeTokenInvariantViolation

Domain exception для нарушения инвариантов:

```typescript
export class OutcomeTokenInvariantViolation extends Error {
  public readonly name = 'OutcomeTokenInvariantViolation';

  constructor(
    message: string,
    public readonly context?: Record<string, unknown>
  ) {
    super(message);
  }
}
```

**Когда бросается:**
- `fromAssetId()` если assetId.type !== 'OUTCOME_TOKEN'

**Пример:**

```typescript
const currencyAssetId = AssetIdHelpers.fromCurrency('USDC');

try {
  const token = OutcomeToken.fromAssetId(currencyAssetId);
} catch (error) {
  if (error instanceof OutcomeTokenInvariantViolation) {
    console.error('Invariant violation:', error.message);
    console.error('Context:', error.context);
  }
}
```

---

## См. также

- [README](./README.md) — обзор и быстрый старт
- [Architecture](./architecture.md) — архитектурные решения
- [Facade Layer](./facade.md) — публичный API с Result<T, E>
- [Adapters Layer](./adapters.md) — сериализация
- [Примеры](./examples.md) — полные примеры
