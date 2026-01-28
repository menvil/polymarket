# InvalidDecimalPlacesError

Ошибка невалидного количества десятичных знаков в операциях округления.

## Описание

Выбрасывается при попытке округления с невалидным количеством знаков после запятой:
- Отрицательное число (`-1`, `-5`)
- Не целое число (`1.5`, `2.7`)
- Не конечное число (`NaN`, `Infinity`, `-Infinity`)

Это математическая невозможность, а не бизнес-правило. Округление к дробному или отрицательному количеству знаков не имеет математического смысла.

**Decimal places (количество знаков)** определяет сколько цифр после запятой будет в результате округления:
- `decimalPlaces = 0` → целое число (`10`)
- `decimalPlaces = 2` → два знака (`10.57`)
- `decimalPlaces = 4` → четыре знака (`10.5670`)

Decimal places должен быть **неотрицательным целым числом**, иначе невозможно выполнить корректное округление.

## Свойства

| Свойство | Значение |
|----------|----------|
| **Код** | `INVALID_DECIMAL_PLACES` |
| **Severity** | `low` |
| **Класс** | `InvalidDecimalPlacesError` |
| **Пакет** | `@polymarket/errors` |
| **Категория** | Math |

## Когда использовать

- Округление значений до указанного количества знаков
- Валидация параметра `decimalPlaces` перед округлением
- Форматирование чисел для вывода пользователю
- Нормализация цен и количеств

## Импорт

```typescript
import { InvalidDecimalPlacesError } from '@polymarket/errors';

// Для примеров с Decimal:
import Decimal from 'decimal.js';
```

---

## Примеры использования

### 1. Базовое округление с валидацией

```typescript
import Decimal from 'decimal.js';
import { InvalidOperandError, InvalidDecimalPlacesError } from '@polymarket/errors';

function roundToPrecision(
  value: Decimal,
  decimalPlaces: number,
  roundingMode: Decimal.Rounding
): Decimal {
  // Валидация value
  if (!value.isFinite()) {
    throw new InvalidOperandError(
      (ctx) => `Value must be finite, got ${ctx.value}`,
      {
        context: {
          value: value.toString(),
          decimalPlaces: String(decimalPlaces),
          operation: 'roundToPrecision'
        }
      }
    );
  }

  // Валидация decimalPlaces через Decimal
  const decimalPlacesDecimal = new Decimal(decimalPlaces);

  if (!decimalPlacesDecimal.isFinite() ||
      decimalPlacesDecimal.isNegative() ||
      !decimalPlacesDecimal.isInteger()) {
    throw new InvalidDecimalPlacesError(
      (ctx) => `Decimal places must be a non-negative integer, got ${ctx.decimalPlaces}`,
      {
        context: {
          decimalPlaces: decimalPlacesDecimal.toString(),
          value: value.toString(),
          operation: 'roundToPrecision'
        }
      }
    );
  }

  return value.toDecimalPlaces(decimalPlaces, roundingMode);
}

// Использование
try {
  const rounded = roundToPrecision(
    new Decimal('10.567'),
    2,
    Decimal.ROUND_HALF_UP
  ); // ✅ 10.57
} catch (error) {
  if (InvalidDecimalPlacesError.is(error)) {
    console.error('Invalid decimal places:', error.context?.decimalPlaces);
  }
}
```

### 2. Форматирование для отображения

```typescript
import Decimal from 'decimal.js';
import { InvalidDecimalPlacesError } from '@polymarket/errors';

function formatPrice(price: Decimal, decimals: number): string {
  // Валидация decimals
  const decimalsDecimal = new Decimal(decimals);

  if (!decimalsDecimal.isFinite() ||
      decimalsDecimal.isNegative() ||
      !decimalsDecimal.isInteger()) {
    throw new InvalidDecimalPlacesError(
      (ctx) => `Decimals for formatting must be a non-negative integer, got ${ctx.decimalPlaces}`,
      {
        context: {
          decimalPlaces: decimalsDecimal.toString(),
          value: price.toString(),
          operation: 'formatPrice'
        }
      }
    );
  }

  const rounded = price.toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);
  return rounded.toFixed(decimals);
}

// Использование
const formatted = formatPrice(new Decimal('0.65432'), 2); // ✅ "0.65"
```

### 3. Округление с разными режимами

```typescript
import Decimal from 'decimal.js';
import { InvalidDecimalPlacesError } from '@polymarket/errors';

function roundWithMode(
  value: Decimal,
  decimalPlaces: number,
  mode: 'up' | 'down' | 'half-up'
): Decimal {
  // Валидация decimalPlaces
  const dpDecimal = new Decimal(decimalPlaces);

  if (!dpDecimal.isFinite() || dpDecimal.isNegative() || !dpDecimal.isInteger()) {
    throw new InvalidDecimalPlacesError(
      (ctx) => `Decimal places must be a non-negative integer, got ${ctx.decimalPlaces}`,
      {
        context: {
          decimalPlaces: dpDecimal.toString(),
          value: value.toString(),
          operation: 'roundWithMode',
          mode
        }
      }
    );
  }

  let roundingMode: Decimal.Rounding;
  switch (mode) {
    case 'up':
      roundingMode = Decimal.ROUND_UP;
      break;
    case 'down':
      roundingMode = Decimal.ROUND_DOWN;
      break;
    case 'half-up':
    default:
      roundingMode = Decimal.ROUND_HALF_UP;
      break;
  }

  return value.toDecimalPlaces(decimalPlaces, roundingMode);
}

// Использование
const value = new Decimal('10.567');

roundWithMode(value, 2, 'half-up'); // ✅ 10.57
roundWithMode(value, 2, 'down');    // ✅ 10.56
roundWithMode(value, 2, 'up');      // ✅ 10.57
```

### 4. Валидация с Result pattern

```typescript
import Decimal from 'decimal.js';
import { InvalidDecimalPlacesError, InvalidOperandError } from '@polymarket/errors';
import { Result, Ok, Err } from '@polymarket/result';

function safeRoundToPrecision(
  value: Decimal,
  decimalPlaces: number,
  roundingMode: Decimal.Rounding
): Result<Decimal, InvalidOperandError | InvalidDecimalPlacesError> {
  // Валидация value
  if (!value.isFinite()) {
    return Err(
      new InvalidOperandError(
        (ctx) => `Value must be finite, got ${ctx.value}`,
        {
          context: {
            value: value.toString(),
            decimalPlaces: String(decimalPlaces),
            operation: 'roundToPrecision'
          }
        }
      )
    );
  }

  // Валидация decimalPlaces
  const dpDecimal = new Decimal(decimalPlaces);

  if (!dpDecimal.isFinite() || dpDecimal.isNegative() || !dpDecimal.isInteger()) {
    return Err(
      new InvalidDecimalPlacesError(
        (ctx) => `Decimal places must be a non-negative integer, got ${ctx.decimalPlaces}`,
        {
          context: {
            decimalPlaces: dpDecimal.toString(),
            value: value.toString(),
            operation: 'roundToPrecision'
          }
        }
      )
    );
  }

  return Ok(value.toDecimalPlaces(decimalPlaces, roundingMode));
}

// Использование
const result = safeRoundToPrecision(
  new Decimal('10.567'),
  2,
  Decimal.ROUND_HALF_UP
);

result.match({
  ok: (rounded) => console.log('Rounded:', rounded.toString()),
  err: (error) => console.error('Error:', error.message)
});
```

### 5. Округление массива значений

```typescript
import Decimal from 'decimal.js';
import { InvalidDecimalPlacesError } from '@polymarket/errors';

function roundAll(
  values: Decimal[],
  decimalPlaces: number
): Decimal[] {
  // Валидация decimalPlaces один раз для всего массива
  const dpDecimal = new Decimal(decimalPlaces);

  if (!dpDecimal.isFinite() || dpDecimal.isNegative() || !dpDecimal.isInteger()) {
    throw new InvalidDecimalPlacesError(
      (ctx) => `Decimal places must be a non-negative integer, got ${ctx.decimalPlaces}`,
      {
        context: {
          decimalPlaces: dpDecimal.toString(),
          operation: 'roundAll',
          count: String(values.length)
        }
      }
    );
  }

  return values.map(v => v.toDecimalPlaces(decimalPlaces, Decimal.ROUND_HALF_UP));
}

// Использование
const prices = [
  new Decimal('0.65432'),
  new Decimal('0.75678'),
  new Decimal('0.85123')
];

const rounded = roundAll(prices, 2);
// ✅ [0.65, 0.76, 0.85]
```

---

## Edge Cases

### Невалидные decimal places

```typescript
import Decimal from 'decimal.js';

// Отрицательное число
roundToPrecision(
  new Decimal('10.567'),
  -1,
  Decimal.ROUND_HALF_UP
);                                   // ❌ InvalidDecimalPlacesError

// Не целое число
roundToPrecision(
  new Decimal('10.567'),
  1.5,
  Decimal.ROUND_HALF_UP
);                                   // ❌ InvalidDecimalPlacesError

// NaN
roundToPrecision(
  new Decimal('10.567'),
  NaN,
  Decimal.ROUND_HALF_UP
);                                   // ❌ InvalidDecimalPlacesError

// Infinity
roundToPrecision(
  new Decimal('10.567'),
  Infinity,
  Decimal.ROUND_HALF_UP
);                                   // ❌ InvalidDecimalPlacesError
```

### Валидные decimal places

```typescript
// Ноль знаков (целое число)
roundToPrecision(
  new Decimal('10.567'),
  0,
  Decimal.ROUND_HALF_UP
);                                   // ✅ 11

// Два знака (стандартные цены)
roundToPrecision(
  new Decimal('10.567'),
  2,
  Decimal.ROUND_HALF_UP
);                                   // ✅ 10.57

// Много знаков (высокая точность)
roundToPrecision(
  new Decimal('1.123456789012345'),
  15,
  Decimal.ROUND_HALF_UP
);                                   // ✅ 1.123456789012345

// Очень большое количество знаков
roundToPrecision(
  new Decimal('10.567'),
  100,
  Decimal.ROUND_HALF_UP
);                                   // ✅ 10.567 (без изменений)
```

### Граничные случаи округления

```typescript
const value = new Decimal('10.565');

// 0 знаков
roundToPrecision(value, 0, Decimal.ROUND_HALF_UP); // ✅ 11

// 1 знак
roundToPrecision(value, 1, Decimal.ROUND_HALF_UP); // ✅ 10.6

// 2 знака
roundToPrecision(value, 2, Decimal.ROUND_HALF_UP); // ✅ 10.57

// 3 знака (без изменений)
roundToPrecision(value, 3, Decimal.ROUND_HALF_UP); // ✅ 10.565
```

---

## Обработка ошибок

### По типу ошибки

```typescript
import { InvalidDecimalPlacesError } from '@polymarket/errors';

try {
  const rounded = roundToPrecision(value, decimalPlaces, Decimal.ROUND_HALF_UP);
} catch (error) {
  if (InvalidDecimalPlacesError.is(error)) {
    console.error('Invalid decimal places:', error.context);
    showUserMessage('Configuration error: invalid precision');
  } else {
    console.error('Unexpected error:', error);
    throw error;
  }
}
```

### По коду ошибки

```typescript
import { InvalidDecimalPlacesError, TradingError } from '@polymarket/errors';

try {
  const formatted = formatPrice(price, decimals);
} catch (error) {
  if (error instanceof TradingError) {
    if (error.code === InvalidDecimalPlacesError.code) {
      logger.error('Invalid decimal places in price formatting', {
        error: error.toJSON()
      });
      // Использовать fallback значение
      return formatPrice(price, 2);
    }
  }
  throw error;
}
```

### С fallback значением

```typescript
import { InvalidDecimalPlacesError } from '@polymarket/errors';

function safeFormatPrice(
  price: Decimal,
  decimals: number,
  fallbackDecimals: number = 2
): string {
  try {
    return formatPrice(price, decimals);
  } catch (error) {
    if (InvalidDecimalPlacesError.is(error)) {
      logger.warn('Invalid decimal places, using fallback', {
        requested: decimals,
        fallback: fallbackDecimals,
        error: error.toJSON()
      });
      return formatPrice(price, fallbackDecimals);
    }
    throw error;
  }
}

// Использование
const formatted = safeFormatPrice(
  new Decimal('10.567'),
  userProvidedDecimals,
  2 // fallback к 2 знакам
);
```

### Валидация конфигурации

```typescript
import { InvalidDecimalPlacesError } from '@polymarket/errors';

interface FormattingConfig {
  priceDecimals: number;
  quantityDecimals: number;
  percentDecimals: number;
}

function validateFormattingConfig(
  config: FormattingConfig
): Result<FormattingConfig, InvalidDecimalPlacesError> {
  const fields = [
    { name: 'priceDecimals', value: config.priceDecimals },
    { name: 'quantityDecimals', value: config.quantityDecimals },
    { name: 'percentDecimals', value: config.percentDecimals }
  ];

  for (const field of fields) {
    const dpDecimal = new Decimal(field.value);

    if (!dpDecimal.isFinite() || dpDecimal.isNegative() || !dpDecimal.isInteger()) {
      return Result.err(
        new InvalidDecimalPlacesError(
          (ctx) => `${ctx.field} must be a non-negative integer, got ${ctx.decimalPlaces}`,
          {
            context: {
              field: field.name,
              decimalPlaces: dpDecimal.toString(),
              operation: 'validateFormattingConfig'
            }
          }
        )
      );
    }
  }

  return Result.ok(config);
}

// Использование при загрузке конфигурации
const configResult = validateFormattingConfig(userConfig);

configResult.match({
  ok: (config) => initializeFormatter(config),
  err: (error) => {
    logger.error('Invalid formatting configuration', { error: error.toJSON() });
    throw error;
  }
});
```

---

## Связанные ошибки

- [InvalidOperandError](./invalid-operand.md) - невалидное значение для округления
- [InvalidTickSizeError](./invalid-tick-size.md) - невалидный tick size для округления к сетке
- [InvalidPriceError](../value-objects/invalid-price.md) - бизнес-валидация цен
- [InvalidQuantityError](../value-objects/invalid-quantity.md) - бизнес-валидация количества

## См. также

- [Math Errors](./README.md) - Обзор категории
- [Обработка ошибок](../error-handling.md) - Best practices
- [Главная документация](../README.md)
