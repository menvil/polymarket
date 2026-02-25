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
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidTimestampError } from '@polymarket/errors';
import Decimal from 'decimal.js';

class Timestamp {
  private constructor(private readonly ms: Decimal) {}

  static fromEpochMs(value: number): Result<Timestamp, InvalidTimestampError> {
    if (!Number.isFinite(value) || Number.isNaN(value)) {
      return Err(
        new InvalidTimestampError(
          'Timestamp must be a finite number',
          {
            code: InvalidTimestampError.code,
            context: { value, reason: 'NOT_FINITE' }
          }
        )
      );
    }

    if (!Number.isInteger(value)) {
      return Err(
        new InvalidTimestampError(
          (ctx) => `Timestamp must be an integer, got ${ctx.value}`,
          {
            code: InvalidTimestampError.code,
            context: { value, reason: 'NOT_INTEGER' }
          }
        )
      );
    }

    if (value < 0) {
      return Err(
        new InvalidTimestampError(
          'Timestamp must be non-negative',
          {
            code: InvalidTimestampError.code,
            context: { value, reason: 'NOT_POSITIVE' }
          }
        )
      );
    }

    const MAX_TIMESTAMP = 9999999999999;
    if (value > MAX_TIMESTAMP) {
      return Err(
        new InvalidTimestampError(
          (ctx) => `Timestamp too large (max: ${ctx.max}), got ${ctx.value}`,
          {
            code: InvalidTimestampError.code,
            context: { value, max: MAX_TIMESTAMP, reason: 'OUT_OF_RANGE' }
          }
        )
      );
    }

    return Ok(new Timestamp(new Decimal(value)));
  }

  toDate(): Date {
    return new Date(this.ms.toNumber());
  }

  toISO(): string {
    return this.toDate().toISOString();
  }
}

// Использование
const result = Timestamp.fromEpochMs(Date.now());

if (result.ok) {
  console.log('Valid timestamp:', result.value.toISO());
} else {
  console.error('Error:', result.error.message);
}
```

### 2. Создание из Date

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidTimestampError } from '@polymarket/errors';

class TimestampService {
  static fromDate(date: Date): Result<Timestamp, InvalidTimestampError> {
    const ms = date.getTime();
    return Timestamp.fromEpochMs(ms);
  }

  static now(): Timestamp {
    const result = Timestamp.fromEpochMs(Date.now());
    if (!result.ok) {
      throw new Error('Failed to create current timestamp');
    }
    return result.value;
  }
}

// Использование
const nowResult = TimestampService.fromDate(new Date());
// Ok(Timestamp)

const futureResult = TimestampService.fromDate(new Date('2030-01-01'));
// Ok(Timestamp)
```

### 3. Quote с временной меткой

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
  const timestampResult = Timestamp.fromEpochMs(timestampMs);

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

### 4. Проверка устаревания (staleness)

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidTimestampError } from '@polymarket/errors';

class TimestampService {
  static isStale(
    timestamp: Timestamp,
    maxAgeMs: number,
    now?: Timestamp
  ): boolean {
    const currentTime = now ?? TimestampService.now();
    const ageMs = currentTime.diffMs(timestamp);
    return ageMs > maxAgeMs;
  }

  static age(
    timestamp: Timestamp,
    now?: Timestamp
  ): number {
    const currentTime = now ?? TimestampService.now();
    return currentTime.diffMs(timestamp);
  }
}

// Использование
const quoteTimestamp = Timestamp.fromEpochMs(Date.now() - 5000);
// 5 секунд назад

if (quoteTimestamp.ok) {
  const isStale = TimestampService.isStale(quoteTimestamp.value, 3000);
  // true (старше 3 секунд)
}
```

---

## Edge Cases

### Граничные значения

```typescript
// Минимальное значение (Unix epoch)
Timestamp.fromEpochMs(0); // ✅ Ok(Timestamp) - 1970-01-01T00:00:00.000Z

// Текущее время
Timestamp.fromEpochMs(Date.now()); // ✅ Ok(Timestamp)

// Будущее время
Timestamp.fromEpochMs(2000000000000); // ✅ Ok(Timestamp)

// Максимальное значение
Timestamp.fromEpochMs(9999999999999); // ✅ Ok(Timestamp)

// Превышение максимума
Timestamp.fromEpochMs(10000000000000); // ❌ Err(OUT_OF_RANGE)
```

### Специальные значения

```typescript
// NaN
Timestamp.fromEpochMs(NaN); // ❌ Err(NOT_FINITE)

// Infinity
Timestamp.fromEpochMs(Infinity); // ❌ Err(NOT_FINITE)
Timestamp.fromEpochMs(-Infinity); // ❌ Err(NOT_FINITE)

// Отрицательное
Timestamp.fromEpochMs(-1); // ❌ Err(NOT_POSITIVE)

// Дробное (не целое)
Timestamp.fromEpochMs(123.456); // ❌ Err(NOT_INTEGER)
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
            code: InvalidTimestampError.code,
            context: { value: iso, reason: 'INVALID_FORMAT' }
          }
        )
      );
    }

    return Timestamp.fromEpochMs(date.getTime());
  }
}

// Использование
Timestamp.fromISO('2024-01-01T00:00:00.000Z'); // ✅ Ok
Timestamp.fromISO('invalid-date'); // ❌ Err(INVALID_FORMAT)
```

---

## Обработка ошибок

### По типу ошибки

```typescript
import { InvalidTimestampError } from '@polymarket/errors';

const result = Timestamp.fromEpochMs(userInput);

if (result.ok) {
  processTimestamp(result.value);
} else {
  if (InvalidTimestampError.is(result.error)) {
    const reason = result.error.context?.reason as string;

    if (reason === 'NOT_INTEGER') {
      showUserMessage('Timestamp must be a whole number');
    } else if (reason === 'NOT_POSITIVE') {
      showUserMessage('Timestamp cannot be negative');
    } else if (reason === 'OUT_OF_RANGE') {
      showUserMessage('Timestamp value is out of range');
    } else if (reason === 'NOT_FINITE') {
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
  const result = Timestamp.fromEpochMs(value);

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
