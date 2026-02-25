# InvalidSignedQuantityError

Ошибка валидации знакового количества в торговой системе Polymarket.

## Описание

Знаковое количество (SignedQuantity) может быть положительным, отрицательным или нулевым. Используется для position deltas, P&L, net positions. Должно быть конечным числом (не NaN, не Infinity).

## Свойства

| Свойство | Значение |
|----------|----------|
| **Код** | `INVALID_SIGNED_QUANTITY` |
| **Severity** | `low` |
| **Класс** | `InvalidSignedQuantityError` |
| **Пакет** | `@polymarket/errors` |
| **Категория** | Value Objects |

## Когда использовать

- Создание value object `SignedQuantity` из пользовательского ввода
- Расчёт P&L (прибыль/убыток)
- Обработка изменений позиций (position deltas)
- Операции с нетто-позициями (net positions)
- Изменения баланса счёта (deposits/withdrawals)

## Импорт

```typescript
import { InvalidSignedQuantityError } from '@polymarket/errors';

// Для примеров с Result<T,E>:
import { Result, Ok, Err } from '@polymarket/result';
```

---

## Примеры использования

### 1. Базовое использование с Result<T,E>

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidSignedQuantityError } from '@polymarket/errors';
import Decimal from 'decimal.js';

class SignedQuantity {
  private constructor(private readonly value: Decimal) {}

  static create(value: number): Result<SignedQuantity, InvalidSignedQuantityError> {
    if (!isFinite(value) || isNaN(value)) {
      return Err(
        new InvalidSignedQuantityError(
          (ctx) => `Invalid signed quantity: ${ctx.reason}`,
          {
            code: InvalidSignedQuantityError.code,
            context: { value, reason: isNaN(value) ? 'NAN' : 'NON_FINITE' }
          }
        )
      );
    }

    return Ok(new SignedQuantity(new Decimal(value)));
  }

  getValue(): Decimal {
    return this.value;
  }
}

// Использование
const result = SignedQuantity.create(userInput);

if (result.ok) {
  console.log('Valid quantity:', result.value.getValue().toNumber());
} else {
  console.error('Error:', result.error.message);
}
```

### 2. Position Delta Tracking

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidSignedQuantityError } from '@polymarket/errors';

class PositionDelta {
  static fromTrade(
    side: 'BUY' | 'SELL',
    quantity: number
  ): Result<SignedQuantity, InvalidSignedQuantityError> {
    // BUY = положительная дельта, SELL = отрицательная дельта
    const signedValue = side === 'BUY' ? quantity : -quantity;
    return SignedQuantity.create(signedValue);
  }
}

// Использование
const buyDelta = PositionDelta.fromTrade('BUY', 100);
// Ok(SignedQuantity(+100))

const sellDelta = PositionDelta.fromTrade('SELL', 50);
// Ok(SignedQuantity(-50))
```

### 3. P&L Calculation

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidSignedQuantityError } from '@polymarket/errors';

function calculatePnL(
  positionSize: number,
  entryPrice: number,
  exitPrice: number
): Result<SignedQuantity, InvalidSignedQuantityError> {
  const pnl = positionSize * (exitPrice - entryPrice);
  return SignedQuantity.create(pnl);
}

// Прибыль
const profitResult = calculatePnL(100, 50, 55);
// Ok(SignedQuantity(+500))

// Убыток
const lossResult = calculatePnL(100, 50, 48);
// Ok(SignedQuantity(-200))
```

### 4. Арифметические операции

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidSignedQuantityError } from '@polymarket/errors';

class SignedQuantityService {
  static add(
    qty1: SignedQuantity,
    qty2: SignedQuantity
  ): Result<SignedQuantity, InvalidSignedQuantityError> {
    const sum = qty1.getValue().plus(qty2.getValue());
    return SignedQuantity.create(sum.toNumber());
  }

  static negate(
    qty: SignedQuantity
  ): Result<SignedQuantity, InvalidSignedQuantityError> {
    const negated = qty.getValue().negated();
    return SignedQuantity.create(negated.toNumber());
  }
}

// Использование
const a = SignedQuantity.create(100).value;
const b = SignedQuantity.create(-30).value;

const sum = SignedQuantityService.add(a, b);
// Ok(SignedQuantity(+70))

const negatedA = SignedQuantityService.negate(a);
// Ok(SignedQuantity(-100))
```

### 5. Деление на ноль

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidSignedQuantityError } from '@polymarket/errors';

class SignedQuantityService {
  static divide(
    qty: SignedQuantity,
    divisor: number
  ): Result<SignedQuantity, InvalidSignedQuantityError> {
    if (divisor === 0) {
      return Err(
        new InvalidSignedQuantityError(
          'Cannot divide by zero',
          {
            code: InvalidSignedQuantityError.code,
            context: {
              quantity: qty.getValue().toString(),
              divisor: 0,
              reason: 'DIVISION_BY_ZERO'
            }
          }
        )
      );
    }

    const result = qty.getValue().dividedBy(divisor);
    return SignedQuantity.create(result.toNumber());
  }
}
```

---

## Edge Cases

### Граничные значения

```typescript
// Положительные
SignedQuantity.create(100); // ✅ Ok(SignedQuantity)
SignedQuantity.create(0.0001); // ✅ Ok(SignedQuantity)

// Ноль
SignedQuantity.create(0); // ✅ Ok(SignedQuantity) - допустимо!

// Отрицательные
SignedQuantity.create(-100); // ✅ Ok(SignedQuantity) - допустимо!
SignedQuantity.create(-0.0001); // ✅ Ok(SignedQuantity)
```

### Специальные значения

```typescript
// NaN
SignedQuantity.create(NaN); // ❌ Err(InvalidSignedQuantityError)
SignedQuantity.create(0 / 0); // ❌ Err(InvalidSignedQuantityError)

// Infinity
SignedQuantity.create(Infinity); // ❌ Err(InvalidSignedQuantityError)
SignedQuantity.create(-Infinity); // ❌ Err(InvalidSignedQuantityError)
SignedQuantity.create(1 / 0); // ❌ Err(InvalidSignedQuantityError)

// Отрицательный ноль
SignedQuantity.create(-0); // ✅ Ok(SignedQuantity(0)) - нормализуется к +0
```

### Нормализация -0

```typescript
import Decimal from 'decimal.js';

// -0 нормализуется в 0
const negativeZero = SignedQuantity.create(-0);
// Ok(SignedQuantity(0))

const positiveZero = SignedQuantity.create(0);
// Ok(SignedQuantity(0))

// Они равны
if (negativeZero.ok && positiveZero.ok) {
  negativeZero.value.equals(positiveZero.value); // true
}
```

---

## Обработка ошибок

### По типу ошибки

```typescript
import { InvalidSignedQuantityError } from '@polymarket/errors';

const result = SignedQuantity.create(userInput);

if (result.ok) {
  processQuantity(result.value);
} else {
  if (InvalidSignedQuantityError.is(result.error)) {
    const reason = result.error.context?.reason as string;

    if (reason === 'NAN') {
      showUserMessage('Please enter a valid number');
    } else if (reason === 'NON_FINITE') {
      showUserMessage('Value must be finite');
    } else if (reason === 'DIVISION_BY_ZERO') {
      showUserMessage('Cannot divide by zero');
    } else {
      showUserMessage('Invalid quantity value');
    }
  }
}
```

### По коду ошибки

```typescript
import { InvalidSignedQuantityError } from '@polymarket/errors';

const result = SignedQuantityService.divide(qty, divisor);

if (result.ok) {
  submitTrade(result.value);
} else {
  if (result.error.code === InvalidSignedQuantityError.code) {
    showError('Invalid operation', result.error.context);
  } else {
    showError('Unexpected error', result.error);
  }
}
```

### С логированием

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidSignedQuantityError } from '@polymarket/errors';

function validateAndLogSignedQuantity(
  value: number,
  orderId: string
): Result<SignedQuantity, InvalidSignedQuantityError> {
  const result = SignedQuantity.create(value);

  if (result.ok) {
    logger.info('SignedQuantity validated', {
      orderId,
      quantity: result.value.getValue().toNumber(),
      sign: result.value.getValue().isNegative() ? 'negative' : 'positive'
    });
  } else {
    logger.error('SignedQuantity validation failed', {
      orderId,
      error: result.error.toJSON(),
      userInput: value
    });
  }

  return result;
}
```

---

## Отличия от InvalidQuantityError

| Характеристика | Quantity | SignedQuantity |
|---------------|----------|----------------|
| Диапазон | > 0 (только положительные) | любое finite число |
| Отрицательные | ❌ Ошибка | ✅ Допустимо |
| Ноль | ❌ Ошибка (зависит от контекста) | ✅ Допустимо |
| Use cases | Абсолютные количества | Относительные изменения |

```typescript
// Quantity - только положительные
Quantity.create(-10); // ❌ Err(InvalidQuantityError)
Quantity.create(0);   // ❌ Err(InvalidQuantityError)

// SignedQuantity - может быть отрицательным
SignedQuantity.create(-10); // ✅ Ok(SignedQuantity)
SignedQuantity.create(0);   // ✅ Ok(SignedQuantity)
```

---

## Связанные ошибки

- [InvalidQuantityError](./invalid-quantity.md) - валидация неотрицательных количеств
- [InvalidAmountError](./invalid-amount.md) - универсальная валидация чисел
- [DivisionByZeroError](./division-by-zero.md) - деление на ноль

## См. также

- [Value Objects Errors](./README.md) - Обзор категории
- [Обработка ошибок](../error-handling.md) - Best practices
- [Главная документация](../README.md)
