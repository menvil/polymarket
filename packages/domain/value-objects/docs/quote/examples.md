# Quote Examples

Практические примеры использования Quote value object.

## Содержание

- [Базовые примеры](#базовые-примеры)
- [Создание котировок](#создание-котировок)
- [Операции](#операции)
- [Валидация](#валидация)
- [Форматирование](#форматирование)
- [Сериализация](#сериализация)
- [Error Handling](#error-handling)
- [Real-world сценарии](#real-world-сценарии)

## Базовые примеры

### Простая двусторонняя котировка

```typescript
import { QuoteService, QuoteFormatter } from '@polymarket/value-objects/quote';

// Создание котировки
const result = QuoteService.create(
  0.48,  // bid price
  0.52,  // ask price
  100,   // bid size
  150,   // ask size
  'POLYMARKET_WS',  // sourceId
  'TEST_MARKET'     // instrumentId
);

if (!result.ok) {
  console.error('Failed to create quote:', result.error.message);
  return;
}

const quote = result.value;

// Отображение
console.log(QuoteFormatter.toDisplay(quote));
// "0.4800 @ 100.00 / 0.5200 @ 150.00"

// Вычисления
console.log('Spread:', quote.spreadWidthOrZero().toNumber());        // 0.04
console.log('Spread %:', quote.spreadPercentage()?.toDecimal().toNumber());  // 0.08 (8% как дробь)
console.log('Mid:', quote.midOrNull()?.toNumber());      // 0.50
```

### Bid-only котировка

```typescript
// Котировка только с bid стороной
const bidResult = QuoteService.bidOnly(0.50, 100, 'POLYMARKET_WS', 'TEST_MARKET');

if (bidResult.ok) {
  const quote = bidResult.value;

  console.log(quote.hasBid());   // true
  console.log(quote.hasAsk());   // false
  console.log(quote.spreadWidthOrZero());  // 0 (нет ask)
  console.log(quote.midOrNull());     // null (нет ask)

  console.log(QuoteFormatter.toDisplay(quote));
  // "0.5000 @ 100.00 / --"
}
```

### Ask-only котировка

```typescript
// Котировка только с ask стороной
const askResult = QuoteService.askOnly(0.51, 200, 'POLYMARKET_WS', 'TEST_MARKET');

if (askResult.ok) {
  const quote = askResult.value;

  console.log(quote.hasBid());   // false
  console.log(quote.hasAsk());   // true

  console.log(QuoteFormatter.toDisplay(quote));
  // "-- / 0.5100 @ 200.00"
}
```

## Создание котировок

### Из number значений

```typescript
// Самый простой способ
const result = QuoteService.create(0.48, 0.52, 100, 150, 'POLYMARKET_WS', 'TEST_MARKET');

// С кастомным timestamp
const timestampResult = QuoteService.create(
  0.48,
  0.52,
  100,
  150,
  'POLYMARKET_WS',
  'TEST_MARKET',
  new Date('2024-01-15T12:30:00Z')
);

// Текущее время
const nowResult = QuoteService.create(
  0.48, 0.52, 100, 150,
  'POLYMARKET_WS', 'TEST_MARKET',
  Date.now()
);
```

### Из Decimal значений

```typescript
import Decimal from 'decimal.js';

const result = QuoteService.create(
  new Decimal('0.48'),
  new Decimal('0.52'),
  new Decimal('100'),
  new Decimal('150'),
  'POLYMARKET_WS',
  'TEST_MARKET'
);
```

### One-sided котировки

```typescript
// Bid-only
const bid1 = QuoteService.bidOnly(0.50, 100, 'POLYMARKET_WS', 'TEST_MARKET');
const bid2 = QuoteService.bidOnly(new Decimal('0.50'), new Decimal('100'), 'POLYMARKET_WS', 'TEST_MARKET');

// Ask-only
const ask1 = QuoteService.askOnly(0.51, 200, 'POLYMARKET_WS', 'TEST_MARKET');
const ask2 = QuoteService.askOnly(new Decimal('0.51'), new Decimal('200'), 'POLYMARKET_WS', 'TEST_MARKET');
```

## Операции

### Shift (сдвиг котировки)

```typescript
import Decimal from 'decimal.js';

const quoteResult = QuoteService.create(0.48, 0.52, 100, 150, 'POLYMARKET_WS', 'TEST_MARKET');
if (!quoteResult.ok) return;

const quote = quoteResult.value;

// Сдвиг вверх на 0.01
const shiftedUp = QuoteService.shift(quote, new Decimal(0.01));
if (shiftedUp.ok) {
  const q = shiftedUp.value;
  console.log(q.bid()?.value().toNumber());  // 0.49
  console.log(q.ask()?.value().toNumber());  // 0.53
  console.log(q.spreadWidthOrZero().toNumber());  // 0.04 (сохранился!)
}

// Сдвиг вниз на 0.01
const shiftedDown = QuoteService.shift(quote, new Decimal(-0.01));
if (shiftedDown.ok) {
  const q = shiftedDown.value;
  console.log(q.bid()?.value().toNumber());  // 0.47
  console.log(q.ask()?.value().toNumber());  // 0.51
}
```

### Skew (независимый сдвиг)

```typescript
const quoteResult = QuoteService.create(0.48, 0.52, 100, 150, 'POLYMARKET_WS', 'TEST_MARKET');
if (!quoteResult.ok) return;

const quote = quoteResult.value;

// Bid вниз, ask вверх (расширение spread)
const wider = QuoteService.skew(
  quote,
  new Decimal(-0.01),  // bid вниз
  new Decimal(0.01)    // ask вверх
);

if (wider.ok) {
  const q = wider.value;
  console.log(q.bid()?.value().toNumber());  // 0.47
  console.log(q.ask()?.value().toNumber());  // 0.53
  console.log(q.spreadWidthOrZero().toNumber());  // 0.06 (увеличился!)
}

// Bid вверх, ask вниз (сужение spread)
const narrower = QuoteService.skew(
  quote,
  new Decimal(0.01),   // bid вверх
  new Decimal(-0.01)   // ask вниз
);

if (narrower.ok) {
  const q = narrower.value;
  console.log(q.spreadWidthOrZero().toNumber());  // 0.02 (уменьшился!)
}
```

### Update Sizes

```typescript
const quoteResult = QuoteService.create(0.48, 0.52, 100, 150, 'POLYMARKET_WS', 'TEST_MARKET');
if (!quoteResult.ok) return;

const quote = quoteResult.value;

// Обновление размеров из number
const updated1 = QuoteService.updateSizes(quote, 200, 300);
if (updated1.ok) {
  console.log(updated1.value.bidSize().value().toNumber());  // 200
  console.log(updated1.value.askSize().value().toNumber());  // 300
  // Prices остались прежними
  console.log(updated1.value.bid()?.value().toNumber());  // 0.48
  console.log(updated1.value.ask()?.value().toNumber());  // 0.52
}

// Обновление из Quantity
import { Quantity } from '@polymarket/value-objects/quantity';

const updated2 = QuoteService.updateSizes(
  quote,
  Quantity.of(500),
  Quantity.of(750)
);
```

## Валидация

### Проверка размеров

```typescript
import { ValidateQuoteSizes, QuoteErrorReason } from '@polymarket/value-objects/quote';
import { Price } from '@polymarket/value-objects/price';
import { Quantity } from '@polymarket/value-objects/quantity';

const bid = Price.of(0.48);
const bidSize = Quantity.of(100);
const ask = Price.of(0.52);
const askSize = Quantity.of(0);  // Невалидный размер!

const result = ValidateQuoteSizes.check(bid, bidSize, ask, askSize);

if (!result.ok) {
  console.error('Validation failed:', result.error.message);
  if (result.error.context?.reason === QuoteErrorReason.ASK_SIZE_MUST_BE_POSITIVE) {
    console.error('Ask size must be positive when ask price is defined');
  }
}
```

### Проверка spread

```typescript
import {
  ValidateMinSpread,
  ValidateMaxSpread,
  QuoteErrorReason
} from '@polymarket/value-objects/quote';
import Decimal from 'decimal.js';

const quoteResult = QuoteService.create(0.48, 0.52, 100, 150, 'POLYMARKET_WS', 'TEST_MARKET');
if (!quoteResult.ok) return;

const quote = quoteResult.value;
const spread = quote.spreadWidthOrZero();

// Минимальный spread: 1%
const minResult = ValidateMinSpread.check(spread, new Decimal(0.01));
if (minResult.ok) {
  console.log('Spread is wide enough');
}

// Максимальный spread: 10%
const maxResult = ValidateMaxSpread.check(spread, new Decimal(0.10));
if (maxResult.ok) {
  console.log('Spread is not too wide');
}

// Проверка spread в процентах
const spreadPct = quote.spreadPercentage();
if (spreadPct && spreadPct.toDecimal().lessThan(new Decimal(0.01))) {
  console.log('Spread less than 1%');
}
```

### Проверка market crossing

```typescript
import {
  ValidateMarketCrossing,
  QuoteErrorReason
} from '@polymarket/value-objects/quote';
import { Price } from '@polymarket/value-objects/price';

const quoteResult = QuoteService.create(0.48, 0.52, 100, 150, 'POLYMARKET_WS', 'TEST_MARKET');
if (!quoteResult.ok) return;

const quote = quoteResult.value;

// Orderbook: bid=0.50, ask=0.51
const orderbookBid = Price.of(0.50);
const orderbookAsk = Price.of(0.51);

const result = ValidateMarketCrossing.check(
  quote.bid(),
  quote.ask(),
  orderbookBid,
  orderbookAsk
);

if (!result.ok) {
  console.error('Market crossing detected!');
  console.error('Side:', result.error.context?.side);  // 'bid' | 'ask'

  if (result.error.context?.side === 'bid') {
    console.error('Quote bid crosses orderbook ask');
    console.error('Quote bid:', result.error.context?.quoteBid);
    console.error('Orderbook ask:', result.error.context?.orderbookAsk);
  }
}

// Или через boolean утилиту
const crosses = ValidateMarketCrossing.crossesMarket(quote, orderbookBid, orderbookAsk);
if (crosses) {
  console.log('Quote crosses market!');
}
```

## Форматирование

### Display формат

```typescript
import { QuoteFormatter } from '@polymarket/value-objects/quote';

const quoteResult = QuoteService.create(0.48, 0.52, 100, 150, 'POLYMARKET_WS', 'TEST_MARKET');
if (!quoteResult.ok) return;

const quote = quoteResult.value;

// Базовый формат
console.log(QuoteFormatter.toDisplay(quote));
// "0.4800 @ 100.00 / 0.5200 @ 150.00"

// С кастомной точностью
console.log(QuoteFormatter.toDisplay(quote, {
  priceDecimals: 2,
  sizeDecimals: 0
}));
// "0.48 @ 100 / 0.52 @ 150"

// С timestamp
console.log(QuoteFormatter.toDisplay(quote, {
  includeTimestamp: true
}));
// "0.4800 @ 100.00 / 0.5200 @ 150.00 [2024-01-15T12:30:00.000Z]"
```

### Short формат

```typescript
// Только цены
console.log(QuoteFormatter.toShort(quote));
// "0.4800/0.5200"

console.log(QuoteFormatter.toShort(quote, 2));
// "0.48/0.52"
```

### Detailed формат

```typescript
// Полный формат с spread и mid
console.log(QuoteFormatter.toDetailed(quote));
// "Bid: 0.4800 @ 100.00, Ask: 0.5200 @ 150.00, Spread: 0.0400 (8.00%), Mid: 0.5000"

// Без spread
console.log(QuoteFormatter.toDetailed(quote, {
  includeSpread: false
}));
// "Bid: 0.4800 @ 100.00, Ask: 0.5200 @ 150.00, Mid: 0.5000"

// Без mid
console.log(QuoteFormatter.toDetailed(quote, {
  includeMid: false
}));
// "Bid: 0.4800 @ 100.00, Ask: 0.5200 @ 150.00, Spread: 0.0400 (8.00%)"
```

### Table формат

```typescript
console.log(QuoteFormatter.toTable(quote));
// Side   Price    Size
// ────────────────────────────────────────
// Bid    0.4800   100.00
// Ask    0.5200   150.00
// ────────────────────────────────────────
// Spread 0.0400   (8.00%)
// Mid    0.5000

console.log(QuoteFormatter.toTable(quote, {
  includeTimestamp: true
}));
// ... (то же самое) ...
// ────────────────────────────────────────
// Time:  2024-01-15T12:30:00.000Z
```

### Format utilities

```typescript
// Форматирование spread
console.log(QuoteFormatter.formatSpread(quote));
// "0.0400 (8.00%)"

console.log(QuoteFormatter.formatSpread(quote, false));
// "0.0400"

// Форматирование mid
console.log(QuoteFormatter.formatMid(quote));
// "0.5000"

console.log(QuoteFormatter.formatMid(quote, 2));
// "0.50"
```

## Сериализация

### JSON serialization

```typescript
import { QuoteSerializer, type QuoteJSON } from '@polymarket/value-objects/quote';

const quoteResult = QuoteService.create(0.48, 0.52, 100, 150, 'POLYMARKET_WS', 'TEST_MARKET', 1234567890000);
if (!quoteResult.ok) return;

const quote = quoteResult.value;

// В JSON объект
const json: QuoteJSON = QuoteSerializer.toJSON(quote);
console.log(json);
// {
//   bid: 0.48,
//   ask: 0.52,
//   bidSize: 100,
//   askSize: 150,
//   timestamp: 1234567890000
// }

// В JSON строку
const jsonString = QuoteSerializer.toJSONString(quote);
console.log(jsonString);
// '{"bid":0.48,"ask":0.52,"bidSize":100,"askSize":150,"timestamp":1234567890000}'
```

### JSON deserialization

```typescript
// Из JSON объекта
const json: QuoteJSON = {
  bid: 0.48,
  ask: 0.52,
  bidSize: 100,
  askSize: 150,
  timestamp: 1234567890000
};

const result = QuoteSerializer.fromJSON(json);
if (result.ok) {
  const quote = result.value;
  console.log(quote.bid()?.value().toNumber());  // 0.48
}

// Из JSON строки
const jsonString = '{"bid":0.48,"ask":0.52,"bidSize":100,"askSize":150,"timestamp":1234567890000}';

const parseResult = QuoteSerializer.fromJSONString(jsonString);
if (parseResult.ok) {
  const quote = parseResult.value;
}
```

### Roundtrip

```typescript
// Создание → Сериализация → Десериализация
const original = QuoteService.create(0.48, 0.52, 100, 150, 'POLYMARKET_WS', 'TEST_MARKET', 1234567890000).value;

const jsonString = QuoteSerializer.toJSONString(original);
const restored = QuoteSerializer.fromJSONString(jsonString).value;

// equals() сравнивает рыночные данные
console.log(original.equals(restored));  // true

// equalsWithTimestamp() проверяет полную идентичность включая timestamp
console.log(original.equalsWithTimestamp(restored));  // true
```

## Error Handling

### Обработка ошибок создания

```typescript
import { QuoteErrorReason } from '@polymarket/value-objects/quote';

const result = QuoteService.create(0.60, 0.40, 100, 150, 'POLYMARKET_WS', 'TEST_MARKET');  // bid > ask

if (!result.ok) {
  const error = result.error;

  switch (error.context?.reason) {
    case QuoteErrorReason.BOTH_SIDES_NULL:
      console.error('Хотя бы одна сторона должна быть определена');
      break;

    case QuoteErrorReason.BID_GREATER_THAN_ASK:
      console.error('Bid не может быть больше ask');
      console.error('Bid:', error.context?.bidValue);
      console.error('Ask:', error.context?.askValue);
      break;

    case QuoteErrorReason.INVALID_FORMAT:
      console.error('Ошибка парсинга:', error.context?.raw);
      break;

    case QuoteErrorReason.INVALID_BID:
      console.error('Невалидный bid:', error.context?.component);
      // Проверить root cause
      if (error.context?.cause) {
        console.error('Причина:', error.context.cause.message);
      }
      break;

    default:
      console.error('Неизвестная ошибка:', error.message);
  }

  // Operation chain для диагностики
  console.error('Operation chain:', error.context?.opChain);
  // ['create', 'create']
}
```

### Обработка ошибок операций

```typescript
const quoteResult = QuoteService.create(0.98, 0.99, 100, 150, 'POLYMARKET_WS', 'TEST_MARKET');
if (!quoteResult.ok) return;

const quote = quoteResult.value;

// Shift за пределы диапазона
const shiftResult = QuoteService.shift(quote, new Decimal(0.10));

if (!shiftResult.ok) {
  const error = shiftResult.error;

  console.error('Shift failed:', error.message);
  console.error('Reason:', error.context?.reason);  // INVALID_BID
  console.error('Operation chain:', error.context?.opChain);
  // ['shift', 'create', 'create:bid']

  // Можно увидеть где именно произошла ошибка
  console.error('Failed at:', error.context?.op);  // 'shift'
  console.error('Delta:', error.context?.delta);   // 0.10
}
```

## Real-world сценарии

### Market Making Bot

```typescript
import {
  QuoteService,
  QuoteFormatter,
  ValidateMarketCrossing,
  ValidateMaxSpread
} from '@polymarket/value-objects/quote';
import { Price } from '@polymarket/value-objects/price';
import Decimal from 'decimal.js';

class MarketMaker {
  private maxSpread = new Decimal(0.10);  // 10%

  async updateQuote(
    marketMid: number,
    inventory: number,
    orderbookBid: number,
    orderbookAsk: number
  ) {
    // Базовый spread: 2%
    const baseSpread = new Decimal(0.02);

    // Inventory skew: если много купили, сдвигаем котировку вверх
    const inventorySkew = new Decimal(inventory).mul(0.0001);

    // Вычисление bid/ask
    const mid = new Decimal(marketMid);
    const halfSpread = baseSpread.div(2);

    const bidPrice = mid.sub(halfSpread).add(inventorySkew);
    const askPrice = mid.add(halfSpread).add(inventorySkew);

    // Создание котировки
    const quoteResult = QuoteService.create(
      bidPrice,
      askPrice,
      new Decimal(1000),  // bidSize
      new Decimal(1000),  // askSize
      'POLYMARKET_WS',    // sourceId
      'TEST_MARKET'       // instrumentId
    );

    if (!quoteResult.ok) {
      console.error('Failed to create quote:', quoteResult.error.message);
      return null;
    }

    const quote = quoteResult.value;

    // Валидация spread
    const spreadCheck = ValidateMaxSpread.check(
      quote.spreadWidthOrZero(),
      this.maxSpread
    );

    if (!spreadCheck.ok) {
      const spreadPct = quote.spreadPercentage();
      const pctDisplay = spreadPct ? (spreadPct.toDecimal().toNumber() * 100).toFixed(2) : 'N/A';
      console.error('Spread too wide:', pctDisplay, '%');
      return null;
    }

    // Валидация crossing
    const crossingCheck = ValidateMarketCrossing.check(
      quote.bid(),
      quote.ask(),
      Price.of(orderbookBid),
      Price.of(orderbookAsk)
    );

    if (!crossingCheck.ok) {
      console.error('Quote crosses market on', crossingCheck.error.context?.side);
      return null;
    }

    // Отправка котировки
    console.log('New quote:', QuoteFormatter.toDisplay(quote));
    return quote;
  }
}

// Использование
const mm = new MarketMaker();
await mm.updateQuote(
  0.50,    // market mid
  100,     // inventory (купили 100)
  0.49,    // orderbook bid
  0.51     // orderbook ask
);
```

### Quote Aggregator

```typescript
import { QuoteService, QuoteFormatter } from '@polymarket/value-objects/quote';
import Decimal from 'decimal.js';

class QuoteAggregator {
  aggregateQuotes(quotes: Quote[]): Quote | null {
    if (quotes.length === 0) return null;

    // Лучший bid (максимальный)
    let bestBidPrice: Decimal | null = null;
    let bestBidSize = new Decimal(0);

    // Лучший ask (минимальный)
    let bestAskPrice: Decimal | null = null;
    let bestAskSize = new Decimal(0);

    for (const quote of quotes) {
      // Агрегация bid
      if (quote.hasBid()) {
        const bidPrice = quote.bid()!.value();
        if (bestBidPrice === null || bidPrice.greaterThan(bestBidPrice)) {
          bestBidPrice = bidPrice;
          bestBidSize = quote.bidSize().value();
        } else if (bidPrice.equals(bestBidPrice)) {
          bestBidSize = bestBidSize.add(quote.bidSize().value());
        }
      }

      // Агрегация ask
      if (quote.hasAsk()) {
        const askPrice = quote.ask()!.value();
        if (bestAskPrice === null || askPrice.lessThan(bestAskPrice)) {
          bestAskPrice = askPrice;
          bestAskSize = quote.askSize().value();
        } else if (askPrice.equals(bestAskPrice)) {
          bestAskSize = bestAskSize.add(quote.askSize().value());
        }
      }
    }

    // Создание агрегированной котировки
    const result = QuoteService.create(
      bestBidPrice,
      bestAskPrice,
      bestBidSize,
      bestAskSize,
      'POLYMARKET_WS',  // sourceId
      'TEST_MARKET'     // instrumentId
    );

    return result.ok ? result.value : null;
  }
}

// Использование
const aggregator = new QuoteAggregator();

const quote1 = QuoteService.create(0.48, 0.52, 100, 150, 'POLYMARKET_WS', 'TEST_MARKET').value;
const quote2 = QuoteService.create(0.49, 0.51, 200, 100, 'POLYMARKET_WS', 'TEST_MARKET').value;
const quote3 = QuoteService.create(0.47, 0.53, 150, 200, 'POLYMARKET_WS', 'TEST_MARKET').value;

const aggregated = aggregator.aggregateQuotes([quote1, quote2, quote3]);

if (aggregated) {
  console.log('Aggregated quote:', QuoteFormatter.toDisplay(aggregated));
  // Best bid: 0.49 @ 200, Best ask: 0.51 @ 100
  // "0.4900 @ 200.00 / 0.5100 @ 100.00"
}
```

### Quote Monitoring

```typescript
import { QuoteService, QuoteFormatter, ValidateMaxSpread } from '@polymarket/value-objects/quote';
import Decimal from 'decimal.js';

class QuoteMonitor {
  private maxAllowedSpread = new Decimal(0.05);  // 5%
  private alerts: string[] = [];

  checkQuote(quote: Quote) {
    this.alerts = [];

    // 1. Проверка spread
    if (quote.isTwoSided()) {
      const spread = quote.spreadWidthOrZero();
      const spreadPct = quote.spreadPercentage();

      const spreadCheck = ValidateMaxSpread.check(spread, this.maxAllowedSpread);
      if (!spreadCheck.ok) {
        const pctDisplay = spreadPct ? (spreadPct.toDecimal().toNumber() * 100).toFixed(2) : 'N/A';
        this.alerts.push(`Spread too wide: ${pctDisplay}%`);
      }
    }

    // 2. Проверка размеров
    const bidSize = quote.bidSize().value();
    const askSize = quote.askSize().value();
    const minSize = new Decimal(10);

    if (quote.hasBid() && bidSize.lessThan(minSize)) {
      this.alerts.push(`Bid size too small: ${bidSize.toNumber()}`);
    }

    if (quote.hasAsk() && askSize.lessThan(minSize)) {
      this.alerts.push(`Ask size too small: ${askSize.toNumber()}`);
    }

    // 3. Проверка устаревания
    const now = Date.now();
    const age = now - quote.timestampMs().toNumber();
    const maxAge = 5000;  // 5 секунд

    if (age > maxAge) {
      this.alerts.push(`Quote is stale: ${age}ms old`);
    }

    // Отчёт
    if (this.alerts.length > 0) {
      console.error('Quote alerts:');
      this.alerts.forEach(alert => console.error('  -', alert));
      console.error('Quote:', QuoteFormatter.toDetailed(quote));
      return false;
    }

    console.log('Quote OK:', QuoteFormatter.toShort(quote));
    return true;
  }
}

// Использование
const monitor = new QuoteMonitor();

const quote1 = QuoteService.create(0.45, 0.55, 100, 150, 'POLYMARKET_WS', 'TEST_MARKET').value;  // Wide spread
const quote2 = QuoteService.create(0.48, 0.52, 5, 150, 'POLYMARKET_WS', 'TEST_MARKET').value;    // Small bid size
const quote3 = QuoteService.create(0.48, 0.52, 100, 150, 'POLYMARKET_WS', 'TEST_MARKET', Date.now() - 10000).value;  // Stale

monitor.checkQuote(quote1);  // Alert: spread too wide
monitor.checkQuote(quote2);  // Alert: bid size too small
monitor.checkQuote(quote3);  // Alert: quote is stale
```

### Quote Storage

```typescript
import {
  QuoteService,
  QuoteSerializer,
  type QuoteJSON
} from '@polymarket/value-objects/quote';

class QuoteStorage {
  private quotes: Map<string, QuoteJSON> = new Map();

  saveQuote(marketId: string, quote: Quote) {
    const json = QuoteSerializer.toJSON(quote);
    this.quotes.set(marketId, json);

    // Persist to database
    // await db.quotes.upsert({ marketId, ...json });
  }

  loadQuote(marketId: string): Quote | null {
    const json = this.quotes.get(marketId);
    if (!json) return null;

    const result = QuoteSerializer.fromJSON(json);
    return result.ok ? result.value : null;
  }

  exportQuotes(): string {
    const data = Array.from(this.quotes.entries()).map(([marketId, json]) => ({
      marketId,
      ...json
    }));

    return JSON.stringify(data, null, 2);
  }

  importQuotes(jsonString: string) {
    const data = JSON.parse(jsonString);

    for (const item of data) {
      const { marketId, ...json } = item;
      this.quotes.set(marketId, json as QuoteJSON);
    }
  }
}

// Использование
const storage = new QuoteStorage();

const quote = QuoteService.create(0.48, 0.52, 100, 150, 'POLYMARKET_WS', 'TEST_MARKET').value;
storage.saveQuote('market-123', quote);

const loaded = storage.loadQuote('market-123');
// equals() сравнивает рыночные данные (timestamp сохранён через JSON)
console.log(loaded?.equals(quote));  // true

// Export/Import
const exported = storage.exportQuotes();
console.log(exported);
// [
//   {
//     "marketId": "market-123",
//     "bid": 0.48,
//     "ask": 0.52,
//     "bidSize": 100,
//     "askSize": 150,
//     "timestamp": 1234567890000
//   }
// ]
```

## См. также

- [README.md](./README.md) — обзор и API reference
- [architecture.md](./architecture.md) — детали архитектуры
- [facade.md](./facade.md) — Facade Layer детали
