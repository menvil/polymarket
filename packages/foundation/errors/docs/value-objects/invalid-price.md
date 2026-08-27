# InvalidOutcomePriceError

Ошибка валидации цены на рынке Polymarket.

## Описание

Цены на рынках Polymarket должны находиться в диапазоне **[0.0001, 0.9999]**.
Это техническое ограничение протокола - цены не могут быть 0 (0%) или 1 (100%).

## Свойства

| Свойство | Значение |
|----------|----------|
| **Код** | `INVALID_PRICE` |
| **Severity** | `low` |
| **Класс** | `InvalidOutcomePriceError` |
| **Пакет** | `@polymarket/errors` |
| **Категория** | Value Objects |

## Когда использовать

- Создание value object `OutcomePrice` из пользовательского ввода
- Валидация цены перед размещением ордера
- Парсинг данных из API
- Обновление цен на UI

## Импорт

```typescript
import { InvalidOutcomePriceError } from '@polymarket/errors';

// Для примеров с Result<T,E>:
import { Result, Ok, Err } from '@polymarket/result';
```

---

## Примеры использования

### 1. Базовое использование (throw)

```typescript
import { InvalidOutcomePriceError } from '@polymarket/errors';

class OutcomePrice {
  constructor(private readonly value: number) {
    if (value < 0.0001 || value > 0.9999) {
      throw new InvalidOutcomePriceError(
        (ctx) => `Invalid price ${ctx.value}: must be in [${ctx.min}, ${ctx.max}]`,
        {
          
          context: { value, min: 0.0001, max: 0.9999 }
        }
      );
    }
  }
}

// Использование
try {
  const price = new OutcomePrice(-0.5);
} catch (error) {
  if (InvalidOutcomePriceError.is(error)) {
    console.error('Invalid price:', error.context?.value);
    // Invalid price: -0.5
  }
}
```

### 2. С Result<T,E> (рекомендуется)

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidOutcomePriceError } from '@polymarket/errors';

class OutcomePrice {
  private constructor(private readonly value: number) {}

  static fromNumber(value: number): Result<OutcomePrice, InvalidOutcomePriceError> {
    if (value < 0.0001 || value > 0.9999) {
      return Err(
        new InvalidOutcomePriceError(
          (ctx) => `Invalid price ${ctx.value}: must be in [${ctx.min}, ${ctx.max}]`,
          {
            
            context: { value, min: 0.0001, max: 0.9999 }
          }
        )
      );
    }
    return Ok(new OutcomePrice(value));
  }

  getValue(): number {
    return this.value;
  }
}

// Использование
const result = OutcomePrice.fromNumber(userInput);

if (result.ok) {
  console.log('Valid price:', result.value.getValue());
} else {
  console.error('Error:', result.error.message);
}
```

### 3. С кастомным сообщением

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidOutcomePriceError } from '@polymarket/errors';

function validatePrice(value: number): Result<OutcomePrice, InvalidOutcomePriceError> {
  if (value <= 0) {
    return Err(
      new InvalidOutcomePriceError(
        'OutcomePrice must be positive',
        {
          
          context: { value, reason: 'non-positive' }
        }
      )
    );
  }

  if (value >= 1) {
    return Err(
      new InvalidOutcomePriceError(
        'OutcomePrice cannot be 100%',
        {
          
          context: { value, reason: 'too-high' }
        }
      )
    );
  }

  if (value < 0.0001) {
    return Err(
      new InvalidOutcomePriceError(
        'OutcomePrice too small (minimum: 0.0001)',
        {
          
          context: { value, min: 0.0001 }
        }
      )
    );
  }

  return OutcomePrice.fromNumber(value);
}
```

### 4. Обработка в форме

```typescript
import { InvalidOutcomePriceError } from '@polymarket/errors';

function handlePriceInput(input: string): void {
  // Используем Number() для более строгого парсинга
  // Для production с высокими требованиями к точности используйте decimal.js
  const value = Number(input);

  // Проверка что парсинг успешен
  if (isNaN(value)) {
    showFieldError('price', 'Please enter a valid number');
    return;
  }

  const result = OutcomePrice.fromNumber(value);

  if (result.ok) {
    // Обновляем UI
    setPrice(result.value);
    clearError('price');
  } else {
    // Показываем ошибку пользователю
    if (InvalidOutcomePriceError.is(result.error)) {
      const min = result.error.context?.min as number;
      const max = result.error.context?.max as number;
      showFieldError('price', `OutcomePrice must be between ${min} and ${max}`);
    }
  }
}
```

### 5. Интеграция с decimal.js

```typescript
import Decimal from 'decimal.js';
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidOutcomePriceError } from '@polymarket/errors';

class OutcomePrice {
  private static readonly MIN = new Decimal('0.0001');
  private static readonly MAX = new Decimal('0.9999');

  private constructor(private readonly value: Decimal) {}

  static fromDecimal(value: Decimal): Result<OutcomePrice, InvalidOutcomePriceError> {
    if (value.lessThan(OutcomePrice.MIN) || value.greaterThan(OutcomePrice.MAX)) {
      return Err(
        new InvalidOutcomePriceError(
          (ctx) => `Invalid price ${ctx.value}: must be in [${ctx.min}, ${ctx.max}]`,
          {
            
            context: {
              value: value.toNumber(),
              min: OutcomePrice.MIN.toNumber(),
              max: OutcomePrice.MAX.toNumber()
            }
          }
        )
      );
    }
    return Ok(new OutcomePrice(value));
  }

  static fromNumber(value: number): Result<OutcomePrice, InvalidOutcomePriceError> {
    try {
      return OutcomePrice.fromDecimal(new Decimal(value));
    } catch (error) {
      return Err(
        new InvalidOutcomePriceError(
          (ctx) => `Invalid price format: ${ctx.value}`,
          {
            
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
OutcomePrice.fromNumber(0.0001); // ✅ Ok(OutcomePrice)

// Максимальная допустимая цена
OutcomePrice.fromNumber(0.9999); // ✅ Ok(OutcomePrice)

// Ниже минимума
OutcomePrice.fromNumber(0.0000); // ❌ Err(InvalidOutcomePriceError)

// Выше максимума
OutcomePrice.fromNumber(1.0000); // ❌ Err(InvalidOutcomePriceError)
```

### Специальные значения

```typescript
// NaN
OutcomePrice.fromNumber(NaN);      // ❌ Err(InvalidOutcomePriceError)

// Infinity
OutcomePrice.fromNumber(Infinity); // ❌ Err(InvalidOutcomePriceError)
OutcomePrice.fromNumber(-Infinity); // ❌ Err(InvalidOutcomePriceError)

// Отрицательный ноль
OutcomePrice.fromNumber(-0);       // ❌ Err(InvalidOutcomePriceError)
                            // Технически -0 === 0, но меньше 0.0001

// Очень малые числа
OutcomePrice.fromNumber(1e-10);    // ❌ Err(InvalidOutcomePriceError)
                            // 0.0000000001 < 0.0001
```

### Округление

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidOutcomePriceError } from '@polymarket/errors';

// Если нужно округлить до допустимого диапазона
function clampPrice(value: number): Result<OutcomePrice, InvalidOutcomePriceError> {
  const MIN = 0.0001;
  const MAX = 0.9999;

  if (isNaN(value) || !isFinite(value)) {
    return Err(
      new InvalidOutcomePriceError(
        'OutcomePrice must be a valid number',
        { context: { value } }
      )
    );
  }

  const clamped = Math.max(MIN, Math.min(MAX, value));
  return OutcomePrice.fromNumber(clamped);
}

clampPrice(-100);  // ✅ OutcomePrice(0.0001)
clampPrice(5);     // ✅ OutcomePrice(0.9999)
clampPrice(0.5);   // ✅ OutcomePrice(0.5)
```

---

## Обработка ошибок

### По типу ошибки

```typescript
import { InvalidOutcomePriceError } from '@polymarket/errors';

try {
  const price = createPrice(userInput);
} catch (error) {
  if (InvalidOutcomePriceError.is(error)) {
    console.error('OutcomePrice validation failed:', error.context);
    showUserMessage(`Invalid price. Valid range: ${error.context?.min} - ${error.context?.max}`);
  } else {
    console.error('Unexpected error:', error);
    throw error;
  }
}
```

### По коду ошибки

```typescript
import { InvalidOutcomePriceError, TradingError } from '@polymarket/errors';

const result = OutcomePrice.fromNumber(userInput);

if (result.ok) {
  submitOrder(result.value);
} else {
  if (result.error.code === InvalidOutcomePriceError.code) {
    // Обработка InvalidOutcomePriceError
    showError('Invalid price', result.error.context);
  } else {
    // Другие ошибки
    showError('Unexpected error', result.error);
  }
}
```

### С логированием

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidOutcomePriceError } from '@polymarket/errors';

function validateAndLogPrice(
  value: number,
  orderId: string
): Result<OutcomePrice, InvalidOutcomePriceError> {
  const result = OutcomePrice.fromNumber(value);

  if (result.ok) {
    logger.info('OutcomePrice validated', {
      orderId,
      price: result.value.getValue()
    });
  } else {
    logger.error('OutcomePrice validation failed', {
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
