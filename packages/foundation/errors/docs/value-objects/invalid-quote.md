# InvalidQuoteError

Ошибка валидации котировки маркет-мейкера.

## Описание

Котировка (Quote) представляет двухстороннюю или одностороннюю котировку маркет-мейкера для prediction markets. Котировка должна удовлетворять строгим правилам валидности:

- Хотя бы одна сторона (bid или ask) должна присутствовать
- Для двухсторонних котировок: **bid < ask**
- Размеры (bidSize, askSize) должны быть неотрицательными
- Если bid = null, то bidSize должен быть 0
- Если ask = null, то askSize должен быть 0

## Свойства

| Свойство | Значение |
|----------|----------|
| **Код** | `INVALID_QUOTE` |
| **Severity** | `low` |
| **Класс** | `InvalidQuoteError` |
| **Пакет** | `@polymarket/errors` |
| **Категория** | Value Objects |

## Когда использовать

- Создание value object `Quote` из рыночных данных
- Валидация котировки перед размещением на биржу
- Парсинг котировок из API/WebSocket
- Корректировка котировок (inventory skew, spread adjustment)
- Десериализация из JSON

## Импорт

```typescript
import { InvalidQuoteError } from '@polymarket/errors';

// Для примеров с Result<T,E>:
import { Result, Ok, Err } from '@polymarket/result';
```

---

## Примеры использования

### 1. Базовое использование (throw)

```typescript
import { InvalidQuoteError } from '@polymarket/errors';

class Quote {
  constructor(
    public readonly bid: OutcomePrice | null,
    public readonly ask: OutcomePrice | null,
    public readonly bidSize: Quantity,
    public readonly askSize: Quantity
  ) {
    // Валидация: должна быть хотя бы одна сторона
    if (!bid && !ask) {
      throw new InvalidQuoteError('Quote must have at least bid or ask', {
        code: InvalidQuoteError.code
      });
    }

    // Валидация: bid < ask для двухсторонних котировок
    if (bid && ask && bid.value >= ask.value) {
      throw new InvalidQuoteError(
        (ctx) => `Bid ${ctx.bid} must be less than ask ${ctx.ask}`,
        {
          code: InvalidQuoteError.code,
          context: { bid: bid.value, ask: ask.value }
        }
      );
    }
  }
}

// Использование
try {
  const quote = new Quote(
    OutcomePrice.fromValue(0.66),
    OutcomePrice.fromValue(0.64), // ask < bid - невалидно!
    Quantity.fromValue(100),
    Quantity.fromValue(100)
  );
} catch (error) {
  if (InvalidQuoteError.is(error)) {
    console.error('Invalid quote:', error.message);
    console.error('Context:', error.context);
    // Invalid quote: Bid 0.66 must be less than ask 0.64
    // Context: { bid: 0.66, ask: 0.64 }
  }
}
```

### 2. С Result<T,E> (рекомендуется)

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidQuoteError } from '@polymarket/errors';

class Quote {
  private constructor(
    public readonly bid: OutcomePrice | null,
    public readonly ask: OutcomePrice | null,
    public readonly bidSize: Quantity,
    public readonly askSize: Quantity,
    public readonly timestamp: Date
  ) {}

  static create(
    bid: OutcomePrice | null,
    ask: OutcomePrice | null,
    bidSize: Quantity,
    askSize: Quantity,
    timestamp: Date = new Date()
  ): Result<Quote, InvalidQuoteError> {
    // Валидация: должна быть хотя бы одна сторона
    if (!bid && !ask) {
      return Err(
        new InvalidQuoteError('Quote must have at least bid or ask', {
          code: InvalidQuoteError.code
        })
      );
    }

    // Валидация: bid < ask для двухсторонних котировок
    if (bid && ask && bid.value >= ask.value) {
      return Err(
        new InvalidQuoteError(
          (ctx) => `Bid ${ctx.bid} must be less than ask ${ctx.ask}`,
          {
            code: InvalidQuoteError.code,
            context: { bid: bid.value, ask: ask.value }
          }
        )
      );
    }

    // Валидация: размеры должны соответствовать ценам
    if (!bid && !bidSize.isZero()) {
      return Err(
        new InvalidQuoteError('Bid size must be 0 when bid price is null', {
          code: InvalidQuoteError.code,
          context: { bidSize: bidSize.value }
        })
      );
    }

    if (!ask && !askSize.isZero()) {
      return Err(
        new InvalidQuoteError('Ask size must be 0 when ask price is null', {
          code: InvalidQuoteError.code,
          context: { askSize: askSize.value }
        })
      );
    }

    return Ok(new Quote(bid, ask, bidSize, askSize, timestamp));
  }
}

// Использование
const result = Quote.create(
  unwrap(OutcomePrice.fromValue(0.66)),
  unwrap(OutcomePrice.fromValue(0.64)),
  unwrap(Quantity.fromValue(100)),
  unwrap(Quantity.fromValue(100))
);

if (result.ok) {
  const quote = result.value;
  console.log('Valid quote:', quote.toString());
} else {
  console.error('Invalid quote:', result.error.message);
  console.error('Error code:', result.error.code);
  // Invalid quote: Bid 0.66 must be less than ask 0.64
  // Error code: INVALID_QUOTE
}
```

### 3. Валидация корректировки котировок

```typescript
import { Result, Ok, Err, unwrap } from '@polymarket/result';
import { InvalidQuoteError } from '@polymarket/errors';

class Quote {
  // ... конструктор и поля

  withAdjustment(
    bidAdjustment: number,
    askAdjustment: number
  ): Result<Quote, InvalidQuoteError> {
    const adjustPrice = (
      price: OutcomePrice,
      adjustment: number,
      priceType: 'bid' | 'ask'
    ): Result<OutcomePrice, InvalidQuoteError> => {
      const result = adjustment >= 0
        ? price.add(adjustment)
        : price.subtract(Math.abs(adjustment));

      if (!result.ok) {
        return Err(
          new InvalidQuoteError(
            (ctx) => `Failed to adjust ${ctx.priceType} price: ${ctx.error}`,
            {
              code: InvalidQuoteError.code,
              context: {
                priceType,
                originalPrice: price.value,
                adjustment,
                error: result.error.message
              }
            }
          )
        );
      }

      return Ok(result.value);
    };

    let newBid: OutcomePrice | null = null;
    if (this.bid) {
      const bidResult = adjustPrice(this.bid, bidAdjustment, 'bid');
      if (!bidResult.ok) return Err(bidResult.error);
      newBid = bidResult.value;
    }

    let newAsk: OutcomePrice | null = null;
    if (this.ask) {
      const askResult = adjustPrice(this.ask, askAdjustment, 'ask');
      if (!askResult.ok) return Err(askResult.error);
      newAsk = askResult.value;
    }

    return Quote.create(newBid, newAsk, this.bidSize, this.askSize, new Date());
  }
}

// Использование
const quote = unwrap(Quote.create(
  unwrap(OutcomePrice.fromValue(0.64)),
  unwrap(OutcomePrice.fromValue(0.66)),
  unwrap(Quantity.fromValue(100)),
  unwrap(Quantity.fromValue(100))
));

// Корректировка может привести к невалидной котировке
const adjustedResult = quote.withAdjustment(+0.05, -0.10);
if (!adjustedResult.ok) {
  console.error('Adjustment resulted in invalid quote:', adjustedResult.error.message);
  // Adjustment resulted in invalid quote: Bid 0.69 must be less than ask 0.56
}
```

### 4. Десериализация из JSON

```typescript
import { Result, Ok, Err, unwrap } from '@polymarket/result';
import { InvalidQuoteError } from '@polymarket/errors';

class Quote {
  // ... конструктор и поля

  static fromJSON(json: {
    bid: number | null;
    ask: number | null;
    bidSize: number;
    askSize: number;
    timestamp: string;
  }): Result<Quote, InvalidQuoteError> {
    // Парсинг цен
    let bid: OutcomePrice | null = null;
    if (json.bid !== null) {
      const bidResult = OutcomePrice.fromValue(json.bid);
      if (!bidResult.ok) {
        return Err(
          new InvalidQuoteError(
            (ctx) => `Invalid bid price: ${ctx.error}`,
            {
              code: InvalidQuoteError.code,
              context: { bid: json.bid, error: bidResult.error.message }
            }
          )
        );
      }
      bid = bidResult.value;
    }

    let ask: OutcomePrice | null = null;
    if (json.ask !== null) {
      const askResult = OutcomePrice.fromValue(json.ask);
      if (!askResult.ok) {
        return Err(
          new InvalidQuoteError(
            (ctx) => `Invalid ask price: ${ctx.error}`,
            {
              code: InvalidQuoteError.code,
              context: { ask: json.ask, error: askResult.error.message }
            }
          )
        );
      }
      ask = askResult.value;
    }

    // Создание котировки с валидацией
    return Quote.create(
      bid,
      ask,
      unwrap(Quantity.fromValue(json.bidSize, 0)),
      unwrap(Quantity.fromValue(json.askSize, 0)),
      new Date(json.timestamp)
    );
  }
}

// Использование
const response = await fetch('/api/quotes/123');
const json = await response.json();

const quoteResult = Quote.fromJSON(json);
if (quoteResult.ok) {
  console.log('Loaded quote:', quoteResult.value.toString());
} else {
  console.error('Invalid quote data:', quoteResult.error.message);
  console.error('Context:', quoteResult.error.context);
}
```

---

## Best Practices

### DO ✅

```typescript
// Используйте Result<T,E> для всех фабричных методов
static create(...): Result<Quote, InvalidQuoteError> {
  // Валидация с явным возвратом ошибки
  if (!bid && !ask) {
    return Err(new InvalidQuoteError(...));
  }
  return Ok(new Quote(...));
}

// Добавляйте контекст для отладки
return Err(
  new InvalidQuoteError(
    (ctx) => `Bid ${ctx.bid} must be less than ask ${ctx.ask}`,
    {
      code: InvalidQuoteError.code,
      context: { bid: bid.value, ask: ask.value }
    }
  )
);

// Проверяйте тип ошибки при обработке
if (!result.ok) {
  if (result.error.code === InvalidQuoteError.code) {
    // Специфичная обработка для невалидных котировок
  }
}
```

### DON'T ❌

```typescript
// Не выбрасывайте ошибки напрямую
throw new InvalidQuoteError('Invalid quote'); // ❌

// Не игнорируйте контекст
return Err(new InvalidQuoteError('Invalid quote')); // ❌ Нет контекста

// Не создавайте котировки без валидации
const quote = new Quote(bid, ask, bidSize, askSize); // ❌ Обходит валидацию

// Правильно:
const result = Quote.create(bid, ask, bidSize, askSize);
if (!result.ok) {
  // Обработка ошибки
}
```

---

## См. также

- [InvalidSpreadError](./invalid-spread.md) - Ошибка валидации спреда
- [InvalidOutcomePriceError](./invalid-price.md) - Ошибка валидации цены
- [InvalidQuantityError](./invalid-quantity.md) - Ошибка валидации количества
- [Value Objects Errors](./README.md) - Обзор всех ошибок value objects
