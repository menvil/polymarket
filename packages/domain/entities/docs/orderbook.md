# Orderbook Entity

## Описание

`Orderbook` — это доменная сущность, представляющая **стакан заявок (order book)** в системе трейдинга на рынках предсказаний Polymarket.

Orderbook — это **неизменяемый (immutable)** объект, содержащий упорядоченные списки bid (заявки на покупку) и ask (заявки на продажу) с возможностью вычисления рыночных метрик (spread, mid price, microprice, imbalance).

## Зачем нужен?

Orderbook используется для:
- **Визуализации ликвидности** рынка (depth chart, order book UI)
- **Расчёта рыночных цен** (best bid/ask, mid price, microprice)
- **Анализа рыночного дисбаланса** (bid/ask volume imbalance)
- **Определения spread** (разница между лучшим bid и ask)
- **Оценки глубины рынка** (количество уровней и общий объём)
- **Валидации возможности торговли** (hasLiquidity)

## Структура данных

```
Orderbook
├── marketId: string          // ID рынка
├── timestamp: Date            // Время снимка
├── bids: OrderbookLevel[]     // Заявки на покупку (отсортированы по убыванию цены)
└── asks: OrderbookLevel[]     // Заявки на продажу (отсортированы по возрастанию цены)

OrderbookLevel
├── price: Price               // Цена уровня
└── quantity: Quantity         // Объём на уровне
```

### Порядок сортировки

**Bids** (заявки на покупку):
```
[0.52, qty: 100]  ← Лучший bid (highest)
[0.51, qty: 200]
[0.50, qty: 150]
```

**Asks** (заявки на продажу):
```
[0.53, qty: 150]  ← Лучший ask (lowest)
[0.54, qty: 250]
[0.55, qty: 100]
```

## Создание Orderbook

### Базовый пример

```typescript
import { Orderbook } from '@polymarket/entities';
import { Price, Quantity } from '@polymarket/value-objects';

// Helper функция для создания уровня
function createLevel(price: number, quantity: number) {
  const priceResult = Price.fromValue(price);
  const qtyResult = Quantity.fromValue(quantity);

  if (!priceResult.ok || !qtyResult.ok) {
    throw new Error('Invalid level');
  }

  return {
    price: priceResult.value,
    quantity: qtyResult.value,
  };
}

// Создание orderbook
const result = Orderbook.create('market-btc-100k', {
  bids: [
    createLevel(0.52, 100),
    createLevel(0.51, 200),
    createLevel(0.50, 150),
  ],
  asks: [
    createLevel(0.53, 150),
    createLevel(0.54, 250),
    createLevel(0.55, 100),
  ],
});

if (result.ok) {
  const orderbook = result.value;
  console.log('Orderbook created:', orderbook.marketId);
  console.log('Best bid:', orderbook.getBestBid()?.value); // 0.52
  console.log('Best ask:', orderbook.getBestAsk()?.value); // 0.53
}
```

### Пустой orderbook

```typescript
const emptyResult = Orderbook.empty('market-123');

if (emptyResult.ok) {
  const empty = emptyResult.value;
  console.log(empty.isEmpty()); // true
  console.log(empty.hasLiquidity()); // false
  console.log(empty.getBestBid()); // null
}
```

### Из JSON данных

```typescript
const json = {
  marketId: 'market-json',
  timestamp: '2024-01-15T12:00:00Z',
  bids: [
    { price: 0.52, quantity: 100 },
    { price: 0.51, quantity: 200 },
  ],
  asks: [
    { price: 0.53, quantity: 150 },
  ],
};

const result = Orderbook.fromJSON(json);

if (result.ok) {
  const orderbook = result.value;
  console.log('Orderbook loaded from JSON');
  console.log('Bid depth:', orderbook.getBidDepth()); // 2
  console.log('Ask depth:', orderbook.getAskDepth()); // 1
}
```

## Получение цен

### Best Bid/Ask

```typescript
const orderbook = result.value;

// Лучший bid (максимальная цена покупки)
const bestBid = orderbook.getBestBid();
if (bestBid) {
  console.log(`Best bid: ${bestBid.value}`); // 0.52
}

// Лучший ask (минимальная цена продажи)
const bestAsk = orderbook.getBestAsk();
if (bestAsk) {
  console.log(`Best ask: ${bestAsk.value}`); // 0.53
}
```

### Spread

```typescript
// Получение spread объекта
const spread = orderbook.getSpread();

if (spread) {
  console.log(`Spread width: ${spread.width()}`); // 0.01
  console.log(`Spread %: ${spread.widthPercentage()}%`); // 1.9%
  console.log(`Midpoint: ${spread.midpoint().value}`); // 0.525
}
```

### Mid Price

```typescript
// Mid price = (best bid + best ask) / 2
const midPrice = orderbook.getMidPrice();

if (midPrice) {
  console.log(`Mid price: ${midPrice.value}`); // 0.525
}
```

### Microprice

Microprice — это **взвешенная цена**, учитывающая объёмы на лучших bid/ask уровнях:

```
microprice = (bestAsk * bidQty + bestBid * askQty) / (bidQty + askQty)
```

```typescript
// Пример: bid = 0.50 qty 100, ask = 0.52 qty 200
const microprice = orderbook.getMicroprice();

if (microprice) {
  // microprice = (0.52 * 100 + 0.50 * 200) / (100 + 200)
  //            = (52 + 100) / 300 = 0.5067
  console.log(`Microprice: ${microprice.value}`); // 0.5067
}

// Сравнение с mid price
const midPrice = orderbook.getMidPrice();
console.log(`Mid price: ${midPrice?.value}`); // 0.51

// Microprice ближе к bid, так как на ask больше объёма
// (больше продавцов → давление вниз)
```

## Анализ ликвидности

### Общий объём

```typescript
// Общий объём всех бидов
const totalBidVol = orderbook.getTotalBidVolume();
console.log(`Total bid volume: ${totalBidVol.value}`);

// Общий объём всех асков
const totalAskVol = orderbook.getTotalAskVolume();
console.log(`Total ask volume: ${totalAskVol.value}`);

// Объём топ-5 уровней
const top5BidVol = orderbook.getTotalBidVolume(5);
const top5AskVol = orderbook.getTotalAskVolume(5);
console.log(`Top 5 bid volume: ${top5BidVol.value}`);
```

### Imbalance (дисбаланс объёмов)

Imbalance показывает перевес покупателей или продавцов:

```
imbalance = (bidVolume - askVolume) / (bidVolume + askVolume)
```

Диапазон: **-1.0 до +1.0**

```typescript
// Дисбаланс топ-5 уровней (по умолчанию)
const imbalance = orderbook.getImbalance();

if (imbalance > 0.3) {
  console.log('Strong buying pressure'); // Много покупателей
} else if (imbalance < -0.3) {
  console.log('Strong selling pressure'); // Много продавцов
} else {
  console.log('Balanced market'); // Баланс
}

// Дисбаланс топ-10 уровней
const imbalance10 = orderbook.getImbalance(10);
```

**Интерпретация:**
- `+1.0` — только bids, нет asks (сильное покупательское давление)
- `+0.5` — bidVolume в 3 раза больше askVolume
- `0.0` — равные объёмы (баланс)
- `-0.5` — askVolume в 3 раза больше bidVolume
- `-1.0` — только asks, нет bids (сильное продавательское давление)

### Глубина (depth)

```typescript
// Количество уровней
const bidDepth = orderbook.getBidDepth();
const askDepth = orderbook.getAskDepth();

console.log(`Bid depth: ${bidDepth} levels`);
console.log(`Ask depth: ${askDepth} levels`);

// Проверка наличия ликвидности
if (orderbook.hasLiquidity()) {
  console.log('Market has liquidity (both bids and asks)');
} else {
  console.log('No liquidity available');
}

// Проверка пустоты
if (orderbook.isEmpty()) {
  console.log('Orderbook is empty (no bids and no asks)');
}
```

## Возраст данных

Orderbook содержит timestamp для отслеживания актуальности данных:

```typescript
// Возраст в миллисекундах
const ageMs = orderbook.getAgeMs();
console.log(`Orderbook age: ${ageMs}ms`);

// Проверка устаревания (по умолчанию 5000ms)
if (orderbook.isStale()) {
  console.log('Orderbook data is stale, need refresh');
}

// Кастомный порог
if (orderbook.isStale(3000)) {
  console.log('Orderbook older than 3 seconds');
}
```

## Сериализация

### toJSON() — полные данные

```typescript
// Полная сериализация с всеми уровнями
const json = orderbook.toJSON();

/*
{
  marketId: 'market-123',
  timestamp: '2024-01-15T12:00:00.000Z',
  bids: [
    { price: 0.52, quantity: 100 },
    { price: 0.51, quantity: 200 }
  ],
  asks: [
    { price: 0.53, quantity: 150 }
  ]
}
*/

// Сохранение и восстановление
const jsonString = JSON.stringify(json);
await db.saveOrderbook(jsonString);

const restored = Orderbook.fromJSON(JSON.parse(jsonString));
```

### toObject() — метрики

```typescript
// Сводные метрики без полных данных уровней
const obj = orderbook.toObject();

/*
{
  marketId: 'market-123',
  timestamp: '2024-01-15T12:00:00.000Z',
  bestBid: 0.52,
  bestAsk: 0.53,
  midPrice: 0.525,
  microprice: 0.5067,
  spreadWidth: 0.01,
  bidDepth: 2,
  askDepth: 1,
  totalBidVolume: 300,
  totalAskVolume: 150,
  imbalance: 0.33,
  ageMs: 1234
}
*/

// Для аналитики и мониторинга
console.log(JSON.stringify(obj, null, 2));
```

## API Reference

### OrderbookData

```typescript
interface OrderbookData {
  bids: OrderbookLevel[];       // Массив bid уровней
  asks: OrderbookLevel[];       // Массив ask уровней
  timestamp?: Date;             // Опционально: время снимка
}

interface OrderbookLevel {
  price: Price;                 // Цена уровня
  quantity: Quantity;           // Объём на уровне
}
```

### Статические методы

| Метод | Сигнатура | Описание |
|-------|-----------|----------|
| `create()` | `(marketId: string, data: OrderbookData) => Result<Orderbook, OrderbookValidationError>` | Создаёт Orderbook с валидацией |
| `fromJSON()` | `(json: Record<string, unknown>) => Result<Orderbook, OrderbookValidationError>` | Создаёт Orderbook из JSON |
| `empty()` | `(marketId: string) => Result<Orderbook, OrderbookValidationError>` | Создаёт пустой Orderbook |

### Методы получения цен

| Метод | Возвращает | Описание |
|-------|------------|----------|
| `getBestBid()` | `Price \| null` | Лучший bid (максимальная цена покупки) |
| `getBestAsk()` | `Price \| null` | Лучший ask (минимальная цена продажи) |
| `getSpread()` | `Spread \| null` | Spread объект (bid-ask разница) |
| `getMidPrice()` | `Price \| null` | Mid price = (bid + ask) / 2 |
| `getMicroprice()` | `Price \| null` | Взвешенная цена с учётом объёмов |

### Методы анализа ликвидности

| Метод | Возвращает | Описание |
|-------|------------|----------|
| `getTotalBidVolume(levels?)` | `Quantity` | Общий объём бидов (опционально первых N уровней) |
| `getTotalAskVolume(levels?)` | `Quantity` | Общий объём асков (опционально первых N уровней) |
| `getImbalance(levels?)` | `number` | Дисбаланс объёмов (-1 до +1, default: 5 уровней) |
| `getBidDepth()` | `number` | Количество bid уровней |
| `getAskDepth()` | `number` | Количество ask уровней |

### Предикаты

| Метод | Возвращает | Описание |
|-------|------------|----------|
| `isEmpty()` | `boolean` | True если нет ни бидов, ни асков |
| `hasLiquidity()` | `boolean` | True если есть хотя бы один bid и один ask |
| `isStale(maxAgeMs?)` | `boolean` | True если старше maxAgeMs (default: 5000) |

### Утилиты

| Метод | Возвращает | Описание |
|-------|------------|----------|
| `getAgeMs()` | `number` | Возраст снимка в миллисекундах |
| `toJSON()` | `Record<string, unknown>` | Полная сериализация с уровнями |
| `toObject()` | `object` | Сводные метрики без уровней |
| `toString()` | `string` | Читаемое строковое представление |

## Валидация и ошибки

Orderbook использует **Result pattern** для обработки ошибок:

```typescript
// Невалидный marketId
const result = Orderbook.create('', { bids: [], asks: [] });

if (!result.ok) {
  console.error('Validation failed:', result.error.message);
  // "Market ID must be a non-empty string"

  console.log('Error context:', result.error.context);
  // { field: 'marketId', value: '' }
}
```

### Типичные ошибки валидации

| Ошибка | Причина |
|--------|---------|
| `Market ID must be a non-empty string` | Пустой или невалидный marketId |
| `Bids must be an array` | bids не является массивом |
| `Asks must be an array` | asks не является массивом |
| `Invalid price in bid[N]` | Невалидная цена в bid уровне |
| `Invalid quantity in bid[N]` | Невалидный объём в bid уровне |
| `Failed to create Price from bid[N]` | Цена выходит за допустимые пределы |
| `Failed to create Quantity from ask[N]` | Объём невалидный |
| `Invalid timestamp format` | Невалидная строка даты в JSON |

## Примеры использования

### Визуализация стакана

```typescript
function displayOrderbook(orderbook: Orderbook) {
  console.log(`\n=== Orderbook: ${orderbook.marketId} ===\n`);

  // Asks (в обратном порядке для визуализации)
  console.log('ASKS (selling):');
  const asks = [...orderbook.asks].reverse();
  asks.forEach(level => {
    console.log(`  ${level.price.value.toFixed(4)}  |  ${level.quantity.value}`);
  });

  // Spread
  const spread = orderbook.getSpread();
  if (spread) {
    console.log(`  -------- SPREAD: ${spread.width().toFixed(4)} --------`);
  }

  // Bids
  console.log('BIDS (buying):');
  orderbook.bids.forEach(level => {
    console.log(`  ${level.price.value.toFixed(4)}  |  ${level.quantity.value}`);
  });

  // Метрики
  console.log(`\nMid Price: ${orderbook.getMidPrice()?.value.toFixed(4)}`);
  console.log(`Microprice: ${orderbook.getMicroprice()?.value.toFixed(4)}`);
  console.log(`Imbalance: ${orderbook.getImbalance().toFixed(2)}`);
}
```

### Market Data обновление

```typescript
class MarketDataService {
  private orderbooks = new Map<string, Orderbook>();

  async updateOrderbook(marketId: string, data: OrderbookData) {
    const result = Orderbook.create(marketId, data);

    if (result.ok) {
      this.orderbooks.set(marketId, result.value);
      this.notifySubscribers(marketId, result.value);
    } else {
      console.error(`Failed to update orderbook ${marketId}:`, result.error.message);
    }
  }

  getOrderbook(marketId: string): Orderbook | null {
    const orderbook = this.orderbooks.get(marketId);

    // Проверка устаревания
    if (orderbook && orderbook.isStale(10000)) {
      console.warn(`Orderbook ${marketId} is stale (>10s old)`);
      return null;
    }

    return orderbook || null;
  }
}
```

### Trading signals на основе orderbook

```typescript
function analyzeOrderbook(orderbook: Orderbook) {
  const imbalance = orderbook.getImbalance();
  const spread = orderbook.getSpread();

  if (!spread) {
    return { signal: 'WAIT', reason: 'No liquidity' };
  }

  // Широкий spread → низкая ликвидность
  if (spread.widthPercentage() > 5) {
    return { signal: 'WAIT', reason: 'Spread too wide' };
  }

  // Сильный дисбаланс в сторону покупателей
  if (imbalance > 0.4) {
    return {
      signal: 'BUY',
      reason: 'Strong buying pressure',
      price: orderbook.getBestAsk()?.value
    };
  }

  // Сильный дисбаланс в сторону продавцов
  if (imbalance < -0.4) {
    return {
      signal: 'SELL',
      reason: 'Strong selling pressure',
      price: orderbook.getBestBid()?.value
    };
  }

  return { signal: 'NEUTRAL', reason: 'Balanced market' };
}
```

### Расчёт execution price

```typescript
/**
 * Вычисляет среднюю цену исполнения для market order
 */
function calculateExecutionPrice(
  orderbook: Orderbook,
  side: 'BUY' | 'SELL',
  targetSize: number
): number | null {
  const levels = side === 'BUY' ? orderbook.asks : orderbook.bids;

  let remainingSize = targetSize;
  let totalCost = 0;

  for (const level of levels) {
    const availableQty = level.quantity.value;
    const takeQty = Math.min(remainingSize, availableQty);

    totalCost += takeQty * level.price.value;
    remainingSize -= takeQty;

    if (remainingSize <= 0) {
      break;
    }
  }

  // Недостаточно ликвидности
  if (remainingSize > 0) {
    return null;
  }

  return totalCost / targetSize;
}

// Пример использования
const avgPrice = calculateExecutionPrice(orderbook, 'BUY', 300);
if (avgPrice) {
  console.log(`Average execution price for 300 units: ${avgPrice.toFixed(4)}`);
} else {
  console.log('Insufficient liquidity for this size');
}
```

## Best Practices

### ✅ DO

```typescript
// ✅ Всегда проверяй Result
const result = Orderbook.create(marketId, data);
if (result.ok) {
  const orderbook = result.value;
  // Работа с orderbook
}

// ✅ Проверяй наличие ликвидности
if (orderbook.hasLiquidity()) {
  const spread = orderbook.getSpread();
}

// ✅ Проверяй актуальность данных
if (!orderbook.isStale(5000)) {
  // Используй данные
}

// ✅ Обрабатывай null от getBestBid/Ask
const bestBid = orderbook.getBestBid();
if (bestBid) {
  console.log(bestBid.value);
}
```

### ❌ DON'T

```typescript
// ❌ Не используй .value! без проверки
const orderbook = Orderbook.create(marketId, data).value!;

// ❌ Не предполагай наличие ликвидности
const spread = orderbook.getSpread().width(); // ❌ Может быть null!

// ❌ Не используй устаревшие данные
if (orderbook.isStale()) {
  // ❌ Не используй такой orderbook для торговли!
}

// ❌ Не мутируй Orderbook
orderbook.bids.push(newLevel); // ❌ Compilation error (readonly)
```

## Performance Tips

1. **Используй toObject() для мониторинга** вместо toJSON() — меньше данных
2. **Кэшируй вычисления** (spread, microprice) если orderbook не меняется
3. **Ограничивай уровни** при вычислении imbalance (getImbalance(5) быстрее чем getImbalance(100))
4. **Проверяй isStale()** перед использованием для предотвращения торговли на устаревших данных

## См. также

- [Order](./order.md) — заявка на покупку/продажу
- [Spread](../../value-objects/docs/spread.md) — bid-ask spread
- [Price](../../value-objects/docs/price.md) — цена
- [Quantity](../../value-objects/docs/quantity.md) — объём
- [OrderbookValidationError](../errors/OrderbookValidationError.md) — ошибки валидации Orderbook
