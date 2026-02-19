# Примеры использования Spread

> Практические примеры реальных сценариев использования Spread Value Object

## Содержание

1. [Базовые операции](#базовые-операции)
2. [Работа с ордербуком](#работа-с-ордербуком)
3. [Маркет-мейкинг](#маркет-мейкинг)
4. [Анализ ликвидности](#анализ-ликвидности)
5. [Интеграция с UI](#интеграция-с-ui)
6. [Обработка ошибок](#обработка-ошибок)

---

## Базовые операции

### Создание спреда из API данных

```typescript
import { SpreadService, SpreadFormatter } from '@polymarket/value-objects';

interface OrderBookData {
  bestBid: string;
  bestAsk: string;
}

function parseOrderBook(data: OrderBookData) {
  const spreadResult = SpreadService.fromValues(
    parseFloat(data.bestBid),
    parseFloat(data.bestAsk)
  );
  
  if (!spreadResult.ok) {
    return {
      error: `Невалидный ордербук: ${spreadResult.error.message}`,
      spread: null
    };
  }
  
  const spread = spreadResult.value;
  
  return {
    error: null,
    spread,
    display: SpreadFormatter.format(spread, { decimals: 4 }),
    midPrice: spread.mid().toNumber(),
    spreadBps: spread.widthInBasisPoints().toFixed(0)
  };
}

// Пример использования
const data = { bestBid: '0.4823', bestAsk: '0.5177' };
const result = parseOrderBook(data);

console.log(result);
// {
//   error: null,
//   spread: Spread { ... },
//   display: "0.4823-0.5177 (0.0354)",
//   midPrice: 0.5,
//   spreadBps: "354"
// }
```

---

## Работа с ордербуком

### Отображение топа ордербука

```typescript
import { SpreadService, SpreadFormatter } from '@polymarket/value-objects';

interface OrderBookLevel {
  price: number;
  size: number;
}

interface OrderBook {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

function displayOrderBookTop(orderBook: OrderBook) {
  if (orderBook.bids.length === 0 || orderBook.asks.length === 0) {
    return 'Ордербук пуст';
  }
  
  const bestBid = orderBook.bids[0].price;
  const bestAsk = orderBook.asks[0].price;
  
  const spreadResult = SpreadService.fromValues(bestBid, bestAsk);
  
  if (!spreadResult.ok) {
    return `Error: ${spreadResult.error.message}`;
  }
  
  const spread = spreadResult.value;
  
  return {
    bid: {
      price: spread.bid().toNumber(),
      size: orderBook.bids[0].size,
      probability: (spread.bid().toNumber() * 100).toFixed(2) + '%'
    },
    ask: {
      price: spread.ask().toNumber(),
      size: orderBook.asks[0].size,
      probability: (spread.ask().toNumber() * 100).toFixed(2) + '%'
    },
    spread: {
      width: spread.width().toNumber(),
      widthBps: spread.widthInBasisPoints().toFixed(0),
      midPrice: spread.mid().toNumber(),
      display: SpreadFormatter.toBidAskString(spread, 4)
    }
  };
}

// Пример
const orderBook: OrderBook = {
  bids: [
    { price: 0.4850, size: 1000 },
    { price: 0.4840, size: 500 }
  ],
  asks: [
    { price: 0.5150, size: 800 },
    { price: 0.5160, size: 600 }
  ]
};

console.log(displayOrderBookTop(orderBook));
// {
//   bid: { price: 0.4850, size: 1000, probability: '48.50%' },
//   ask: { price: 0.5150, size: 800, probability: '51.50%' },
//   spread: {
//     width: 0.03,
//     widthBps: '300',
//     midPrice: 0.50,
//     display: '0.4850-0.5150'
//   }
// }
```

### Проверка crossed orderbook

```typescript
import { SpreadService, SpreadErrorReason } from '@polymarket/value-objects';

function validateOrderBook(bestBid: number, bestAsk: number) {
  const result = SpreadService.fromValues(bestBid, bestAsk);
  
  if (!result.ok) {
    const ctx = result.error.context;
    
    if (ctx?.reason === SpreadErrorReason.BID_GREATER_THAN_ASK) {
      return {
        valid: false,
        error: 'CROSSED_BOOK',
        message: `Crossed orderbook detected: bid ${ctx.bid} > ask ${ctx.ask}`,
        arbitrageOpportunity: true
      };
    }
    
    return {
      valid: false,
      error: 'INVALID_PRICES',
      message: result.error.message,
      arbitrageOpportunity: false
    };
  }
  
  return {
    valid: true,
    error: null,
    spread: result.value
  };
}

// Примеры
console.log(validateOrderBook(0.48, 0.52));  // { valid: true, ... }
console.log(validateOrderBook(0.55, 0.45));  // { valid: false, error: 'CROSSED_BOOK', ... }
```

---

## Маркет-мейкинг

### Динамическое управление спредом

```typescript
import { SpreadService, Spread, InvalidSpreadError } from '@polymarket/value-objects';
import type { Result } from '@polymarket/result';

interface MarketConditions {
  volatility: number;      // 0-1
  volume24h: number;       // в USD
  inventorySkew: number;   // -1 to 1
}

function calculateOptimalSpread(
  fairValue: number,
  conditions: MarketConditions
): Result<Spread, InvalidSpreadError> {
  // Базовый спред: 1% (100 bps)
  let baseSpreadBps = 100;
  
  // Увеличение за волатильность
  baseSpreadBps += conditions.volatility * 200;
  
  // Уменьшение за объём торгов
  const volumeFactor = Math.min(conditions.volume24h / 100000, 1);
  baseSpreadBps *= (1 - volumeFactor * 0.5);
  
  // Абсолютная ширина спреда
  const spreadWidth = fairValue * (baseSpreadBps / 10000);
  
  // Начальный симметричный спред
  const halfWidth = spreadWidth / 2;
  let bid = fairValue - halfWidth;
  let ask = fairValue + halfWidth;
  
  // Применяем skew для inventory management
  const skewAdjustment = conditions.inventorySkew * halfWidth * 0.3;
  bid += skewAdjustment;
  ask += skewAdjustment;
  
  return SpreadService.fromValues(bid, ask);
}

// Пример использования
const conditions: MarketConditions = {
  volatility: 0.3,      // Средняя волатильность
  volume24h: 50000,     // $50k объём
  inventorySkew: 0.2    // Небольшой long bias
};

const spreadResult = calculateOptimalSpread(0.50, conditions);

if (spreadResult.ok) {
  const spread = spreadResult.value;
  console.log({
    bid: spread.bid().toNumber(),
    ask: spread.ask().toNumber(),
    width: spread.width().toNumber(),
    widthBps: spread.widthInBasisPoints().toFixed(0)
  });
  // {
  //   bid: 0.49718,
  //   ask: 0.50318,
  //   width: 0.006,
  //   widthBps: '60'
  // }
}
```

### Постепенное сужение спреда

```typescript
import { SpreadService, Spread } from '@polymarket/value-objects';

function* tightenSpreadGradually(
  initialSpread: Spread,
  targetWidthBps: number,
  steps: number
) {
  const initialWidthBps = initialSpread.widthInBasisPoints().toNumber();
  const stepSizeBps = (initialWidthBps - targetWidthBps) / steps;

  let currentSpread = initialSpread;

  for (let i = 0; i < steps; i++) {
    // Convert bps step to absolute per-side amount:
    // widthInBasisPoints = width × 10000, so width = stepSizeBps / 10000
    // tighten() takes per-side amount, so divide by 2
    const absoluteStep = stepSizeBps / 10000;
    const tightenAmount = absoluteStep / 2;

    const result = SpreadService.tighten(currentSpread, tightenAmount);

    if (!result.ok) {
      console.error(`Step ${i}: Failed to tighten - ${result.error.message}`);
      break;
    }

    currentSpread = result.value;

    yield {
      step: i + 1,
      spread: currentSpread,
      widthBps: currentSpread.widthInBasisPoints().toFixed(0)
    };
  }
}

// Пример: сужаем спред от 1000 bps до 50 bps за 5 шагов
const initialSpreadResult = SpreadService.fromValues(0.45, 0.55);

if (initialSpreadResult.ok) {
  for (const update of tightenSpreadGradually(initialSpreadResult.value, 50, 5)) {
    console.log(`Step ${update.step}: ${update.widthBps} bps`);
    console.log(`  Bid: ${update.spread.bid().toNumber()}`);
    console.log(`  Ask: ${update.spread.ask().toNumber()}`);
  }
}
```

---

## Анализ ликвидности

### Расчёт метрик ликвидности

```typescript
import { SpreadService, Spread } from '@polymarket/value-objects';

interface LiquidityMetrics {
  spreadBps: number;
  liquidityScore: 'HIGH' | 'MEDIUM' | 'LOW';
  recommendedOrderSize: number;
  slippageEstimate1k: number;
}

function analyzeLiquidity(spread: Spread, depth: number): LiquidityMetrics {
  const widthBps = spread.widthInBasisPoints().toNumber();

  // Определяем score на основе ширины спреда
  let liquidityScore: LiquidityMetrics['liquidityScore'];
  if (widthBps < 50) {
    liquidityScore = 'HIGH';
  } else if (widthBps < 200) {
    liquidityScore = 'MEDIUM';
  } else {
    liquidityScore = 'LOW';
  }
  
  // Рекомендуемый размер ордера (консервативно)
  const recommendedOrderSize = depth * 0.1;  // 10% от глубины
  
  // Оценка slippage для $1k ордера
  const slippageEstimate1k = (1000 / depth) * widthBps * 0.01;
  
  return {
    spreadBps: Number(widthBps.toFixed(0)),
    liquidityScore,
    recommendedOrderSize: Number(recommendedOrderSize.toFixed(0)),
    slippageEstimate1k: Number(slippageEstimate1k.toFixed(2))
  };
}

// Пример
const spreadResult = SpreadService.fromValues(0.4900, 0.5100);
if (spreadResult.ok) {
  const metrics = analyzeLiquidity(spreadResult.value, 10000);
  console.log(metrics);
  // {
  //   spreadBps: 200,
  //   liquidityScore: 'LOW',
  //   recommendedOrderSize: 1000,
  //   slippageEstimate1k: 0.20
  // }
}
```

### Сравнение спредов на разных рынках

```typescript
import { SpreadService, Spread } from '@polymarket/value-objects';

interface Market {
  id: string;
  name: string;
  bid: number;
  ask: number;
}

function compareMarketLiquidity(markets: Market[]) {
  return markets
    .map(market => {
      const spreadResult = SpreadService.fromValues(market.bid, market.ask);
      
      if (!spreadResult.ok) {
        return null;
      }
      
      const spread = spreadResult.value;
      
      return {
        marketId: market.id,
        marketName: market.name,
        widthBps: spread.widthInBasisPoints().toNumber(),
        midPrice: spread.mid().toNumber(),
        spread
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null)
    .sort((a, b) => a.widthBps - b.widthBps);  // Сортировка по ликвидности
}

// Пример
const markets: Market[] = [
  { id: '1', name: 'Market A', bid: 0.48, ask: 0.52 },
  { id: '2', name: 'Market B', bid: 0.49, ask: 0.51 },
  { id: '3', name: 'Market C', bid: 0.45, ask: 0.55 }
];

const ranked = compareMarketLiquidity(markets);
console.log(ranked.map(m => ({
  name: m.marketName,
  widthBps: m.widthBps.toFixed(0)
})));
// [
//   { name: 'Market B', widthBps: '200' },  // Самый ликвидный
//   { name: 'Market A', widthBps: '400' },
//   { name: 'Market C', widthBps: '1000' }
// ]
```

---

## Интеграция с UI

### React компонент для отображения спреда

```typescript
import React from 'react';
import { SpreadService, SpreadFormatter, Spread } from '@polymarket/value-objects';

interface SpreadDisplayProps {
  bid: number;
  ask: number;
}

export const SpreadDisplay: React.FC<SpreadDisplayProps> = ({ bid, ask }) => {
  const spreadResult = SpreadService.fromValues(bid, ask);
  
  if (!spreadResult.ok) {
    return (
      <div className="spread-error">
        <span className="error-icon">⚠️</span>
        <span>{spreadResult.error.message}</span>
      </div>
    );
  }
  
  const spread = spreadResult.value;
  const widthBps = spread.widthInBasisPoints().toNumber();

  // Цветовая индикация ликвидности
  const liquidityColor = 
    widthBps < 50 ? 'green' :
    widthBps < 200 ? 'yellow' : 'red';
  
  return (
    <div className="spread-display">
      <div className="prices">
        <span className="bid">{spread.bid().toNumber().toFixed(4)}</span>
        <span className="separator">–</span>
        <span className="ask">{spread.ask().toNumber().toFixed(4)}</span>
      </div>
      
      <div className="metrics">
        <div className="mid-price">
          Mid: {spread.mid().toNumber().toFixed(4)}
        </div>
        <div className={`spread-width ${liquidityColor}`}>
          Spread: {widthBps.toFixed(0)} bps
        </div>
      </div>
    </div>
  );
};
```

### Форматирование для таблиц

```typescript
import { SpreadService, SpreadFormatter } from '@polymarket/value-objects';

function formatSpreadForTable(bid: number, ask: number) {
  const spreadResult = SpreadService.fromValues(bid, ask);
  
  if (!spreadResult.ok) {
    return {
      display: 'N/A',
      bidDisplay: 'N/A',
      askDisplay: 'N/A',
      midDisplay: 'N/A',
      widthDisplay: 'N/A',
      error: spreadResult.error.message
    };
  }
  
  const spread = spreadResult.value;
  const obj = SpreadFormatter.toObject(spread);
  
  return {
    display: SpreadFormatter.format(spread, { decimals: 4, showWidth: false }),
    bidDisplay: obj.bid.toFixed(4),
    askDisplay: obj.ask.toFixed(4),
    midDisplay: obj.midpoint.toFixed(4),
    widthDisplay: `${obj.width.times(100).toFixed(2)}%`,
    widthBps: spread.widthInBasisPoints().toFixed(0),
    error: null
  };
}

// Пример для таблицы
console.table([
  formatSpreadForTable(0.48, 0.52),
  formatSpreadForTable(0.49, 0.51),
  formatSpreadForTable(0.45, 0.55)
]);
```

---

## Обработка ошибок

### Валидация пользовательского ввода

```typescript
import { SpreadService, SpreadErrorReason } from '@polymarket/value-objects';

function validateUserSpread(bidInput: string, askInput: string) {
  const result = SpreadService.fromValues(bidInput, askInput);

  if (!result.ok) {
    const ctx = result.error.context;

    // Проверяем reason из вложенной ошибки (может быть из PriceService)
    switch (ctx?.reason) {
      case SpreadErrorReason.BID_GREATER_THAN_ASK:
        return {
          valid: false,
          field: 'both',
          message: `Bid (${ctx.bid}) не может быть больше Ask (${ctx.ask})`
        };

      default:
        return {
          valid: false,
          field: 'both',
          message: 'Невалидные значения спреда'
        };
    }
  }
  
  return {
    valid: true,
    spread: result.value
  };
}

// Примеры
console.log(validateUserSpread('0.48', '0.52'));
// { valid: true, spread: Spread { ... } }

console.log(validateUserSpread('1.5', '0.52'));
// { valid: false, field: 'both', message: 'Невалидные значения спреда' }

console.log(validateUserSpread('0.60', '0.50'));
// { valid: false, field: 'both', message: 'Bid (0.6) не может быть больше Ask (0.5)' }
```

### Graceful degradation при ошибках API

```typescript
import { SpreadService, SpreadFormatter } from '@polymarket/value-objects';

interface APIResponse {
  bid?: number;
  ask?: number;
  lastTrade?: number;
}

function displayMarketData(data: APIResponse) {
  // Попытка создать спред
  if (data.bid !== undefined && data.ask !== undefined) {
    const spreadResult = SpreadService.fromValues(data.bid, data.ask);
    
    if (spreadResult.ok) {
      return {
        type: 'spread',
        display: SpreadFormatter.format(spreadResult.value, { decimals: 4 }),
        midPrice: spreadResult.value.mid().toNumber()
      };
    }
  }
  
  // Fallback: показываем last trade price
  if (data.lastTrade !== undefined) {
    return {
      type: 'lastTrade',
      display: `Last: ${data.lastTrade.toFixed(4)}`,
      midPrice: data.lastTrade
    };
  }
  
  // Полный fallback
  return {
    type: 'unavailable',
    display: 'Market data unavailable',
    midPrice: null
  };
}

// Примеры
console.log(displayMarketData({ bid: 0.48, ask: 0.52 }));
// { type: 'spread', display: '0.4800-0.5200 (0.0400)', midPrice: 0.50 }

console.log(displayMarketData({ lastTrade: 0.51 }));
// { type: 'lastTrade', display: 'Last: 0.5100', midPrice: 0.51 }

console.log(displayMarketData({}));
// { type: 'unavailable', display: 'Market data unavailable', midPrice: null }
```

---

## Performance оптимизации

### Кэширование вычислений

```typescript
import { Spread, SpreadService, type InvalidSpreadError } from '@polymarket/value-objects';
import type { Result } from '@polymarket/result';
import { Ok } from '@polymarket/result';

class SpreadCache {
  private cache = new Map<string, Spread>();
  
  private getKey(bid: number, ask: number): string {
    return `${bid}_${ask}`;
  }
  
  getOrCreate(bid: number, ask: number): Result<Spread, InvalidSpreadError> {
    const key = this.getKey(bid, ask);
    
    const cached = this.cache.get(key);
    if (cached) {
      return Ok(cached);
    }
    
    const result = SpreadService.fromValues(bid, ask);
    
    if (result.ok) {
      this.cache.set(key, result.value);
    }
    
    return result;
  }
  
  clear() {
    this.cache.clear();
  }
}

// Использование
const cache = new SpreadCache();

// Первый вызов — создаёт и кэширует
const spread1 = cache.getOrCreate(0.48, 0.52);

// Второй вызов — берёт из кэша
const spread2 = cache.getOrCreate(0.48, 0.52);
```

---

## Строгие сравнения

### Проверка идентичности спредов

Spread использует **строгие** сравнения через `equals()`:

```typescript
import { SpreadService } from '@polymarket/value-objects';

const spread1 = SpreadService.fromValues(0.48, 0.52);
const spread2 = SpreadService.fromValues(0.48, 0.52);

if (spread1.ok && spread2.ok) {
  // Строгое сравнение — точное совпадение bid и ask
  console.log(spread1.value.equals(spread2.value));  // true

  // Объектная идентичность — разные экземпляры
  console.log(spread1.value === spread2.value);  // false
}
```

### Валидация результатов операций

```typescript
import { SpreadService } from '@polymarket/value-objects';

const original = SpreadService.fromValues(0.48, 0.52).value;

// Операция tighten
const tightened = SpreadService.tighten(original, 0.01).value;

// Проверка результата — строгое сравнение
const expected = SpreadService.fromValues(0.49, 0.51).value;
console.log(tightened.equals(expected));  // true — точное совпадение

// Неточное совпадение НЕ считается равным
const almostSame = SpreadService.fromValues(0.49000001, 0.51).value;
console.log(tightened.equals(almostSame));  // false
```

### Тестирование со строгими сравнениями

```typescript
import { SpreadService } from '@polymarket/value-objects';

describe('Spread operations', () => {
  it('should tighten spread correctly', () => {
    const spread = SpreadService.fromValues(0.48, 0.52).value;
    const result = SpreadService.tighten(spread, 0.01);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // ✅ Строгое сравнение без epsilon
      expect(result.value.bid().value().toNumber()).toBe(0.49);
      expect(result.value.ask().value().toNumber()).toBe(0.51);
      expect(result.value.width().toNumber()).toBe(0.02);

      // ❌ НЕ используйте toBeCloseTo()
      // expect(result.value.width().toNumber()).toBeCloseTo(0.02, 10);
    }
  });
});
```

### Почему строгие сравнения?

**Преимущества:**

- ✅ Предсказуемость — нет сюрпризов с epsilon
- ✅ Детерминированность — результат всегда одинаковый
- ✅ Type-safety — Decimal.js гарантирует точность
- ✅ Финансовая точность — важна до последнего знака
- ✅ Простота — не нужно выбирать epsilon

**Когда это важно:**

```typescript
// Проверка после сериализации/десериализации
const original = SpreadService.fromValues(0.48, 0.52).value;
const json = SpreadSerializer.toJSON(original);
const restored = SpreadSerializer.fromJSON(json).value;

// Roundtrip должен быть идентичным
console.log(original.equals(restored));  // true — точное восстановление
```

---

## Дальнейшее чтение

- [Facade API](./facade.md) — полное описание SpreadService
- [Core Layer](./core.md) — детали Spread класса
- [Адаптеры](./adapters.md) — сериализация и форматирование
- [Архитектура](./architecture.md) — архитектурные решения
