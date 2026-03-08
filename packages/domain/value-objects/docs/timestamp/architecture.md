# Timestamp: Архитектура и Дизайн

Детальная документация архитектурных решений Timestamp Value Object.

## Содержание

- [Обзор архитектуры](#обзор-архитектуры)
- [Слои системы](#слои-системы)
- [Ключевые решения](#ключевые-решения)
- [Error Reasons](#error-reasons)

## Обзор архитектуры

Timestamp следует **3-слойной архитектуре** Value Objects в `@polymarket/value-objects`:

```
┌─────────────────────────────────────────┐
│         Public API (Facade)             │  Result<T, E>
│         TimestampService                │  Never throws
├─────────────────────────────────────────┤
│              Core                       │  Throws on invariant violation
│           Timestamp                     │  Business logic, invariants
├─────────────────────────────────────────┤
│            Adapters                     │  I/O, formatting, serialization
│  TimestampFormatter, TimestampSerializer│
└─────────────────────────────────────────┘
```

## Слои системы

```
timestamp/
├── core/
│   ├── Timestamp.ts                    # Value object, инварианты, арифметика
│   └── TimestampInvariantViolation.ts  # Внутреннее исключение нарушения инварианта
├── errors/
│   └── TimestampErrorReason.ts         # Типизированные причины ошибок (enum)
├── facade/
│   └── TimestampService.ts             # Публичный API, Result-based
└── adapters/
    ├── TimestampSerializer.ts          # JSON: number (epoch ms)
    └── TimestampFormatter.ts           # UI: ISO, display, relative
```

## Ключевые решения

### Truncate в Facade, не в Core

`TimestampService.create()` делает `decimal.trunc()` перед передачей в Core:

```
create(1609459200000.789)
  → toDecimal: Decimal(1609459200000.789)
  → trunc():   Decimal(1609459200000)
  → Timestamp.of(Decimal(1609459200000))  ← Core видит только integer
  → OK(Timestamp)
```

**Почему:** Это обеспечивает удобство для внешнего API (truncate без ошибки) при сохранении строгости Core.
`Timestamp.of(new Decimal(1000.5))` (Core, напрямую) → `NOT_INTEGER`.

### Почему Decimal, а не number?

| Аспект | `number` | `Decimal` |
|--------|---------|-----------|
| Точность | Теряет точность для > 2^53 | Точная арифметика |
| Согласованность | — | Все VOs используют Decimal |
| Арифметика | Ручная работа | `addDecimal`, `subtractDecimal`, `divideDecimal` из `@polymarket/math` |

### Почему integer milliseconds, а не Date?

| Аспект | `Date` | `Timestamp` |
|--------|--------|-------------|
| Точность | `number` (float) | `Decimal` (exact integer) |
| Иммутабельность | Mutable | Immutable |
| Инварианты | Не проверяются | `finite`, `>= 0`, `<= MAX`, `integer` |
| Сериализация | ISO string / number | `number` (epoch ms) |
| Арифметика | Ручная работа | `addMs`, `diffMs`, `diffSeconds` |

### IClock: Never Throw в TimestampService.now()

```typescript
// TimestampService.now() — никогда не бросает
public static now(clock?: IClock): Timestamp {
  try {
    return Timestamp.now(clock); // Core может бросить при невалидном clock
  } catch {
    return Timestamp.of(new Decimal(Date.now())); // Fallback
  }
}
```

Это гарантирует Never Throw Contract даже при buggy реализации IClock.

### Паттерн Throws+Facade

```
Core (Timestamp.of / Timestamp.addMs)
  → бросает TimestampInvariantViolation

Facade (TimestampService.create / .addMs)
  → ловит и возвращает Result<Timestamp, InvalidTimestampError>
```

```typescript
// ❌ НЕ используй Core напрямую в публичном коде
const ts = Timestamp.of(new Decimal(value)); // может бросить!

// ✅ Используй Facade
const result = TimestampService.create(value);
if (result.ok) {
  // работай с result.value
}
```

## Error Reasons

```typescript
import { TimestampErrorReason } from '@polymarket/value-objects';

enum TimestampErrorReason {
  INVALID_FORMAT = 'INVALID_FORMAT',  // Не удалось распарсить значение
  NOT_FINITE     = 'NOT_FINITE',      // NaN или ±Infinity
  NOT_POSITIVE   = 'NOT_POSITIVE',    // < 0 (Unix timestamp не может быть отрицательным)
  NOT_INTEGER    = 'NOT_INTEGER',     // Дробное число (не integer milliseconds)
  OUT_OF_RANGE   = 'OUT_OF_RANGE',   // > 9999999999999 (~год 2286)
  INVALID_ISO    = 'INVALID_ISO',     // Невалидная ISO 8601 строка
}
```

### Типичные ошибки и причины

| Входное значение | Ошибка | Причина |
|-----------------|--------|---------|
| `NaN` | NOT_FINITE | NaN не допускается |
| `Infinity` | NOT_FINITE | Infinity не допускается |
| `-1` | NOT_POSITIVE | Unix timestamp не может быть < 0 |
| `10000000000000` | OUT_OF_RANGE | > MAX (~год 2286); вероятно microseconds |
| `"abc"` | INVALID_FORMAT | Не парсится как число |
| `"not-iso"` | INVALID_ISO | fromISO с невалидной строкой |
| `"string"` в fromUnknown | INVALID_FORMAT | fromUnknown ожидает number, не string |

**Замечание**: `TimestampService.create(1000.5)` → `OK` (truncate до 1000, не ошибка).
`Timestamp.of(new Decimal(1000.5))` (Core, напрямую) → `NOT_INTEGER`.
