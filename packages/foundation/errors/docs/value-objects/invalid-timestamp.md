# InvalidTimestampError

Ошибка валидации временной метки в торговой системе Polymarket.

## Описание

Временная метка (Timestamp) представляет момент времени в формате Unix epoch milliseconds. Должна быть неотрицательным целым числом в допустимых границах (0 до 9999999999999).

## Свойства

| Свойство | Значение |
|----------|----------|
| **Код** | `INVALID_TIMESTAMP` |
| **Severity** | `low` |
| **Класс** | `InvalidTimestampError` |
| **Пакет** | `@polymarket/errors` |
| **Категория** | Value Objects |

## Когда использовать

- Создание value object `Timestamp` из пользовательского ввода
- Валидация временных меток из API
- Обработка event timestamps
- Создание котировок с временными метками
- Проверка времени истечения (expiration times)

## Импорт

```typescript
import { InvalidTimestampError } from '@polymarket/errors';

// Для примеров с Result<T,E>:
import { Result, Ok, Err } from '@polymarket/result';
```

---

## Примеры использования

### 1. Базовое использование

```typescript
import { InvalidTimestampError } from '@polymarket/errors';
import { Result, Ok, Err } from '@polymarket/result';

// Пример: как InvalidTimestampError используется внутри TimestampService
class TimestampService {
  static create(ms: number): Result<number, InvalidTimestampError> {
    // автоматически truncate дробные значения
    const trunc = Math.trunc(ms);
    if (!isFinite(ms) || isNaN(ms)) {
      return Err(new InvalidTimestampError('Invalid timestamp format', {
        context: { value: ms, reason: 'INVALID_FORMAT' }
      }));
    }
    if (ms < 0) {
      return Err(new InvalidTimestampError('Timestamp cannot be negative', {
        context: { value: ms, reason: 'NOT_POSITIVE' }
      }));
    }
    return Ok(trunc);
  }
}

const result = TimestampService.create(1609459200000.789);

if (!result.ok) {
  console.error(result.error.message);
  // Обработка InvalidTimestampError
  return;
}

const epochMs = result.value;
console.log(new Date(epochMs).toISOString()); // "2021-01-01T00:00:00.000Z"
```

### 2. Обработка невалидных значений

```typescript
import { InvalidTimestampError } from '@polymarket/errors';
import { Result, Ok, Err } from '@polymarket/result';

class TimestampService {
  static create(ms: number): Result<number, InvalidTimestampError> {
    if (!isFinite(ms) || isNaN(ms)) {
      return Err(new InvalidTimestampError('Invalid timestamp format', {
        context: { value: ms, reason: 'INVALID_FORMAT' }
      }));
    }
    if (ms < 0) {
      return Err(new InvalidTimestampError('Timestamp cannot be negative', {
        context: { value: ms, reason: 'NOT_POSITIVE' }
      }));
    }
    if (ms > 9999999999999) {
      return Err(new InvalidTimestampError('Timestamp out of range', {
        context: { value: ms, reason: 'OUT_OF_RANGE' }
      }));
    }
    return Ok(Math.trunc(ms));
  }
}

function processTimestamp(value: number) {
  const result = TimestampService.create(value);

  if (!result.ok) {
    // InvalidTimestampError содержит context с reason
    const { reason, op } = result.error.context || {};

    switch (reason) {
      case 'INVALID_FORMAT':
        console.error('Value is not finite (NaN or Infinity)');
        break;
      case 'NOT_POSITIVE':
        console.error('Timestamp cannot be negative');
        break;
      case 'OUT_OF_RANGE':
        console.error('Timestamp exceeds maximum (9999999999999)');
        break;
      default:
        console.error('Invalid timestamp:', result.error.message);
    }

    return null;
  }

  return result.value;
}

// Примеры ошибок
processTimestamp(NaN);        // INVALID_FORMAT
processTimestamp(Infinity);   // INVALID_FORMAT
processTimestamp(-1000);      // NOT_POSITIVE
processTimestamp(1e14);       // OUT_OF_RANGE (too large)
```

### 3. Создание из Date

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidTimestampError } from '@polymarket/errors';

class TimestampService {
  static fromDate(date: Date): Result<Timestamp, InvalidTimestampError> {
    const ms = date.getTime();
    return TimestampService.create(ms);
  }

  static now(clock?: IClock): Timestamp {
    // Never throws - использует fallback на Date.now() при ошибках
    try {
      return Timestamp.now(clock);
    } catch {
      return Timestamp.of(new Decimal(Date.now()));
    }
  }
}

// Использование
const nowResult = TimestampService.fromDate(new Date());
// Ok(Timestamp)

const futureResult = TimestampService.fromDate(new Date('2030-01-01'));
// Ok(Timestamp)
```

### 4. Quote с временной меткой

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidTimestampError } from '@polymarket/errors';

interface Quote {
  bid: number;
  ask: number;
  timestamp: Timestamp;
}

function createQuote(
  bid: number,
  ask: number,
  timestampMs: number
): Result<Quote, InvalidTimestampError> {
  const timestampResult = TimestampService.create(timestampMs);

  if (!timestampResult.ok) {
    return timestampResult;
  }

  return Ok({
    bid,
    ask,
    timestamp: timestampResult.value
  });
}

// Использование
const quoteResult = createQuote(0.45, 0.55, Date.now());
// Ok({ bid, ask, timestamp })
```

### 5. Проверка устаревания (staleness)

```typescript
import { TimestampService } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

// Создание timestamp 5 секунд назад
const quoteResult = TimestampService.create(Date.now() - 5000);

if (quoteResult.ok) {
  const quoteTimestamp = quoteResult.value;
  const now = TimestampService.now();

  // diffMs возвращает Decimal
  const ageMs = TimestampService.diffMs(now, quoteTimestamp);
  const maxAge = new Decimal(3000); // 3 секунды

  if (ageMs.greaterThan(maxAge)) {
    console.log('Quote is stale');
    console.log(`Age: ${ageMs.toNumber()}ms`);
  }

  // Или через метод Timestamp
  const ageMsAlt = now.diffMs(quoteTimestamp);
  console.log(`Alternative age: ${ageMsAlt.toNumber()}ms`);
}
```

---

## Edge Cases

### Граничные значения

```typescript
// Минимальное значение (Unix epoch)
TimestampService.create(0); // ✅ Ok(Timestamp) - 1970-01-01T00:00:00.000Z

// Текущее время
TimestampService.create(Date.now()); // ✅ Ok(Timestamp)

// Будущее время
TimestampService.create(2000000000000); // ✅ Ok(Timestamp)

// Максимальное значение
TimestampService.create(9999999999999); // ✅ Ok(Timestamp)

// Превышение максимума
TimestampService.create(10000000000000); // ❌ Err(OUT_OF_RANGE)
```

### Специальные значения

```typescript
// NaN
TimestampService.create(NaN); // ❌ Err(INVALID_FORMAT)

// Infinity
TimestampService.create(Infinity); // ❌ Err(INVALID_FORMAT)
TimestampService.create(-Infinity); // ❌ Err(INVALID_FORMAT)

// Отрицательное
TimestampService.create(-1); // ❌ Err(NOT_POSITIVE)

// Дробное (автоматически truncate до integer)
TimestampService.create(123.456); // ✅ Ok(Timestamp) - становится 123
TimestampService.create(1609459200000.999); // ✅ Ok - truncate до 1609459200000
```

### Валидация ISO строк

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidTimestampError } from '@polymarket/errors';

class TimestampService {
  static fromISO(iso: string): Result<Timestamp, InvalidTimestampError> {
    const date = new Date(iso);

    if (isNaN(date.getTime())) {
      return Err(
        new InvalidTimestampError(
          (ctx) => `Invalid ISO string: "${ctx.value}"`,
          {
            context: { value: iso, reason: 'INVALID_ISO' }
          }
        )
      );
    }

    return TimestampService.create(date.getTime());
  }
}

// Использование
TimestampService.fromISO('2024-01-01T00:00:00.000Z'); // ✅ Ok
TimestampService.fromISO('invalid-date'); // ❌ Err(INVALID_ISO)
```

---

## Обработка ошибок

### По типу ошибки

```typescript
import { InvalidTimestampError } from '@polymarket/errors';

const result = TimestampService.create(userInput);

if (result.ok) {
  processTimestamp(result.value);
} else {
  if (InvalidTimestampError.is(result.error)) {
    const reason = result.error.context?.reason as string;

    if (reason === 'NOT_POSITIVE') {
      showUserMessage('Timestamp cannot be negative');
    } else if (reason === 'OUT_OF_RANGE') {
      showUserMessage('Timestamp value is out of range');
    } else if (reason === 'INVALID_FORMAT') {
      showUserMessage('Timestamp must be a valid number');
    }
  }
}
```

### С логированием

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidTimestampError } from '@polymarket/errors';

function validateAndLogTimestamp(
  value: number,
  source: string
): Result<Timestamp, InvalidTimestampError> {
  const result = TimestampService.create(value);

  if (result.ok) {
    logger.info('Timestamp validated', {
      source,
      timestamp: result.value.toISO(),
      epochMs: value
    });
  } else {
    logger.error('Timestamp validation failed', {
      source,
      error: result.error.toJSON(),
      input: value
    });
  }

  return result;
}
```

---

## Связанные ошибки

- [InvalidAmountError](./invalid-amount.md) - универсальная валидация чисел

## См. также

- [Value Objects Errors](./README.md) - Обзор категории
- [Обработка ошибок](../error-handling.md) - Best practices
- [Главная документация](../README.md)
