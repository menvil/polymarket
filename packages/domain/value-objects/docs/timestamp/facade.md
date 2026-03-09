# Timestamp: Справочник API

Полный справочник публичного API: TimestampService, Timestamp (Core), TimestampFormatter, TimestampSerializer.

## Содержание

- [TimestampService](#timestampservice)
- [Timestamp (Core)](#timestamp-core)
- [TimestampFormatter](#timestampformatter)
- [TimestampSerializer](#timestampserializer)

## TimestampService

**Единая точка входа** для создания и операций. Все фабричные методы возвращают `Result`.

**Контракт "Never Throw":**

- Фабричные методы (`create`, `fromDate`, `fromISO`, `addMs`) → `Result<Timestamp, InvalidTimestampError>`
- Утилитные методы (`now`, `diffMs`, `diffSeconds`) → возвращают значения напрямую (Never Throw)

### Создание

| Метод | Параметры | Возвращает | Описание |
|-------|-----------|------------|----------|
| `create(value)` | `number \| string \| Decimal` | `Result<Timestamp, InvalidTimestampError>` | Парсит и валидирует; дробные значения truncate-ируются |
| `fromDate(date)` | `Date` | `Result<Timestamp, InvalidTimestampError>` | Из JavaScript Date |
| `fromISO(iso)` | `string` | `Result<Timestamp, InvalidTimestampError>` | Из ISO 8601 строки |
| `now(clock?)` | `IClock?` | `Timestamp` | Текущее время; никогда не бросает. При broken IClock: fallback → `Date.now()` → epoch 1ms. Сбои silent — мониторьте IClock отдельно |

```typescript
import { TimestampService } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

// Из number (epoch ms)
const ts1 = TimestampService.create(1609459200000);

// Из string
const ts2 = TimestampService.create('1609459200000');

// Из Decimal
const ts3 = TimestampService.create(new Decimal(1609459200000));

// Из Date объекта
const ts4 = TimestampService.fromDate(new Date('2021-01-01T00:00:00Z'));

// Из ISO строки
const ts5 = TimestampService.fromISO('2021-01-01T00:00:00.000Z');

// Текущее время
const now = TimestampService.now();
```

### IClock dependency injection

```typescript
import { PaperClock } from '@polymarket/time';

// В продакшне
const now = TimestampService.now(); // Date.now()

// В тестах (детерминированное время)
const fixedClock = new PaperClock(new Date('2024-01-01T00:00:00Z'));
const fixedNow = TimestampService.now(fixedClock); // 2024-01-01T00:00:00.000Z
```

### Операции

| Метод | Параметры | Возвращает | Описание |
|-------|-----------|------------|----------|
| `addMs(ts, delta)` | `Timestamp, number \| Decimal` | `Result<Timestamp, InvalidTimestampError>` | Добавить ms (может быть отрицательным) |
| `diffMs(ts1, ts2)` | `Timestamp, Timestamp` | `Decimal` | Разница ts1 - ts2 в ms |
| `diffSeconds(ts1, ts2)` | `Timestamp, Timestamp` | `Decimal` | Разница ts1 - ts2 в секундах |

```typescript
const ts = TimestampService.create(1609459200000);

if (ts.ok) {
  const base = ts.value;

  // Добавить 60 секунд
  const plusMinute = TimestampService.addMs(base, 60000);
  if (plusMinute.ok) {
    console.log(plusMinute.value.toISO()); // "2021-01-01T00:01:00.000Z"
  }

  // Вычесть 1 час (отрицательный delta)
  const minusHour = TimestampService.addMs(base, -3600000);

  // Разница между timestamps
  const later = TimestampService.create(1609459260000);
  if (later.ok) {
    const diffMs = TimestampService.diffMs(later.value, base);
    console.log(diffMs.toNumber()); // 60000

    const diffSeconds = TimestampService.diffSeconds(later.value, base);
    console.log(diffSeconds.toNumber()); // 60
  }
}
```

### Обработка ошибок

```typescript
import { TimestampErrorReason } from '@polymarket/value-objects';

const result = TimestampService.create(value);

if (!result.ok) {
  const { reason } = result.error.context ?? {};

  switch (reason) {
    case TimestampErrorReason.INVALID_FORMAT:
      console.error('Cannot parse value:', result.error.context?.raw);
      break;
    case TimestampErrorReason.NOT_FINITE:
      console.error('Timestamp cannot be NaN or Infinity');
      break;
    case TimestampErrorReason.NOT_POSITIVE:
      console.error('Timestamp must be >= 0');
      break;
    case TimestampErrorReason.OUT_OF_RANGE:
      console.error('Timestamp > 9999999999999 — possible microseconds input?');
      break;
    case TimestampErrorReason.INVALID_ISO:
      console.error('Invalid ISO 8601 string:', result.error.context?.value);
      break;
  }
}
```

## Timestamp (Core)

**Immutable value object.** Не используйте напрямую в публичном коде — для создания используйте `TimestampService`.

### Значение

| Метод | Возвращает | Описание |
|-------|------------|----------|
| `value()` | `Decimal` | Epoch milliseconds как Decimal (для вычислений) |
| `toNumber()` | `number` | Epoch milliseconds как number (⚠️ lossy для очень больших значений) |
| `toDate()` | `Date` | JavaScript Date объект |
| `toISO()` | `string` | ISO 8601 строка в UTC |

### Сравнения

| Метод | Параметр | Возвращает | Описание |
|-------|----------|------------|----------|
| `equals(other)` | `Timestamp` | `boolean` | Строгое равенство |
| `isBefore(other)` | `Timestamp` | `boolean` | `this < other` |
| `isAfter(other)` | `Timestamp` | `boolean` | `this > other` |
| `isBeforeOrEqual(other)` | `Timestamp` | `boolean` | `this <= other` |
| `isAfterOrEqual(other)` | `Timestamp` | `boolean` | `this >= other` |

### Арифметика Core (бросают исключения)

| Метод | Параметр | Возвращает | Описание |
|-------|----------|------------|----------|
| `addMs(delta)` | `Decimal` | `Timestamp` | Добавить ms; delta должен быть integer |
| `diffMs(other)` | `Timestamp` | `Decimal` | `this - other` в ms |
| `diffSeconds(other)` | `Timestamp` | `Decimal` | `this - other` в секундах |

⚠️ Для публичного кода используйте `TimestampService.addMs()` — он возвращает Result.

## TimestampFormatter

**Форматирование для UI и логов.** Все методы возвращают `string` напрямую (не Result).

```typescript
import { TimestampFormatter } from '@polymarket/value-objects';

const ts = TimestampService.create(1705318200000); // 2024-01-15T10:30:00.000Z
if (ts.ok) {
  const t = ts.value;

  TimestampFormatter.toISO(t);       // "2024-01-15T10:30:00.000Z"
  TimestampFormatter.toDisplay(t);   // "2024-01-15 10:30:00 UTC"
  TimestampFormatter.toDate(t);      // "2024-01-15"
  TimestampFormatter.toTime(t);      // "10:30:00"
  TimestampFormatter.toEpochMs(t);   // "1705318200000"
  TimestampFormatter.toLogString(t); // "2024-01-15T10:30:00.000Z (1705318200000)"
  TimestampFormatter.toString(t);    // "Timestamp(1705318200000, 2024-01-15T10:30:00.000Z)"

  // Относительное время (зависит от текущего времени)
  TimestampFormatter.toRelative(t);  // "3 days ago"
}
```

### Таблица методов

| Метод | Результат | Пример |
|-------|-----------|--------|
| `toISO(ts)` | ISO 8601 UTC | `"2024-01-15T10:30:00.000Z"` |
| `toDisplay(ts)` | Readable UTC | `"2024-01-15 10:30:00 UTC"` |
| `toDate(ts)` | Дата | `"2024-01-15"` |
| `toTime(ts)` | Время | `"10:30:00"` |
| `toEpochMs(ts)` | Epoch ms строкой | `"1705318200000"` |
| `toLogString(ts)` | ISO + epoch ms | `"2024-01-15T10:30:00.000Z (1705318200000)"` |
| `toString(ts)` | Debug | `"Timestamp(1705318200000, 2024-01-15T10:30:00.000Z)"` |
| `toRelative(ts, now?)` | Относительное | `"2 minutes ago"`, `"in 5 seconds"` |

### Логика toRelative()

- `< 60s` → `"X seconds ago"` / `"in X seconds"`
- `< 1h` → `"X minutes ago"` / `"in X minutes"`
- `< 24h` → `"X hours ago"` / `"in X hours"`
- `>= 24h` → `"X days ago"` / `"in X days"`

## TimestampSerializer

**JSON сериализация.** Epoch milliseconds сериализуется как `number`.

```typescript
import { TimestampSerializer } from '@polymarket/value-objects';
```

### Таблица методов

| Метод | Параметр | Возвращает | Описание |
|-------|----------|------------|----------|
| `toJSON(ts)` | `Timestamp` | `number` | Epoch ms как number |
| `fromJSON(json)` | `number` | `Result<Timestamp, InvalidTimestampError>` | Десериализация из number |
| `fromUnknown(value)` | `unknown` | `Result<Timestamp, InvalidTimestampError>` | Десериализация из unknown (проверяет typeof) |

```typescript
// Сериализация
const ts = TimestampService.create(1609459200000);
if (ts.ok) {
  const json: number = TimestampSerializer.toJSON(ts.value);
  // json = 1609459200000
}

// Десериализация из number
const result = TimestampSerializer.fromJSON(1609459200000);
if (result.ok) {
  console.log(result.value.toISO()); // "2021-01-01T00:00:00.000Z"
}

// Десериализация из unknown
const rawJson = '{"timestamp": 1609459200000}';
const parsed: unknown = JSON.parse(rawJson);
const safeResult = TimestampSerializer.fromUnknown((parsed as any).timestamp);
if (safeResult.ok) {
  // использовать safeResult.value
}

// Round-trip
const original = TimestampService.create(1609459200000);
if (original.ok) {
  const json = TimestampSerializer.toJSON(original.value);
  const restored = TimestampSerializer.fromJSON(json);
  if (restored.ok) {
    console.log(restored.value.equals(original.value)); // true
  }
}
```
