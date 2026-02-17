# InvalidOutcomeTokenError

Ошибка валидации токена исхода (OutcomeToken value object).

## Описание

OutcomeToken представляет собой токен для конкретного исхода рынка предсказаний:

- **ConditionRef** - ссылка на условие (condition) рынка
- **outcomeKey** - ключ конкретного исхода ("YES"/"NO", или индекс для multi-outcome)

Валидация проверяет корректность обоих компонентов.

## Свойства

| Свойство | Значение |
|----------|----------|
| **Код** | `INVALID_OUTCOME_TOKEN` |
| **Severity** | `low` |
| **Класс** | `InvalidOutcomeTokenError` |
| **Пакет** | `@polymarket/errors` |
| **Категория** | Value Objects |

## Когда использовать

- Создание value object `OutcomeToken` из данных API
- Валидация outcomeKey перед операциями с токенами
- Парсинг event данных из blockchain
- Проверка корректности ConditionRef при создании токена

## Импорт

```typescript
import { InvalidOutcomeTokenError } from '@polymarket/errors';

// Для примеров с Result<T,E>:
import { Result, Ok, Err } from '@polymarket/result';
```

---

## Примеры использования

### 1. Базовое использование (throw)

```typescript
import { InvalidOutcomeTokenError } from '@polymarket/errors';

class OutcomeToken {
  constructor(
    private readonly conditionRef: ConditionRef,
    private readonly outcomeKey: string
  ) {
    if (!outcomeKey || outcomeKey.trim().length === 0) {
      throw new InvalidOutcomeTokenError(
        (ctx) => `Outcome key cannot be empty for condition ${ctx.conditionRef}`,
        {
          
          context: {
            conditionRef: conditionRef.toString(),
            outcomeKey,
            reason: 'empty-outcome-key'
          }
        }
      );
    }
  }
}

// Использование
try {
  const token = new OutcomeToken(conditionRef, ''); // ❌ Ошибка!
} catch (error) {
  if (InvalidOutcomeTokenError.is(error)) {
    console.error('Invalid outcome token:', error.context);
  }
}
```

### 2. С Result<T,E> (рекомендуется)

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidOutcomeTokenError } from '@polymarket/errors';

class OutcomeToken {
  private constructor(
    private readonly conditionRef: ConditionRef,
    private readonly outcomeKey: string
  ) {}

  static create(
    conditionRef: ConditionRef,
    outcomeKey: string
  ): Result<OutcomeToken, InvalidOutcomeTokenError> {
    // Валидация outcomeKey
    if (typeof outcomeKey !== 'string') {
      return Err(
        new InvalidOutcomeTokenError(
          (ctx) => `Outcome key must be a string, got ${typeof ctx.outcomeKey}`,
          {
            
            context: {
              conditionRef: conditionRef.toString(),
              outcomeKey: String(outcomeKey),
              reason: 'invalid-type'
            }
          }
        )
      );
    }

    if (outcomeKey.trim().length === 0) {
      return Err(
        new InvalidOutcomeTokenError(
          (ctx) => `Outcome key cannot be empty for condition ${ctx.conditionRef}`,
          {
            
            context: {
              conditionRef: conditionRef.toString(),
              outcomeKey,
              reason: 'empty-outcome-key'
            }
          }
        )
      );
    }

    return Ok(new OutcomeToken(conditionRef, outcomeKey));
  }

  getConditionRef(): ConditionRef {
    return this.conditionRef;
  }

  getOutcomeKey(): string {
    return this.outcomeKey;
  }

  equals(other: OutcomeToken): boolean {
    return (
      this.conditionRef.equals(other.conditionRef) &&
      this.outcomeKey === other.outcomeKey
    );
  }
}

// Использование
const result = OutcomeToken.create(conditionRef, 'YES');

if (result.ok) {
  console.log('Token created:', result.value.getOutcomeKey());
} else {
  console.error('Error:', result.error.message);
}
```

### 3. Валидация со списком допустимых исходов

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidOutcomeTokenError } from '@polymarket/errors';

class OutcomeToken {
  private static readonly BINARY_OUTCOMES = ['YES', 'NO'] as const;

  static createBinary(
    conditionRef: ConditionRef,
    outcomeKey: string
  ): Result<OutcomeToken, InvalidOutcomeTokenError> {
    if (!OutcomeToken.BINARY_OUTCOMES.includes(outcomeKey as any)) {
      return Err(
        new InvalidOutcomeTokenError(
          (ctx) => `Invalid binary outcome key: ${ctx.outcomeKey}. Must be YES or NO`,
          {
            
            context: {
              conditionRef: conditionRef.toString(),
              outcomeKey,
              validOutcomes: OutcomeToken.BINARY_OUTCOMES.join(', '),
              reason: 'invalid-binary-outcome'
            }
          }
        )
      );
    }

    return OutcomeToken.create(conditionRef, outcomeKey);
  }

  static createMulti(
    conditionRef: ConditionRef,
    outcomeIndex: number,
    totalOutcomes: number
  ): Result<OutcomeToken, InvalidOutcomeTokenError> {
    if (!Number.isInteger(outcomeIndex) || outcomeIndex < 0) {
      return Err(
        new InvalidOutcomeTokenError(
          (ctx) => `Outcome index must be a non-negative integer, got ${ctx.outcomeIndex}`,
          {
            
            context: {
              conditionRef: conditionRef.toString(),
              outcomeIndex: String(outcomeIndex),
              reason: 'invalid-index'
            }
          }
        )
      );
    }

    if (outcomeIndex >= totalOutcomes) {
      return Err(
        new InvalidOutcomeTokenError(
          (ctx) => `Outcome index ${ctx.outcomeIndex} out of range [0, ${ctx.maxIndex}]`,
          {
            
            context: {
              conditionRef: conditionRef.toString(),
              outcomeIndex: String(outcomeIndex),
              maxIndex: String(totalOutcomes - 1),
              reason: 'index-out-of-range'
            }
          }
        )
      );
    }

    return OutcomeToken.create(conditionRef, String(outcomeIndex));
  }
}

// Использование
const binaryResult = OutcomeToken.createBinary(conditionRef, 'YES');
// ✅ Ok

const invalidBinary = OutcomeToken.createBinary(conditionRef, 'MAYBE');
// ❌ Err (invalid-binary-outcome)

const multiResult = OutcomeToken.createMulti(conditionRef, 2, 5);
// ✅ Ok (outcome index 2 из 5)

const outOfRange = OutcomeToken.createMulti(conditionRef, 10, 5);
// ❌ Err (index-out-of-range)
```

### 4. Парсинг из blockchain events

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidOutcomeTokenError, InvalidConditionRefError } from '@polymarket/errors';

// Предполагаем наличие ConditionRef value object
// import { ConditionRef } from './ConditionRef';

interface TokenMintedEvent {
  conditionId: string;
  outcomeSlotIndex: number;
  recipient: string;
  amount: string;
}

class OutcomeToken {
  static fromBlockchainEvent(
    event: TokenMintedEvent
  ): Result<OutcomeToken, InvalidOutcomeTokenError | InvalidConditionRefError> {
    // Валидируем ConditionRef
    const conditionRefResult = ConditionRef.fromString(event.conditionId);
    if (!conditionRefResult.ok) {
      return conditionRefResult;
    }

    // Валидируем outcomeSlotIndex
    if (!Number.isInteger(event.outcomeSlotIndex)) {
      return Err(
        new InvalidOutcomeTokenError(
          (ctx) => `Outcome slot index must be an integer, got ${ctx.index}`,
          {
            
            context: {
              conditionId: event.conditionId,
              index: String(event.outcomeSlotIndex),
              reason: 'non-integer-index'
            }
          }
        )
      );
    }

    if (event.outcomeSlotIndex < 0) {
      return Err(
        new InvalidOutcomeTokenError(
          (ctx) => `Outcome slot index cannot be negative: ${ctx.index}`,
          {
            
            context: {
              conditionId: event.conditionId,
              index: String(event.outcomeSlotIndex),
              reason: 'negative-index'
            }
          }
        )
      );
    }

    return OutcomeToken.create(
      conditionRefResult.value,
      String(event.outcomeSlotIndex)
    );
  }
}

// Использование
const event: TokenMintedEvent = {
  conditionId: '0x123...',
  outcomeSlotIndex: 1,
  recipient: '0xabc...',
  amount: '1000000000000000000'
};

const result = OutcomeToken.fromBlockchainEvent(event);

if (result.ok) {
  console.log('Token from event:', result.value.getOutcomeKey());
} else {
  if (InvalidOutcomeTokenError.is(result.error)) {
    console.error('Invalid outcome token:', result.error.context);
  } else {
    console.error('Invalid condition ref:', result.error.message);
  }
}
```

### 5. Работа с коллекциями токенов

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidOutcomeTokenError } from '@polymarket/errors';

class OutcomeTokenSet {
  private constructor(
    private readonly conditionRef: ConditionRef,
    private readonly tokens: ReadonlyArray<OutcomeToken>
  ) {}

  static create(
    conditionRef: ConditionRef,
    outcomeKeys: readonly string[]
  ): Result<OutcomeTokenSet, InvalidOutcomeTokenError> {
    if (outcomeKeys.length === 0) {
      return Err(
        new InvalidOutcomeTokenError(
          (ctx) => `Outcome keys array cannot be empty for condition ${ctx.conditionRef}`,
          {
            
            context: {
              conditionRef: conditionRef.toString(),
              reason: 'empty-outcomes-array'
            }
          }
        )
      );
    }

    const tokens: OutcomeToken[] = [];
    const seen = new Set<string>();

    for (const outcomeKey of outcomeKeys) {
      // Проверяем дубликаты
      if (seen.has(outcomeKey)) {
        return Err(
          new InvalidOutcomeTokenError(
            (ctx) => `Duplicate outcome key: ${ctx.outcomeKey}`,
            {
              
              context: {
                conditionRef: conditionRef.toString(),
                outcomeKey,
                reason: 'duplicate-outcome-key'
              }
            }
          )
        );
      }

      // Создаём токен
      const tokenResult = OutcomeToken.create(conditionRef, outcomeKey);
      if (!tokenResult.ok) {
        return tokenResult;
      }

      tokens.push(tokenResult.value);
      seen.add(outcomeKey);
    }

    return Ok(new OutcomeTokenSet(conditionRef, tokens));
  }

  getTokens(): ReadonlyArray<OutcomeToken> {
    return this.tokens;
  }

  getToken(outcomeKey: string): OutcomeToken | undefined {
    return this.tokens.find(t => t.getOutcomeKey() === outcomeKey);
  }
}

// Использование
const setResult = OutcomeTokenSet.create(conditionRef, ['YES', 'NO']);
// ✅ Ok

const duplicateResult = OutcomeTokenSet.create(conditionRef, ['YES', 'YES']);
// ❌ Err (duplicate-outcome-key)

const emptyResult = OutcomeTokenSet.create(conditionRef, []);
// ❌ Err (empty-outcomes-array)
```

---

## Edge Cases

### Пустые и невалидные ключи

```typescript
// Пустая строка
OutcomeToken.create(conditionRef, '');
// ❌ Err (empty-outcome-key)

// Только пробелы
OutcomeToken.create(conditionRef, '   ');
// ❌ Err (empty-outcome-key после trim)

// Null/undefined (с type assertion для демонстрации)
OutcomeToken.create(conditionRef, null as any);
// ❌ Err (invalid-type)

OutcomeToken.create(conditionRef, undefined as any);
// ❌ Err (invalid-type)
```

### Специальные символы

```typescript
// Валидные ключи с различными символами
OutcomeToken.create(conditionRef, 'YES');    // ✅ Ok
OutcomeToken.create(conditionRef, 'NO');     // ✅ Ok
OutcomeToken.create(conditionRef, '0');      // ✅ Ok (индекс)
OutcomeToken.create(conditionRef, '42');     // ✅ Ok (индекс)
OutcomeToken.create(conditionRef, 'Team_A'); // ✅ Ok (с подчеркиванием)

// Длинные ключи
OutcomeToken.create(conditionRef, 'Very Long Outcome Name With Spaces');
// ✅ Ok (если не применяется дополнительная валидация)
```

### Case sensitivity

```typescript
const yesToken = OutcomeToken.create(conditionRef, 'YES').value;
const yesLower = OutcomeToken.create(conditionRef, 'yes').value;

// Это разные токены!
yesToken.equals(yesLower); // ❌ false

// Если нужна case-insensitive валидация - нормализуйте входные данные
const normalized = outcomeKey.toUpperCase();
OutcomeToken.create(conditionRef, normalized);
```

---

## Обработка ошибок

### По причине ошибки

```typescript
import { InvalidOutcomeTokenError } from '@polymarket/errors';

const result = OutcomeToken.create(conditionRef, outcomeKey);

if (result.ok) {
  processToken(result.value);
} else {
  if (InvalidOutcomeTokenError.is(result.error)) {
    const reason = result.error.context?.reason;

    switch (reason) {
      case 'empty-outcome-key':
        showError('Outcome key cannot be empty');
        break;
      case 'invalid-type':
        showError('Outcome key must be a string');
        break;
      case 'invalid-binary-outcome':
        showError('Binary outcome must be YES or NO');
        break;
      case 'index-out-of-range':
        showError('Outcome index is out of valid range');
        break;
      case 'duplicate-outcome-key':
        showError('Duplicate outcome key detected');
        break;
      default:
        showError('Invalid outcome token');
    }
  }
}
```

### С логированием

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidOutcomeTokenError } from '@polymarket/errors';

function createOutcomeTokenWithLogging(
  conditionRef: ConditionRef,
  outcomeKey: string
): Result<OutcomeToken, InvalidOutcomeTokenError> {
  logger.debug('Creating outcome token', {
    conditionRef: conditionRef.toString(),
    outcomeKey
  });

  const result = OutcomeToken.create(conditionRef, outcomeKey);

  if (result.ok) {
    logger.info('Outcome token created', {
      conditionRef: conditionRef.toString(),
      outcomeKey: result.value.getOutcomeKey()
    });
  } else {
    logger.error('Outcome token creation failed', {
      error: result.error.toJSON(),
      conditionRef: conditionRef.toString(),
      outcomeKey
    });
  }

  return result;
}
```

---

## Связанные ошибки

- [InvalidAmountError](./invalid-amount.md) - используется при работе с количеством токенов
- [InvalidAssetQuantityError](./invalid-asset-quantity.md) - для комбинации токена с количеством

## См. также

- [Value Objects Errors](./README.md) - Обзор категории
- [Обработка ошибок](../error-handling.md) - Best practices
- [Главная документация](../README.md)
