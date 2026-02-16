# InvalidPriceError

Ошибка валидации цены на рынке Polymarket.

## Описание

Цены на рынках Polymarket должны находиться в диапазоне **[0.0001, 0.9999]**.
Это техническое ограничение протокола - цены не могут быть 0 (0%) или 1 (100%).

## Свойства

| Свойство | Значение |
|----------|----------|
| **Код** | `INVALID_PRICE` |
| **Severity** | `low` |
| **Класс** | `InvalidPriceError` |
| **Пакет** | `@polymarket/errors` |
| **Категория** | Value Objects |

## Когда использовать

- Создание value object `Price` из пользовательского ввода
- Валидация цены перед размещением ордера
- Парсинг данных из API
- Обновление цен на UI

## Импорт

```typescript
import { InvalidPriceError } from '@polymarket/errors';

// Для примеров с Result<T,E>:
import { Result, Ok, Err } from '@polymarket/result';
```

---

## Примеры использования

### 1. Базовое использование (throw)

```typescript
import { InvalidPriceError } from '@polymarket/errors';

class Price {
  constructor(private readonly value: number) {
    if (value < 0.0001 || value > 0.9999) {
      throw new InvalidPriceError(
        (ctx) => `Invalid price ${ctx.value}: must be in [${ctx.min}, ${ctx.max}]`,
        {
          code: InvalidPriceError.code,
          context: { value, min: 0.0001, max: 0.9999 }
        }
      );
    }
  }
}

// Использование
try {
  const price = new Price(-0.5);
} catch (error) {
  if (InvalidPriceError.is(error)) {
    console.error('Invalid price:', error.context?.value);
    // Invalid price: -0.5
  }
}
```

### 2. С Result<T,E> (рекомендуется)

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidPriceError } from '@polymarket/errors';

class Price {
  private constructor(private readonly value: number) {}

  static fromNumber(value: number): Result<Price, InvalidPriceError> {
    if (value < 0.0001 || value > 0.9999) {
      return Err(
        new InvalidPriceError(
          (ctx) => `Invalid price ${ctx.value}: must be in [${ctx.min}, ${ctx.max}]`,
          {
            code: InvalidPriceError.code,
            context: { value, min: 0.0001, max: 0.9999 }
          }
        )
      );
    }
    return Ok(new Price(value));
  }

  getValue(): number {
    return this.value;
  }
}

// Использование
const result = Price.fromNumber(userInput);

if (result.ok) {
  console.log('Valid price:', result.value.getValue());
} else {
  console.error('Error:', result.error.message);
}
```

### 3. С кастомным сообщением

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidPriceError } from '@polymarket/errors';

function validatePrice(value: number): Result<Price, InvalidPriceError> {
  if (value <= 0) {
    return Err(
      new InvalidPriceError(
        'Price must be positive',
        {
          code: InvalidPriceError.code,
          context: { value, reason: 'non-positive' }
        }
      )
    );
  }

  if (value >= 1) {
    return Err(
      new InvalidPriceError(
        'Price cannot be 100%',
        {
          code: InvalidPriceError.code,
          context: { value, reason: 'too-high' }
        }
      )
    );
  }

  if (value < 0.0001) {
    return Err(
      new InvalidPriceError(
        'Price too small (minimum: 0.0001)',
        {
          code: InvalidPriceError.code,
          context: { value, min: 0.0001 }
        }
      )
    );
  }

  return Price.fromNumber(value);
}
```

### 4. Обработка в форме

```typescript
import { InvalidPriceError } from '@polymarket/errors';

function handlePriceInput(input: string): void {
  // Используем Number() для более строгого парсинга
  // Для production с высокими требованиями к точности используйте decimal.js
  const value = Number(input);

  // Проверка что парсинг успешен
  if (isNaN(value)) {
    showFieldError('price', 'Please enter a valid number');
    return;
  }

  const result = Price.fromNumber(value);

  result.match({
    ok: (price) => {
      // Обновляем UI
      setPrice(price);
      clearError('price');
    },
    err: (error) => {
      // Показываем ошибку пользователю
      if (InvalidPriceError.is(error)) {
        const min = error.context?.min as number;
        const max = error.context?.max as number;
        showFieldError('price', `Price must be between ${min} and ${max}`);
      }
    }
  });
}
```

### 5. Интеграция с decimal.js

```typescript
import Decimal from 'decimal.js';
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidPriceError } from '@polymarket/errors';

class Price {
  private static readonly MIN = new Decimal('0.0001');
  private static readonly MAX = new Decimal('0.9999');

  private constructor(private readonly value: Decimal) {}

  static fromDecimal(value: Decimal): Result<Price, InvalidPriceError> {
    if (value.lessThan(Price.MIN) || value.greaterThan(Price.MAX)) {
      return Err(
        new InvalidPriceError(
          (ctx) => `Invalid price ${ctx.value}: must be in [${ctx.min}, ${ctx.max}]`,
          {
            code: InvalidPriceError.code,
            context: {
              value: value.toNumber(),
              min: Price.MIN.toNumber(),
              max: Price.MAX.toNumber()
            }
          }
        )
      );
    }
    return Ok(new Price(value));
  }

  static fromNumber(value: number): Result<Price, InvalidPriceError> {
    try {
      return Price.fromDecimal(new Decimal(value));
    } catch (error) {
      return Err(
        new InvalidPriceError(
          (ctx) => `Invalid price format: ${ctx.value}`,
          {
            code: InvalidPriceError.code,
            context: { value, error: String(error) }
          }
        )
      );
    }
  }

  toDecimal(): Decimal {
    return this.value;
  }
}
```

---

## Edge Cases

### Граничные значения

```typescript
// Минимальная допустимая цена
Price.fromNumber(0.0001); // ✅ Ok(Price)

// Максимальная допустимая цена
Price.fromNumber(0.9999); // ✅ Ok(Price)

// Ниже минимума
Price.fromNumber(0.0000); // ❌ Err(InvalidPriceError)

// Выше максимума
Price.fromNumber(1.0000); // ❌ Err(InvalidPriceError)
```

### Специальные значения

```typescript
// NaN
Price.fromNumber(NaN);      // ❌ Err(InvalidPriceError)

// Infinity
Price.fromNumber(Infinity); // ❌ Err(InvalidPriceError)
Price.fromNumber(-Infinity); // ❌ Err(InvalidPriceError)

// Отрицательный ноль
Price.fromNumber(-0);       // ❌ Err(InvalidPriceError)
                            // Технически -0 === 0, но меньше 0.0001

// Очень малые числа
Price.fromNumber(1e-10);    // ❌ Err(InvalidPriceError)
                            // 0.0000000001 < 0.0001
```

### Округление

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidPriceError } from '@polymarket/errors';

// Если нужно округлить до допустимого диапазона
function clampPrice(value: number): Result<Price, InvalidPriceError> {
  const MIN = 0.0001;
  const MAX = 0.9999;

  if (isNaN(value) || !isFinite(value)) {
    return Err(
      new InvalidPriceError(
        'Price must be a valid number',
        { code: InvalidPriceError.code, context: { value } }
      )
    );
  }

  const clamped = Math.max(MIN, Math.min(MAX, value));
  return Price.fromNumber(clamped);
}

clampPrice(-100);  // ✅ Price(0.0001)
clampPrice(5);     // ✅ Price(0.9999)
clampPrice(0.5);   // ✅ Price(0.5)
```

---

## Обработка ошибок

### По типу ошибки

```typescript
import { InvalidPriceError } from '@polymarket/errors';

try {
  const price = createPrice(userInput);
} catch (error) {
  if (InvalidPriceError.is(error)) {
    console.error('Price validation failed:', error.context);
    showUserMessage(`Invalid price. Valid range: ${error.context?.min} - ${error.context?.max}`);
  } else {
    console.error('Unexpected error:', error);
    throw error;
  }
}
```

### По коду ошибки

```typescript
import { InvalidPriceError, TradingError } from '@polymarket/errors';

const result = Price.fromNumber(userInput);

result.match({
  ok: (price) => submitOrder(price),
  err: (error) => {
    if (error.code === InvalidPriceError.code) {
      // Обработка InvalidPriceError
      showError('Invalid price', error.context);
    } else {
      // Другие ошибки
      showError('Unexpected error', error);
    }
  }
});
```

### С логированием

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidPriceError } from '@polymarket/errors';

function validateAndLogPrice(
  value: number,
  orderId: string
): Result<Price, InvalidPriceError> {
  const result = Price.fromNumber(value);

  if (result.ok) {
    logger.info('Price validated', {
      orderId,
      price: result.value.getValue()
    });
  } else {
    logger.error('Price validation failed', {
      orderId,
      error: result.error.toJSON(),
      userInput: value
    });
  }

  return result;
}
```

---

## Связанные ошибки

- [InvalidAmountError](./invalid-amount.md) - универсальная валидация чисел
- [InvalidPercentageError](./invalid-percentage.md) - валидация процентов (похожа, но другой диапазон)

## См. также

- [Value Objects Errors](./README.md) - Обзор категории
- [Обработка ошибок](../error-handling.md) - Best practices
- [Главная документация](../README.md)
