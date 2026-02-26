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
import { TimestampService } from '@polymarket/value-objects/timestamp';

// TimestampService.create() автоматически truncate дробные значения
const result = TimestampService.create(1609459200000.789);

if (!result.ok) {
  console.error(result.error.message);
  // Обработка InvalidTimestampError
  return;
}

const timestamp = result.value;
console.log(timestamp.toISO()); // "2021-01-01T00:00:00.000Z"
```

### 2. Обработка невалидных значений

```typescript
import { TimestampService } from '@polymarket/value-objects/timestamp';

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

### 3. Пример с устаревшим API (НЕ ИСПОЛЬЗУЙТЕ)

```typescript
// ❌ НЕПРАВИЛЬНО - этот API не существует
// static fromEpochMs(value: number): Result<Timestamp, InvalidTimestampError> {
//   if (!Number.isFinite(value) || Number.isNaN(value)) {
//     return Err(
//       new InvalidTimestampError(
//         'Timestamp must be finite',
//         {
//           code: InvalidTimestampError.code,
//           context: { value, reason: 'INVALID_FORMAT' }
//         }
//       )
//     );
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
const result = TimestampService.create(Date.now());

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
    return TimestampService.create(ms);
  }

  static now(): Timestamp {
    const result = TimestampService.create(Date.now());
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
const quoteTimestamp = TimestampService.create(Date.now() - 5000);
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
TimestampService.create(NaN); // ❌ Err(NOT_FINITE)

// Infinity
TimestampService.create(Infinity); // ❌ Err(NOT_FINITE)
TimestampService.create(-Infinity); // ❌ Err(NOT_FINITE)

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
            code: InvalidTimestampError.code,
            context: { value: iso, reason: 'INVALID_FORMAT' }
          }
        )
      );
    }

    return TimestampService.create(date.getTime());
  }
}

// Использование
TimestampService.fromISO('2024-01-01T00:00:00.000Z'); // ✅ Ok
TimestampService.fromISO('invalid-date'); // ❌ Err(INVALID_FORMAT)
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
