# InvalidRoundingModeError

Ошибка невалидного режима округления в математических операциях торговой системы Polymarket.

## Описание

Выбрасывается при попытке округления с невалидным roundingMode. Decimal.js поддерживает режимы округления от 0 до 8. Любое значение вне этого диапазона, не-integer или специальные значения (NaN, Infinity) недопустимы.

## Свойства

| Свойство | Значение |
|----------|----------|
| **Код** | `INVALID_ROUNDING_MODE` |
| **Severity** | `low` |
| **Класс** | `InvalidRoundingModeError` |
| **Пакет** | `@polymarket/errors` |
| **Категория** | Value Objects / Math |

## Режимы округления Decimal.js

| Режим | Константа | Описание |
|-------|-----------|----------|
| 0 | ROUND_UP | От нуля |
| 1 | ROUND_DOWN | К нулю (truncate) |
| 2 | ROUND_CEIL | К +Infinity |
| 3 | ROUND_FLOOR | К -Infinity |
| 4 | ROUND_HALF_UP | К ближайшему, .5 вверх |
| 5 | ROUND_HALF_DOWN | К ближайшему, .5 вниз |
| 6 | ROUND_HALF_EVEN | К ближайшему, .5 к чётному (banker's rounding) |
| 7 | ROUND_HALF_CEIL | К ближайшему, .5 к +Infinity |
| 8 | ROUND_HALF_FLOOR | К ближайшему, .5 к -Infinity |

## Когда использовать

- Округление цен с кастомным режимом: `price.round(precision, roundingMode)`
- Округление количества акций: `quantity.round(0, roundingMode)`
- Вычисление процентов с округлением: `percentage.round(2, roundingMode)`
- Нормализация денежных значений: `money.round(decimals, roundingMode)`
- Любые операции округления в value objects с параметром roundingMode
- Валидация пользовательского ввода режима округления

## Импорт

```typescript
import { InvalidRoundingModeError } from '@polymarket/errors';

// Для примеров с Result<T,E> также понадобятся:
import { InvalidPriceError } from '@polymarket/errors';
import { Result, Ok, Err } from '@polymarket/result';
```

---

## Примеры использования

### 1. Базовое использование (throw)

```typescript
import { InvalidRoundingModeError } from '@polymarket/errors';

class Price {
  constructor(private readonly value: number) {}

  round(precision: number, roundingMode: number): Price {
    if (!Number.isInteger(roundingMode) || roundingMode < 0 || roundingMode > 8) {
      throw new InvalidRoundingModeError(
        (ctx) => `Rounding mode must be an integer between 0 and 8, got ${ctx.roundingMode}`,
        {
          code: InvalidRoundingModeError.code,
          context: {
            roundingMode,
            value: this.value,
            precision,
            operation: 'Price.round'
          }
        }
      );
    }

    const multiplier = Math.pow(10, precision);
    // Применяем roundingMode (упрощённо, в реальности используется Decimal.js)
    const rounded = Math.round(this.value * multiplier) / multiplier;
    return new Price(rounded);
  }

  getValue(): number {
    return this.value;
  }
}

// Использование
try {
  const price = new Price(10.567);
  const result = price.round(2, 9); // ❌ 9 вне диапазона 0-8
} catch (error) {
  if (InvalidRoundingModeError.is(error)) {
    console.error('Invalid rounding mode:', error.context);
    // { roundingMode: 9, value: 10.567, precision: 2, operation: 'Price.round' }
  }
}
```

### 2. С Result<T,E> (рекомендуется)

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidRoundingModeError, InvalidPriceError } from '@polymarket/errors';
import Decimal from 'decimal.js';

class Price {
  private constructor(private readonly value: Decimal) {}

  static fromDecimal(value: Decimal): Result<Price, InvalidPriceError> {
    // ... валидация
    return Ok(new Price(value));
  }

  /**
   * Округлить цену с заданным режимом округления
   */
  round(
    precision: number,
    roundingMode: number
  ): Result<Price, InvalidRoundingModeError> {
    // Валидация roundingMode
    if (!Number.isInteger(roundingMode)) {
      return Err(
        new InvalidRoundingModeError(
          (ctx) => `Rounding mode must be an integer, got ${ctx.roundingMode}`,
          {
            code: InvalidRoundingModeError.code,
            context: {
              roundingMode,
              value: this.value.toString(),
              precision,
              reason: 'not an integer'
            }
          }
        )
      );
    }

    if (roundingMode < 0 || roundingMode > 8) {
      return Err(
        new InvalidRoundingModeError(
          (ctx) => `Rounding mode must be between 0 and 8, got ${ctx.roundingMode}`,
          {
            code: InvalidRoundingModeError.code,
            context: {
              roundingMode,
              value: this.value.toString(),
              precision,
              min: 0,
              max: 8
            }
          }
        )
      );
    }

    // Применяем округление через Decimal.js
    const rounded = this.value.toDecimalPlaces(precision, roundingMode);
    return Ok(new Price(rounded));
  }

  toDecimal(): Decimal {
    return this.value;
  }
}

// Использование
const priceResult = Price.fromDecimal(new Decimal('10.567'));
if (!priceResult.ok) {
  console.error('Failed to create price');
  return;
}

const price = priceResult.value;
const result = price.round(2, 4); // ROUND_HALF_UP

if (result.ok) {
  console.log('Rounded price:', result.value.toDecimal().toString()); // "10.57"
} else {
  console.error('Error:', result.error.message);
}

// Невалидный режим
const invalidResult = price.round(2, 10);
if (!invalidResult.ok) {
  console.error('Invalid rounding mode:', invalidResult.error.context);
  // { roundingMode: 10, value: '10.567', precision: 2, min: 0, max: 8 }
}
```

### 3. Валидация пользовательского ввода

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidRoundingModeError } from '@polymarket/errors';

/**
 * Валидация режима округления из пользовательского ввода
 */
function validateRoundingMode(
  input: unknown
): Result<number, InvalidRoundingModeError> {
  // Проверка типа
  if (typeof input !== 'number') {
    return Err(
      new InvalidRoundingModeError(
        (ctx) => `Rounding mode must be a number, got ${ctx.type}`,
        {
          code: InvalidRoundingModeError.code,
          context: {
            roundingMode: input,
            type: typeof input,
            reason: 'not a number'
          }
        }
      )
    );
  }

  // Проверка NaN
  if (isNaN(input)) {
    return Err(
      new InvalidRoundingModeError(
        'Rounding mode cannot be NaN',
        {
          code: InvalidRoundingModeError.code,
          context: {
            roundingMode: input,
            reason: 'NaN'
          }
        }
      )
    );
  }

  // Проверка Infinity
  if (!isFinite(input)) {
    return Err(
      new InvalidRoundingModeError(
        'Rounding mode must be finite',
        {
          code: InvalidRoundingModeError.code,
          context: {
            roundingMode: input,
            reason: 'Infinity'
          }
        }
      )
    );
  }

  // Проверка integer
  if (!Number.isInteger(input)) {
    return Err(
      new InvalidRoundingModeError(
        (ctx) => `Rounding mode must be an integer, got ${ctx.roundingMode}`,
        {
          code: InvalidRoundingModeError.code,
          context: {
            roundingMode: input,
            reason: 'not an integer'
          }
        }
      )
    );
  }

  // Проверка диапазона
  if (input < 0 || input > 8) {
    return Err(
      new InvalidRoundingModeError(
        (ctx) => `Rounding mode must be between ${ctx.min} and ${ctx.max}, got ${ctx.roundingMode}`,
        {
          code: InvalidRoundingModeError.code,
          context: {
            roundingMode: input,
            min: 0,
            max: 8,
            reason: 'out of range'
          }
        }
      )
    );
  }

  return Ok(input);
}

// Использование
const userInput = 4; // ROUND_HALF_UP
const result = validateRoundingMode(userInput);

if (result.ok) {
  const mode = result.value;
  console.log('Valid rounding mode:', mode);

  // Можно использовать для округления
  const priceResult = Price.fromDecimal(new Decimal('10.567'));
  if (priceResult.ok) {
    const rounded = priceResult.value.round(2, mode);
  }
} else {
  console.error('Invalid rounding mode:', result.error.message);
  showUserError('Please select a valid rounding mode (0-8)');
}
```

### 4. Обработка в форме настроек

```typescript
import { InvalidRoundingModeError } from '@polymarket/errors';

interface RoundingSettings {
  precision: number;
  roundingMode: number;
}

function handleRoundingModeInput(input: string): void {
  const value = parseInt(input, 10);

  const result = validateRoundingMode(value);

  if (result.ok) {
    const mode = result.value;
    // Обновляем настройки
    setRoundingMode(mode);
    clearError('roundingMode');

    // Показываем описание режима
    const descriptions: Record<number, string> = {
      0: 'Round up (away from zero)',
      1: 'Round down (towards zero)',
      2: 'Round towards +Infinity',
      3: 'Round towards -Infinity',
      4: 'Round to nearest, .5 up',
      5: 'Round to nearest, .5 down',
      6: 'Round to nearest, .5 to even (banker\'s)',
      7: 'Round to nearest, .5 towards +Infinity',
      8: 'Round to nearest, .5 towards -Infinity',
    };

    showInfo(descriptions[mode]);
  } else {
    const error = result.error;
    if (InvalidRoundingModeError.is(error)) {
      const reason = error.context?.reason as string;

      let userMessage = 'Rounding mode must be an integer between 0 and 8';
      if (reason === 'not a number') {
        userMessage = 'Please enter a valid number';
      } else if (reason === 'NaN') {
        userMessage = 'Rounding mode cannot be NaN';
      } else if (reason === 'not an integer') {
        userMessage = 'Rounding mode must be a whole number';
      } else if (reason === 'out of range') {
        userMessage = 'Rounding mode must be between 0 and 8';
      }

      showFieldError('roundingMode', userMessage);
    }
  }
}
```

### 5. Интеграция с Decimal.js

```typescript
import Decimal from 'decimal.js';
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidRoundingModeError, InvalidMoneyError } from '@polymarket/errors';

class Money {
  private constructor(
    private readonly amount: Decimal,
    public readonly currency: string
  ) {}

  static fromDecimal(amount: Decimal, currency: string): Result<Money, InvalidMoneyError> {
    // ... валидация
    return Ok(new Money(amount, currency));
  }

  /**
   * Округлить сумму с заданным режимом округления
   *
   * @param decimals - Количество знаков после запятой
   * @param roundingMode - Режим округления Decimal.js (0-8)
   */
  round(
    decimals: number,
    roundingMode: number
  ): Result<Money, InvalidRoundingModeError> {
    // Валидация roundingMode
    if (!Number.isInteger(roundingMode) || roundingMode < 0 || roundingMode > 8) {
      return Err(
        new InvalidRoundingModeError(
          (ctx) => `Invalid rounding mode ${ctx.roundingMode} for ${ctx.currency}`,
          {
            code: InvalidRoundingModeError.code,
            context: {
              roundingMode,
              currency: this.currency,
              amount: this.amount.toString(),
              decimals
            }
          }
        )
      );
    }

    try {
      // Применяем округление через Decimal.js
      const rounded = this.amount.toDecimalPlaces(decimals, roundingMode);
      return Ok(new Money(rounded, this.currency));
    } catch (error) {
      // На случай если Decimal.js выбросит ошибку
      return Err(
        new InvalidRoundingModeError(
          (ctx) => `Decimal.js rounding failed: ${ctx.error}`,
          {
            code: InvalidRoundingModeError.code,
            context: {
              roundingMode,
              currency: this.currency,
              amount: this.amount.toString(),
              decimals,
              error: String(error)
            }
          }
        )
      );
    }
  }

  toDecimal(): Decimal {
    return this.amount;
  }
}

// Использование
const moneyResult = Money.fromDecimal(new Decimal('123.456'), 'USDC');
if (!moneyResult.ok) {
  console.error('Failed to create money');
  return;
}

const money = moneyResult.value;

// Округление до 2 знаков с ROUND_HALF_UP
const rounded = money.round(2, Decimal.ROUND_HALF_UP); // 4
if (rounded.ok) {
  console.log('Rounded:', rounded.value.toDecimal().toString()); // "123.46"
}

// Невалидный режим
const invalidResult = money.round(2, -1);
if (!invalidResult.ok) {
  console.error('Error:', invalidResult.error.message);
  // "Invalid rounding mode -1 for USDC"
}
```

---

## Edge Cases

### Граничные значения

```typescript
// Валидные режимы
validateRoundingMode(0); // ✅ Ok(0) - ROUND_UP
validateRoundingMode(4); // ✅ Ok(4) - ROUND_HALF_UP
validateRoundingMode(8); // ✅ Ok(8) - ROUND_HALF_FLOOR

// Невалидные режимы
validateRoundingMode(-1); // ❌ Err(InvalidRoundingModeError) - ниже минимума
validateRoundingMode(9); // ❌ Err(InvalidRoundingModeError) - выше максимума
validateRoundingMode(10); // ❌ Err(InvalidRoundingModeError)
```

### Специальные значения

```typescript
// NaN
validateRoundingMode(NaN); // ❌ Err(InvalidRoundingModeError)
validateRoundingMode(0 / 0); // ❌ Err(InvalidRoundingModeError)

// Infinity
validateRoundingMode(Infinity); // ❌ Err(InvalidRoundingModeError)
validateRoundingMode(-Infinity); // ❌ Err(InvalidRoundingModeError)
validateRoundingMode(1 / 0); // ❌ Err(InvalidRoundingModeError)

// Не-integer
validateRoundingMode(4.5); // ❌ Err(InvalidRoundingModeError)
validateRoundingMode(0.1); // ❌ Err(InvalidRoundingModeError)
validateRoundingMode(7.999); // ❌ Err(InvalidRoundingModeError)

// Отрицательный ноль
validateRoundingMode(-0); // ✅ Ok(0) - технически -0 === 0 и это валидный режим

// Не-числа
validateRoundingMode('4'); // ❌ Err(InvalidRoundingModeError) - строка
validateRoundingMode(null); // ❌ Err(InvalidRoundingModeError)
validateRoundingMode(undefined); // ❌ Err(InvalidRoundingModeError)
validateRoundingMode({}); // ❌ Err(InvalidRoundingModeError)
```

### Константы Decimal.js

```typescript
import Decimal from 'decimal.js';

// Использование констант Decimal.js (рекомендуется)
validateRoundingMode(Decimal.ROUND_UP); // ✅ Ok(0)
validateRoundingMode(Decimal.ROUND_DOWN); // ✅ Ok(1)
validateRoundingMode(Decimal.ROUND_CEIL); // ✅ Ok(2)
validateRoundingMode(Decimal.ROUND_FLOOR); // ✅ Ok(3)
validateRoundingMode(Decimal.ROUND_HALF_UP); // ✅ Ok(4)
validateRoundingMode(Decimal.ROUND_HALF_DOWN); // ✅ Ok(5)
validateRoundingMode(Decimal.ROUND_HALF_EVEN); // ✅ Ok(6)
validateRoundingMode(Decimal.ROUND_HALF_CEIL); // ✅ Ok(7)
validateRoundingMode(Decimal.ROUND_HALF_FLOOR); // ✅ Ok(8)

// Это гарантирует использование правильных значений
const priceResult = Price.fromDecimal(new Decimal('10.567'));
if (priceResult.ok) {
  const rounded = priceResult.value.round(2, Decimal.ROUND_HALF_UP); // ✅ Безопасно
}
```

### Цепочка операций

```typescript
import { toChain } from '@polymarket/result';

const result = toChain(validateRoundingMode(userInput))
  .flatMap(mode =>
    Price.fromDecimal(new Decimal('10.567')).flatMap(price =>
      price.round(2, mode)
    )
  )
  .toResult();

if (result.ok) {
  console.log('Rounded price:', result.value.toDecimal().toString());
} else {
  // Остановится на первой ошибке (невалидный режим или невалидная цена)
  console.error('Error in chain:', result.error.message);
}
```

---

## Обработка ошибок

### По типу ошибки

```typescript
import { InvalidRoundingModeError } from '@polymarket/errors';

try {
  const rounded = price.round(2, invalidMode);
} catch (error) {
  if (InvalidRoundingModeError.is(error)) {
    console.error('Invalid rounding mode:', error.context);

    const roundingMode = error.context?.roundingMode;
    const reason = error.context?.reason as string;

    if (reason === 'out of range') {
      showUserMessage('Rounding mode must be between 0 and 8');
    } else if (reason === 'not an integer') {
      showUserMessage('Rounding mode must be a whole number');
    } else {
      showUserMessage('Invalid rounding mode');
    }

    // Использовать fallback (например, ROUND_HALF_UP)
    return price.round(2, 4);
  } else {
    console.error('Unexpected error:', error);
    throw error;
  }
}
```

### По коду ошибки

```typescript
import { InvalidRoundingModeError } from '@polymarket/errors';

const result = price.round(precision, roundingMode);

if (result.ok) {
  processPrice(result.value);
} else {
  const error = result.error;
  if (error.code === InvalidRoundingModeError.code) {
    showError('Invalid rounding mode', error.context);

    // Использовать безопасное значение по умолчанию
    const defaultMode = Decimal.ROUND_HALF_UP;
    return price.round(precision, defaultMode);
  } else {
    showError('Unexpected error', error);
  }
}
```

### С fallback значением

```typescript
import { InvalidRoundingModeError } from '@polymarket/errors';

function roundOrDefault(
  price: Price,
  precision: number,
  roundingMode: number,
  defaultMode: number = Decimal.ROUND_HALF_UP
): Price {
  const result = price.round(precision, roundingMode);

  if (result.ok) {
    return result.value;
  } else {
    const error = result.error;
    if (InvalidRoundingModeError.is(error)) {
      logger.warn('Invalid rounding mode, using default', {
        error: error.toJSON(),
        defaultMode
      });
      // Используем fallback режим
      const fallbackResult = price.round(precision, defaultMode);
      if (fallbackResult.ok) {
        return fallbackResult.value;
      }
      throw new Error('Fallback rounding also failed');
    }
    throw error;
  }
}

// Использование
const rounded = roundOrDefault(
  price,
  2,
  userInput, // Может быть невалидным
  Decimal.ROUND_HALF_UP // Fallback
);
```

### С логированием

```typescript
import { InvalidRoundingModeError } from '@polymarket/errors';

function roundWithLogging(
  price: Price,
  precision: number,
  roundingMode: number,
  operationName: string
): Result<Price, InvalidRoundingModeError> {
  const result = price.round(precision, roundingMode);

  if (result.ok) {
    logger.info('Rounding successful', {
      operation: operationName,
      price: price.toDecimal().toString(),
      precision,
      roundingMode,
      result: result.value.toDecimal().toString()
    });
  } else {
    logger.error('Invalid rounding mode', {
      operation: operationName,
      error: result.error.toJSON(),
      price: price.toDecimal().toString(),
      precision,
      roundingMode
    });
  }

  return result;
}
```

### Обработка в расчётах

```typescript
import { InvalidRoundingModeError } from '@polymarket/errors';

/**
 * Рассчитать комиссию с округлением
 */
function calculateFee(
  amount: Money,
  feePercentage: number,
  decimals: number,
  roundingMode: number
): Result<Money, InvalidRoundingModeError> {
  // Валидация roundingMode
  const modeResult = validateRoundingMode(roundingMode);
  if (!modeResult.ok) {
    return Err(modeResult.error);
  }

  // Вычисление комиссии
  const feeDecimal = amount.toDecimal().mul(feePercentage).div(100);
  const feeResult = Money.fromDecimal(feeDecimal, amount.currency);

  if (!feeResult.ok) {
    return Err(new InvalidRoundingModeError('Failed to create fee money', {
      code: InvalidRoundingModeError.code,
      context: { feeDecimal: feeDecimal.toString(), currency: amount.currency }
    }));
  }

  const fee = feeResult.value;

  // Округление комиссии
  return fee.round(decimals, roundingMode);
}

// Использование
const amountResult = Money.fromDecimal(new Decimal('1000'), 'USDC');
if (!amountResult.ok) {
  console.error('Failed to create money');
  return;
}

const amount = amountResult.value;
const feeResult = calculateFee(amount, 0.5, 2, Decimal.ROUND_HALF_UP);

if (feeResult.ok) {
  console.log('Fee:', feeResult.value.toDecimal().toString()); // "5.00"
} else {
  if (feeResult.error.code === InvalidRoundingModeError.code) {
    console.error('Invalid rounding mode for fee calculation');
  }
}
```

---

## Связанные ошибки

- [ArithmeticOverflowError](./arithmetic-overflow.md) - переполнение при арифметических операциях
- [InvalidOperandError](./invalid-operand.md) - невалидные операнды (NaN, Infinity)
- [DivisionByZeroError](./division-by-zero.md) - деление на ноль
- [InvalidAmountError](./invalid-amount.md) - универсальная валидация чисел

## См. также

- [Value Objects Errors](./README.md) - Обзор категории
- [Обработка ошибок](../error-handling.md) - Best practices
- [Главная документация](../README.md)
- [Decimal.js Documentation](https://mikemcl.github.io/decimal.js/) - Официальная документация
