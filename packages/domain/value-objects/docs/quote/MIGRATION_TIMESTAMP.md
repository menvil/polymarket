# Миграция Quote на Timestamp VO

## Обзор

В версии 0.2.0 Quote мигрировал с использования `Decimal` для временных меток на использование `Timestamp` Value Object. Это обеспечивает:

- **Строгую типизацию** - временные метки теперь имеют собственный тип
- **Централизованную валидацию** - все проверки timestamp делегируются Timestamp VO
- **Единообразный API** - методы сравнения и вычисления через Timestamp
- **Форматирование** - встроенная поддержка различных форматов вывода

## Breaking Changes

### 1. Quote.of() signature

**Было:**
```typescript
Quote.of(
  bid: Price | null,
  ask: Price | null,
  bidSize: Quantity,
  askSize: Quantity,
  timestampMs: Decimal,  // ❌
  sourceId: MarketDataSourceId,
  instrumentId: InstrumentId
)
```

**Стало:**
```typescript
Quote.of(
  bid: Price | null,
  ask: Price | null,
  bidSize: Quantity,
  askSize: Quantity,
  timestamp: Timestamp,  // ✅
  sourceId: MarketDataSourceId,
  instrumentId: InstrumentId
)
```

### 2. Новый метод timestamp()

**Добавлен:**
```typescript
quote.timestamp(): Timestamp  // Возвращает Timestamp VO
```

**Существующие методы сохранены:**
```typescript
quote.timestampMs(): Decimal  // Возвращает Unix ms как Decimal
quote.getTimestamp(): Date    // Возвращает Date объект
```

### 3. Метод age() signature

**Было:**
```typescript
quote.age(nowMs: Decimal): Decimal
```

**Стало:**
```typescript
quote.age(now?: Timestamp): Decimal  // Timestamp.now() по умолчанию
```

## Миграционный гайд

### Если вы используете QuoteService

**НЕ ТРЕБУЕТСЯ ИЗМЕНЕНИЙ** - QuoteService автоматически конвертирует Decimal/number в Timestamp:

```typescript
// ✅ Работает как раньше
const result = QuoteService.create(
  0.48, 0.52, 100, 150,
  'POLYMARKET_WS',
  'TEST_MARKET',
  Date.now()  // Автоматически конвертируется в Timestamp
);
```

### Если вы используете Quote.of() напрямую

**ТРЕБУЕТСЯ ИЗМЕНЕНИЕ** - конвертируйте Decimal в Timestamp:

**Было:**
```typescript
import Decimal from 'decimal.js';

const quote = Quote.of(
  bid,
  ask,
  bidSize,
  askSize,
  new Decimal(Date.now()),  // ❌
  sourceId,
  instrumentId
);
```

**Стало:**
```typescript
import { TimestampService } from '@polymarket/value-objects/timestamp';

const tsResult = TimestampService.fromEpochMs(Date.now());
if (!tsResult.ok) {
  // Обработка ошибки
  return;
}

const quote = Quote.of(
  bid,
  ask,
  bidSize,
  askSize,
  tsResult.value,  // ✅
  sourceId,
  instrumentId
);
```

### Если вы используете age()

**Было:**
```typescript
const ageMs = quote.age(new Decimal(Date.now()));
```

**Стало:**
```typescript
// Вариант 1: Использовать Timestamp.now() по умолчанию
const ageMs = quote.age();

// Вариант 2: Передать конкретный Timestamp
import { Timestamp } from '@polymarket/value-objects/timestamp';
const now = Timestamp.now();
const ageMs = quote.age(now);
```

### Если вы работаете с timestamp напрямую

**Было:**
```typescript
const tsMs: Decimal = quote.timestampMs();
const date = new Date(tsMs.toNumber());
```

**Стало (рекомендуется):**
```typescript
// Получить Timestamp VO
const ts: Timestamp = quote.timestamp();

// Использовать методы Timestamp
const date = ts.toDate();
const iso = ts.toISO();
const formatted = TimestampFormatter.toDisplay(ts);
```

**Стало (альтернативно):**
```typescript
// Старый способ тоже работает
const tsMs: Decimal = quote.timestampMs();
const date = new Date(tsMs.toNumber());
```

## Примеры миграции

### Тестовый код

**Было:**
```typescript
import Decimal from 'decimal.js';

const quote = Quote.of(
  Price.of(0.48),
  Price.of(0.52),
  Quantity.of(100),
  Quantity.of(150),
  new Decimal(1234567890000),
  'POLYMARKET_WS' as MarketDataSourceId,
  'TEST_MARKET' as InstrumentId
);
```

**Стало:**
```typescript
import { TimestampService } from '../../../src/timestamp/index.js';
import type { Timestamp } from '../../../src/timestamp/index.js';

function createTestTimestamp(ms?: number): Timestamp {
  const result = TimestampService.fromEpochMs(ms ?? Date.now());
  if (!result.ok) {
    throw new Error(`Failed to create test timestamp: ${result.error.message}`);
  }
  return result.value;
}

const quote = Quote.of(
  Price.of(0.48),
  Price.of(0.52),
  Quantity.of(100),
  Quantity.of(150),
  createTestTimestamp(1234567890000),
  'POLYMARKET_WS' as MarketDataSourceId,
  'TEST_MARKET' as InstrumentId
);
```

### Проверка устаревания котировки

**Было:**
```typescript
const now = new Decimal(Date.now());
const age = quote.age(now);

if (age.greaterThan(5000)) {
  console.log('Quote is stale');
}
```

**Стало:**
```typescript
// Используем встроенный Timestamp.now()
const age = quote.age();

if (age.greaterThan(5000)) {
  console.log('Quote is stale');
}

// Или с конкретным временем
const now = Timestamp.now();
const age2 = quote.age(now);
```

## Преимущества миграции

### 1. Типобезопасность

```typescript
// ❌ Было: Decimal может быть любым числом
const timestamp = new Decimal(999999999999999); // Валидный Decimal, невалидный timestamp

// ✅ Стало: Timestamp гарантирует валидность
const result = TimestampService.fromEpochMs(999999999999999);
// result.ok === false (слишком большое значение)
```

### 2. Богатый API

```typescript
const ts = quote.timestamp();

// Форматирование
ts.toISO();                    // "2024-01-15T10:30:00.000Z"
ts.toDate();                   // Date объект

// Сравнение
ts.equals(other);              // Точное сравнение
ts.isAfter(other);             // ts > other
ts.isBefore(other);            // ts < other

// Арифметика
const diff = ts.diffMs(other);       // Разница в ms
const diffSec = ts.diffSeconds(other); // Разница в секундах
```

### 3. Единообразие

Все Value Objects (Price, Quantity, Timestamp) теперь следуют одному паттерну:

```typescript
// Создание через Service
const priceResult = PriceService.create(0.48);
const qtyResult = QuantityService.create(100);
const tsResult = TimestampService.fromEpochMs(Date.now());

// Core объект с методами
const price: Price = priceResult.value;
const qty: Quantity = qtyResult.value;
const ts: Timestamp = tsResult.value;
```

## FAQ

### Q: Нужно ли мне обновлять код, если я использую только QuoteService?

**A:** Нет, QuoteService автоматически обрабатывает конвертацию. Все публичные API остались прежними.

### Q: Как получить Decimal timestamp из Quote?

**A:** Используйте `quote.timestampMs()` - метод остался без изменений.

### Q: Что делать, если у меня уже есть Decimal timestamp?

**A:** Конвертируйте через TimestampService:
```typescript
const decimal: Decimal = new Decimal(Date.now());
const result = TimestampService.fromEpochMs(decimal.toNumber());
```

### Q: Изменилась ли JSON сериализация?

**A:** Нет, формат JSON остался прежним:
```json
{
  "bid": 0.48,
  "ask": 0.52,
  "bidSize": 100,
  "askSize": 150,
  "timestamp": 1234567890000
}
```

### Q: Нужно ли обновлять тесты?

**A:** Да, если тесты используют Quote.of() напрямую. Создайте helper функцию `createTestTimestamp()` (см. примеры выше).

## См. также

- [Timestamp VO Documentation](../timestamp/README.md)
- [Quote Architecture](./architecture.md)
- [Quote API Reference](./README.md)
