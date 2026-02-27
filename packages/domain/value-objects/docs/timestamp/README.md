# Timestamp Value Object

**Момент времени** — immutable value object для представления временных меток в epoch milliseconds.

## Обзор

Timestamp хранит момент времени как целое число миллисекунд с Unix epoch (1970-01-01T00:00:00Z).

**Используется для:**
- Временных меток событий (trades, orders, fills)
- Хронологических сравнений (isBefore/isAfter)
- Временной арифметики (addMs, diffMs)
- Blockchain timestamp validation

## Инварианты

Timestamp гарантирует 5 инвариантов:

1. **Not NaN** — не является NaN
2. **Finite** — не является `±Infinity`
3. **Non-negative** — `>= 0` (Unix epoch начинается с 0)
4. **Bounded** — `<= 9999999999999` (~год 2286; значения выше вероятно ошибка — microseconds вместо ms)
5. **Integer** — целое число (дробные миллисекунды не допускаются)

**Важно**: `TimestampService.create()` автоматически truncate-ит дробные значения до integer:
```typescript
TimestampService.create(1609459200000.789); // OK → Timestamp(1609459200000)
```

## Быстрый старт

```typescript
import { TimestampService, TimestampFormatter, TimestampSerializer } from '@polymarket/value-objects';

// Создание
const tsResult = TimestampService.create(1609459200000);
if (tsResult.ok) {
  const ts = tsResult.value;

  // Форматирование
  console.log(TimestampFormatter.toISO(ts));     // "2021-01-01T00:00:00.000Z"
  console.log(TimestampFormatter.toDisplay(ts)); // "2021-01-01 00:00:00 UTC"

  // Сравнение
  const later = TimestampService.create(1609459260000);
  if (later.ok) {
    console.log(ts.isBefore(later.value)); // true
    const diff = TimestampService.diffMs(later.value, ts);
    console.log(diff.toNumber()); // 60000
  }
}

// Текущее время
const now = TimestampService.now();

// Из ISO строки
const fromISO = TimestampService.fromISO('2021-01-01T00:00:00.000Z');
```

## Связанные разделы

- [architecture.md](./architecture.md) — 3-слойная архитектура, truncate дизайн, Decimal vs number, IClock, error reasons
- [facade.md](./facade.md) — полный справочник API: TimestampService, Timestamp (Core), TimestampFormatter, TimestampSerializer
- [examples.md](./examples.md) — практические сценарии: сортировка, TTL, blockchain parsing, тесты с IClock

## См. также

- [Side](../side/README.md) — простой string enum VO
- [Fee](../fee/README.md) — комиссии с asset validation
- [SignedQuantity](../signed-quantity/README.md) — знаковые количества
