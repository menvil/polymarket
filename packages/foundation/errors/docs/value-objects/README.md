# Value Objects Errors

Ошибки валидации value objects для торговой системы Polymarket.

## Обзор

Value Objects представляют неизменяемые бизнес-концепции в domain model:

- **Price** - цена на рынке [0.0001, 0.9999]
- **Quantity** - количество акций
- **Money** - денежная сумма с валютой
- **Spread** - спред между bid и ask
- И другие числовые величины

Все ошибки валидации value objects имеют:

- **Severity:** `low` (проблемы валидации данных не критичны)
- **Статический код:** `ErrorClass.code` (для удобства)
- **Поддержка Result<T,E>:** интеграция с Railway-Oriented Programming

---

## Каталог ошибок

### Валидация диапазонов

| Код | Класс | Когда использовать | Документация |
|-----|-------|-------------------|--------------|
| `INVALID_PRICE` | InvalidPriceError | Цена вне [0.0001, 0.9999] | [→](./invalid-price.md) |
| `INVALID_QUANTITY` | InvalidQuantityError | Отрицательное/нулевое количество | [→](./invalid-quantity.md) |
| `INVALID_PERCENTAGE` | InvalidPercentageError | Процент вне [0, 100] или [0, 1] | [→](./invalid-percentage.md) |
| `INVALID_AMOUNT` | InvalidAmountError | Универсальная валидация чисел | [→](./invalid-amount.md) |

### Валидация денежных значений

| Код | Класс | Когда использовать | Документация |
|-----|-------|-------------------|--------------|
| `INVALID_MONEY` | InvalidMoneyError | Некорректная денежная сумма (NaN, отрицательная) | [→](./invalid-money.md) |
| `CURRENCY_MISMATCH` | CurrencyMismatchError | Операции с разными валютами | [→](./currency-mismatch.md) |

### Математические ошибки

| Код | Класс | Когда использовать | Документация |
|-----|-------|-------------------|--------------|
| `DIVISION_BY_ZERO` | DivisionByZeroError | Деление на ноль в расчетах | [→](./division-by-zero.md) |
| `ARITHMETIC_OVERFLOW` | ArithmeticOverflowError | Результат операции = Infinity | [→](./arithmetic-overflow.md) |

### Валидация котировок и спредов

| Код | Класс | Когда использовать | Документация |
|-----|-------|-------------------|--------------|
| `INVALID_QUOTE` | InvalidQuoteError | Невалидная котировка (bid >= ask, отсутствие сторон) | [→](./invalid-quote.md) |
| `INVALID_SPREAD` | InvalidSpreadError | Невалидный спред (bid > ask) | [→](./invalid-spread.md) |

---

## Общие паттерны использования

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
}

// Использование
const priceResult = Price.fromNumber(userInput);

if (priceResult.ok) {
  console.log('Valid price:', priceResult.value);
} else {
  console.error('Invalid price:', priceResult.error.message);
}
```

### 3. Обработка ошибок

```typescript
import {
  InvalidPriceError,
  InvalidQuantityError,
  InvalidMoneyError
} from '@polymarket/errors';

const result = createOrder(priceInput, qtyInput, balanceInput);

if (result.ok) {
  submitOrder(result.value);
} else {
  const error = result.error;
  // Обработка по типу
  if (InvalidPriceError.is(error)) {
    showFieldError('price', `Price must be between ${error.context?.min} and ${error.context?.max}`);
  } else if (InvalidQuantityError.is(error)) {
    showFieldError('quantity', 'Quantity must be positive');
  } else if (InvalidMoneyError.is(error)) {
    showFieldError('balance', 'Invalid balance amount');
  }

  // Логирование
  logger.error('Order creation failed', {
    code: error.code,
    context: error.context
  });
}
```

### 4. Композиция с ResultChain

```typescript
import { toChain } from '@polymarket/result';
import {
  InvalidPriceError,
  InvalidQuantityError,
  CurrencyMismatchError
} from '@polymarket/errors';

function createOrder(
  priceInput: number,
  qtyInput: number,
  money1: Money,
  money2: Money
): Result<Order, InvalidPriceError | InvalidQuantityError | CurrencyMismatchError> {
  return toChain(Price.fromNumber(priceInput))
    .flatMap(price =>
      Quantity.fromNumber(qtyInput).map(qty => ({ price, qty }))
    )
    .flatMap(({ price, qty }) =>
      money1.add(money2).map(total => ({ price, qty, total }))
    )
    .map(({ price, qty, total }) => new Order(price, qty, total))
    .toResult();
}

// Использование
const orderResult = createOrder(0.5, 100, money1, money2);

orderResult.match({
  ok: (order) => console.log('Order created:', order),
  err: (error) => {
    // Все типы ошибок обрабатываются в одном месте
    if (error.code === InvalidPriceError.code) {
      showError('Invalid price');
    } else if (error.code === InvalidQuantityError.code) {
      showError('Invalid quantity');
    } else if (error.code === CurrencyMismatchError.code) {
      showError('Currency mismatch');
    }
  }
});
```

### 5. Множественная валидация (aggregate errors)

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';

type ValidationErrors = TradingError[];

function validateOrderForm(
  priceInput: number,
  qtyInput: number,
  balanceInput: number
): Result<ValidatedOrder, ValidationErrors> {
  const errors: TradingError[] = [];

  const priceResult = Price.fromNumber(priceInput);
  if (!priceResult.ok) {
    errors.push(priceResult.error);
  }

  const qtyResult = Quantity.fromNumber(qtyInput);
  if (!qtyResult.ok) {
    errors.push(qtyResult.error);
  }

  const balanceResult = Money.fromUSDC(balanceInput);
  if (!balanceResult.ok) {
    errors.push(balanceResult.error);
  }

  if (errors.length > 0) {
    return Err(errors);
  }

  return Ok({
    price: priceResult.value,
    quantity: qtyResult.value,
    balance: balanceResult.value
  });
}

// Использование
const validationResult = validateOrderForm(priceInput, qtyInput, balanceInput);

if (validationResult.ok) {
  submitOrder(validationResult.value);
} else {
  // Показываем все ошибки сразу
  validationResult.error.forEach(error => {
    showFieldError(
      error.context?.field as string,
      error.message
    );
  });
}
```

---

## Интеграция с decimal.js

Для высокоточных финансовых расчётов рекомендуется использовать `decimal.js`:

```typescript
import Decimal from 'decimal.js';
import { Result, Ok, Err } from '@polymarket/result';
import {
  InvalidMoneyError,
  ArithmeticOverflowError,
  DivisionByZeroError,
  CurrencyMismatchError
} from '@polymarket/errors';

class Money {
  private constructor(
    private readonly amount: Decimal,
    public readonly currency: string
  ) {}

  static fromAmount(
    amount: number | string | Decimal,
    currency: string
  ): Result<Money, InvalidMoneyError | ArithmeticOverflowError> {
    try {
      const decimal = new Decimal(amount);

      if (!decimal.isFinite()) {
        return Err(
          new ArithmeticOverflowError(
            (ctx) => `Amount overflow: ${ctx.amount}`,
            {
              code: ArithmeticOverflowError.code,
              context: { amount, operation: 'parse' }
            }
          )
        );
      }

      if (decimal.isNegative()) {
        return Err(
          new InvalidMoneyError(
            (ctx) => `Amount cannot be negative: ${ctx.amount}`,
            {
              code: InvalidMoneyError.code,
              context: { amount: decimal.toNumber(), currency }
            }
          )
        );
      }

      return Ok(new Money(decimal, currency));
    } catch (error) {
      return Err(
        new InvalidMoneyError(
          (ctx) => `Invalid amount: ${ctx.amount}`,
          {
            code: InvalidMoneyError.code,
            context: { amount, currency }
          }
        )
      );
    }
  }

  divide(divisor: Money): Result<Money, DivisionByZeroError | CurrencyMismatchError> {
    if (this.currency !== divisor.currency) {
      return Err(
        new CurrencyMismatchError(
          (ctx) => `Cannot divide ${ctx.expected} by ${ctx.actual}`,
          {
            code: CurrencyMismatchError.code,
            context: {
              operation: 'divide',
              expected: this.currency,
              actual: divisor.currency
            }
          }
        )
      );
    }

    if (divisor.amount.isZero()) {
      return Err(
        new DivisionByZeroError(
          (ctx) => `Cannot divide ${ctx.dividend} by zero`,
          {
            code: DivisionByZeroError.code,
            context: {
              dividend: this.amount.toNumber(),
              divisor: 0,
              operation: 'Money.divide'
            }
          }
        )
      );
    }

    const result = this.amount.div(divisor.amount);
    return Ok(new Money(result, this.currency));
  }
}
```

---

## Best Practices

### ✅ DO

1. **Используйте Result<T,E> вместо throw**

   ```typescript
   static fromNumber(value: number): Result<Price, InvalidPriceError>
   ```

2. **Используйте статические коды**

   ```typescript
   code: InvalidPriceError.code // ✅ 'INVALID_PRICE'
   ```

3. **Включайте полезный context**

   ```typescript
   context: { value, min, max, field: 'price' }
   ```

4. **Используйте template функции для динамических сообщений**

   ```typescript
   (ctx) => `Invalid price ${ctx.value}: must be in [${ctx.min}, ${ctx.max}]`
   ```

5. **Обрабатывайте ошибки по типу или коду**

   ```typescript
   if (InvalidPriceError.is(error)) { ... }
   // или
   if (error.code === InvalidPriceError.code) { ... }
   ```

### ❌ DON'T

1. **Не используйте общие ошибки**

   ```typescript
   throw new Error('Invalid price') // ❌
   throw new InvalidPriceError(...) // ✅
   ```

2. **Не опускайте код ошибки**

   ```typescript
   new InvalidPriceError('message', {}) // ❌ нет code
   new InvalidPriceError('message', { code: InvalidPriceError.code }) // ✅
   ```

3. **Не игнорируйте валидацию**

   ```typescript
   new Price(userInput) // ❌ без проверки
   Price.fromNumber(userInput) // ✅ с Result<T,E>
   ```

4. **Не используйте native number для денег**

   ```typescript
   const total = price * quantity // ❌ точность теряется
   const total = price.mul(quantity) // ✅ decimal.js
   ```

---

## См. также

- [Обработка ошибок](../error-handling.md) - Best practices
- [Главная документация](../README.md)
- [Result<T,E> документация](../../../result/README.md)

---

## Полный список ошибок

- [InvalidPriceError](./invalid-price.md)
- [InvalidQuantityError](./invalid-quantity.md)
- [InvalidMoneyError](./invalid-money.md)
- [InvalidPercentageError](./invalid-percentage.md)
- [InvalidAmountError](./invalid-amount.md)
- [DivisionByZeroError](./division-by-zero.md)
- [ArithmeticOverflowError](./arithmetic-overflow.md)
- [CurrencyMismatchError](./currency-mismatch.md)

Примечание: InvalidRoundingModeError теперь находится в [Math Errors](../math/invalid-rounding-mode.md)
