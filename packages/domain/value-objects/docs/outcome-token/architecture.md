# OutcomeToken — Архитектура

> Детальное описание архитектурных решений и паттернов OutcomeToken value object

## 📋 Содержание

1. [Обзор](#обзор)
2. [Ключевые архитектурные решения](#ключевые-архитектурные-решения)
3. [Слои системы](#слои-системы)
4. [Single Source of Truth](#single-source-of-truth)
5. [Type Narrowing](#type-narrowing)
6. [Иммутабельность](#иммутабельность)
7. [Error Handling](#error-handling)
8. [Валидация](#валидация)

---

## Обзор

OutcomeToken построен на архитектуре **Throws+Facade** с чётким разделением на 4 слоя:

```text
┌─────────────────────────────────────────────────────────────┐
│                     ADAPTERS LAYER                          │
│  ┌──────────────────────┐  ┌──────────────────────┐        │
│  │ OutcomeTokenSerializer│  │ OutcomeTokenFormatter│        │
│  │  (JSON ↔ Domain)     │  │  (Display)           │        │
│  └──────────────────────┘  └──────────────────────┘        │
└─────────────────────────────────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────┐
│                     FACADE LAYER                            │
│  ┌──────────────────────────────────────────────┐          │
│  │  OutcomeTokenService                         │          │
│  │  • create(ConditionRef, ...) → Result        │          │
│  │  • equals(...) → boolean                     │          │
│  │  • Never throws, always returns Result       │          │
│  └──────────────────────────────────────────────┘          │
└─────────────────────────────────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────┐
│                     CORE LAYER                              │
│  ┌──────────────────────────────────────────────┐          │
│  │  OutcomeToken (Domain Model)                 │          │
│  │  • fromAssetId(assetId) → OutcomeToken       │          │
│  │  • of(conditionRef, outcomeKey) → OutcomeToken│         │
│  │  • assetId(), conditionRef(), outcomeKey()   │          │
│  │  • equals(other) → boolean                   │          │
│  │  • May throw (domain exceptions)             │          │
│  └──────────────────────────────────────────────┘          │
└─────────────────────────────────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────┐
│                     ERRORS LAYER                            │
│  ┌──────────────────────┐  ┌──────────────────────┐        │
│  │ InvalidOutcomeToken  │  │ OutcomeTokenError    │        │
│  │ Error                │  │ Reason (enum)        │        │
│  └──────────────────────┘  └──────────────────────┘        │
└─────────────────────────────────────────────────────────────┘
```

---

## Ключевые архитектурные решения

### 1. AssetId как Single Source of Truth

**Проблема**: Ранее OutcomeToken хранил избыточные данные:

- `_assetId: AssetId`
- `_conditionRef: OnChainConditionRef` (дубликат из assetId)
- `_outcomeKey: OutcomeKey` (дубликат из assetId)

Это создавало риск рассинхронизации данных.

**Решение**: AssetId как единственный источник данных.

```typescript
// ❌ БЫЛО: Избыточность
class OutcomeToken {
  private readonly _assetId: AssetId;
  private readonly _conditionRef: OnChainConditionRef;  // Дубликат!
  private readonly _outcomeKey: OutcomeKey;             // Дубликат!
}

// ✅ СТАЛО: Single Source of Truth
class OutcomeToken {
  private readonly _assetId: OutcomeTokenAssetId;  // Единственный источник!
}
```

**Преимущества**:

- Невозможна рассинхронизация (нечего синхронизировать)
- Меньше памяти
- Проще тестирование (один источник данных)
- Accessor'ы просто извлекают из assetId

### 2. Type Narrowing вместо дублирования проверок

**Проблема**: Ранее Core и Facade дублировали проверку `kind === 'ONCHAIN'`:

```typescript
// ❌ БЫЛО: Дублирование
// Facade
if (conditionRef.kind !== 'ONCHAIN') {
  return Err(...);
}

// Core
public static of(conditionRef: OnChainConditionRef, ...) {
  if (conditionRef.kind !== 'ONCHAIN') {  // Дублирование!
    throw new Error('...');
  }
}
```

**Решение**: Facade принимает union type и делает type narrowing ОДИН РАЗ, Core доверяет типу.

```typescript
// ✅ СТАЛО: Type narrowing в facade
// Facade
public static create(
  conditionRef: ConditionRef,  // Union type!
  outcomeKey: OutcomeKey
): Result<OutcomeToken, InvalidOutcomeTokenError> {
  // Type narrowing — ЕДИНСТВЕННАЯ проверка
  if (conditionRef.kind !== 'ONCHAIN') {
    return Err(...NOT_ONCHAIN_CONDITION);
  }

  // После проверки TypeScript знает: conditionRef это OnChainConditionRef
  const token = OutcomeToken.of(conditionRef, outcomeKey);
  return Ok(token);
}

// Core
public static of(
  conditionRef: OnChainConditionRef,  // Доверяем типу!
  outcomeKey: OutcomeKey
): OutcomeToken {
  // Никаких проверок kind — доверяем TypeScript типу
  const assetId = AssetIdHelpers.fromOutcomeToken(conditionRef, outcomeKey);
  return OutcomeToken.fromAssetId(assetId);
}
```

**Преимущества**:

- Нет дублирования кода
- Граница ответственности чёткая: facade валидирует, core доверяет
- TypeScript гарантирует корректность после narrowing

### 3. Extract<> для узкого типа вместо runtime проверок

**Проблема**: Ранее accessor'ы делали runtime проверки даже после валидации в constructor:

```typescript
// ❌ БЫЛО: Мусорные проверки
public outcomeKey(): OutcomeKey {
  if (this._assetId.type !== 'OUTCOME_TOKEN') {
    throw new Error('...');  // this should never happen
  }
  return this._assetId.outcomeKey;
}
```

**Решение**: Использовать `Extract<>` тип для узкого типа поля.

```typescript
// ✅ СТАЛО: Узкий тип + чистые accessor'ы
type OutcomeTokenAssetId = Extract<AssetId, { type: 'OUTCOME_TOKEN' }>;

class OutcomeToken {
  private constructor(private readonly _assetId: OutcomeTokenAssetId) {
    // Никаких проверок — доверяем типу
  }

  public static fromAssetId(assetId: AssetId): OutcomeToken {
    // ЕДИНСТВЕННАЯ проверка type
    if (assetId.type !== 'OUTCOME_TOKEN') {
      throw new OutcomeTokenInvariantViolation(...);
    }
    return new OutcomeToken(assetId);  // Type narrowing
  }

  public outcomeKey(): OutcomeKey {
    return this._assetId.outcomeKey;  // Никаких проверок!
  }
}
```

**Преимущества**:

- Единая точка валидации в `fromAssetId()`
- Accessor'ы без проверок (доверяют типу OutcomeTokenAssetId)
- TypeScript гарантирует что type === 'OUTCOME_TOKEN'

### 4. Deep Freeze для иммутабельности

**Проблема**: TypeScript `readonly` не защищает в runtime:

```typescript
const token = OutcomeToken.of(onChainRef, BinaryOutcome.UP);
const ref = token.conditionRef();

// ⚠️ TypeScript ошибка, но можно обойти через as any
(ref as any).chainId = 999;  // Мутация!
```

**Решение**: `Object.freeze()` на всех уровнях (deep freeze).

```typescript
// ✅ Deep freeze в AssetIdHelpers
function deepFreezeAssetId(asset: AssetId): AssetId {
  if (asset.type === 'CURRENCY') {
    return Object.freeze(asset);
  }

  // Freeze вложенный conditionRef
  Object.freeze(asset.conditionRef);

  // Freeze сам AssetId
  return Object.freeze(asset);
}

export const AssetIdHelpers = {
  fromOutcomeToken(conditionRef: OnChainConditionRef, outcomeKey: OutcomeKey): AssetId {
    // Создаём frozen copy conditionRef
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

**Преимущества**:

- Runtime защита от мутаций (бросает TypeError в strict mode)
- Невозможно нарушить инварианты после создания
- Defensive copy — не мутируем входные параметры

---

## Слои системы

### Core Layer: Domain Model

**Ответственность**:

- Инкапсуляция domain логики
- Гарантия инвариантов
- Чистые операции (без side effects)

**Ключевые решения**:

- AssetId как Single Source of Truth
- Единая точка валидации в `fromAssetId()`
- Accessor'ы без проверок (доверяют типу)
- Может бросать domain exceptions

**Инварианты**:

1. `_assetId.type === 'OUTCOME_TOKEN'` (проверяется в fromAssetId)
2. После создания инварианты ГАРАНТИРОВАНЫ (accessor'ы не проверяют)

```typescript
export class OutcomeToken {
  // Private constructor — доверяет типу OutcomeTokenAssetId
  private constructor(private readonly _assetId: OutcomeTokenAssetId) {}

  // Фабрика с валидацией type
  public static fromAssetId(assetId: AssetId): OutcomeToken {
    if (assetId.type !== 'OUTCOME_TOKEN') {
      throw new OutcomeTokenInvariantViolation(
        'OutcomeToken requires AssetId of type OUTCOME_TOKEN',
        { assetId }
      );
    }
    return new OutcomeToken(assetId);
  }

  // Фабрика из domain объектов
  public static of(
    conditionRef: OnChainConditionRef,
    outcomeKey: OutcomeKey
  ): OutcomeToken {
    const assetId = AssetIdHelpers.fromOutcomeToken(conditionRef, outcomeKey);
    return OutcomeToken.fromAssetId(assetId);
  }

  // Чистые accessor'ы (без проверок)
  public assetId(): OutcomeTokenAssetId { return this._assetId; }
  public conditionRef(): OnChainConditionRef { return this._assetId.conditionRef; }
  public outcomeKey(): OutcomeKey { return this._assetId.outcomeKey; }

  // Сравнение
  public equals(other: OutcomeToken): boolean {
    return AssetIdHelpers.equals(this._assetId, other._assetId);
  }
}
```

### Facade Layer: Public API

**Ответственность**:

- Публичный API с Result<T, E>
- Type narrowing для union types
- Error handling (catch domain exceptions)
- Never throws — ВСЕГДА возвращает Result

**Ключевые решения**:

- Принимает `ConditionRef` (union type)
- Делает type narrowing ОДИН РАЗ
- Точный error mapping по instanceof
- Честный UNEXPECTED reason для неизвестных ошибок

```typescript
export class OutcomeTokenService {
  public static create(
    conditionRef: ConditionRef,  // Union type!
    outcomeKey: OutcomeKey
  ): Result<OutcomeToken, InvalidOutcomeTokenError> {
    return wrapOp(SERVICE_NAME, 'create', { conditionRef, outcomeKey }, () => {
      // Type narrowing
      if (conditionRef.kind !== 'ONCHAIN') {
        throw new InvalidOutcomeTokenError(
          (ctx) => `OutcomeToken requires on-chain condition, got: ${ctx.kind}`,
          { context: { kind: 'not_onchain_condition', conditionRefKind: conditionRef.kind, outcomeKey: String(outcomeKey) } }
        );
      }

      // После проверки TypeScript знает: conditionRef это OnChainConditionRef
      const token = OutcomeToken.of(conditionRef, outcomeKey);
      return Ok(token);
    }, InvalidOutcomeTokenError);
  }

  public static equals(a: OutcomeToken, b: OutcomeToken): boolean {
    return a.equals(b);
  }
}
```

### Adapters Layer: Граница системы

**Ответственность**:

- Сериализация/десериализация (JSON ↔ Domain)
- Валидация ЗНАЧЕНИЙ (не только типов)
- Форматирование для display

**Ключевые решения**:

- `fromJSON()` принимает `unknown` (граница типов)
- Валидация значений через валидаторы из @polymarket/ids
- Использование facade для создания (не core напрямую)

```typescript
export class OutcomeTokenSerializer {
  public static fromJSON(
    json: unknown,
    source: ErrorSource = ErrorSource.PARSING
  ): Result<OutcomeToken, InvalidOutcomeTokenError> {
    // Структурная валидация (это объект? есть поля?)
    if (typeof json !== 'object' || json === null) {
      return Err(...INVALID_FORMAT);
    }

    const obj = json as Record<string, unknown>;

    // Проверка наличия полей
    if (!('conditionRef' in obj) || !('outcomeKey' in obj)) {
      return Err(...INVALID_FORMAT);
    }

    // Валидация типов
    if (typeof obj.outcomeKey !== 'string') {
      return Err(...INVALID_OUTCOME_KEY);
    }

    // ⚠️ КРИТИЧНО: Валидация ЗНАЧЕНИЙ, не только типов!
    const validatedProtocolId = asOnChainProtocolId(refObj.protocolId);
    if (!validatedProtocolId) {
      return Err(...INVALID_CONDITION_REF);
    }

    const validatedChainId = parseChainId(String(refObj.chainId));
    if (!validatedChainId) {
      return Err(...INVALID_CONDITION_REF);
    }

    const validatedConditionId = parseConditionId(refObj.conditionId);
    if (!validatedConditionId) {
      return Err(...INVALID_CONDITION_REF);
    }

    const outcomeKey = parseOutcomeKey(obj.outcomeKey);
    if (!outcomeKey) {
      return Err(...INVALID_OUTCOME_KEY);
    }

    // Создаём OnChainConditionRef с валидированными данными
    const onChainRef: OnChainConditionRef = {
      kind: 'ONCHAIN',
      protocolId: validatedProtocolId,
      chainId: validatedChainId,
      conditionId: validatedConditionId,
    };

    // Делегируем создание OutcomeTokenService (не core!)
    return OutcomeTokenService.create(onChainRef, outcomeKey, source);
  }

  public static toJSON(token: OutcomeToken): OutcomeTokenJSON {
    const conditionRef = token.conditionRef();
    return {
      conditionRef: {
        kind: 'ONCHAIN',
        protocolId: conditionRef.protocolId as string,
        chainId: conditionRef.chainId as number,
        conditionId: conditionRef.conditionId as string,
      },
      outcomeKey: token.outcomeKey() as string,
    };
  }
}
```

### Errors Layer: Типизированные ошибки

**Ответственность**:

- Domain errors с типизированным контекстом
- Enum для причин ошибок (не строки!)

```typescript
// InvalidOutcomeTokenError с типизированным контекстом (kind вместо reason enum)
// Возможные значения context.kind:
//   'not_onchain_condition'  — conditionRef не является OnChainConditionRef
//   'invalid_json'           — невалидная структура JSON
//   'invalid_condition_ref'  — невалидный condition reference (format/type)
//   'invalid_outcome_key'    — невалидный outcome key

export class InvalidOutcomeTokenError extends BaseError {
  // Расширяет BaseError из @polymarket/errors
  // context.kind содержит причину ошибки вместо отдельного enum
}
```

---

## Single Source of Truth

### Проблема дублирования данных

Ранее OutcomeToken хранил избыточные данные:

```typescript
// ❌ БЫЛО
class OutcomeToken {
  private readonly _assetId: AssetId;
  private readonly _conditionRef: OnChainConditionRef;  // Дубликат!
  private readonly _outcomeKey: OutcomeKey;             // Дубликат!

  constructor(assetId: AssetId) {
    this._assetId = assetId;

    // Извлекаем данные из assetId и сохраняем отдельно (дубликат!)
    if (assetId.type === 'OUTCOME_TOKEN') {
      this._conditionRef = assetId.conditionRef;
      this._outcomeKey = assetId.outcomeKey;
    }
  }

  public conditionRef(): OnChainConditionRef {
    return this._conditionRef;  // Возвращаем дубликат
  }
}
```

**Проблемы**:

- Память: 3 поля вместо 1
- Синхронизация: _assetId и_conditionRef могут рассинхрониться (если кто-то мутирует)
- Сложность: Нужно поддерживать согласованность

### Решение: AssetId как единственный источник

```typescript
// ✅ СТАЛО
type OutcomeTokenAssetId = Extract<AssetId, { type: 'OUTCOME_TOKEN' }>;

class OutcomeToken {
  private readonly _assetId: OutcomeTokenAssetId;  // Единственный источник!

  private constructor(assetId: OutcomeTokenAssetId) {
    this._assetId = assetId;  // Только AssetId
  }

  public conditionRef(): OnChainConditionRef {
    return this._assetId.conditionRef;  // Извлекаем из асsetId
  }

  public outcomeKey(): OutcomeKey {
    return this._assetId.outcomeKey;  // Извлекаем из асsetId
  }
}
```

**Преимущества**:

- Память: 1 поле вместо 3
- Синхронизация: Нечего синхронизировать (Single Source of Truth)
- Простота: Accessor'ы просто извлекают из assetId
- Иммутабельность: AssetId frozen → рассинхронизация невозможна

---

## Type Narrowing

### Discriminated Unions

TypeScript поддерживает discriminated unions — union types с общим literal полем:

```typescript
type ConditionRef = OnChainConditionRef | OffChainConditionRef;

interface OnChainConditionRef {
  kind: 'ONCHAIN';  // Discriminant
  protocolId: OnChainProtocolId;
  chainId: ChainId;
  conditionId: ConditionId;
}

interface OffChainConditionRef {
  kind: 'OFFCHAIN';  // Discriminant
  venueId: OffChainVenueId;
  marketId: string;
}
```

### Type Narrowing через проверку discriminant

После проверки `kind === 'ONCHAIN'` TypeScript **знает** что тип `OnChainConditionRef`:

```typescript
function example(ref: ConditionRef) {
  // До проверки: TypeScript не знает какой тип
  // ref.protocolId  // ❌ Error: Property 'protocolId' does not exist on type 'OffChainConditionRef'

  // Type narrowing
  if (ref.kind === 'ONCHAIN') {
    // После проверки: TypeScript знает что это OnChainConditionRef
    console.log(ref.protocolId);  // ✅ OK
    console.log(ref.chainId);     // ✅ OK
  }
}
```

### Применение в OutcomeToken

Facade принимает union type и делает narrowing:

```typescript
// Facade
public static create(
  conditionRef: ConditionRef,  // Union: OnChainConditionRef | OffChainConditionRef
  outcomeKey: OutcomeKey
): Result<OutcomeToken, InvalidOutcomeTokenError> {
  // Type narrowing
  if (conditionRef.kind !== 'ONCHAIN') {
    return Err(...NOT_ONCHAIN_CONDITION);
  }

  // После проверки TypeScript знает: conditionRef это OnChainConditionRef
  const token = OutcomeToken.of(conditionRef, outcomeKey);
  //                            ^ TypeScript: OnChainConditionRef ✅
  return Ok(token);
}

// Core
public static of(
  conditionRef: OnChainConditionRef,  // Узкий тип!
  outcomeKey: OutcomeKey
): OutcomeToken {
  // Никаких проверок kind — доверяем TypeScript типу
  const assetId = AssetIdHelpers.fromOutcomeToken(conditionRef, outcomeKey);
  return OutcomeToken.fromAssetId(assetId);
}
```

**Преимущества**:

- Нет дублирования проверок (facade проверяет ОДИН РАЗ)
- Core доверяет типу (чистая domain логика)
- TypeScript гарантирует корректность

---

## Иммутабельность

### TypeScript readonly

TypeScript `readonly` защищает только от **случайных** мутаций:

```typescript
class OutcomeToken {
  constructor(private readonly _assetId: AssetId) {}

  public assetId(): AssetId {
    return this._assetId;
  }
}

const token = OutcomeToken.of(...);
token._assetId = otherAssetId;  // ❌ TypeScript Error: readonly
```

Но НЕ защищает от **намеренных** мутаций:

```typescript
const token = OutcomeToken.of(...);
const assetId = token.assetId();

// ⚠️ TypeScript ошибка, но можно обойти
(assetId as any).type = 'CURRENCY';  // Мутация!
```

### Object.freeze() для runtime защиты

`Object.freeze()` делает объект **действительно** иммутабельным в runtime:

```typescript
const obj = { value: 10 };
Object.freeze(obj);

obj.value = 20;  // ❌ TypeError: Cannot assign to read only property (strict mode)
```

### Deep Freeze для вложенных объектов

`Object.freeze()` — shallow freeze. Нужен deep freeze для вложенных объектов:

```typescript
function deepFreezeAssetId(asset: AssetId): AssetId {
  if (asset.type === 'CURRENCY') {
    return Object.freeze(asset);
  }

  // OUTCOME_TOKEN имеет вложенный conditionRef
  Object.freeze(asset.conditionRef);  // Freeze вложенный объект
  return Object.freeze(asset);         // Freeze сам AssetId
}
```

### Defensive Copy

Не мутируем входные параметры — создаём frozen copy:

```typescript
export const AssetIdHelpers = {
  fromOutcomeToken(conditionRef: OnChainConditionRef, outcomeKey: OutcomeKey): AssetId {
    // Создаём FROZEN COPY вместо использования входного conditionRef
    const frozenConditionRef: OnChainConditionRef = Object.freeze({
      kind: 'ONCHAIN' as const,
      protocolId: conditionRef.protocolId,  // Copy значений
      chainId: conditionRef.chainId,
      conditionId: conditionRef.conditionId,
    });

    return deepFreezeAssetId({
      type: 'OUTCOME_TOKEN',
      conditionRef: frozenConditionRef,  // Frozen copy
      outcomeKey: validated,
    });
  }
};
```

**Преимущества**:

- Runtime защита от мутаций (TypeError в strict mode)
- Невозможно нарушить инварианты после создания
- Defensive copy — входные параметры не мутируются

---

## Error Handling

### Railway-Oriented Programming

OutcomeToken использует Result<T, E> pattern (Railway-Oriented Programming):

```typescript
// ✅ Success path
const result = OutcomeTokenService.create(onChainRef, BinaryOutcome.UP);
if (result.ok) {
  const token = result.value;  // OutcomeToken
  console.log(token.outcomeKey());
}

// ❌ Error path
if (!result.ok) {
  const error = result.error;  // InvalidOutcomeTokenError
  console.error(error.message);
  console.error(error.context?.reason);  // Типизированная причина
}
```

### Типизированные причины ошибок

Вместо строковых констант — enum:

```typescript
// ❌ Хрупкая проверка по message
if (result.error.message.includes('not on-chain')) {
  // ...
}

// ✅ Надёжная проверка по context.kind
if (result.error.context?.kind === 'not_onchain_condition') {
  // Точная проверка по строковому дискриминатору
}
```

### Точный error mapping

Facade делает точный маппинг по instanceof:

```typescript
try {
  const token = OutcomeToken.of(conditionRef, outcomeKey);
  return Ok(token);
} catch (error) {
  // Точный маппинг по instanceof
  if (error instanceof OutcomeTokenInvariantViolation) {
    return Err(...INVALID_ASSET_ID_TYPE);
  }

  // Честное признание незнания причины
  return Err(...UNEXPECTED);  // НЕ мапим всё в INVALID_OUTCOME_KEY!
}
```

**Преимущества**:

- Type-safe error handling
- Точная диагностика (не "всё в одну кучу")
- Честность (UNEXPECTED вместо ложных причин)

---

## Валидация

### Уровни валидации

OutcomeToken имеет 3 уровня валидации:

1. **TypeScript типы** (compile-time)
2. **Runtime type checking** (структура объекта)
3. **Value validation** (форматы, диапазоны)

### Уровень 1: TypeScript типы

```typescript
const ref: OnChainConditionRef = {
  kind: 'ONCHAIN',
  protocolId: 'POLYMARKET_CTF',  // ✅ Compile-time check
  chainId: 137,
  conditionId: '0x...' as any
};

OutcomeTokenService.create(ref, BinaryOutcome.UP);  // ✅ Type-safe
```

### Уровень 2: Runtime type checking

Проверка что JSON имеет правильную структуру:

```typescript
// fromJSON()
if (typeof json !== 'object' || json === null) {
  return Err(...INVALID_FORMAT);
}

if (!('conditionRef' in obj)) {
  return Err(...INVALID_FORMAT);
}

if (typeof refObj.protocolId !== 'string') {
  return Err(...INVALID_CONDITION_REF);
}
```

### Уровень 3: Value validation

Проверка что значения имеют правильный формат:

```typescript
// Валидация protocolId (формат: UPPERCASE_WITH_UNDERSCORES)
const validatedProtocolId = asOnChainProtocolId(refObj.protocolId);
if (!validatedProtocolId) {
  return Err(...INVALID_CONDITION_REF);
}

// Валидация chainId (положительное целое число)
const validatedChainId = parseChainId(String(refObj.chainId));
if (!validatedChainId) {
  return Err(...INVALID_CONDITION_REF);
}

// Валидация conditionId (32-byte hex с 0x префиксом)
const validatedConditionId = parseConditionId(refObj.conditionId);
if (!validatedConditionId) {
  return Err(...INVALID_CONDITION_REF);
}

// Валидация outcomeKey
const outcomeKey = parseOutcomeKey(outcomeKeyValue);
if (!outcomeKey) {
  return Err(...INVALID_OUTCOME_KEY);
}
```

**Критично**: Валидация ЗНАЧЕНИЙ, не только типов!

```typescript
// ❌ Недостаточно
if (typeof refObj.chainId === 'number') {
  // chainId может быть -1, 0, NaN, Infinity
}

// ✅ Правильно
const validatedChainId = parseChainId(String(refObj.chainId));
if (!validatedChainId) {
  // chainId валидирован на положительное целое число
}
```

---

## См. также

- [README](./README.md) — обзор и быстрый старт
- [Core Layer](./core.md) — domain model
- [Facade Layer](./facade.md) — публичный API
- [Adapters Layer](./adapters.md) — сериализация
- [Примеры](./examples.md) — полные примеры
