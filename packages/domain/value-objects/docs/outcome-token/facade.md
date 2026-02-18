# OutcomeToken Facade Layer — Public API

> Публичный API с гарантией "Never Throw"

## 📋 Содержание

1. [Обзор](#обзор)
2. [OutcomeTokenService](#outcometokenservice)
3. [create() метод](#create-метод)
4. [equals() метод](#equals-метод)
5. [Error Handling](#error-handling)
6. [Type Narrowing](#type-narrowing)

---

## Обзор

Facade Layer предоставляет публичный API для работы с OutcomeToken:

- **OutcomeTokenService** — фасад с методами create(), equals()

**Контракт "Never Throw":**

- ВСЕ методы ГАРАНТИРОВАННО возвращают `Result<T, E>`
- НИКОГДА не бросают исключения
- Все domain exceptions ловятся и мапятся в Result.Err

---

## OutcomeTokenService

```typescript
export class OutcomeTokenService {
  /**
   * Создать OutcomeToken из condition reference и outcome key
   */
  public static create(
    conditionRef: ConditionRef,
    outcomeKey: OutcomeKey
  ): Result<OutcomeToken, InvalidOutcomeTokenError>

  /**
   * Сравнить два OutcomeToken на равенство
   */
  public static equals(a: OutcomeToken, b: OutcomeToken): boolean
}
```

---

## create() метод

### Сигнатура

```typescript
public static create(
  conditionRef: ConditionRef,  // Union: OnChainConditionRef | OffChainConditionRef
  outcomeKey: OutcomeKey
): Result<OutcomeToken, InvalidOutcomeTokenError>
```

### Параметры

- **conditionRef** — `ConditionRef` (union type!)
  - Может быть `OnChainConditionRef` или `OffChainConditionRef`
  - Facade делает type narrowing и проверяет `kind === 'ONCHAIN'`

- **outcomeKey** — `OutcomeKey`
  - Ключ outcome (UP, DOWN, etc.)

### Возвращает

`Result<OutcomeToken, InvalidOutcomeTokenError>`:

- **Ok(OutcomeToken)** — успешное создание
- **Err(InvalidOutcomeTokenError)** — ошибка с типизированной причиной

### Возможные ошибки

| `context.kind` | Когда возникает |
| --------- | ----------------- |
| `'not_onchain_condition'` | conditionRef.kind !== 'ONCHAIN' |
| *(внутренние ошибки)* | AssetId невалидный или неожиданное исключение |

### Пример использования

```typescript
import { OutcomeTokenService } from '@polymarket/value-objects/outcome-token';
import { BinaryOutcome } from '@polymarket/ids';
import type { OnChainConditionRef } from '@polymarket/ids';

const onChainRef: OnChainConditionRef = {
  kind: 'ONCHAIN',
  protocolId: 'POLYMARKET_CTF' as any,
  chainId: 137 as any,
  conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as any
};

// ✅ Success
const result = OutcomeTokenService.create(onChainRef, BinaryOutcome.UP);
if (result.ok) {
  const token = result.value;
  console.log(token.outcomeKey());  // "UP"
}

// ❌ Error handling
if (!result.ok) {
  const error = result.error;
  console.error(error.message);

  // Используйте context.kind для диагностики причины
  if (error.context?.kind === 'not_onchain_condition') {
    console.error('OutcomeToken requires valid on-chain condition');
  }
}
```

### Type Narrowing

Facade принимает `ConditionRef` (union type) и делает type narrowing:

```typescript
public static create(
  conditionRef: ConditionRef,  // Union type!
  outcomeKey: OutcomeKey
): Result<OutcomeToken, InvalidOutcomeTokenError> {
  return wrapOp(SERVICE_NAME, 'create', { conditionRef, outcomeKey }, () => {
    // Type narrowing: проверяем что это OnChainConditionRef
    if (conditionRef.kind !== 'ONCHAIN') {
      throw new InvalidOutcomeTokenError(
        (ctx) => `OutcomeToken requires on-chain condition, got: ${ctx.conditionRefKind}`,
        { context: { kind: 'not_onchain_condition', conditionRefKind: conditionRef.kind } }
      );
    }

    // После проверки TypeScript знает: conditionRef это OnChainConditionRef
    const token = OutcomeToken.of(conditionRef, outcomeKey);
    return Ok(token);
  }, InvalidOutcomeTokenError);
}
```

**Преимущества**:

- Проверка `kind === 'ONCHAIN'` происходит ОДИН РАЗ в facade
- Core доверяет типу `OnChainConditionRef`
- Нет дублирования проверок

---

## equals() метод

### Сигнатура

```typescript
public static equals(a: OutcomeToken, b: OutcomeToken): boolean
```

### Параметры

- **a** — первый OutcomeToken
- **b** — второй OutcomeToken

### Возвращает

`boolean`:

- **true** — tokens представляют одинаковый актив (same conditionRef, same outcomeKey)
- **false** — разные активы

### Пример использования

```typescript
const token1Result = OutcomeTokenService.create(onChainRef, BinaryOutcome.UP);
const token2Result = OutcomeTokenService.create(onChainRef, BinaryOutcome.UP);
const token3Result = OutcomeTokenService.create(onChainRef, BinaryOutcome.DOWN);

if (token1Result.ok && token2Result.ok && token3Result.ok) {
  const same = OutcomeTokenService.equals(token1Result.value, token2Result.value);
  console.log(same);  // → true

  const different = OutcomeTokenService.equals(token1Result.value, token3Result.value);
  console.log(different);  // → false
}
```

---

## Error Handling

### Railway-Oriented Programming

Все методы facade возвращают `Result<T, E>`:

```typescript
const result = OutcomeTokenService.create(conditionRef, outcomeKey);

// Success path
if (result.ok) {
  const token = result.value;
  // ...
}

// Error path
if (!result.ok) {
  const error = result.error;
  // ...
}
```

### Точный error mapping

Facade делает точный маппинг по instanceof:

```typescript
return wrapOp(
  SERVICE_NAME,
  'create',
  { conditionRef, outcomeKey },
  () => {
    if (conditionRef.kind !== 'ONCHAIN') {
      throw new InvalidOutcomeTokenError(
        (ctx) => `OutcomeToken requires on-chain condition, got: ${ctx.conditionRefKind}`,
        { context: { kind: 'not_onchain_condition', conditionRefKind: conditionRef.kind } }
      );
    }

    const token = OutcomeToken.of(conditionRef, outcomeKey);
    return Ok(token);
  },
  InvalidOutcomeTokenError
);
```

**Преимущества**:

- Точная диагностика (не "всё в одну кучу")
- Честность (UNEXPECTED вместо ложных причин)
- Подробный контекст для debugging

### Типизированные причины

Вместо проверки по message — используй строковый дискриминатор `context.kind`:

```typescript
// ❌ Хрупкая проверка
if (result.error.message.includes('not on-chain')) {
  // ...
}

// ✅ Type-safe проверка
if (result.error.context?.kind === 'not_onchain_condition') {
  // ...
}
```

---

## Type Narrowing

### Discriminated Unions

ConditionRef — это discriminated union:

```typescript
type ConditionRef = OnChainConditionRef | OffChainConditionRef;

interface OnChainConditionRef {
  kind: 'ONCHAIN';  // Discriminant
  // ...
}

interface OffChainConditionRef {
  kind: 'OFFCHAIN';  // Discriminant
  // ...
}
```

### Проверка discriminant

После проверки `kind === 'ONCHAIN'` TypeScript знает точный тип:

```typescript
function example(ref: ConditionRef) {
  // До проверки: TypeScript не знает тип
  // ref.protocolId  // ❌ Error

  if (ref.kind === 'ONCHAIN') {
    // После проверки: TypeScript знает что это OnChainConditionRef
    console.log(ref.protocolId);  // ✅ OK
  }
}
```

### Применение в create()

Facade делает narrowing ОДИН РАЗ, core доверяет типу:

```typescript
// Facade
public static create(
  conditionRef: ConditionRef,  // Union type
  outcomeKey: OutcomeKey
): Result<OutcomeToken, InvalidOutcomeTokenError> {
  return wrapOp(SERVICE_NAME, 'create', { conditionRef, outcomeKey }, () => {
    // Type narrowing: выбрасываем ошибку если не OnChainConditionRef
    if (conditionRef.kind !== 'ONCHAIN') {
      throw new InvalidOutcomeTokenError(
        (ctx) => `OutcomeToken requires on-chain condition, got: ${ctx.conditionRefKind}`,
        { context: { kind: 'not_onchain_condition', conditionRefKind: conditionRef.kind } }
      );
    }

    // После проверки TypeScript знает: conditionRef это OnChainConditionRef ✅
    const token = OutcomeToken.of(conditionRef, outcomeKey);
    return Ok(token);
  }, InvalidOutcomeTokenError);
}

// Core
public static of(
  conditionRef: OnChainConditionRef,  // Узкий тип!
  // ...
): OutcomeToken {
  // Никаких проверок kind — доверяем типу
  // ...
}
```

---

## См. также

- [README](./README.md) — обзор и быстрый старт
- [Architecture](./architecture.md) — архитектурные решения
- [Core Layer](./core.md) — domain model
- [Adapters Layer](./adapters.md) — сериализация
- [Примеры](./examples.md) — полные примеры
