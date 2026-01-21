# InvalidMoneyError

Ошибка валидации денежной суммы в торговой системе Polymarket.

## Описание

Денежная сумма (Money) должна быть неотрицательным числом с корректной валютой. Отрицательное значение, NaN, Infinity или некорректная валюта недопустимы.

## Свойства

| Свойство | Значение |
|----------|----------|
| **Код** | `INVALID_MONEY` |
| **Severity** | `low` |
| **Класс** | `InvalidMoneyError` |
| **Пакет** | `@polymarket/errors` |
| **Категория** | Value Objects |

## Когда использовать

- Создание value object `Money` из пользовательского ввода
- Валидация баланса перед операциями
- Парсинг денежных значений из API
- Проверка достаточности средств
- Конвертация валют
- Операции с денежными суммами (сложение, вычитание)

## Импорт

```typescript
import { InvalidMoneyError } from '@polymarket/errors';

// Для примеров с операциями также понадобятся:
import { CurrencyMismatchError, ArithmeticOverflowError } from '@polymarket/errors';
import { Result } from '@polymarket/types';
```

---

## Примеры использования

### 1. Базовое использование (throw)

```typescript
import { InvalidMoneyError } from '@polymarket/errors';

class Money {
  constructor(
    private readonly amount: number,
    public readonly currency: string
  ) {
    if (!isFinite(amount) || isNaN(amount)) {
      throw new InvalidMoneyError(
        (ctx) => `Invalid amount: ${ctx.reason}`,
        {
          code: InvalidMoneyError.code,
          context: { amount, currency, reason: 'not a finite number' }
        }
      );
    }

    if (amount < 0) {
      throw new InvalidMoneyError(
        (ctx) => `Amount cannot be negative: ${ctx.amount} ${ctx.currency}`,
        {
          code: InvalidMoneyError.code,
          context: { amount, currency }
        }
      );
    }

    if (!currency || currency.trim().length === 0) {
      throw new InvalidMoneyError(
        'Currency must be a non-empty string',
        {
          code: InvalidMoneyError.code,
          context: { amount, currency }
        }
      );
    }
  }
}

// Использование
try {
  const money = new Money(-100, 'USDC');
} catch (error) {
  if (InvalidMoneyError.is(error)) {
    console.error('Invalid money:', error.context);
    // { amount: -100, currency: 'USDC' }
  }
}
```

### 2. С Result<T,E> (рекомендуется)

```typescript
import { Result } from '@polymarket/types';
import { InvalidMoneyError } from '@polymarket/errors';

class Money {
  private constructor(
    private readonly amount: number,
    public readonly currency: string
  ) {}

  static fromAmount(
    amount: number,
    currency: string
  ): Result<Money, InvalidMoneyError> {
    // Валидация валюты
    if (!currency || currency.trim().length === 0) {
      return Result.err(
        new InvalidMoneyError(
          'Currency must be a non-empty string',
          {
            code: InvalidMoneyError.code,
            context: { amount, currency: currency || '(empty)' }
          }
        )
      );
    }

    // Валидация NaN
    if (isNaN(amount)) {
      return Result.err(
        new InvalidMoneyError(
          'Amount must be a valid number',
          {
            code: InvalidMoneyError.code,
            context: { amount, currency, reason: 'NaN' }
          }
        )
      );
    }

    // Валидация Infinity
    if (!isFinite(amount)) {
      return Result.err(
        new InvalidMoneyError(
          'Amount must be finite',
          {
            code: InvalidMoneyError.code,
            context: { amount, currency, reason: 'Infinity' }
          }
        )
      );
    }

    // Валидация отрицательных значений
    if (amount < 0) {
      return Result.err(
        new InvalidMoneyError(
          (ctx) => `Amount cannot be negative: ${ctx.amount} ${ctx.currency}`,
          {
            code: InvalidMoneyError.code,
            context: { amount, currency }
          }
        )
      );
    }

    return Result.ok(new Money(amount, currency));
  }

  static fromString(
    amountStr: string,
    currency: string
  ): Result<Money, InvalidMoneyError> {
    // Парсинг строки в число
    const amount = Number(amountStr);

    // Проверка что парсинг успешен
    if (isNaN(amount)) {
      return Result.err(
        new InvalidMoneyError(
          (ctx) => `Invalid amount format: "${ctx.amountStr}"`,
          {
            code: InvalidMoneyError.code,
            context: { amountStr, currency, reason: 'NaN after parsing' }
          }
        )
      );
    }

    // Используем существующую валидацию fromAmount
    return Money.fromAmount(amount, currency);
  }

  getAmount(): number {
    return this.amount;
  }

  getCurrency(): string {
    return this.currency;
  }
}

// Использование
const result = Money.fromAmount(userInput, 'USDC');

result.match({
  ok: (money) => console.log(`Valid: ${money.getAmount()} ${money.getCurrency()}`),
  err: (error) => console.error('Error:', error.message)
});
```

### 3. Операции с Money и обработка ошибок

```typescript
import { Result } from '@polymarket/types';
import { InvalidMoneyError, CurrencyMismatchError } from '@polymarket/errors';

class Money {
  private constructor(
    private readonly amount: number,
    public readonly currency: string
  ) {}

  static fromAmount(
    amount: number,
    currency: string
  ): Result<Money, InvalidMoneyError> {
    // ... валидация (см. пример выше)
  }

  add(other: Money): Result<Money, CurrencyMismatchError> {
    if (this.currency !== other.currency) {
      return Result.err(
        new CurrencyMismatchError(
          (ctx) => `Cannot add ${ctx.actual} to ${ctx.expected}`,
          {
            code: CurrencyMismatchError.code,
            context: {
              operation: 'add',
              expected: this.currency,
              actual: other.currency
            }
          }
        )
      );
    }

    // add не может вернуть InvalidMoneyError т.к. оба значения уже валидны
    // но для безопасности можно проверить на overflow
    const newAmount = this.amount + other.amount;
    return Money.fromAmount(newAmount, this.currency) as Result<Money, CurrencyMismatchError>;
  }

  subtract(other: Money): Result<Money, CurrencyMismatchError | InvalidMoneyError> {
    if (this.currency !== other.currency) {
      return Result.err(
        new CurrencyMismatchError(
          (ctx) => `Cannot subtract ${ctx.actual} from ${ctx.expected}`,
          {
            code: CurrencyMismatchError.code,
            context: {
              operation: 'subtract',
              expected: this.currency,
              actual: other.currency
            }
          }
        )
      );
    }

    const newAmount = this.amount - other.amount;

    // Вычитание может дать отрицательное значение
    if (newAmount < 0) {
      return Result.err(
        new InvalidMoneyError(
          (ctx) => `Insufficient funds: ${ctx.available} - ${ctx.required} = ${ctx.result}`,
          {
            code: InvalidMoneyError.code,
            context: {
              available: this.amount,
              required: other.amount,
              result: newAmount,
              currency: this.currency
            }
          }
        )
      );
    }

    return Result.ok(new Money(newAmount, this.currency));
  }
}
```

### 4. Обработка в форме пополнения баланса

```typescript
import { InvalidMoneyError } from '@polymarket/errors';

function handleDepositInput(input: string, currency: string): void {
  // Используем fromString для работы со строковым вводом
  // Примечание: для production с высокими требованиями к точности
  // используйте версию Money с decimal.js (пример 5)
  const result = Money.fromString(input, currency);

  result.match({
    ok: (money) => {
      // Обновляем UI
      setDepositAmount(money);
      clearError('deposit');

      // Показываем подтверждение
      showConfirmation(
        `Deposit ${money.getAmount()} ${money.getCurrency()}`
      );
    },
    err: (error) => {
      // Показываем ошибку пользователю
      if (InvalidMoneyError.is(error)) {
        const reason = error.context?.reason as string;

        let userMessage = 'Invalid deposit amount';

        if (reason === 'NaN') {
          userMessage = 'Please enter a valid number';
        } else if (reason === 'Infinity') {
          userMessage = 'Amount is too large';
        } else if (error.context?.amount < 0) {
          userMessage = 'Amount cannot be negative';
        }

        showFieldError('deposit', userMessage);
      }
    }
  });
}
```

### 5. Интеграция с decimal.js

```typescript
import Decimal from 'decimal.js';
import { Result } from '@polymarket/types';
import { InvalidMoneyError } from '@polymarket/errors';

class Money {
  private constructor(
    private readonly amount: Decimal,
    public readonly currency: string
  ) {}

  static fromDecimal(
    amount: Decimal,
    currency: string
  ): Result<Money, InvalidMoneyError> {
    // Валидация валюты
    if (!currency || currency.trim().length === 0) {
      return Result.err(
        new InvalidMoneyError(
          'Currency must be a non-empty string',
          {
            code: InvalidMoneyError.code,
            context: { amount: amount.toString(), currency: currency || '(empty)' }
          }
        )
      );
    }

    // Валидация Infinity
    if (!amount.isFinite()) {
      return Result.err(
        new InvalidMoneyError(
          'Amount must be finite',
          {
            code: InvalidMoneyError.code,
            context: { amount: amount.toString(), currency, reason: 'not finite' }
          }
        )
      );
    }

    // Валидация отрицательных значений
    if (amount.isNegative()) {
      return Result.err(
        new InvalidMoneyError(
          (ctx) => `Amount cannot be negative: ${ctx.amount} ${ctx.currency}`,
          {
            code: InvalidMoneyError.code,
            context: { amount: amount.toString(), currency }
          }
        )
      );
    }

    return Result.ok(new Money(amount, currency));
  }

  static fromNumber(
    amount: number,
    currency: string
  ): Result<Money, InvalidMoneyError> {
    try {
      return Money.fromDecimal(new Decimal(amount), currency);
    } catch (error) {
      return Result.err(
        new InvalidMoneyError(
          (ctx) => `Invalid amount format: ${ctx.amount}`,
          {
            code: InvalidMoneyError.code,
            context: { amount, currency, error: String(error) }
          }
        )
      );
    }
  }

  static fromString(
    amount: string,
    currency: string
  ): Result<Money, InvalidMoneyError> {
    try {
      return Money.fromDecimal(new Decimal(amount), currency);
    } catch (error) {
      return Result.err(
        new InvalidMoneyError(
          (ctx) => `Invalid amount format: "${ctx.amount}"`,
          {
            code: InvalidMoneyError.code,
            context: { amount, currency, error: String(error) }
          }
        )
      );
    }
  }

  toDecimal(): Decimal {
    return this.amount;
  }

  add(other: Money): Result<Money, CurrencyMismatchError> {
    if (this.currency !== other.currency) {
      return Result.err(
        new CurrencyMismatchError(
          (ctx) => `Cannot add ${ctx.actual} to ${ctx.expected}`,
          {
            code: CurrencyMismatchError.code,
            context: {
              operation: 'add',
              expected: this.currency,
              actual: other.currency
            }
          }
        )
      );
    }

    const sum = this.amount.plus(other.amount);
    return Result.ok(new Money(sum, this.currency));
  }
}
```

---

## Edge Cases

### Граничные значения

```typescript
// Ноль (допустимо)
Money.fromAmount(0, 'USDC'); // ✅ Result.ok(Money)

// Очень малые суммы
Money.fromAmount(0.0001, 'USDC'); // ✅ Result.ok(Money)
Money.fromAmount(Number.MIN_VALUE, 'USDC'); // ✅ Result.ok(Money)

// Отрицательные (недопустимо)
Money.fromAmount(-0.01, 'USDC'); // ❌ Result.err(InvalidMoneyError)
Money.fromAmount(-100, 'USDC'); // ❌ Result.err(InvalidMoneyError)

// Большие суммы
Money.fromAmount(1e10, 'USDC'); // ✅ Result.ok(Money)
Money.fromAmount(Number.MAX_SAFE_INTEGER, 'USDC'); // ✅ Result.ok(Money)
```

### Специальные значения

```typescript
// NaN
Money.fromAmount(NaN, 'USDC'); // ❌ Result.err(InvalidMoneyError)
Money.fromAmount(0 / 0, 'USDC'); // ❌ Result.err(InvalidMoneyError)

// Infinity
Money.fromAmount(Infinity, 'USDC'); // ❌ Result.err(InvalidMoneyError)
Money.fromAmount(-Infinity, 'USDC'); // ❌ Result.err(InvalidMoneyError)
Money.fromAmount(1 / 0, 'USDC'); // ❌ Result.err(InvalidMoneyError)

// Отрицательный ноль (допустимо, т.к. -0 === 0)
Money.fromAmount(-0, 'USDC'); // ✅ Result.ok(Money)
```

### Валидация валюты

```typescript
// Корректные валюты
Money.fromAmount(100, 'USDC'); // ✅ Result.ok(Money)
Money.fromAmount(100, 'BTC'); // ✅ Result.ok(Money)
Money.fromAmount(100, 'EUR'); // ✅ Result.ok(Money)

// Некорректные валюты
Money.fromAmount(100, ''); // ❌ Result.err(InvalidMoneyError)
Money.fromAmount(100, '   '); // ❌ Result.err(InvalidMoneyError)
Money.fromAmount(100, null as any); // ❌ Result.err(InvalidMoneyError)
Money.fromAmount(100, undefined as any); // ❌ Result.err(InvalidMoneyError)
```

### Точность с decimal.js

```typescript
// Проблемы с float
const m1 = Money.fromNumber(0.1, 'USDC');
const m2 = Money.fromNumber(0.2, 'USDC');
const sum1 = m1.unwrap().add(m2.unwrap()); // 0.30000000000000004 (float precision)

// Решение с decimal.js
const m3 = Money.fromString('0.1', 'USDC');
const m4 = Money.fromString('0.2', 'USDC');
const sum2 = m3.unwrap().add(m4.unwrap()); // Точно 0.3 ✅
```

### Операции приводящие к ошибкам

```typescript
// Вычитание больше чем есть
const balance = Money.fromAmount(100, 'USDC').unwrap();
const cost = Money.fromAmount(150, 'USDC').unwrap();

const result = balance.subtract(cost);
// ❌ Result.err(InvalidMoneyError)
// context: { available: 100, required: 150, result: -50 }

// Операции с разными валютами
const usdc = Money.fromAmount(100, 'USDC').unwrap();
const btc = Money.fromAmount(1, 'BTC').unwrap();

const result2 = usdc.add(btc);
// ❌ Result.err(CurrencyMismatchError)
```

---

## Обработка ошибок

### По типу ошибки

```typescript
import { InvalidMoneyError } from '@polymarket/errors';

try {
  const money = createMoney(amountInput, currencyInput);
} catch (error) {
  if (InvalidMoneyError.is(error)) {
    console.error('Money validation failed:', error.context);

    const amount = error.context?.amount;
    const currency = error.context?.currency;
    const reason = error.context?.reason as string;

    if (reason === 'NaN') {
      showUserMessage('Please enter a valid amount');
    } else if (reason === 'Infinity') {
      showUserMessage('Amount is too large');
    } else if (amount < 0) {
      showUserMessage('Amount cannot be negative');
    } else {
      showUserMessage(`Invalid amount: ${amount} ${currency}`);
    }
  } else {
    console.error('Unexpected error:', error);
    throw error;
  }
}
```

### По коду ошибки

```typescript
import { InvalidMoneyError, CurrencyMismatchError } from '@polymarket/errors';

const result = money1.add(money2);

result.match({
  ok: (total) => console.log('Total:', total),
  err: (error) => {
    if (error.code === InvalidMoneyError.code) {
      showError('Invalid money amount', error.context);
    } else if (error.code === CurrencyMismatchError.code) {
      showError('Currency mismatch', error.context);
    } else {
      showError('Unexpected error', error);
    }
  }
});
```

### С логированием

```typescript
import { InvalidMoneyError } from '@polymarket/errors';

function validateAndLogMoney(
  amount: number,
  currency: string,
  userId: string
): Result<Money, InvalidMoneyError> {
  const result = Money.fromAmount(amount, currency);

  result.match({
    ok: (money) => {
      logger.info('Money validated', {
        userId,
        amount: money.getAmount(),
        currency: money.getCurrency()
      });
    },
    err: (error) => {
      logger.error('Money validation failed', {
        userId,
        error: error.toJSON(),
        userInput: { amount, currency }
      });
    }
  });

  return result;
}
```

### Обработка множественных ошибок в балансе

```typescript
import { InvalidMoneyError } from '@polymarket/errors';

interface BalanceValidationResult {
  valid: Money[];
  errors: InvalidMoneyError[];
}

function validateBalances(
  balances: Array<{ amount: number; currency: string }>
): BalanceValidationResult {
  const valid: Money[] = [];
  const errors: InvalidMoneyError[] = [];

  for (const { amount, currency } of balances) {
    const result = Money.fromAmount(amount, currency);

    result.match({
      ok: (money) => valid.push(money),
      err: (error) => errors.push(error)
    });
  }

  return { valid, errors };
}

// Использование
const { valid, errors } = validateBalances(userBalances);

if (errors.length > 0) {
  errors.forEach((error) => {
    logger.error('Balance validation error', error.toJSON());
  });
  showError(`${errors.length} invalid balance(s) found`);
} else {
  console.log(`All ${valid.length} balances are valid`);
}
```

---

## Связанные ошибки

- [CurrencyMismatchError](./currency-mismatch.md) - операции с разными валютами
- [InvalidAmountError](./invalid-amount.md) - универсальная валидация чисел
- [ArithmeticOverflowError](./arithmetic-overflow.md) - переполнение при операциях

## См. также

- [Value Objects Errors](./README.md) - Обзор категории
- [Обработка ошибок](../error-handling.md) - Best practices
- [Главная документация](../README.md)