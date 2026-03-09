# @polymarket/orderbook

Доменная entity стакана заявок для Polymarket. Иммутабельная, type-safe, с VO-валидацией через `PriceService` и `QuantityService`.

## Структура пакета

```
orderbook/
├── core/
│   ├── Orderbook.ts           # Доменная entity (иммутабельная)
│   └── OrderbookLevel.ts      # Value Object уровня (price + quantity)
├── normalizer/
│   ├── OrderbookNormalizer.ts # Нормализация и валидация сырых данных
│   ├── NormalizationPolicy.ts # Политики нормализации
│   └── types.ts               # RawOrderbook, RawLevel
└── adapters/
    ├── PolymarketBookEventParser.ts  # Парсер Polymarket WebSocket "book" событий
    └── OrderbookSerializer.ts        # JSON сериализация/десериализация
```

## Поток данных

```
Polymarket WebSocket "book" событие
    ↓
PolymarketBookEventParser.parse()
    ↓
RawOrderbook { marketId, tokenId, bids: [{price, quantity}], venueTimestamp }
    ↓
OrderbookNormalizer.normalize(raw, policy)
    ↓  фильтрация нулей, агрегация дубликатов, сортировка, crossed book check
NormalizedOrderbook (все инварианты соблюдены)
    ↓
Orderbook.fromNormalized()
    ↓
Orderbook entity (иммутабельная, frozen)
```

## Использование

### Из Polymarket WebSocket

Основной путь — Polymarket CLOB WebSocket присылает полный снапшот стакана:

```typescript
import { PolymarketBookEventParser, type PolymarketBookEvent } from '@polymarket/orderbook';

const raw: PolymarketBookEvent = {
  market:     '0xb9ed6ed97ce9146ef1a01278d5fc0f8bd04050a69f0a5568a66075b3c0c6b2c3',
  asset_id:   '62305814799875783974460176688386847666394972778903073967664089920408777315323',
  bids:       [{ price: '0.43', size: '41' }, { price: '0.42', size: '194' }],
  asks:       [{ price: '0.44', size: '253.92' }, { price: '0.45', size: '384' }],
  hash:       'b94cbda1d86a59a0a8c15c586039aa811c2a15c6',
  timestamp:  '1767463213110',
  event_type: 'book',
};

const result = PolymarketBookEventParser.parse(raw);

if (!result.ok) {
  console.error(result.error.message);
  return;
}

const ob = result.value;
console.log(ob.getBestBid()?.value().toNumber()); // 0.43
console.log(ob.getBestAsk()?.value().toNumber()); // 0.44

const spreadResult = ob.getSpread();
if (spreadResult.ok) {
  console.log(spreadResult.value.width().toNumber()); // 0.01
}

console.log(ob.getMidPrice()?.value().toNumber()); // 0.435
console.log(ob.getImbalance());                    // дисбаланс [-1, +1]
console.log(ob.venueTimestamp?.toNumber());         // 1767463213110
```

Парсер делегирует всю валидацию в `OrderbookNormalizer`:
- `PriceService.create()` — диапазон [0.0001, 0.9999]
- `QuantityService.create()` — quantity >= 0
- Сортировка bids ↓, asks ↑
- Crossed book detection

### Из сырых данных

```typescript
import { OrderbookNormalizer, Orderbook, type RawOrderbook } from '@polymarket/orderbook';

const raw: RawOrderbook = {
  marketId: '0xb9ed...',
  tokenId:  '62305814...',
  bids: [
    { price: 0.43, quantity: 41 },
    { price: 0.42, quantity: 194 },
  ],
  asks: [
    { price: 0.44, quantity: 253.92 },
  ],
  venueTimestamp: 1767463213110,
};

const normalized = OrderbookNormalizer.normalize(raw);
if (normalized.ok) {
  const ob = Orderbook.fromNormalized(normalized.value);
}
```

### Из JSON (сериализация)

```typescript
import { OrderbookSerializer } from '@polymarket/orderbook';

// Десериализация
const result = OrderbookSerializer.fromJSON(json);
if (result.ok) {
  const ob = result.value;
}

// Сериализация
const json = OrderbookSerializer.toJSON(ob);
const str  = OrderbookSerializer.stringify(ob, true); // pretty-print
```

## Политики нормализации

| Политика | dropZeroQty | aggregateSamePrice | allowCrossed | maxLevels |
|---|---|---|---|---|
| `DEFAULT_NORMALIZATION_POLICY` | ✅ | ✅ | ❌ | без лимита |
| `PERMISSIVE_NORMALIZATION_POLICY` | ❌ | ❌ | ✅ | без лимита |
| `TOP_OF_BOOK_POLICY` | ✅ | ✅ | ❌ | 1 |

```typescript
import {
  DEFAULT_NORMALIZATION_POLICY,
  PERMISSIVE_NORMALIZATION_POLICY,
  TOP_OF_BOOK_POLICY,
} from '@polymarket/orderbook';

// Production trading — strict (рекомендуется для торговли, включает crossed book detection)
PolymarketBookEventParser.parse(event, DEFAULT_NORMALIZATION_POLICY);

// Анализ / бэктест — permissive
PolymarketBookEventParser.parse(event, PERMISSIVE_NORMALIZATION_POLICY);

// Только лучший bid/ask
PolymarketBookEventParser.parse(event, TOP_OF_BOOK_POLICY);

// Кастомная политика
PolymarketBookEventParser.parse(event, {
  dropZeroQty:        true,
  aggregateSamePrice: true,
  allowCrossed:       false,
  maxLevelsPerSide:   10,
});
```

## API

### `Orderbook`

```typescript
// Фабрики
Orderbook.fromNormalized(normalized: NormalizedOrderbook): Orderbook
Orderbook.empty(instrumentId: InstrumentId, asset: InstrumentId): Orderbook

// Поля
ob.instrumentId: InstrumentId   // market condition ID
ob.asset: InstrumentId          // outcome token ID
ob.bids: readonly OrderbookLevel[]
ob.asks: readonly OrderbookLevel[]
ob.venueTimestamp?: Timestamp   // время от биржи
ob.receivedAt: Timestamp        // время получения

// Best price
ob.getBestBid(): Price | null
ob.getBestAsk(): Price | null

// Цены
ob.getSpread(): Result<Spread, OrderbookInvalidError>
ob.getMidPrice(): Price | null       // (bid + ask) / 2
ob.getMicroprice(): Price | null     // взвешенная по объёмам

// Объём
ob.getTotalBidVolume(levels?: number): Quantity
ob.getTotalAskVolume(levels?: number): Quantity

// Дисбаланс
ob.getImbalance(levels?: number): number  // [-1, +1]

// Состояние
ob.isEmpty(): boolean
ob.hasLiquidity(): boolean
ob.getBidDepth(): number
ob.getAskDepth(): number

// Время
ob.getAgeMs(): number          // Date.now() - receivedAt
ob.getLatencyMs(): number | null  // receivedAt - venueTimestamp
ob.isStale(maxAgeMs?: number): boolean  // default 5000ms

// Представление
ob.toObject(): { bestBid, bestAsk, midPrice, spreadWidth, spreadStatus, imbalance, ... }
ob.toString(): string
```

### `OrderbookLevel`

Value Object одного уровня стакана.

```typescript
level.price: Price
level.quantity: Quantity
level.isEmpty(): boolean             // quantity = 0
level.withQuantity(q: Quantity): OrderbookLevel
level.equals(other: OrderbookLevel): boolean
level.toObject(): { price: number; quantity: number }
```

### `PolymarketBookEventParser`

> **⚠️ Production warning:** По умолчанию используется `PERMISSIVE_NORMALIZATION_POLICY`
> (нулевые уровни не фильтруются, crossed book не проверяется).
> В production-торговле **всегда** передавайте `DEFAULT_NORMALIZATION_POLICY` явно.

```typescript
// Статический класс
PolymarketBookEventParser.parse(
  event: PolymarketBookEvent,
  policy?: NormalizationPolicy    // default: PERMISSIVE_NORMALIZATION_POLICY (в production используйте DEFAULT_NORMALIZATION_POLICY)
): Result<Orderbook, OrderbookValidationError | OrderbookInvalidError>
```

Маппинг полей Polymarket → домен:

| Polymarket | RawOrderbook | Преобразование |
|---|---|---|
| `market` | `marketId` | переименование |
| `asset_id` | `tokenId` | переименование |
| `bids[].price` | `bids[].price` | строка передаётся as-is → `PriceService.create(string)` |
| `bids[].size` | `bids[].quantity` | строка передаётся as-is + переименование → `QuantityService.create(string)` |
| `timestamp` | `venueTimestamp` | строка передаётся as-is → `TimestampService.create(string)` |

### `OrderbookInvalidError`

```typescript
const spreadResult = ob.getSpread();
if (!spreadResult.ok) {
  const err = spreadResult.error;
  err.getReason(): OrderbookInvalidReason
  err.isCrossedBook(): boolean
  err.isStaleData(): boolean
}

// Причины:
OrderbookInvalidReason.CROSSED_BOOK  // bid > ask в getSpread(); bid >= ask в normalize()
OrderbookInvalidReason.EMPTY_BOOK    // нет ни bid, ни ask
OrderbookInvalidReason.ONE_SIDED     // только bid или только ask
OrderbookInvalidReason.STALE_DATA    // данные устарели
```

## Обработка ошибок

`getSpread()` возвращает `Result<Spread, OrderbookInvalidError>` — явный сигнал о проблемах вместо `null`:

```typescript
const spreadResult = ob.getSpread();

if (!spreadResult.ok) {
  switch (spreadResult.error.getReason()) {
    case OrderbookInvalidReason.CROSSED_BOOK:
      // bid > ask (getSpread) — критично, торговать опасно
      // Примечание: normalize() строже — отвергает bid >= ask до создания Orderbook
      break;
    case OrderbookInvalidReason.EMPTY_BOOK:
      // нет ликвидности
      break;
    case OrderbookInvalidReason.ONE_SIDED:
      // только одна сторона стакана
      break;
  }
  return;
}

const spread = spreadResult.value.width().toNumber(); // 0.01
```

## Зависимости

- `@polymarket/result` — Result pattern
- `@polymarket/errors`, `@polymarket/errors/orderbook` — типы ошибок
- `@polymarket/ids` — InstrumentId (branded type)
- `@polymarket/value-objects` — Price, Quantity, Spread, Timestamp VO
