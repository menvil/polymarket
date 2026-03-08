# InvalidSpreadError

Ошибка валидации спреда между bid и ask ценами.

## Описание

Спред (Spread) представляет разницу между ask и bid ценами на рынке prediction markets. Спред всегда должен быть **неотрицательным**, т.е. **ask >= bid**.

Отрицательный спред означает "crossed market" - ситуацию, когда кто-то готов купить дороже, чем кто-то готов продать, что приведёт к немедленному исполнению ордеров.

## Свойства

| Свойство | Значение |
|----------|----------|
| **Код** | `INVALID_SPREAD` |
| **Severity** | `low` |
| **Класс** | `InvalidSpreadError` |
| **Пакет** | `@polymarket/errors` |
| **Категория** | Value Objects |

## Когда использовать

- Создание value object `Spread` из рыночных данных
- Валидация спреда перед размещением котировки
- Операции корректировки спреда (tighten, widen, shift)
- Парсинг данных из orderbook
- Расчёт метрик маркет-мейкинга

## Импорт

```typescript
import { InvalidSpreadError } from '@polymarket/errors';

// Для примеров с Result<T,E>:
import { Result, Ok, Err } from '@polymarket/result';
```

---

## Примеры использования

### 1. Базовое использование (throw)

```typescript
import { InvalidSpreadError } from '@polymarket/errors';

class Spread {
  constructor(
    public readonly bid: Price,
    public readonly ask: Price
  ) {
    if (bid.value > ask.value) {
      throw new InvalidSpreadError(
        (ctx) => `Invalid spread: bid (${ctx.bid}) must be <= ask (${ctx.ask})`,
        {
          code: InvalidSpreadError.code,
          context: { bid: bid.value, ask: ask.value }
        }
      );
    }
  }
}

// Использование
try {
  const spread = new Spread(
    Price.fromValue(0.66), // bid
    Price.fromValue(0.64)  // ask - crossed market!
  );
} catch (error) {
  if (InvalidSpreadError.is(error)) {
    console.error('Invalid spread:', error.message);
    console.error('Context:', error.context);
    // Invalid spread: bid (0.66) must be <= ask (0.64)
    // Context: { bid: 0.66, ask: 0.64 }
  }
}
```

### 2. С Result<T,E> (рекомендуется)

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidSpreadError } from '@polymarket/errors';

class Spread {
  private constructor(
    public readonly bid: Price,
    public readonly ask: Price
  ) {}

  static create(bid: Price, ask: Price): Result<Spread, InvalidSpreadError> {
    if (bid.value > ask.value) {
      return Err(
        new InvalidSpreadError(
          (ctx) => `Invalid spread: bid (${ctx.bid}) must be <= ask (${ctx.ask})`,
          {
            code: InvalidSpreadError.code,
            context: { bid: bid.value, ask: ask.value }
          }
        )
      );
    }

    return Ok(new Spread(bid, ask));
  }

  get value(): number {
    return this.ask.value - this.bid.value;
  }
}

// Использование
const result = Spread.create(
  unwrap(Price.fromValue(0.64)),
  unwrap(Price.fromValue(0.66))
);

if (result.ok) {
  const spread = result.value;
  console.log('Spread value:', spread.value); // 0.02
} else {
  console.error('Invalid spread:', result.error.message);
  console.error('Error code:', result.error.code);
}
```

### 3. Операции корректировки спреда

```typescript
import { Result, Ok, Err, unwrap } from '@polymarket/result';
import { InvalidSpreadError } from '@polymarket/errors';

class Spread {
  // ... конструктор и поля

  /**
   * Сужает спред (приближает bid и ask друг к другу)
   */
  tighten(amount: number): Result<Spread, InvalidSpreadError> {
    const newBidResult = this.bid.add(amount);
    const newAskResult = this.ask.subtract(amount);

    if (!newBidResult.ok || !newAskResult.ok) {
      return Err(
        new InvalidSpreadError('Failed to tighten spread: price adjustment error', {
          code: InvalidSpreadError.code,
          context: { amount, currentSpread: this.value }
        })
      );
    }

    return Spread.create(newBidResult.value, newAskResult.value);
  }

  /**
   * Расширяет спред (отдаляет bid и ask друг от друга)
   */
  widen(amount: number): Result<Spread, InvalidSpreadError> {
    const newBidResult = this.bid.subtract(amount);
    const newAskResult = this.ask.add(amount);

    if (!newBidResult.ok || !newAskResult.ok) {
      return Err(
        new InvalidSpreadError('Failed to widen spread: price adjustment error', {
          code: InvalidSpreadError.code,
          context: { amount, currentSpread: this.value }
        })
      );
    }

    return Spread.create(newBidResult.value, newAskResult.value);
  }

  /**
   * Сдвигает спред вверх или вниз (сохраняя ширину)
   */
  shift(amount: number): Result<Spread, InvalidSpreadError> {
    const adjustMethod = amount >= 0 ? 'add' : 'subtract';
    const absAmount = Math.abs(amount);

    const newBidResult = this.bid[adjustMethod](absAmount);
    const newAskResult = this.ask[adjustMethod](absAmount);

    if (!newBidResult.ok || !newAskResult.ok) {
      return Err(
        new InvalidSpreadError('Failed to shift spread: price adjustment error', {
          code: InvalidSpreadError.code,
          context: { amount, currentSpread: this.value }
        })
      );
    }

    return Spread.create(newBidResult.value, newAskResult.value);
  }
}

// Использование
const spread = unwrap(Spread.create(
  unwrap(Price.fromValue(0.64)),
  unwrap(Price.fromValue(0.66))
));

console.log('Original spread:', spread.value); // 0.02

// Сужение спреда
const tightenedResult = spread.tighten(0.005);
if (tightenedResult.ok) {
  console.log('Tightened spread:', tightenedResult.value.value); // 0.01
}

// Попытка сузить слишком сильно
const overtightenResult = spread.tighten(0.02);
if (!overtightenResult.ok) {
  console.error('Cannot tighten:', overtightenResult.error.message);
  // Cannot tighten: Invalid spread: bid (0.66) must be <= ask (0.64)
}
```

### 4. Валидация рыночных данных

```typescript
import { Result, Ok, Err, unwrap } from '@polymarket/result';
import { InvalidSpreadError } from '@polymarket/errors';

interface OrderbookSnapshot {
  bestBid: number | null;
  bestAsk: number | null;
  timestamp: number;
}

function parseOrderbook(
  snapshot: OrderbookSnapshot
): Result<Spread | null, InvalidSpreadError> {
  // Нет данных
  if (snapshot.bestBid === null || snapshot.bestAsk === null) {
    return Ok(null);
  }

  const bidResult = Price.fromValue(snapshot.bestBid);
  const askResult = Price.fromValue(snapshot.bestAsk);

  if (!bidResult.ok || !askResult.ok) {
    return Err(
      new InvalidSpreadError('Invalid orderbook prices', {
        code: InvalidSpreadError.code,
        context: { bestBid: snapshot.bestBid, bestAsk: snapshot.bestAsk }
      })
    );
  }

  // Создание Spread с валидацией
  return Spread.create(bidResult.value, askResult.value);
}

// Использование
const snapshot: OrderbookSnapshot = {
  bestBid: 0.65,
  bestAsk: 0.64, // Crossed market!
  timestamp: Date.now()
};

const spreadResult = parseOrderbook(snapshot);
if (!spreadResult.ok) {
  console.error('Invalid orderbook:', spreadResult.error.message);
  console.error('This indicates a crossed market - orders will execute immediately');
  // Invalid orderbook: Invalid spread: bid (0.65) must be <= ask (0.64)
}
```

### 5. Метрики маркет-мейкинга

```typescript
import { Result, Ok, Err, unwrap } from '@polymarket/result';
import { InvalidSpreadError } from '@polymarket/errors';

interface MarketMetrics {
  spread: number;
  spreadBps: number; // basis points
  midPrice: number;
  isHealthy: boolean;
}

function calculateMetrics(
  bid: Price,
  ask: Price
): Result<MarketMetrics, InvalidSpreadError> {
  const spreadResult = Spread.create(bid, ask);
  if (!spreadResult.ok) {
    return Err(spreadResult.error);
  }

  const spread = spreadResult.value;
  const midPrice = (bid.value + ask.value) / 2;
  const spreadBps = (spread.value / midPrice) * 10000;

  return Ok({
    spread: spread.value,
    spreadBps,
    midPrice,
    isHealthy: spreadBps < 200 // Спред < 2%
  });
}

// Использование
const metricsResult = calculateMetrics(
  unwrap(Price.fromValue(0.64)),
  unwrap(Price.fromValue(0.66))
);

if (metricsResult.ok) {
  const metrics = metricsResult.value;
  console.log('Market metrics:', metrics);
  // {
  //   spread: 0.02,
  //   spreadBps: 307.69,
  //   midPrice: 0.65,
  //   isHealthy: false
  // }
}
```

---

## Best Practices

### DO ✅

```typescript
// Используйте Result<T,E> для всех операций со спредом
static create(bid: Price, ask: Price): Result<Spread, InvalidSpreadError> {
  if (bid.value > ask.value) {
    return Err(new InvalidSpreadError(...));
  }
  return Ok(new Spread(bid, ask));
}

// Добавляйте контекст для отладки
return Err(
  new InvalidSpreadError(
    (ctx) => `Invalid spread: bid (${ctx.bid}) must be <= ask (${ctx.ask})`,
    {
      code: InvalidSpreadError.code,
      context: { bid: bid.value, ask: ask.value }
    }
  )
);

// Проверяйте результаты операций корректировки
const tightenedResult = spread.tighten(0.01);
if (!tightenedResult.ok) {
  console.error('Cannot tighten spread:', tightenedResult.error.message);
  // Обработка ошибки
}

// Валидируйте рыночные данные перед использованием
const spreadResult = Spread.create(bestBid, bestAsk);
if (!spreadResult.ok) {
  // Это crossed market - нужна особая обработка
  handleCrossedMarket();
}
```

### DON'T ❌

```typescript
// Не выбрасывайте ошибки напрямую
throw new InvalidSpreadError('Invalid spread'); // ❌

// Не игнорируйте контекст
return Err(new InvalidSpreadError('Invalid spread')); // ❌ Нет контекста

// Не создавайте спред без валидации
const spread = new Spread(bid, ask); // ❌ Обходит валидацию

// Не игнорируйте crossed markets
if (bid > ask) {
  // Просто логируем и продолжаем
  console.warn('Crossed market detected');
  // ❌ Нужно обработать это как ошибку!
}

// Правильно:
const spreadResult = Spread.create(bid, ask);
if (!spreadResult.ok) {
  if (spreadResult.error.code === InvalidSpreadError.code) {
    // Специфичная обработка для crossed market
    handleCrossedMarket(spreadResult.error);
  }
}
```

---

## Детали реализации

### Почему bid > ask - это ошибка?

Когда bid > ask, это называется "crossed market" или "locked market":

- **Crossed market** (bid > ask): Кто-то готов купить дороже, чем кто-то готов продать
- **Locked market** (bid = ask): Bid и ask совпадают

Обе ситуации приводят к **немедленному исполнению ордеров**. На нормально функционирующих биржах такие ситуации:

1. Либо исполняются моментально
2. Либо блокируются системой риск-менеджмента

Поэтому спред всегда должен быть **строго неотрицательным** (ask >= bid).

### Использование в маркет-мейкинге

Маркет-мейкеры используют спред для:

- **Profit margin**: Разница между ценой покупки и продажи
- **Risk management**: Более широкий спред = больше защита от adverse selection
- **Inventory management**: Корректировка спреда на основе текущей позиции

Типичные операции:

```typescript
// Расширение спреда при высокой волатильности
const widened = unwrap(spread.widen(0.01));

// Сужение спреда для повышения вероятности исполнения
const tightened = unwrap(spread.tighten(0.005));

// Сдвиг спреда при движении рынка
const shifted = unwrap(spread.shift(+0.02));
```

---

## См. также

- [InvalidQuoteError](./invalid-quote.md) - Ошибка валидации котировки
- [InvalidPriceError](./invalid-price.md) - Ошибка валидации цены
- [Value Objects Errors](./README.md) - Обзор всех ошибок value objects
