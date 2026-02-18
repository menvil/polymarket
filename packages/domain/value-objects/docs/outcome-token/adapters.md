# OutcomeToken Adapters Layer — Сериализация

> Граница системы: валидация и сериализация JSON ↔ Domain

## 📋 Содержание

1. [Обзор](#обзор)
2. [OutcomeTokenSerializer](#outcometokenserializer)
3. [OutcomeTokenFormatter](#outcometokenformatter)
4. [Валидация](#валидация)

---

## Обзор

Adapters Layer отвечает за:

- Сериализацию/десериализацию (JSON ↔ Domain)
- Валидацию ЗНАЧЕНИЙ (не только типов)
- Форматирование для display

---

## OutcomeTokenSerializer

### fromJSON() — десериализация

**Сигнатура:**

```typescript
public static fromJSON(
  json: unknown,
  source?: ErrorSource
): Result<OutcomeToken, InvalidOutcomeTokenError>
```

**Параметры:**

- **json** — `unknown` (граница типов!)
- **source** — `ErrorSource` (опционально)

**Возвращает:**

- `Result<OutcomeToken, InvalidOutcomeTokenError>`

**Валидация (3 уровня):**

1. **Структура** — это объект? есть поля?
2. **Типы** — поля имеют правильные типы?
3. **Значения** — значения имеют правильные форматы?

**Пример:**

```typescript
import { OutcomeTokenSerializer } from '@polymarket/value-objects/outcome-token';

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
  const token = result.value;
  console.log(token.outcomeKey());  // "UP"
}
```

**Возможные ошибки:**

| Причина | Когда возникает |
| --------- | ----------------- |
| `INVALID_FORMAT` | Невалидная структура JSON |
| `NOT_ONCHAIN_CONDITION` | conditionRef.kind !== 'ONCHAIN' |
| `INVALID_CONDITION_REF` | Невалидный формат conditionRef полей |
| `INVALID_OUTCOME_KEY` | Невалидный формат outcomeKey |

### toJSON() — сериализация

**Сигнатура:**

```typescript
public static toJSON(token: OutcomeToken): OutcomeTokenJSON
```

**Параметры:**

- **token** — OutcomeToken для сериализации

**Возвращает:**

- `OutcomeTokenJSON` объект

**Пример:**

```typescript
const tokenResult = OutcomeTokenService.create(onChainRef, BinaryOutcome.UP);
if (!tokenResult.ok) return;

const json = OutcomeTokenSerializer.toJSON(tokenResult.value);
console.log(JSON.stringify(json, null, 2));
// {
//   "conditionRef": {
//     "kind": "ONCHAIN",
//     "protocolId": "POLYMARKET_CTF",
//     "chainId": 137,
//     "conditionId": "0x..."
//   },
//   "outcomeKey": "UP"
// }
```

### OutcomeTokenJSON тип

```typescript
export interface OutcomeTokenJSON {
  conditionRef: {
    kind: 'ONCHAIN';
    protocolId: string;
    chainId: number;
    conditionId: string;
  };
  outcomeKey: string;
}
```

---

## OutcomeTokenFormatter

### format() — человекочитаемое представление

**Сигнатура:**

```typescript
public static format(token: OutcomeToken): string
```

**Параметры:**

- **token** — OutcomeToken для форматирования

**Возвращает:**

- `string` — человекочитаемое представление

**Пример:**

```typescript
import { OutcomeTokenFormatter } from '@polymarket/value-objects/outcome-token';

const tokenResult = OutcomeTokenService.create(onChainRef, BinaryOutcome.UP);
if (!tokenResult.ok) return;

const formatted = OutcomeTokenFormatter.format(tokenResult.value);
console.log(formatted);
// "POLYMARKET_CTF:137:0xaaaa...:UP"
```

---

## Валидация

### Уровень 1: Структура

Проверка того, что JSON имеет правильную структуру:

```typescript
// Это объект?
if (typeof json !== 'object' || json === null) {
  return Err(...INVALID_FORMAT);
}

// Это не массив?
if (Array.isArray(json)) {
  return Err(...INVALID_FORMAT);
}

// Есть обязательные поля?
if (!('conditionRef' in obj) || !('outcomeKey' in obj)) {
  return Err(...INVALID_FORMAT);
}
```

### Уровень 2: Типы

Проверка что поля имеют правильные типы:

```typescript
// conditionRef это объект?
if (typeof conditionRef !== 'object' || conditionRef === null) {
  return Err(...INVALID_CONDITION_REF);
}

// protocolId это строка?
if (typeof refObj.protocolId !== 'string') {
  return Err(...INVALID_CONDITION_REF);
}

// chainId это число?
if (typeof refObj.chainId !== 'number') {
  return Err(...INVALID_CONDITION_REF);
}

// conditionId это строка?
if (typeof refObj.conditionId !== 'string') {
  return Err(...INVALID_CONDITION_REF);
}

// outcomeKey это строка?
if (typeof outcomeKeyValue !== 'string') {
  return Err(...INVALID_OUTCOME_KEY);
}
```

### Уровень 3: Значения

**⚠️ КРИТИЧНО**: Валидация ЗНАЧЕНИЙ, не только типов!

```typescript
// Валидация protocolId (формат: UPPERCASE_WITH_UNDERSCORES)
const validatedProtocolId = asOnChainProtocolId(refObj.protocolId);
if (!validatedProtocolId) {
  return Err(
    new InvalidOutcomeTokenError(
      `Invalid protocolId format: '${refObj.protocolId}'. Must be UPPERCASE_WITH_UNDERSCORES`,
      { reason: OutcomeTokenErrorReason.INVALID_CONDITION_REF, ... },
      source
    )
  );
}

// Валидация chainId (положительное целое число)
const validatedChainId = parseChainId(String(refObj.chainId));
if (!validatedChainId) {
  return Err(
    new InvalidOutcomeTokenError(
      `Invalid chainId: ${refObj.chainId}. Must be positive integer`,
      { reason: OutcomeTokenErrorReason.INVALID_CONDITION_REF, ... },
      source
    )
  );
}

// Валидация conditionId (32-byte hex с 0x префиксом)
const validatedConditionId = parseConditionId(refObj.conditionId);
if (!validatedConditionId) {
  return Err(
    new InvalidOutcomeTokenError(
      `Invalid conditionId format: '${refObj.conditionId}'. Must be 32-byte hex (0x...)`,
      { reason: OutcomeTokenErrorReason.INVALID_CONDITION_REF, ... },
      source
    )
  );
}

// Валидация outcomeKey
const outcomeKey = parseOutcomeKey(outcomeKeyValue);
if (!outcomeKey) {
  return Err(
    new InvalidOutcomeTokenError(
      `Invalid outcomeKey format: '${outcomeKeyValue}'`,
      { reason: OutcomeTokenErrorReason.INVALID_OUTCOME_KEY, ... },
      source
    )
  );
}
```

**Почему важна валидация значений:**

```typescript
// ❌ Недостаточно проверить тип
if (typeof chainId === 'number') {
  // chainId может быть: -1, 0, NaN, Infinity, 1.5
}

// ✅ Нужно валидировать значение
const validated = parseChainId(String(chainId));
if (!validated) {
  // chainId НЕ является положительным целым числом
}
```

---

## См. также

- [README](./README.md) — обзор и быстрый старт
- [Architecture](./architecture.md) — архитектурные решения
- [Core Layer](./core.md) — domain model
- [Facade Layer](./facade.md) — публичный API
- [Примеры](./examples.md) — полные примеры
