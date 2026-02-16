# InvalidTickSizeError

Ошибка невалидного размера тика (tick size) в операциях округления.

## Описание

Выбрасывается когда `tickSize <= 0` или не является конечным числом (`NaN`, `Infinity`).

**Tick size** - это минимальный шаг изменения цены на рынке. Например:

- Tick size `0.01` означает что цена может быть `10.50`, `10.51`, но не `10.505`
- Tick size `0.0001` означает что цена может быть `0.6543`, но не `0.65435`

Tick size должен быть **положительным конечным числом**, иначе невозможно выполнить корректное округление.

## Свойства

| Свойство | Значение |
|----------|----------|
| **Код** | `INVALID_TICK_SIZE` |
| **Severity** | `low` |
| **Класс** | `InvalidTickSizeError` |
| **Пакет** | `@polymarket/errors` |
| **Категория** | Math |

## Когда использовать

- Округление цен к минимальному шагу (tick)
- Валидация tick size перед операциями округления
- Создание price grid для книги ордеров
- Нормализация пользовательского ввода цен

## Импорт

```typescript
import { InvalidTickSizeError } from '@polymarket/errors';

// Для примеров с Decimal:
import Decimal from 'decimal.js';
```

---

## Примеры использования

### 1. Базовое округление к tick size

```typescript
import Decimal from 'decimal.js';
import { InvalidTickSizeError } from '@polymarket/errors';

function roundToTickSize(value: Decimal, tickSize: Decimal): Decimal {
  // Валидация tick size
  if (!tickSize.isFinite()) {
    throw new InvalidTickSizeError(
      (ctx) => `Tick size must be finite, got ${ctx.tickSize}`,
      {
        code: InvalidTickSizeError.code,
        context: { tickSize: tickSize.toString(), value: value.toString() }
      }
    );
  }

  if (tickSize.isNegative() || tickSize.isZero()) {
    throw new InvalidTickSizeError(
      (ctx) => `Tick size must be positive, got ${ctx.tickSize}`,
      {
        code: InvalidTickSizeError.code,
        context: { tickSize: tickSize.toString(), value: value.toString() }
      }
    );
  }

  // Округление: (value / tickSize).round() * tickSize
  return value.dividedBy(tickSize).round().times(tickSize);
}

// Использование
const rounded = roundToTickSize(
  new Decimal('10.567'),
  new Decimal('0.01')
); // ✅ 10.57

const rounded2 = roundToTickSize(
  new Decimal('0.65432'),
  new Decimal('0.0001')
); // ✅ 0.6543
```

### 2. С разными стратегиями округления

```typescript
import Decimal from 'decimal.js';
import { InvalidTickSizeError } from '@polymarket/errors';

type RoundingMode = 'round' | 'floor' | 'ceil';

function roundToTickSizeWithMode(
  value: Decimal,
  tickSize: Decimal,
  mode: RoundingMode = 'round'
): Decimal {
  // Валидация tick size
  if (!tickSize.isFinite() || tickSize.isNegative() || tickSize.isZero()) {
    throw new InvalidTickSizeError(
      (ctx) => `Tick size must be finite and positive, got ${ctx.tickSize}`,
      {
        code: InvalidTickSizeError.code,
        context: { tickSize: tickSize.toString(), value: value.toString() }
      }
    );
  }

  const divided = value.dividedBy(tickSize);

  let rounded: Decimal;
  switch (mode) {
    case 'floor':
      rounded = divided.floor();
      break;
    case 'ceil':
      rounded = divided.ceil();
      break;
    case 'round':
    default:
      rounded = divided.round();
      break;
  }

  return rounded.times(tickSize);
}

// Использование
const value = new Decimal('10.567');
const tickSize = new Decimal('0.01');

roundToTickSizeWithMode(value, tickSize, 'round'); // ✅ 10.57
roundToTickSizeWithMode(value, tickSize, 'floor'); // ✅ 10.56
roundToTickSizeWithMode(value, tickSize, 'ceil');  // ✅ 10.57
```

### 3. Создание Price с tick size

```typescript
import Decimal from 'decimal.js';
import { InvalidTickSizeError, InvalidPriceError } from '@polymarket/errors';
import { Result, Ok, Err } from '@polymarket/result';

class Price {
  private constructor(
    private readonly value: Decimal,
    private readonly tickSize: Decimal
  ) {}

  static create(
    value: Decimal,
    tickSize: Decimal
  ): Result<Price, InvalidTickSizeError | InvalidPriceError> {
    // Валидация tick size
    if (!tickSize.isFinite() || tickSize.isNegative() || tickSize.isZero()) {
      return Err(
        new InvalidTickSizeError(
          (ctx) => `Tick size must be finite and positive, got ${ctx.tickSize}`,
          {
            code: InvalidTickSizeError.code,
            context: { tickSize: tickSize.toString() }
          }
        )
      );
    }

    // Валидация что value кратен tick size
    const divided = value.dividedBy(tickSize);
    if (!divided.equals(divided.round())) {
      return Err(
        new InvalidPriceError(
          (ctx) => `Price ${ctx.value} is not a multiple of tick size ${ctx.tickSize}`,
          {
            code: InvalidPriceError.code,
            context: {
              value: value.toString(),
              tickSize: tickSize.toString()
            }
          }
        )
      );
    }

    return Ok(new Price(value, tickSize));
  }

  getValue(): Decimal {
    return this.value;
  }

  getTickSize(): Decimal {
    return this.tickSize;
  }
}

// Использование
const result = Price.create(
  new Decimal('10.57'),
  new Decimal('0.01')
);

if (result.ok) {
  console.log('Valid price:', result.value.getValue().toString());
} else {
  console.error('Error:', result.error.message);
}
```

### 4. Price grid для order book

```typescript
import Decimal from 'decimal.js';
import { InvalidTickSizeError } from '@polymarket/errors';

function generatePriceGrid(
  startPrice: Decimal,
  endPrice: Decimal,
  tickSize: Decimal
): Decimal[] {
  // Валидация tick size
  if (!tickSize.isFinite() || tickSize.isNegative() || tickSize.isZero()) {
    throw new InvalidTickSizeError(
      (ctx) => `Tick size must be finite and positive, got ${ctx.tickSize}`,
      {
        code: InvalidTickSizeError.code,
        context: {
          tickSize: tickSize.toString(),
          startPrice: startPrice.toString(),
          endPrice: endPrice.toString()
        }
      }
    );
  }

  const prices: Decimal[] = [];
  let currentPrice = startPrice;

  while (currentPrice.lessThanOrEqualTo(endPrice)) {
    prices.push(currentPrice);
    currentPrice = currentPrice.plus(tickSize);
  }

  return prices;
}

// Использование
const grid = generatePriceGrid(
  new Decimal('0.50'),
  new Decimal('0.55'),
  new Decimal('0.01')
);
// ✅ [0.50, 0.51, 0.52, 0.53, 0.54, 0.55]
```

### 5. Нормализация пользовательского ввода

```typescript
import Decimal from 'decimal.js';
import { InvalidTickSizeError, InvalidPriceError } from '@polymarket/errors';
import { Result, Ok, Err } from '@polymarket/result';

function normalizeUserPrice(
  userInput: string,
  tickSize: Decimal
): Result<Decimal, InvalidTickSizeError | InvalidPriceError> {
  // Валидация tick size
  if (!tickSize.isFinite() || tickSize.isNegative() || tickSize.isZero()) {
    return Err(
      new InvalidTickSizeError(
        (ctx) => `Tick size must be finite and positive, got ${ctx.tickSize}`,
        {
          code: InvalidTickSizeError.code,
          context: { tickSize: tickSize.toString(), input: userInput }
        }
      )
    );
  }

  try {
    const value = new Decimal(userInput);

    // Округляем к ближайшему tick
    const normalized = value.dividedBy(tickSize).round().times(tickSize);

    return Ok(normalized);
  } catch (error) {
    return Err(
      new InvalidPriceError(
        (ctx) => `Invalid price input: ${ctx.input}`,
        {
          code: InvalidPriceError.code,
          context: { input: userInput, error: String(error) }
        }
      )
    );
  }
}

// Использование
const result = normalizeUserPrice('10.567', new Decimal('0.01'));

result.match({
  ok: (normalized) => console.log('Normalized:', normalized.toString()), // "10.57"
  err: (error) => console.error('Error:', error.message)
});
```

---

## Edge Cases

### Невалидные tick sizes

```typescript
import Decimal from 'decimal.js';

// Ноль
roundToTickSize(
  new Decimal('10.5'),
  new Decimal('0')
);                              // ❌ InvalidTickSizeError

// Отрицательное число
roundToTickSize(
  new Decimal('10.5'),
  new Decimal('-0.01')
);                              // ❌ InvalidTickSizeError

// NaN
roundToTickSize(
  new Decimal('10.5'),
  new Decimal('NaN')
);                              // ❌ InvalidTickSizeError

// Infinity
roundToTickSize(
  new Decimal('10.5'),
  new Decimal('Infinity')
);                              // ❌ InvalidTickSizeError
```

### Валидные tick sizes

```typescript
// Стандартные tick sizes
roundToTickSize(
  new Decimal('10.567'),
  new Decimal('0.01')
);                              // ✅ 10.57

// Очень малый tick size
roundToTickSize(
  new Decimal('0.123456789'),
  new Decimal('0.00000001')
);                              // ✅ 0.12345679

// Tick size = 1 (целые числа)
roundToTickSize(
  new Decimal('10.567'),
  new Decimal('1')
);                              // ✅ 11

// Дробный tick size
roundToTickSize(
  new Decimal('10.567'),
  new Decimal('0.333')
);                              // ✅ 10.656 (10.567 / 0.333 = 31.732... → 32 → 32 * 0.333 = 10.656)
```

### Граничные случаи округления

```typescript
const tickSize = new Decimal('0.01');

// Ровно посередине между тиками
roundToTickSize(
  new Decimal('10.565'),
  tickSize
);                              // ✅ 10.57 (ROUND_HALF_UP: .5 округляется вверх)

// Чуть выше нижнего тика
roundToTickSize(
  new Decimal('10.561'),
  tickSize
);                              // ✅ 10.56

// Чуть ниже верхнего тика
roundToTickSize(
  new Decimal('10.569'),
  tickSize
);                              // ✅ 10.57
```

---

## Обработка ошибок

### По типу ошибки

```typescript
import { InvalidTickSizeError } from '@polymarket/errors';

try {
  const rounded = roundToTickSize(value, tickSize);
} catch (error) {
  if (InvalidTickSizeError.is(error)) {
    console.error('Invalid tick size:', error.context);
    showUserMessage('Configuration error: invalid tick size');
  } else {
    console.error('Unexpected error:', error);
    throw error;
  }
}
```

### По коду ошибки

```typescript
import { InvalidTickSizeError, TradingError } from '@polymarket/errors';

try {
  const grid = generatePriceGrid(start, end, tickSize);
} catch (error) {
  if (error instanceof TradingError) {
    if (error.code === InvalidTickSizeError.code) {
      logger.error('Invalid tick size in price grid generation', {
        error: error.toJSON()
      });
      return [];
    }
  }
  throw error;
}
```

### С fallback значением

```typescript
import { InvalidTickSizeError } from '@polymarket/errors';

function safeRoundToTickSize(
  value: Decimal,
  tickSize: Decimal,
  fallback: Decimal = new Decimal('0.01')
): Decimal {
  try {
    return roundToTickSize(value, tickSize);
  } catch (error) {
    if (InvalidTickSizeError.is(error)) {
      logger.warn('Invalid tick size, using fallback', {
        requested: tickSize.toString(),
        fallback: fallback.toString(),
        error: error.toJSON()
      });
      return roundToTickSize(value, fallback);
    }
    throw error;
  }
}

// Использование
const rounded = safeRoundToTickSize(
  new Decimal('10.567'),
  userProvidedTickSize,
  new Decimal('0.01') // fallback к стандартному tick size
);
```

### Валидация конфигурации

```typescript
import Decimal from 'decimal.js';
import { InvalidTickSizeError } from '@polymarket/errors';
import { Result, Ok, Err } from '@polymarket/result';

interface MarketConfig {
  minPrice: Decimal;
  maxPrice: Decimal;
  tickSize: Decimal;
}

function validateMarketConfig(
  config: MarketConfig
): Result<MarketConfig, InvalidTickSizeError> {
  // Валидация tick size
  if (!config.tickSize.isFinite() ||
      config.tickSize.isNegative() ||
      config.tickSize.isZero()) {
    return Err(
      new InvalidTickSizeError(
        (ctx) => `Market tick size must be finite and positive, got ${ctx.tickSize}`,
        {
          code: InvalidTickSizeError.code,
          context: {
            tickSize: config.tickSize.toString(),
            minPrice: config.minPrice.toString(),
            maxPrice: config.maxPrice.toString()
          }
        }
      )
    );
  }

  return Ok(config);
}

// Использование при инициализации рынка
const configResult = validateMarketConfig(marketConfig);

configResult.match({
  ok: (config) => initializeMarket(config),
  err: (error) => {
    logger.error('Invalid market configuration', { error: error.toJSON() });
    throw error;
  }
});
```

---

## Связанные ошибки

- [InvalidDivisorError](./invalid-divisor.md) - невалидный делитель (используется внутри операций с tick size)
- [InvalidPriceError](../value-objects/invalid-price.md) - цена не кратна tick size
- [ArithmeticOverflowError](../value-objects/arithmetic-overflow.md) - результат округления вышел за пределы

## См. также

- [Math Errors](./README.md) - Обзор категории
- [Обработка ошибок](../error-handling.md) - Best practices
- [Главная документация](../README.md)
