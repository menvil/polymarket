# InvalidFeeError

Ошибка валидации комиссии в торговой системе Polymarket.

## Описание

Комиссия (Fee) представляет стоимость выполнения операции. Должна быть неотрицательным числом (>= 0). Может быть нулевой для бесплатных операций.

## Свойства

| Свойство | Значение |
|----------|----------|
| **Код** | `INVALID_FEE` |
| **Severity** | `low` |
| **Класс** | `InvalidFeeError` |
| **Пакет** | `@polymarket/errors` |
| **Категория** | Value Objects |

## Когда использовать

- Создание value object `Fee` из пользовательского ввода
- Расчёт комиссий для ордеров
- Валидация fee estimates из API
- Проверка максимальных комиссий
- Расчёт общей стоимости транзакций

## Импорт

```typescript
import { InvalidFeeError } from '@polymarket/errors';

// Для примеров с Result<T,E>:
import { Result, Ok, Err } from '@polymarket/result';
```

---

## Примеры использования

### 1. Базовое использование

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidFeeError } from '@polymarket/errors';
import Decimal from 'decimal.js';

class Fee {
  private constructor(
    private readonly amount: Decimal,
    private readonly currency: string
  ) {}

  static create(
    amount: number,
    currency: string
  ): Result<Fee, InvalidFeeError> {
    if (!isFinite(amount) || isNaN(amount)) {
      return Err(
        new InvalidFeeError(
          'Fee must be a finite number',
          {
            context: { amount, currency, reason: 'NOT_FINITE' }
          }
        )
      );
    }

    if (amount < 0) {
      return Err(
        new InvalidFeeError(
          (ctx) => `Fee cannot be negative: ${ctx.amount}`,
          {
            context: { amount, currency, reason: 'NEGATIVE' }
          }
        )
      );
    }

    return Ok(new Fee(new Decimal(amount), currency));
  }

  getAmount(): Decimal {
    return this.amount;
  }

  getCurrency(): string {
    return this.currency;
  }
}

// Использование
const result = Fee.create(0.001, 'USDC');
// Ok(Fee)

const invalid = Fee.create(-1, 'USDC');
// Err(InvalidFeeError)
```

### 2. Расчёт комиссии от суммы ордера

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidFeeError } from '@polymarket/errors';

class FeeCalculator {
  static calculateTradingFee(
    orderValue: number,
    feeRate: number
  ): Result<Fee, InvalidFeeError> {
    const feeAmount = orderValue * feeRate;
    return Fee.create(feeAmount, 'USDC');
  }

  static calculateWithdrawalFee(
    flatFee: number = 0.001
  ): Result<Fee, InvalidFeeError> {
    return Fee.create(flatFee, 'USDC');
  }
}

// Использование
const orderValue = 1000; // $1000
const feeRate = 0.002;   // 0.2%

const tradingFeeResult = FeeCalculator.calculateTradingFee(orderValue, feeRate);
// Ok(Fee(2 USDC))

const withdrawalFeeResult = FeeCalculator.calculateWithdrawalFee(100);
// Ok(Fee(0.001 USDC))
```

### 3. Нулевая комиссия

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidFeeError } from '@polymarket/errors';

class FeeService {
  static ZERO_FEE = Fee.create(0, 'USDC');

  static noFee(currency: string = 'USDC'): Result<Fee, InvalidFeeError> {
    return Fee.create(0, currency);
  }
}

// Использование
const zeroFee = FeeService.noFee();
// Ok(Fee(0 USDC))
```

### 4. Проверка максимальной комиссии

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidFeeError } from '@polymarket/errors';

class FeeValidator {
  static validateMaxFee(
    fee: Fee,
    maxFee: number
  ): Result<Fee, InvalidFeeError> {
    const amount = fee.getAmount().toNumber();

    if (amount > maxFee) {
      return Err(
        new InvalidFeeError(
          (ctx) => `Fee ${ctx.amount} exceeds maximum ${ctx.max}`,
          {
            code: InvalidFeeError.code,
            context: {
              amount,
              max: maxFee,
              currency: fee.getCurrency(),
              reason: 'EXCEEDS_MAX'
            }
          }
        )
      );
    }

    return Ok(fee);
  }
}

// Использование
const fee = Fee.create(5, 'USDC').value;
const validation = FeeValidator.validateMaxFee(fee, 10);
// Ok(Fee) - в пределах лимита

const highFee = Fee.create(15, 'USDC').value;
const validation2 = FeeValidator.validateMaxFee(highFee, 10);
// Err(EXCEEDS_MAX)
```

### 5. Общая стоимость с комиссией

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidFeeError } from '@polymarket/errors';

interface OrderCost {
  subtotal: number;
  fee: Fee;
  total: number;
}

function calculateTotalCost(
  orderValue: number,
  feeRate: number
): Result<OrderCost, InvalidFeeError> {
  const feeResult = FeeCalculator.calculateTradingFee(orderValue, feeRate);

  if (!feeResult.ok) {
    return feeResult;
  }

  const fee = feeResult.value;
  const total = orderValue + fee.getAmount().toNumber();

  return Ok({
    subtotal: orderValue,
    fee,
    total
  });
}

// Использование
const costResult = calculateTotalCost(1000, 0.002);
// Ok({ subtotal: 1000, fee: Fee(2), total: 1002 })
```

---

## Edge Cases

### Допустимые значения

```typescript
// Ноль (бесплатная операция)
Fee.create(0, 'USDC'); // ✅ Ok(Fee)

// Малые комиссии
Fee.create(0.0001, 'USDC'); // ✅ Ok(Fee)
Fee.create(0.001, 'USDC');  // ✅ Ok(Fee)

// Обычные комиссии
Fee.create(1, 'USDC');    // ✅ Ok(Fee)
Fee.create(10.5, 'USDC'); // ✅ Ok(Fee)

// Большие комиссии
Fee.create(1000, 'USDC'); // ✅ Ok(Fee)
```

### Недопустимые значения

```typescript
// Отрицательные
Fee.create(-1, 'USDC');      // ❌ Err(NEGATIVE)
Fee.create(-0.001, 'USDC');  // ❌ Err(NEGATIVE)

// NaN
Fee.create(NaN, 'USDC');     // ❌ Err(NOT_FINITE)

// Infinity
Fee.create(Infinity, 'USDC');  // ❌ Err(NOT_FINITE)
Fee.create(-Infinity, 'USDC'); // ❌ Err(NOT_FINITE)
```

### Различные валюты

```typescript
// USDC
Fee.create(1, 'USDC'); // ✅ Ok(Fee)

// ETH
Fee.create(0.001, 'ETH'); // ✅ Ok(Fee)

// Custom tokens
Fee.create(10, 'TOKEN_123'); // ✅ Ok(Fee)
```

---

## Обработка ошибок

### По типу ошибки

```typescript
import { InvalidFeeError } from '@polymarket/errors';

const result = Fee.create(userInput, 'USDC');

if (result.ok) {
  processFee(result.value);
} else {
  if (InvalidFeeError.is(result.error)) {
    const reason = result.error.context?.reason as string;

    if (reason === 'NEGATIVE') {
      showUserMessage('Fee cannot be negative');
    } else if (reason === 'NOT_FINITE') {
      showUserMessage('Fee must be a valid number');
    } else if (reason === 'EXCEEDS_MAX') {
      const max = result.error.context?.max;
      showUserMessage(`Fee exceeds maximum of ${max}`);
    } else {
      showUserMessage('Invalid fee value');
    }
  }
}
```

### По коду ошибки

```typescript
import { InvalidFeeError } from '@polymarket/errors';

const result = FeeCalculator.calculateTradingFee(orderValue, feeRate);

if (result.ok) {
  submitOrder(result.value);
} else {
  if (result.error.code === InvalidFeeError.code) {
    showError('Invalid fee calculation', result.error.context);
  } else {
    showError('Unexpected error', result.error);
  }
}
```

### С логированием

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidFeeError } from '@polymarket/errors';

function validateAndLogFee(
  amount: number,
  currency: string,
  orderId: string
): Result<Fee, InvalidFeeError> {
  const result = Fee.create(amount, currency);

  if (result.ok) {
    logger.info('Fee validated', {
      orderId,
      amount,
      currency
    });
  } else {
    logger.error('Fee validation failed', {
      orderId,
      error: result.error.toJSON(),
      input: { amount, currency }
    });
  }

  return result;
}
```

---

## Сравнение с другими VO

### Fee vs Money

```typescript
// Fee - специализирован для комиссий
Fee.create(0, 'USDC');    // ✅ Допустимо - бесплатная операция

// Money - для общих денежных сумм
Money.create(0, 'USDC');  // ✅ Допустимо - нулевой баланс

// Оба не допускают отрицательные значения
Fee.create(-1, 'USDC');   // ❌ Err
Money.create(-1, 'USDC'); // ❌ Err
```

### Fee vs Quantity

```typescript
// Fee - всегда имеет валюту
Fee.create(1, 'USDC');    // ✅ Fee(1 USDC)

// Quantity - абстрактное количество без единиц
Quantity.create(1);       // ✅ Quantity(1)
```

---

## Связанные ошибки

- [InvalidMoneyError](./invalid-money.md) - валидация денежных сумм
- [InvalidQuantityError](./invalid-quantity.md) - валидация количеств
- [InvalidAmountError](./invalid-amount.md) - универсальная валидация чисел

## См. также

- [Value Objects Errors](./README.md) - Обзор категории
- [Обработка ошибок](../error-handling.md) - Best practices
- [Главная документация](../README.md)
