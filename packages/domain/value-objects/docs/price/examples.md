# Примеры использования Price

> Практические примеры реальных сценариев использования Price Value Object

## Содержание

1. [Базовые операции](#базовые-операции)
2. [Работа с рынками предсказаний](#работа-с-рынками-предсказаний)
3. [Ордербук и трейдинг](#ордербук-и-трейдинг)
4. [Валидация и обработка ошибок](#валидация-и-обработка-ошибок)
5. [Интеграция с API](#интеграция-с-api)
6. [Performance оптимизации](#performance-оптимизации)

---

## Базовые операции

### Создание цены из пользовательского ввода

```typescript
import { PriceService } from '@polymarket/value-objects/price';

function handleUserPriceInput(input: string) {
  const result = PriceService.create(input);

  if (!result.ok) {
    const ctx = result.error.context;

    if (ctx?.value) {
      const numValue = parseFloat(ctx.value);

      if (numValue < 0.0001) {
        return `Минимальная цена: 0.0001 (${(0.0001 * 100).toFixed(2)}%)`;
      }

      if (numValue > 0.9999) {
        return `Максимальная цена: 0.9999 (${(0.9999 * 100).toFixed(2)}%)`;
      }
    }

    return `Невалидная цена: ${result.error.message}`;
  }

  const price = result.value;
  return `Цена принята: ${(price.toNumber() * 100).toFixed(2)}%`;
}

// Примеры
console.log(handleUserPriceInput('0.65'));      // "Цена принята: 65.00%"
console.log(handleUserPriceInput('1.5'));       // "Максимальная цена: 0.9999 (99.99%)"
console.log(handleUserPriceInput('0.00001'));   // "Минимальная цена: 0.0001 (0.01%)"
console.log(handleUserPriceInput('invalid'));   // "Невалидная цена: ..."
```

---

### Вычисление противоположной цены

```typescript
import { PriceService, Price } from '@polymarket/value-objects/price';

function calculateOppositePrice(yesPrice: Price) {
  const noResult = PriceService.complement(yesPrice);

  if (!noResult.ok) {
    throw new Error(`Failed to calculate NO price: ${noResult.error.message}`);
  }

  return noResult.value;
}

// Пример: YES/NO рынок
const yesPrice = Price.of(0.65);
const noPrice = calculateOppositePrice(yesPrice);

console.log(`YES: ${(yesPrice.toNumber() * 100).toFixed(2)}%`);  // "YES: 65.00%"
console.log(`NO: ${(noPrice.toNumber() * 100).toFixed(2)}%`);     // "NO: 35.00%"

// Проверка: сумма должна быть 1 (используем Decimal для точности)
const sum = yesPrice.value().plus(noPrice.value());
console.log(sum.toNumber());  // 1.0
```

---

## Работа с рынками предсказаний

### Создание симметричного рынка

```typescript
import { PriceService, Price } from '@polymarket/value-objects/price';

interface Market {
  yesPrice: Price;
  noPrice: Price;
  isBalanced: boolean;
}

function createBalancedMarket(): Market {
  const yesPrice = Price.HALF;  // 0.5
  const noResult = PriceService.complement(yesPrice);

  if (!noResult.ok) {
    throw new Error('Failed to create balanced market');
  }

  const noPrice = noResult.value;

  return {
    yesPrice,
    noPrice,
    isBalanced: yesPrice.equals(noPrice)  // true
  };
}

const market = createBalancedMarket();
console.log(`YES: ${market.yesPrice.toNumber()}`);  // 0.5
console.log(`NO: ${market.noPrice.toNumber()}`);    // 0.5
console.log(`Balanced: ${market.isBalanced}`);      // true
```

---

### Расчёт implied probability

```typescript
import { Price } from '@polymarket/value-objects/price';

function displayProbability(price: Price): string {
  const percentage = price.toNumber() * 100;
  return `${percentage.toFixed(2)}%`;
}

function classifyProbability(price: Price): string {
  const value = price.toNumber();

  if (price.equals(Price.HALF)) {
    return 'Toss-up (50/50)';
  }

  if (value > 0.75) {
    return 'Highly likely';
  }

  if (value > 0.6) {
    return 'Likely';
  }

  if (value > 0.4) {
    return 'Uncertain';
  }

  if (value > 0.25) {
    return 'Unlikely';
  }

  return 'Highly unlikely';
}

// Примеры
const scenarios = [
  Price.of(0.95),
  Price.of(0.65),
  Price.HALF,
  Price.of(0.35),
  Price.of(0.05)
];

scenarios.forEach(price => {
  console.log(
    `${displayProbability(price)}: ${classifyProbability(price)}`
  );
});

// Output:
// 95.00%: Highly likely
// 65.00%: Likely
// 50.00%: Toss-up (50/50)
// 35.00%: Unlikely
// 5.00%: Highly unlikely
```

---

## Ордербук и трейдинг

### Вычисление mid price

```typescript
import { PriceService, Price } from '@polymarket/value-objects/price';
import Decimal from 'decimal.js';

interface OrderbookLevel {
  price: Price;
  size: Decimal;
}

interface Orderbook {
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
}

function calculateMidPrice(orderbook: Orderbook): Price | null {
  if (orderbook.bids.length === 0 || orderbook.asks.length === 0) {
    return null;
  }

  const bestBid = orderbook.bids[0].price;
  const bestAsk = orderbook.asks[0].price;

  const midResult = PriceService.average(bestBid, bestAsk);

  if (!midResult.ok) {
    console.error('Failed to calculate mid price:', midResult.error);
    return null;
  }

  return midResult.value;
}

// Пример использования
const orderbook: Orderbook = {
  bids: [
    { price: Price.of(0.64), size: new Decimal(100) },
    { price: Price.of(0.63), size: new Decimal(200) }
  ],
  asks: [
    { price: Price.of(0.66), size: new Decimal(150) },
    { price: Price.of(0.67), size: new Decimal(250) }
  ]
};

const midPrice = calculateMidPrice(orderbook);
if (midPrice) {
  console.log(`Mid price: ${midPrice.toNumber()}`);  // 0.65
  console.log(`Spread: ${(0.66 - 0.64).toFixed(4)}`); // 0.0200
}
```

---

### Округление цен для размещения ордеров

```typescript
import { PriceService, Price } from '@polymarket/value-objects/price';

function roundPriceForOrder(
  price: Price,
  tickSize: number,
  side: 'buy' | 'sell'
): Price | null {
  // Buy orders: округляем вниз (выгоднее для покупателя)
  // Sell orders: округляем вверх (выгоднее для продавца)
  const mode = side === 'buy' ? 'floor' : 'ceil';

  const result = PriceService.roundToMarketTick(price, tickSize, mode);

  if (!result.ok) {
    console.error(`Failed to round price: ${result.error.message}`);
    return null;
  }

  return result.value;
}

// Пример: пользователь хочет купить по 0.6543
const userPrice = Price.of(0.6543);
const tickSize = 0.01;

const buyPrice = roundPriceForOrder(userPrice, tickSize, 'buy');
const sellPrice = roundPriceForOrder(userPrice, tickSize, 'sell');

console.log(`User input: ${userPrice.toNumber()}`);       // 0.6543
console.log(`Buy order price: ${buyPrice?.toNumber()}`);  // 0.65 (floor)
console.log(`Sell order price: ${sellPrice?.toNumber()}`); // 0.66 (ceil)
```

---

### Валидация ордера

```typescript
import { PriceService, Price } from '@polymarket/value-objects/price';

interface OrderValidationResult {
  valid: boolean;
  error?: string;
}

function validateOrderPrice(
  price: Price,
  tickSize: number,
  minPrice: Price = Price.MIN,
  maxPrice: Price = Price.MAX
): OrderValidationResult {
  // Проверка диапазона (уже гарантировано Core инвариантами, но можно уточнить)
  if (price.toNumber() < minPrice.toNumber()) {
    return {
      valid: false,
      error: `Price ${price.toNumber()} is below minimum ${minPrice.toNumber()}`
    };
  }

  if (price.toNumber() > maxPrice.toNumber()) {
    return {
      valid: false,
      error: `Price ${price.toNumber()} is above maximum ${maxPrice.toNumber()}`
    };
  }

  // Проверка выравнивания к tick size
  const alignResult = PriceService.ensureAlignedToMarketTick(price, tickSize);

  if (!alignResult.ok) {
    return {
      valid: false,
      error: `Price ${price.toNumber()} is not aligned to tick size ${tickSize}`
    };
  }

  return { valid: true };
}

// Примеры
const tickSize = 0.01;

console.log(validateOrderPrice(Price.of(0.65), tickSize));
// { valid: true }

console.log(validateOrderPrice(Price.of(0.6543), tickSize));
// { valid: false, error: "Price 0.6543 is not aligned to tick size 0.01" }

console.log(validateOrderPrice(Price.of(1.5), tickSize));
// Не дойдёт сюда - Price.of(1.5) бросит исключение
// Используйте PriceService.create() для безопасного создания!
```

---

## Валидация и обработка ошибок

### Обработка пользовательского ввода

```typescript
import { PriceService, Price } from '@polymarket/value-objects/price';
import { Result } from '@polymarket/result';

interface PriceInputResult {
  price?: Price;
  error?: string;
  errorType?: 'parse' | 'range' | 'unknown';
}

function parseUserPrice(input: string): PriceInputResult {
  const result = PriceService.create(input);

  if (!result.ok) {
    const ctx = result.error.context;
    const value = ctx?.value;

    // Parse error
    if (!value) {
      return {
        errorType: 'parse',
        error: 'Невалидный формат числа'
      };
    }

    // Range error
    const numValue = parseFloat(value);

    if (!isFinite(numValue)) {
      return {
        errorType: 'range',
        error: 'Цена должна быть конечным числом'
      };
    }

    if (numValue < 0.0001) {
      return {
        errorType: 'range',
        error: `Минимальная цена: 0.0001 (0.01%). Вы ввели: ${(numValue * 100).toFixed(4)}%`
      };
    }

    if (numValue > 0.9999) {
      return {
        errorType: 'range',
        error: `Максимальная цена: 0.9999 (99.99%). Вы ввели: ${(numValue * 100).toFixed(4)}%`
      };
    }

    return {
      errorType: 'unknown',
      error: result.error.message
    };
  }

  return { price: result.value };
}

// Примеры
const testInputs = ['0.65', '1.5', '0.00001', 'abc', 'NaN'];

testInputs.forEach(input => {
  const result = parseUserPrice(input);

  if (result.price) {
    console.log(`✓ ${input} -> ${result.price.toNumber()}`);
  } else {
    console.log(`✗ ${input} -> [${result.errorType}] ${result.error}`);
  }
});

// Output:
// ✓ 0.65 -> 0.65
// ✗ 1.5 -> [range] Максимальная цена: 0.9999 (99.99%). Вы ввели: 150.0000%
// ✗ 0.00001 -> [range] Минимальная цена: 0.0001 (0.01%). Вы ввели: 0.0010%
// ✗ abc -> [parse] Невалидный формат числа
// ✗ NaN -> [parse] Невалидный формат числа
```

---

### Композиция операций с обработкой ошибок

```typescript
import { PriceService, Price } from '@polymarket/value-objects/price';
import { Result, Ok, Err } from '@polymarket/result';
import type { InvalidPriceError } from '@polymarket/errors';

function processMarketPrice(
  rawYesPrice: string,
  tickSize: number
): Result<
  { yes: Price; no: Price; mid: Price },
  InvalidPriceError
> {
  // 1. Создаём YES цену
  const yesResult = PriceService.create(rawYesPrice);
  if (!yesResult.ok) {
    return yesResult;
  }

  const yesPrice = yesResult.value;

  // 2. Округляем к тику
  const roundedYesResult = PriceService.roundToMarketTick(
    yesPrice,
    tickSize,
    'nearest'
  );
  if (!roundedYesResult.ok) {
    return roundedYesResult;
  }

  const roundedYes = roundedYesResult.value;

  // 3. Вычисляем NO цену
  const noResult = PriceService.complement(roundedYes);
  if (!noResult.ok) {
    return noResult;
  }

  const noPrice = noResult.value;

  // 4. Вычисляем mid price (должно быть 0.5 для симметричного рынка)
  const midResult = PriceService.average(roundedYes, noPrice);
  if (!midResult.ok) {
    return midResult;
  }

  const midPrice = midResult.value;

  return Ok({
    yes: roundedYes,
    no: noPrice,
    mid: midPrice
  });
}

// Пример использования
const result = processMarketPrice('0.6543', 0.01);

if (result.ok) {
  const { yes, no, mid } = result.value;

  console.log(`YES: ${(yes.toNumber() * 100).toFixed(2)}%`);   // "YES: 65.00%"
  console.log(`NO: ${(no.toNumber() * 100).toFixed(2)}%`);     // "NO: 35.00%"
  console.log(`MID: ${(mid.toNumber() * 100).toFixed(2)}%`);   // "MID: 50.00%"
} else {
  console.error(`Error: ${result.error.message}`);
  console.error(`Context:`, result.error.context);
}
```

---

## Интеграция с API

### Сериализация для отправки на сервер

```typescript
import { PriceService, PriceSerializer, Price } from '@polymarket/value-objects/price';

interface CreateOrderRequest {
  marketId: string;
  side: 'buy' | 'sell';
  price: { value: string };  // Сериализованный Price
  size: string;
}

function createOrderRequest(
  marketId: string,
  side: 'buy' | 'sell',
  price: Price,
  size: number
): CreateOrderRequest {
  return {
    marketId,
    side,
    price: PriceSerializer.toJSON(price),  // { value: "0.65" }
    size: size.toString()
  };
}

// Пример
const price = Price.of(0.65);
const request = createOrderRequest('market-123', 'buy', price, 100);

console.log(JSON.stringify(request, null, 2));
/*
{
  "marketId": "market-123",
  "side": "buy",
  "price": {
    "value": "0.65"
  },
  "size": "100"
}
*/
```

---

### Десериализация ответа от сервера

```typescript
import { PriceSerializer, Price } from '@polymarket/value-objects/price';

interface OrderResponse {
  orderId: string;
  marketId: string;
  side: 'buy' | 'sell';
  price: { value: string };
  size: string;
  status: 'open' | 'filled' | 'cancelled';
}

interface ParsedOrder {
  orderId: string;
  marketId: string;
  side: 'buy' | 'sell';
  price: Price;
  size: number;
  status: 'open' | 'filled' | 'cancelled';
}

function parseOrderResponse(response: OrderResponse): ParsedOrder | null {
  const priceResult = PriceSerializer.fromJSON(response.price);

  if (!priceResult.ok) {
    console.error('Failed to parse price:', priceResult.error);
    return null;
  }

  return {
    orderId: response.orderId,
    marketId: response.marketId,
    side: response.side,
    price: priceResult.value,
    size: parseFloat(response.size),
    status: response.status
  };
}

// Пример
const response: OrderResponse = {
  orderId: 'order-456',
  marketId: 'market-123',
  side: 'buy',
  price: { value: '0.6500' },
  size: '100',
  status: 'filled'
};

const order = parseOrderResponse(response);
if (order) {
  console.log(`Order ${order.orderId}: ${order.side} ${order.size} @ ${order.price.toNumber()}`);
  // "Order order-456: buy 100 @ 0.65"
}
```

---

## Performance оптимизации

### Batch валидация цен

```typescript
import { PriceService, Price } from '@polymarket/value-objects/price';

function validatePrices(rawPrices: string[]): Price[] {
  return rawPrices
    .map(raw => PriceService.create(raw))
    .filter(result => {
      if (!result.ok) {
        console.warn(`Invalid price skipped: ${result.error.message}`);
        return false;
      }
      return true;
    })
    .map(result => result.value);
}

// Пример
const rawPrices = ['0.65', '1.5', '0.45', '0.00001', '0.75'];
const validPrices = validatePrices(rawPrices);

console.log(`Valid prices: ${validPrices.length} / ${rawPrices.length}`);
// "Valid prices: 3 / 5"

validPrices.forEach(price => {
  console.log(`  - ${price.toNumber()}`);
});
// Output:
//   - 0.65
//   - 0.45
//   - 0.75
```

---

### Кэширование округлённых цен

```typescript
import { PriceService, Price } from '@polymarket/value-objects/price';

class PriceRounder {
  private cache = new Map<string, Price>();

  roundToTick(price: Price, tickSize: number, mode: 'nearest' | 'floor' | 'ceil' = 'nearest'): Price | null {
    const key = `${price.value().toString()}-${tickSize}-${mode}`;

    // Проверяем кэш
    if (this.cache.has(key)) {
      return this.cache.get(key)!;
    }

    // Округляем
    const result = PriceService.roundToMarketTick(price, tickSize, mode);

    if (!result.ok) {
      return null;
    }

    // Кэшируем результат
    this.cache.set(key, result.value);

    return result.value;
  }

  clearCache() {
    this.cache.clear();
  }

  get cacheSize(): number {
    return this.cache.size;
  }
}

// Пример использования
const rounder = new PriceRounder();

const prices = Array.from({ length: 1000 }, (_, i) => Price.of(0.5 + i * 0.0001));

console.time('First run');
prices.forEach(p => rounder.roundToTick(p, 0.01));
console.timeEnd('First run');  // ~XX ms

console.time('Second run (cached)');
prices.forEach(p => rounder.roundToTick(p, 0.01));
console.timeEnd('Second run (cached)');  // ~X ms (значительно быстрее!)

console.log(`Cache size: ${rounder.cacheSize}`);  // 1000
```

---

### Переиспользование констант

```typescript
import { Price } from '@polymarket/value-objects/price';

// ❌ Плохо: создаём каждый раз
function processPrice(price: Price) {
  if (price.equals(Price.HALF)) {  // Price.HALF вызывается каждый раз!
    console.log('Neutral price');
  }
}

// ✅ Хорошо: переиспользуем
const HALF_PRICE = Price.HALF;
const MIN_PRICE = Price.MIN;
const MAX_PRICE = Price.MAX;

function processPriceOptimized(price: Price) {
  if (price.equals(HALF_PRICE)) {
    console.log('Neutral price');
  } else if (price.equals(MIN_PRICE)) {
    console.log('Minimum price');
  } else if (price.equals(MAX_PRICE)) {
    console.log('Maximum price');
  }
}

// Benchmark
const testPrices = Array.from({ length: 10000 }, () => Price.of(0.5 + Math.random() * 0.4));

console.time('Without caching');
testPrices.forEach(p => processPrice(p));
console.timeEnd('Without caching');

console.time('With caching');
testPrices.forEach(p => processPriceOptimized(p));
console.timeEnd('With caching');  // Значительно быстрее!
```

---

## Заключение

Эти примеры демонстрируют:

1. **Создание и валидацию** цен из разных источников
2. **Polymarket-специфичные операции** (complement, average)
3. **Работу с ордербуком** и трейдингом
4. **Обработку ошибок** на всех уровнях
5. **Интеграцию с API** через сериализацию
6. **Performance оптимизации** для production

Используйте эти паттерны как основу для своих приложений!
