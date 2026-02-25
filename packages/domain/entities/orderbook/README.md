# @polymarket/orderbook

Orderbook entity для Polymarket trading system с продвинутой нормализацией данных и type-safe error handling.

## Установка

```bash
npm install @polymarket/orderbook
```

## Архитектура

Пакет следует принципам Domain-Driven Design и разделяет ответственность:

### Структура

```
orderbook/
├── core/               # Доменные entity и VO
│   ├── Orderbook.ts    # Главная entity
│   └── OrderbookLevel.ts  # Value Object для уровня
├── normalizer/         # Нормализация сырых данных
│   ├── OrderbookNormalizer.ts
│   ├── NormalizationPolicy.ts
│   └── types.ts        # Raw DTO типы
├── adapters/           # Адаптеры для внешних форматов
│   └── OrderbookSerializer.ts  # JSON serialization
└── errors/
    └── OrderbookInvalidError.ts  # Type-safe errors
```

### Поток данных

```
Raw JSON/API data
    ↓
RawOrderbook (допускает нули, дубликаты, crossed)
    ↓
OrderbookNormalizer (фильтрация, агрегация, валидация)
    ↓
NormalizedOrderbook (валидные данные)
    ↓
Orderbook entity (immutable, type-safe)
```

## Основные возможности

### ✅ Исправленные проблемы оригинала

1. **Branded Types**: `InstrumentId` и `AssetId` вместо string
2. **Раздельные Timestamps**: `venueTimestamp` (от exchange) + `receivedAt` (локально)
3. **Result Pattern**: `getSpread()` → `Result<Spread, OrderbookInvalidError>` вместо `null`
4. **Нет лишних проверок**: Убраны лишние `if (total === 0)` и `throw` в `getTotalVolume()`
5. **Правильный stale detection**: `isStale()` использует `receivedAt` вместо venue timestamp
6. **Нормализатор**: Устранено дублирование парсинга bids/asks
7. **Явные ошибки**: Crossed book → `OrderbookInvalidError` вместо silent `null`

### 🎯 Ключевые фичи

- **Нормализация данных**: Автоматическая обработка сырых данных (фильтрация нулей, агрегация дубликатов, сортировка)
- **Politika-based**: Настраиваемая политика нормализации для разных use cases
- **Type-safe errors**: Discriminated union для ошибок (CROSSED_BOOK, EMPTY_BOOK, ONE_SIDED, STALE_DATA)
- **Immutability**: Все entity frozen для предотвращения мутаций
- **Метрики**: Mid price, microprice, imbalance, spread, depth, latency, age
- **JSON serialization**: Round-trip safe сериализация

## Использование

### Базовый пример

```typescript
import {
  OrderbookSerializer,
  OrderbookNormalizer,
  DEFAULT_NORMALIZATION_POLICY,
  type RawOrderbook,
} from '@polymarket/orderbook';

// Из JSON (через Serializer)
const json = {
  marketId: 'market-123',
  tokenId: 'token-yes',
  bids: [
    { price: 0.52, quantity: 100 },
    { price: 0.51, quantity: 200 },
  ],
  asks: [
    { price: 0.53, quantity: 150 },
    { price: 0.54, quantity: 250 },
  ],
};

const result = OrderbookSerializer.fromJSON(json);

if (result.ok) {
  const orderbook = result.value;

  // Best bid/ask
  const bestBid = orderbook.getBestBid(); // Price(0.52)
  const bestAsk = orderbook.getBestAsk(); // Price(0.53)

  // Spread (Result pattern!)
  const spreadResult = orderbook.getSpread();
  if (spreadResult.ok) {
    console.log(`Spread: ${spreadResult.value.width()}`); // 0.01
  } else {
    // Явная обработка crossed/invalid book
    if (spreadResult.error.isCrossedBook()) {
      console.error('CRITICAL: Crossed book detected!');
    }
  }

  // Метрики
  console.log(`Mid price: ${orderbook.getMidPrice()?.value}`); // 0.525
  console.log(`Microprice: ${orderbook.getMicroprice()?.value}`); // weighted
  console.log(`Imbalance: ${orderbook.getImbalance()}`); // -0.14 (more asks)

  // Время
  console.log(`Age: ${orderbook.getAgeMs()}ms`);
  console.log(`Latency: ${orderbook.getLatencyMs()}ms`); // если есть venueTimestamp
  console.log(`Stale: ${orderbook.isStale(5000)}`); // > 5s old?
}
```

### Работа с Raw данными

```typescript
import { OrderbookNormalizer, Orderbook } from '@polymarket/orderbook';

// Raw данные от exchange (могут быть грязные)
const rawData: RawOrderbook = {
  marketId: 'market-123',
  tokenId: 'token-yes',
  bids: [
    { price: 0.52, quantity: 0 },     // zero qty → будет отфильтрован
    { price: 0.51, quantity: 100 },
    { price: 0.51, quantity: 50 },    // дубликат → будет агрегирован
  ],
  asks: [{ price: 0.53, quantity: 150 }],
  venueTimestamp: '2024-01-15T10:30:00Z', // ISO string
};

// Нормализация с default policy
const normalized = OrderbookNormalizer.normalize(rawData);

if (normalized.ok) {
  const orderbook = Orderbook.fromNormalized(normalized.value);
  console.log(`Bids: ${orderbook.bids.length}`); // 1 (агрегирован + отфильтрован)
}
```

### Политики нормализации

```typescript
import {
  DEFAULT_NORMALIZATION_POLICY,
  PERMISSIVE_NORMALIZATION_POLICY,
  TOP_OF_BOOK_POLICY,
  OrderbookNormalizer,
} from '@polymarket/orderbook';

// Conservative policy (для production trading)
const result1 = OrderbookNormalizer.normalize(rawData, DEFAULT_NORMALIZATION_POLICY);
// - Фильтрует нули
// - Агрегирует дубликаты
// - НЕ допускает crossed book
// - Без ограничения уровней

// Permissive policy (для анализа/тестов)
const result2 = OrderbookNormalizer.normalize(rawData, PERMISSIVE_NORMALIZATION_POLICY);
// - Оставляет всё как есть
// - Допускает crossed book

// Top-of-Book policy (только лучшие bid/ask)
const result3 = OrderbookNormalizer.normalize(rawData, TOP_OF_BOOK_POLICY);
// - Только 1 уровень на сторону
// - Агрегация и фильтрация включены

// Custom policy
const customPolicy = {
  dropZeroQty: true,
  aggregateSamePrice: true,
  allowCrossed: false,
  maxLevelsPerSide: 10, // топ 10 уровней
};
const result4 = OrderbookNormalizer.normalize(rawData, customPolicy);
```

### Обработка ошибок

```typescript
import {
  OrderbookInvalidError,
  OrderbookInvalidReason,
} from '@polymarket/orderbook';

const spreadResult = orderbook.getSpread();

if (!spreadResult.ok) {
  const error = spreadResult.error;

  // Type guard
  if (OrderbookInvalidError.isOrderbookInvalidError(error)) {
    switch (error.getReason()) {
      case OrderbookInvalidReason.CROSSED_BOOK:
        console.error('Crossed book - trading dangerous!');
        break;
      case OrderbookInvalidReason.EMPTY_BOOK:
        console.warn('No liquidity available');
        break;
      case OrderbookInvalidReason.ONE_SIDED:
        console.warn('Only bids or asks present');
        break;
      case OrderbookInvalidReason.STALE_DATA:
        console.warn('Data too old');
        break;
    }

    // Helper methods
    if (error.isCrossedBook()) {
      // Critical error handling
    }
  }
}
```

### Метрики и анализ

```typescript
// Volume
const totalBidVolume = orderbook.getTotalBidVolume(); // все уровни
const top5BidVolume = orderbook.getTotalBidVolume(5); // топ 5

// Imbalance (дисбаланс bid/ask)
const imbalance = orderbook.getImbalance(5); // топ 5 уровней
if (imbalance > 0.3) {
  console.log('Strong buying pressure');
} else if (imbalance < -0.3) {
  console.log('Strong selling pressure');
}

// Depth
console.log(`Bid depth: ${orderbook.getBidDepth()} levels`);
console.log(`Ask depth: ${orderbook.getAskDepth()} levels`);

// Status
console.log(`Empty: ${orderbook.isEmpty()}`);
console.log(`Has liquidity: ${orderbook.hasLiquidity()}`);

// Время
console.log(`Age: ${orderbook.getAgeMs()}ms`); // от receivedAt
console.log(`Latency: ${orderbook.getLatencyMs()}ms`); // receivedAt - venueTimestamp
console.log(`Stale: ${orderbook.isStale(5000)}`); // старше 5 секунд?
```

### Serialization

```typescript
import { OrderbookSerializer } from '@polymarket/orderbook';

// Serialize
const json = OrderbookSerializer.toJSON(orderbook);
const jsonString = OrderbookSerializer.stringify(orderbook, true); // pretty

// Deserialize
const result1 = OrderbookSerializer.fromJSON(json);
const result2 = OrderbookSerializer.parse(jsonString);

// Round-trip safe
const restored = OrderbookSerializer.fromJSON(
  OrderbookSerializer.toJSON(orderbook)
);
```

### Summary view

```typescript
const summary = orderbook.toObject();

console.log(summary);
/*
{
  instrumentId: 'market-123',
  asset: 'token-yes',
  venueTimestamp: 1705318199000,
  receivedAt: 1705318200000,
  bestBid: 0.52,
  bestAsk: 0.53,
  midPrice: 0.525,
  microprice: 0.524,
  spreadWidth: 0.01,
  spreadStatus: 'ok', // или OrderbookInvalidReason
  bidDepth: 2,
  askDepth: 2,
  totalBidVolume: 300,
  totalAskVolume: 400,
  imbalance: -0.14,
  ageMs: 1523,
  latencyMs: 1000,
}
*/
```

## Почему раздельные timestamps?

### Проблема с одним timestamp

```typescript
// Плохо: один timestamp (оригинал)
timestamp: Date // какое время? venue? local? непонятно!
isStale() { return Date.now() - this.timestamp.getTime() > maxAge; }
// Проблемы:
// - Venue часы могут быть рассинхронизированы
// - Latency не учтена
// - Нельзя различить venue lag vs network lag
```

### Решение: два timestamps

```typescript
// Хорошо: раздельные timestamps (рефакторинг)
venueTimestamp?: number // когда exchange сгенерировал данные
receivedAt: number      // когда мы получили данные (локально)

// Age = насколько устарели наши данные
getAgeMs() { return Date.now() - this.receivedAt; }

// Latency = сколько заняла доставка
getLatencyMs() { return this.receivedAt - this.venueTimestamp; }

// Stale detection по локальному времени (правильно)
isStale(maxAge) { return this.getAgeMs() > maxAge; }
```

**Преимущества:**
- Stale detection не зависит от venue часов
- Можно измерить latency
- Можно детектировать clock skew
- Явное разделение "когда создано" vs "когда получено"

## Почему Result вместо null?

### Проблема с null

```typescript
// Плохо: silent null (оригинал)
getSpread(): Spread | null {
  const spread = Spread.create(bid, ask);
  if (!spread.ok) {
    return null; // ТИХО прячем факт что стакан сломан!
  }
  return spread.value;
}

// Использование
const spread = orderbook.getSpread();
if (!spread) {
  // Почему null? Empty book? Crossed book? Непонятно!
  console.log('No spread'); // теряем критичную информацию
}
```

### Решение: Result с typed errors

```typescript
// Хорошо: Result pattern (рефакторинг)
getSpread(): Result<Spread, OrderbookInvalidError> {
  // Явные ошибки для каждого случая
  if (!bid && !ask) {
    return Err(new OrderbookInvalidError('Empty book', {
      context: { reason: OrderbookInvalidReason.EMPTY_BOOK }
    }));
  }
  if (!bid || !ask) {
    return Err(new OrderbookInvalidError('One-sided', {
      context: { reason: OrderbookInvalidReason.ONE_SIDED }
    }));
  }
  // Crossed book detected!
  if (bid >= ask) {
    return Err(new OrderbookInvalidError('Crossed book', {
      context: { reason: OrderbookInvalidReason.CROSSED_BOOK }
    }));
  }
  return Ok(spread);
}

// Использование
const result = orderbook.getSpread();
if (!result.ok) {
  // Явно знаем причину ошибки
  if (result.error.isCrossedBook()) {
    alertCritical('CROSSED BOOK DETECTED'); // торговать опасно!
  }
}
```

**Преимущества:**
- Явный сигнал о проблемах
- Type-safe error handling
- Нет потери информации
- Компилятор форсит обработку ошибок

## API Reference

### Orderbook

Главная entity для стакана заявок.

**Методы:**

- `fromNormalized(normalized)` - создать из нормализованных данных
- `empty(instrumentId, asset)` - создать пустой orderbook
- `getBestBid()` - лучший bid price
- `getBestAsk()` - лучший ask price
- `getSpread()` - **Result<Spread, Error>** (не null!)
- `getMidPrice()` - средняя цена
- `getMicroprice()` - взвешенная цена
- `getTotalBidVolume(levels?)` - общий объём бидов
- `getTotalAskVolume(levels?)` - общий объём асков
- `getImbalance(levels)` - дисбаланс bid/ask
- `isEmpty()` - пуст ли стакан
- `hasLiquidity()` - есть ли bid и ask
- `getBidDepth()` - количество bid уровней
- `getAskDepth()` - количество ask уровней
- `getAgeMs()` - возраст от receivedAt
- `getLatencyMs()` - latency (receivedAt - venueTimestamp)
- `isStale(maxAgeMs)` - устарел ли стакан
- `toString()` - строковое представление
- `toObject()` - summary view с метриками

### OrderbookLevel

Value Object для одного уровня стакана.

**Методы:**

- `create(price, quantity)` - создать level
- `isEmpty()` - quantity = 0?
- `withQuantity(newQuantity)` - immutable update
- `equals(other)` - сравнение
- `toString()` - строковое представление
- `toObject()` - serialization

### OrderbookNormalizer

Статический класс для нормализации raw данных.

**Методы:**

- `normalize(raw, policy?)` - нормализовать raw orderbook

### OrderbookSerializer

Адаптер для JSON serialization.

**Методы:**

- `fromJSON(json, policy?)` - deserialize
- `toJSON(orderbook)` - serialize
- `stringify(orderbook, pretty?)` - to JSON string
- `parse(jsonString, policy?)` - from JSON string

### OrderbookInvalidError

Type-safe ошибка для invalid orderbook.

**Методы:**

- `getReason()` - получить OrderbookInvalidReason
- `isCrossedBook()` - crossed book?
- `isStaleData()` - stale data?

## Best Practices

### 1. Всегда используй Normalizer

```typescript
// ✅ Хорошо
const normalized = OrderbookNormalizer.normalize(rawData);
if (normalized.ok) {
  const orderbook = Orderbook.fromNormalized(normalized.value);
}

// ❌ Плохо - ручной парсинг
const orderbook = new Orderbook(...); // private constructor
```

### 2. Обрабатывай ошибки spread

```typescript
// ✅ Хорошо
const spreadResult = orderbook.getSpread();
if (spreadResult.ok) {
  const spread = spreadResult.value;
} else {
  handleInvalidOrderbook(spreadResult.error);
}

// ❌ Плохо - игнорируем ошибки
const spread = orderbook.getSpread();
// Нельзя получить value без проверки ok!
```

### 3. Используй правильную политику

```typescript
// Production trading - strict policy
const prodResult = OrderbookNormalizer.normalize(data, DEFAULT_NORMALIZATION_POLICY);

// Analysis/backtesting - permissive policy
const testResult = OrderbookNormalizer.normalize(data, PERMISSIVE_NORMALIZATION_POLICY);

// Real-time quotes - top-of-book only
const quoteResult = OrderbookNormalizer.normalize(data, TOP_OF_BOOK_POLICY);
```

### 4. Проверяй stale данные

```typescript
if (orderbook.isStale(5000)) {
  console.warn('Orderbook stale, refreshing...');
  await refreshOrderbook();
}

// Мониторинг latency
const latency = orderbook.getLatencyMs();
if (latency && latency > 1000) {
  console.warn(`High latency: ${latency}ms`);
}
```

### 5. Используй summary для логирования

```typescript
// Вместо логирования всего orderbook
console.log(orderbook.toObject()); // compact summary

// А не
console.log(orderbook); // огромный объект с всеми уровнями
```

## Зависимости

- `@polymarket/result` - Result pattern
- `@polymarket/errors` - Error types
- `@polymarket/ids` - Branded ID types
- `@polymarket/value-objects` - Price, Quantity, Spread VOs

## License

MIT
