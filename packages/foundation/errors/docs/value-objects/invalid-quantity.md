# InvalidQuantityError

Ошибка валидации количества акций в торговой системе Polymarket.

## Описание

Количество акций (shares) должно быть положительным числом. Отрицательное, нулевое или некорректное значение (NaN, Infinity) недопустимо.

## Свойства

| Свойство | Значение |
|----------|----------|
| **Код** | `INVALID_QUANTITY` |
| **Severity** | `low` |
| **Класс** | `InvalidQuantityError` |
| **Пакет** | `@polymarket/errors` |
| **Категория** | Value Objects |

## Когда использовать

- Создание value object `Quantity` из пользовательского ввода
- Валидация количества акций перед размещением ордера
- Парсинг данных из API
- Обновление количества на UI
- Проверка остатков на балансе

## Импорт

```typescript
import { InvalidQuantityError } from '@polymarket/errors';

// Для примеров с Result<T,E>:
import { Result } from '@polymarket/types';
```

---

## Примеры использования

### 1. Базовое использование (throw)

```typescript
import { InvalidQuantityError } from '@polymarket/errors';

class Quantity {
  constructor(private readonly value: number) {
    if (value <= 0 || !isFinite(value)) {
      throw new InvalidQuantityError(
        (ctx) => `Invalid quantity ${ctx.value}: must be positive`,
        {
          code: InvalidQuantityError.code,
          context: { value, min: 0 }
        }
      );
    }
  }
}

// Использование
try {
  const qty = new Quantity(-10);
} catch (error) {
  if (InvalidQuantityError.is(error)) {
    console.error('Invalid quantity:', error.context?.value);
    // Invalid quantity: -10
  }
}
```

### 2. С Result<T,E> (рекомендуется)

```typescript
import { Result } from '@polymarket/types';
import { InvalidQuantityError } from '@polymarket/errors';

class Quantity {
  private constructor(private readonly value: number) {}

  static fromNumber(value: number): Result<Quantity, InvalidQuantityError> {
    if (!isFinite(value) || isNaN(value)) {
      return Result.err(
        new InvalidQuantityError(
          (ctx) => `Invalid quantity: ${ctx.reason}`,
          {
            code: InvalidQuantityError.code,
            context: { value, reason: 'not a finite number' }
          }
        )
      );
    }

    if (value <= 0) {
      return Result.err(
        new InvalidQuantityError(
          (ctx) => `Quantity ${ctx.value} must be positive (min: ${ctx.min})`,
          {
            code: InvalidQuantityError.code,
            context: { value, min: 0 }
          }
        )
      );
    }

    return Result.ok(new Quantity(value));
  }

  getValue(): number {
    return this.value;
  }
}

// Использование
const result = Quantity.fromNumber(userInput);

result.match({
  ok: (qty) => console.log('Valid quantity:', qty.getValue()),
  err: (error) => console.error('Error:', error.message)
});
```

### 3. С кастомным сообщением для разных случаев

```typescript
import { InvalidQuantityError } from '@polymarket/errors';

function validateQuantity(value: number, min: number = 0): Result<Quantity, InvalidQuantityError> {
  if (isNaN(value)) {
    return Result.err(
      new InvalidQuantityError(
        'Quantity must be a valid number',
        {
          code: InvalidQuantityError.code,
          context: { value, reason: 'NaN' }
        }
      )
    );
  }

  if (!isFinite(value)) {
    return Result.err(
      new InvalidQuantityError(
        'Quantity cannot be infinite',
        {
          code: InvalidQuantityError.code,
          context: { value, reason: 'Infinity' }
        }
      )
    );
  }

  if (value < 0) {
    return Result.err(
      new InvalidQuantityError(
        'Quantity cannot be negative',
        {
          code: InvalidQuantityError.code,
          context: { value, min: 0, reason: 'negative' }
        }
      )
    );
  }

  if (value === 0 && min > 0) {
    return Result.err(
      new InvalidQuantityError(
        (ctx) => `Quantity must be at least ${ctx.min}`,
        {
          code: InvalidQuantityError.code,
          context: { value: 0, min }
        }
      )
    );
  }

  if (value < min) {
    return Result.err(
      new InvalidQuantityError(
        (ctx) => `Quantity ${ctx.value} is below minimum ${ctx.min}`,
        {
          code: InvalidQuantityError.code,
          context: { value, min }
        }
      )
    );
  }

  return Quantity.fromNumber(value);
}
```

### 4. Обработка в форме заказа

```typescript
import { InvalidQuantityError } from '@polymarket/errors';

function handleQuantityInput(input: string): void {
  // Используем Number() для более строгого парсинга
  const value = Number(input);

  // Проверка что парсинг успешен
  if (isNaN(value)) {
    showFieldError('quantity', 'Please enter a valid number');
    return;
  }

  const result = Quantity.fromNumber(value);

  result.match({
    ok: (qty) => {
      // Обновляем UI
      setQuantity(qty);
      clearError('quantity');

      // Рассчитываем стоимость
      const totalCost = price.getValue() * qty.getValue();
      setTotalCost(totalCost);
    },
    err: (error) => {
      // Показываем ошибку пользователю
      if (InvalidQuantityError.is(error)) {
        const reason = error.context?.reason as string;

        let userMessage = 'Quantity must be a positive number';
        if (reason === 'NaN') {
          userMessage = 'Please enter a valid number';
        } else if (reason === 'negative') {
          userMessage = 'Quantity cannot be negative';
        } else if (reason === 'Infinity') {
          userMessage = 'Quantity value is too large';
        }

        showFieldError('quantity', userMessage);
      }
    }
  });
}
```

### 5. Интеграция с decimal.js для точных расчётов

```typescript
import Decimal from 'decimal.js';
import { Result } from '@polymarket/types';
import { InvalidQuantityError } from '@polymarket/errors';

class Quantity {
  private static readonly MIN = new Decimal('0');

  private constructor(private readonly value: Decimal) {}

  static fromDecimal(value: Decimal): Result<Quantity, InvalidQuantityError> {
    if (!value.isFinite()) {
      return Result.err(
        new InvalidQuantityError(
          (ctx) => `Invalid quantity: ${ctx.reason}`,
          {
            code: InvalidQuantityError.code,
            context: { value: value.toString(), reason: 'not finite' }
          }
        )
      );
    }

    if (value.lessThanOrEqualTo(Quantity.MIN)) {
      return Result.err(
        new InvalidQuantityError(
          (ctx) => `Quantity ${ctx.value} must be positive`,
          {
            code: InvalidQuantityError.code,
            context: { value: value.toNumber(), min: 0 }
          }
        )
      );
    }

    return Result.ok(new Quantity(value));
  }

  static fromNumber(value: number): Result<Quantity, InvalidQuantityError> {
    try {
      return Quantity.fromDecimal(new Decimal(value));
    } catch (error) {
      return Result.err(
        new InvalidQuantityError(
          (ctx) => `Invalid quantity format: ${ctx.value}`,
          {
            code: InvalidQuantityError.code,
            context: { value, error: String(error) }
          }
        )
      );
    }
  }

  static fromString(value: string): Result<Quantity, InvalidQuantityError> {
    try {
      return Quantity.fromDecimal(new Decimal(value));
    } catch (error) {
      return Result.err(
        new InvalidQuantityError(
          (ctx) => `Invalid quantity format: "${ctx.value}"`,
          {
            code: InvalidQuantityError.code,
            context: { value, error: String(error) }
          }
        )
      );
    }
  }

  toDecimal(): Decimal {
    return this.value;
  }

  multiply(other: Quantity): Quantity {
    return new Quantity(this.value.mul(other.value));
  }
}
```

---

## Edge Cases

### Граничные значения

```typescript
// Минимальное положительное
Quantity.fromNumber(0.0001); // ✅ Result.ok(Quantity)
Quantity.fromNumber(Number.MIN_VALUE); // ✅ Result.ok(Quantity) - 5e-324

// Ноль
Quantity.fromNumber(0); // ❌ Result.err(InvalidQuantityError)

// Отрицательные
Quantity.fromNumber(-1); // ❌ Result.err(InvalidQuantityError)
Quantity.fromNumber(-0.0001); // ❌ Result.err(InvalidQuantityError)

// Большие числа
Quantity.fromNumber(1e10); // ✅ Result.ok(Quantity)
Quantity.fromNumber(Number.MAX_SAFE_INTEGER); // ✅ Result.ok(Quantity)
```

### Специальные значения

```typescript
// NaN
Quantity.fromNumber(NaN); // ❌ Result.err(InvalidQuantityError)
Quantity.fromNumber(0 / 0); // ❌ Result.err(InvalidQuantityError)

// Infinity
Quantity.fromNumber(Infinity); // ❌ Result.err(InvalidQuantityError)
Quantity.fromNumber(-Infinity); // ❌ Result.err(InvalidQuantityError)
Quantity.fromNumber(1 / 0); // ❌ Result.err(InvalidQuantityError)

// Отрицательный ноль
Quantity.fromNumber(-0); // ❌ Result.err(InvalidQuantityError)
                        // Технически -0 === 0, но не положительное

// Строковые значения
Quantity.fromString('100'); // ✅ Result.ok(Quantity)
Quantity.fromString('abc'); // ❌ Result.err(InvalidQuantityError)
Quantity.fromString(''); // ❌ Result.err(InvalidQuantityError)
```

### Округление и точность

```typescript
// Дробные количества
Quantity.fromNumber(0.5); // ✅ Допустимо (если протокол поддерживает)
Quantity.fromNumber(1.23456789); // ✅ Допустимо

// Очень малые числа
Quantity.fromNumber(1e-18); // ✅ Result.ok(Quantity)

// Проблемы с точностью float
const qty1 = Quantity.fromNumber(0.1 + 0.2); // 0.30000000000000004
// ✅ Result.ok(Quantity) - но значение может быть неточным

// Использование decimal.js решает эту проблему
const qty2 = Quantity.fromString('0.1');
const qty3 = Quantity.fromString('0.2');
const sum = qty2.unwrap().toDecimal().plus(qty3.unwrap().toDecimal());
Quantity.fromDecimal(sum); // ✅ Точно 0.3
```

### Валидация с минимальным значением

```typescript
class Quantity {
  static fromNumberWithMin(
    value: number,
    min: number = 0
  ): Result<Quantity, InvalidQuantityError> {
    if (value < min) {
      return Result.err(
        new InvalidQuantityError(
          (ctx) => `Quantity ${ctx.value} must be >= ${ctx.min}`,
          {
            code: InvalidQuantityError.code,
            context: { value, min }
          }
        )
      );
    }
    return Quantity.fromNumber(value);
  }
}

// Использование
Quantity.fromNumberWithMin(0, 1); // ❌ min = 1, значит 0 недопустим
Quantity.fromNumberWithMin(1, 1); // ✅ Result.ok(Quantity)
Quantity.fromNumberWithMin(100, 10); // ✅ Result.ok(Quantity)
```

---

## Обработка ошибок

### По типу ошибки

```typescript
import { InvalidQuantityError } from '@polymarket/errors';

try {
  const quantity = createQuantity(userInput);
} catch (error) {
  if (InvalidQuantityError.is(error)) {
    console.error('Quantity validation failed:', error.context);

    const value = error.context?.value as number;
    const reason = error.context?.reason as string;

    if (reason === 'negative') {
      showUserMessage('Quantity cannot be negative');
    } else if (reason === 'NaN') {
      showUserMessage('Please enter a valid number');
    } else {
      showUserMessage('Invalid quantity value');
    }
  } else {
    console.error('Unexpected error:', error);
    throw error;
  }
}
```

### По коду ошибки

```typescript
import { InvalidQuantityError, TradingError } from '@polymarket/errors';

const result = Quantity.fromNumber(userInput);

result.match({
  ok: (quantity) => submitOrder(quantity),
  err: (error) => {
    if (error.code === InvalidQuantityError.code) {
      // Обработка InvalidQuantityError
      showError('Invalid quantity', error.context);
    } else {
      // Другие ошибки
      showError('Unexpected error', error);
    }
  }
});
```

### С логированием

```typescript
import { InvalidQuantityError } from '@polymarket/errors';

function validateAndLogQuantity(
  value: number,
  orderId: string
): Result<Quantity, InvalidQuantityError> {
  const result = Quantity.fromNumber(value);

  result.match({
    ok: (quantity) => {
      logger.info('Quantity validated', {
        orderId,
        quantity: quantity.getValue()
      });
    },
    err: (error) => {
      logger.error('Quantity validation failed', {
        orderId,
        error: error.toJSON(),
        userInput: value
      });
    }
  });

  return result;
}
```

### Обработка в цепочке валидаций

```typescript
import { ResultChain } from '@polymarket/types';
import { InvalidPriceError, InvalidQuantityError } from '@polymarket/errors';

function createOrder(
  priceInput: number,
  qtyInput: number
): Result<Order, InvalidPriceError | InvalidQuantityError> {
  return ResultChain
    .from(Price.fromNumber(priceInput))
    .flatMap(price =>
      Quantity.fromNumber(qtyInput).map(qty => ({ price, qty }))
    )
    .map(({ price, qty }) => new Order(price, qty))
    .run();
}

// Использование
const orderResult = createOrder(0.5, 100);

orderResult.match({
  ok: (order) => console.log('Order created:', order),
  err: (error) => {
    // Обработка обоих типов ошибок
    if (error.code === InvalidPriceError.code) {
      showError('Invalid price');
    } else if (error.code === InvalidQuantityError.code) {
      showError('Invalid quantity');
    }
  }
});
```

---

## Связанные ошибки

- [InvalidAmountError](./invalid-amount.md) - универсальная валидация чисел
- [InvalidPriceError](./invalid-price.md) - валидация цен

## См. также

- [Value Objects Errors](./README.md) - Обзор категории
- [Обработка ошибок](../error-handling.md) - Best practices
- [Главная документация](../README.md)
