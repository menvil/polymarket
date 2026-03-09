# Timestamp: Примеры использования

Практические сценарии применения Timestamp Value Object.

## Содержание

- [Создание Timestamp](#создание-timestamp)
- [Хронологическая сортировка](#хронологическая-сортировка)
- [Проверка TTL](#проверка-ttl)
- [Парсинг blockchain timestamp](#парсинг-blockchain-timestamp)
- [Детерминированные тесты с IClock](#детерминированные-тесты-с-iclock)
- [Форматирование для UI](#форматирование-для-ui)
- [Обработка ошибок](#обработка-ошибок)

## Создание Timestamp

```typescript
import { TimestampService } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

// Из number (epoch ms)
const ts1 = TimestampService.create(1609459200000);
if (ts1.ok) {
  console.log(ts1.value.toISO());    // "2021-01-01T00:00:00.000Z"
  console.log(ts1.value.toNumber()); // 1609459200000
}

// Из ISO строки
const ts2 = TimestampService.fromISO('2021-01-01T00:00:00.000Z');

// Из Date объекта
const ts3 = TimestampService.fromDate(new Date('2021-01-01T00:00:00Z'));

// Текущее время
const now = TimestampService.now();
console.log(now.toISO()); // текущее ISO время
```

## Хронологическая сортировка

```typescript
import { TimestampService } from '@polymarket/value-objects';

const events = [
  { id: 'a', ts: TimestampService.create(3000) },
  { id: 'b', ts: TimestampService.create(1000) },
  { id: 'c', ts: TimestampService.create(2000) },
].filter(e => e.ts.ok).map(e => ({ id: e.id, ts: e.ts.value }));

events.sort((a, b) => {
  if (a.ts.isBefore(b.ts)) return -1;
  if (a.ts.isAfter(b.ts)) return 1;
  return 0;
});

console.log(events.map(e => e.id)); // ['b', 'c', 'a']
```

## Проверка TTL

```typescript
import { TimestampService } from '@polymarket/value-objects';
import type { Timestamp } from '@polymarket/value-objects';

function isExpired(createdAt: Timestamp, ttlMs: number): boolean {
  const now = TimestampService.now();
  const diffMs = TimestampService.diffMs(now, createdAt);
  return diffMs.toNumber() > ttlMs;
}

// Создан 60 секунд назад
const created = TimestampService.create(Date.now() - 60000);
if (created.ok) {
  console.log(isExpired(created.value, 30000));  // true  (TTL 30s истёк)
  console.log(isExpired(created.value, 120000)); // false (TTL 120s ещё не истёк)
}
```

### Order expiry

```typescript
function checkOrderExpiry(order: { createdAt: Timestamp; expiresAfterMs: number }): void {
  const expiresAt = TimestampService.addMs(order.createdAt, order.expiresAfterMs);
  if (!expiresAt.ok) return;

  const now = TimestampService.now();
  if (now.isAfter(expiresAt.value)) {
    console.log('Order expired at:', expiresAt.value.toISO());
  } else {
    const remaining = TimestampService.diffMs(expiresAt.value, now);
    console.log(`Order expires in ${remaining.toNumber()} ms`);
  }
}
```

## Парсинг blockchain timestamp

```typescript
import { TimestampService, TimestampErrorReason } from '@polymarket/value-objects';

// Blockchain отдаёт timestamp в секундах — конвертируем в ms
const blockTimestampSec = 1609459200; // Unix seconds
const tsResult = TimestampService.create(blockTimestampSec * 1000);

if (tsResult.ok) {
  console.log(tsResult.value.toISO()); // "2021-01-01T00:00:00.000Z"
}

// ⚠️ ОСТОРОЖНО: timestamp в microseconds попадёт в OUT_OF_RANGE
const microTs = 1609459200000000; // microseconds (слишком большое)
const errorResult = TimestampService.create(microTs);
if (!errorResult.ok) {
  console.error(errorResult.error.context?.reason); // "OUT_OF_RANGE"
  // Подсказка: возможно это microseconds — делим на 1000
  // Сначала проверяем что значение кратно 1000 (признак microseconds)
  if (microTs % 1000 === 0) {
    const candidateMs = microTs / 1000;
    const fixedResult = TimestampService.create(candidateMs);
    if (fixedResult.ok) {
      console.log('Converted microseconds to ms:', fixedResult.value.toISO());
    }
  }
}
```

## Детерминированные тесты с IClock

```typescript
import { TimestampService } from '@polymarket/value-objects';
import { PaperClock } from '@polymarket/time';

describe('Order expiry', () => {
  it('should detect expired order', () => {
    const fixedDate = new Date('2024-01-15T10:00:00Z');
    const clock = new PaperClock(fixedDate);

    // Все вызовы TimestampService.now() вернут 2024-01-15T10:00:00Z
    const createdAt = TimestampService.now(clock);

    // "Прошло" 2 часа
    clock.tick(2 * 3600 * 1000); // продвинуть время вперёд на 2 часа

    const now = TimestampService.now(clock);
    const diffMs = TimestampService.diffMs(now, createdAt);
    console.log(diffMs.toNumber()); // 7200000 (детерминировано)
  });
});
```

## Форматирование для UI

```typescript
import { TimestampService, TimestampFormatter } from '@polymarket/value-objects';

const tsResult = TimestampService.create(1705318200000); // 2024-01-15T10:30:00.000Z
if (tsResult.ok) {
  const ts = tsResult.value;

  // Для отображения в UI
  console.log(TimestampFormatter.toDisplay(ts));   // "2024-01-15 10:30:00 UTC"
  console.log(TimestampFormatter.toISO(ts));       // "2024-01-15T10:30:00.000Z"
  console.log(TimestampFormatter.toDate(ts));      // "2024-01-15"
  console.log(TimestampFormatter.toTime(ts));      // "10:30:00"

  // Для логов
  console.log(TimestampFormatter.toLogString(ts)); // "2024-01-15T10:30:00.000Z (1705318200000)"

  // Относительное время
  console.log(TimestampFormatter.toRelative(ts));  // "3 days ago" (зависит от текущего времени)
}
```

## Обработка ошибок

```typescript
import { TimestampService, TimestampErrorReason } from '@polymarket/value-objects';
import type { Timestamp } from '@polymarket/value-objects';

function parseTimestamp(raw: unknown): Timestamp | null {
  if (typeof raw !== 'number') {
    console.error('Expected number for timestamp, got:', typeof raw);
    return null;
  }

  const result = TimestampService.create(raw);
  if (!result.ok) {
    const reason = result.error.context?.reason;
    switch (reason) {
      case TimestampErrorReason.OUT_OF_RANGE:
        // Возможно microseconds — проверяем кратность 1000 и делим
        if (raw % 1000 === 0) {
          const fixAttempt = TimestampService.create(raw / 1000);
          if (fixAttempt.ok) {
            console.warn('Timestamp appears to be in microseconds, converted to ms');
            return fixAttempt.value;
          }
        }
        break;
      case TimestampErrorReason.NOT_POSITIVE:
        console.error('Negative timestamp received:', raw);
        break;
      default:
        console.error('Invalid timestamp:', result.error.message);
    }
    return null;
  }

  return result.value;
}
```

### Парсинг из API response

```typescript
import { TimestampSerializer } from '@polymarket/value-objects';

interface ApiTrade {
  id: string;
  timestamp: unknown;
}

function parseTrade(raw: ApiTrade) {
  const tsResult = TimestampSerializer.fromUnknown(raw.timestamp);
  if (!tsResult.ok) {
    throw new Error(`Invalid trade timestamp: ${tsResult.error.message}`);
  }

  return {
    id: raw.id,
    timestamp: tsResult.value,
  };
}
```
