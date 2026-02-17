# ArithmeticOverflowError

Ошибка переполнения при арифметических операциях в торговой системе Polymarket.

## Описание

Выбрасывается когда результат арифметической операции превышает допустимые границы числовых типов и приводит к Infinity или -Infinity. Особенно критично для финансовых расчетов, где точность и конечность результата обязательны.

## Свойства

| Свойство | Значение |
|----------|----------|
| **Код** | `ARITHMETIC_OVERFLOW` |
| **Severity** | `low` |
| **Класс** | `ArithmeticOverflowError` |
| **Пакет** | `@polymarket/errors` |
| **Категория** | Value Objects |

## Когда использовать

- Сложение/вычитание очень больших чисел
- Умножение больших значений
- Экспоненциальные операции
- Любые операции приводящие к Infinity/-Infinity
- Валидация результатов расчётов с decimal.js
- Защита от переполнения в финансовых операциях

## Импорт

```typescript
import { ArithmeticOverflowError } from '@polymarket/errors';

// Для примеров с Result<T,E> и SafeMath также понадобятся:
import { InvalidMoneyError, CurrencyMismatchError, DivisionByZeroError } from '@polymarket/errors';
import { Result, Ok, Err } from '@polymarket/result';
```

---

## Примеры использования

### 1. Базовое использование (throw)

```typescript
import { ArithmeticOverflowError } from '@polymarket/errors';

class Money {
  constructor(
    private readonly amount: number,
    public readonly currency: string
  ) {}

  multiply(factor: number): Money {
    const result = this.amount * factor;

    if (!isFinite(result)) {
      throw new ArithmeticOverflowError(
        (ctx) => `Multiplication overflow: ${ctx.a} * ${ctx.b} = ${ctx.result}`,
        {
          code: ArithmeticOverflowError.code,
          context: {
            operation: 'multiply',
            a: this.amount,
            b: factor,
            result,
            currency: this.currency
          }
        }
      );
    }

    return new Money(result, this.currency);
  }

  getAmount(): number {
    return this.amount;
  }
}

// Использование
try {
  const money = new Money(1e308, 'USDC');
  const result = money.multiply(10); // Переполнение!
} catch (error) {
  if (ArithmeticOverflowError.is(error)) {
    console.error('Overflow:', error.context);
    // { operation: 'multiply', a: 1e308, b: 10, result: Infinity }
  }
}
```

### 2. С Result<T,E> (рекомендуется)

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { ArithmeticOverflowError, InvalidMoneyError, CurrencyMismatchError } from '@polymarket/errors';

class Money {
  private constructor(
    private readonly amount: number,
    public readonly currency: string
  ) {}

  static fromAmount(amount: number, currency: string): Result<Money, InvalidMoneyError | ArithmeticOverflowError> {
    if (!isFinite(amount)) {
      return Err(
        new ArithmeticOverflowError(
          'Amount is not finite',
          {
            code: ArithmeticOverflowError.code,
            context: { amount, currency, operation: 'create' }
          }
        )
      );
    }

    if (amount < 0) {
      return Err(
        new InvalidMoneyError(
          'Amount cannot be negative',
          {
            code: InvalidMoneyError.code,
            context: { amount, currency }
          }
        )
      );
    }

    return Ok(new Money(amount, currency));
  }

  add(other: Money): Result<Money, ArithmeticOverflowError | CurrencyMismatchError> {
    if (this.currency !== other.currency) {
      return Err(
        new CurrencyMismatchError(
          (ctx) => `Cannot add ${ctx.actual} to ${ctx.expected}`,
          {
            code: CurrencyMismatchError.code,
            context: { operation: 'add', expected: this.currency, actual: other.currency }
          }
        )
      );
    }

    const result = this.amount + other.amount;

    if (!isFinite(result)) {
      return Err(
        new ArithmeticOverflowError(
          (ctx) => `Addition overflow: ${ctx.a} + ${ctx.b} = ${ctx.result}`,
          {
            code: ArithmeticOverflowError.code,
            context: {
              operation: 'add',
              a: this.amount,
              b: other.amount,
              result,
              currency: this.currency
            }
          }
        )
      );
    }

    return Ok(new Money(result, this.currency));
  }

  multiply(factor: number): Result<Money, ArithmeticOverflowError> {
    const result = this.amount * factor;

    if (!isFinite(result)) {
      return Err(
        new ArithmeticOverflowError(
          (ctx) => `Multiplication overflow: ${ctx.a} * ${ctx.b} = ${ctx.result}`,
          {
            code: ArithmeticOverflowError.code,
            context: {
              operation: 'multiply',
              a: this.amount,
              b: factor,
              result,
              currency: this.currency
            }
          }
        )
      );
    }

    return Ok(new Money(result, this.currency));
  }

  getAmount(): number {
    return this.amount;
  }
}

// Использование
const moneyResult = Money.fromAmount(1e308, 'USDC');
if (!moneyResult.ok) {
  throw new Error('Failed to create money');
}

const result = moneyResult.value.multiply(10);

if (result.ok) {
  console.log('Result:', result.value.getAmount());
} else {
  console.error('Error:', result.error.message);
}
```

### 3. Проверка всех арифметических операций

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { ArithmeticOverflowError, DivisionByZeroError } from '@polymarket/errors';

class SafeMath {
  /**
   * Безопасное сложение с проверкой переполнения
   */
  static add(a: number, b: number): Result<number, ArithmeticOverflowError> {
    const result = a + b;

    if (!isFinite(result)) {
      return Err(
        new ArithmeticOverflowError(
          (ctx) => `Addition overflow: ${ctx.a} + ${ctx.b} = ${ctx.result}`,
          {
            code: ArithmeticOverflowError.code,
            context: { operation: 'add', a, b, result }
          }
        )
      );
    }

    return Ok(result);
  }

  /**
   * Безопасное вычитание с проверкой переполнения
   */
  static subtract(a: number, b: number): Result<number, ArithmeticOverflowError> {
    const result = a - b;

    if (!isFinite(result)) {
      return Err(
        new ArithmeticOverflowError(
          (ctx) => `Subtraction overflow: ${ctx.a} - ${ctx.b} = ${ctx.result}`,
          {
            code: ArithmeticOverflowError.code,
            context: { operation: 'subtract', a, b, result }
          }
        )
      );
    }

    return Ok(result);
  }

  /**
   * Безопасное умножение с проверкой переполнения
   */
  static multiply(a: number, b: number): Result<number, ArithmeticOverflowError> {
    const result = a * b;

    if (!isFinite(result)) {
      return Err(
        new ArithmeticOverflowError(
          (ctx) => `Multiplication overflow: ${ctx.a} * ${ctx.b} = ${ctx.result}`,
          {
            code: ArithmeticOverflowError.code,
            context: { operation: 'multiply', a, b, result }
          }
        )
      );
    }

    return Ok(result);
  }

  /**
   * Безопасное деление с проверкой переполнения и деления на ноль
   */
  static divide(a: number, b: number): Result<number, ArithmeticOverflowError | DivisionByZeroError> {
    if (b === 0) {
      return Err(
        new DivisionByZeroError(
          (ctx) => `Cannot divide ${ctx.a} by zero`,
          {
            code: DivisionByZeroError.code,
            context: { operation: 'divide', dividend: a, divisor: b }
          }
        )
      );
    }

    const result = a / b;

    if (!isFinite(result)) {
      return Err(
        new ArithmeticOverflowError(
          (ctx) => `Division overflow: ${ctx.a} / ${ctx.b} = ${ctx.result}`,
          {
            code: ArithmeticOverflowError.code,
            context: { operation: 'divide', a, b, result }
          }
        )
      );
    }

    return Ok(result);
  }
}

// Использование
const result = SafeMath.multiply(1e308, 10);

if (result.ok) {
  console.log('Result:', result.value);
} else {
  console.error('Overflow:', result.error.message);
}
```

### 4. Расчёт процентов с защитой от переполнения

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { ArithmeticOverflowError } from '@polymarket/errors';

// Примечание: SafeMath определён в Примере 3 выше
class InterestCalculator {
  /**
   * Вычислить сложный процент: principal * (1 + rate)^periods
   */
  static calculateCompoundInterest(
    principal: number,
    rate: number,
    periods: number
  ): Result<number, ArithmeticOverflowError> {
    // Вычисляем (1 + rate) используя SafeMath (см. Пример 3)
    const rateResult = SafeMath.add(1, rate);
    if (!rateResult.ok) {
      return Err(rateResult.error);
    }

    const base = rateResult.value;

    // Вычисляем base^periods
    const power = Math.pow(base, periods);

    if (!isFinite(power)) {
      return Err(
        new ArithmeticOverflowError(
          (ctx) => `Power overflow: ${ctx.base}^${ctx.periods} = ${ctx.result}`,
          {
            code: ArithmeticOverflowError.code,
            context: { operation: 'compound interest', base, periods, result: power, principal }
          }
        )
      );
    }

    // Вычисляем principal * power
    const finalResult = principal * power;

    if (!isFinite(finalResult)) {
      return Err(
        new ArithmeticOverflowError(
          (ctx) => `Interest calculation overflow: ${ctx.principal} * ${ctx.multiplier} = ${ctx.result}`,
          {
            code: ArithmeticOverflowError.code,
            context: { operation: 'compound interest', principal, multiplier: power, result: finalResult }
          }
        )
      );
    }

    return Ok(finalResult);
  }
}

// Использование
const result = InterestCalculator.calculateCompoundInterest(1000, 0.1, 100);

if (result.ok) {
  console.log('Final amount:', result.value);
} else {
  console.error('Calculation overflow:', result.error.message);
}
```

### 5. Интеграция с decimal.js для точных вычислений

```typescript
import Decimal from 'decimal.js';
import { Result, Ok, Err } from '@polymarket/result';
import { ArithmeticOverflowError, InvalidMoneyError, CurrencyMismatchError } from '@polymarket/errors';

class DecimalMoney {
  private constructor(
    private readonly amount: Decimal,
    public readonly currency: string
  ) {}

  static fromDecimal(
    amount: Decimal,
    currency: string
  ): Result<DecimalMoney, ArithmeticOverflowError | InvalidMoneyError> {
    // Проверка на Infinity
    if (!amount.isFinite()) {
      return Err(
        new ArithmeticOverflowError(
          'Amount is not finite',
          {
            code: ArithmeticOverflowError.code,
            context: { amount: amount.toString(), currency, operation: 'create' }
          }
        )
      );
    }

    // Проверка на отрицательные значения
    if (amount.isNegative()) {
      return Err(
        new InvalidMoneyError(
          'Amount cannot be negative',
          {
            code: InvalidMoneyError.code,
            context: { amount: amount.toString(), currency }
          }
        )
      );
    }

    return Ok(new DecimalMoney(amount, currency));
  }

  add(other: DecimalMoney): Result<DecimalMoney, ArithmeticOverflowError | CurrencyMismatchError> {
    if (this.currency !== other.currency) {
      return Err(
        new CurrencyMismatchError(
          (ctx) => `Cannot add ${ctx.actual} to ${ctx.expected}`,
          {
            code: CurrencyMismatchError.code,
            context: { operation: 'add', expected: this.currency, actual: other.currency }
          }
        )
      );
    }

    try {
      const result = this.amount.plus(other.amount);

      if (!result.isFinite()) {
        return Err(
          new ArithmeticOverflowError(
            'Addition resulted in overflow',
            {
              code: ArithmeticOverflowError.code,
              context: {
                operation: 'add',
                a: this.amount.toString(),
                b: other.amount.toString(),
                result: result.toString(),
                currency: this.currency
              }
            }
          )
        );
      }

      return Ok(new DecimalMoney(result, this.currency));
    } catch (error) {
      return Err(
        new ArithmeticOverflowError(
          (ctx) => `Addition error: ${ctx.error}`,
          {
            code: ArithmeticOverflowError.code,
            context: {
              operation: 'add',
              a: this.amount.toString(),
              b: other.amount.toString(),
              error: String(error),
              currency: this.currency
            }
          }
        )
      );
    }
  }

  multiply(factor: Decimal): Result<DecimalMoney, ArithmeticOverflowError> {
    try {
      const result = this.amount.mul(factor);

      if (!result.isFinite()) {
        return Err(
          new ArithmeticOverflowError(
            'Multiplication resulted in overflow',
            {
              code: ArithmeticOverflowError.code,
              context: {
                operation: 'multiply',
                a: this.amount.toString(),
                b: factor.toString(),
                result: result.toString(),
                currency: this.currency
              }
            }
          )
        );
      }

      return Ok(new DecimalMoney(result, this.currency));
    } catch (error) {
      return Err(
        new ArithmeticOverflowError(
          (ctx) => `Multiplication error: ${ctx.error}`,
          {
            code: ArithmeticOverflowError.code,
            context: {
              operation: 'multiply',
              a: this.amount.toString(),
              b: factor.toString(),
              error: String(error),
              currency: this.currency
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
```

---

## Edge Cases

### Переполнение при сложении

```typescript
// Number.MAX_VALUE + Number.MAX_VALUE = Infinity
SafeMath.add(Number.MAX_VALUE, Number.MAX_VALUE);
// ❌ Err(ArithmeticOverflowError)

// Очень большие числа
SafeMath.add(1e308, 1e308);
// ❌ Err(ArithmeticOverflowError)

// Безопасные значения
SafeMath.add(1000, 2000);
// ✅ Ok(3000)
```

### Переполнение при умножении

```typescript
// 1e200 * 1e200 = Infinity
SafeMath.multiply(1e200, 1e200);
// ❌ Err(ArithmeticOverflowError)

// Number.MAX_VALUE * 2 = Infinity
SafeMath.multiply(Number.MAX_VALUE, 2);
// ❌ Err(ArithmeticOverflowError)

// Безопасные значения
SafeMath.multiply(1000, 1000);
// ✅ Ok(1000000)
```

### Переполнение при экспоненциации

```typescript
// Math.pow(10, 1000) = Infinity
const result = Math.pow(10, 1000);
if (!isFinite(result)) {
  // ❌ ArithmeticOverflowError
}

// Math.pow(2, 1024) = Infinity
const result2 = Math.pow(2, 1024);
if (!isFinite(result2)) {
  // ❌ ArithmeticOverflowError
}

// Безопасные значения
const result3 = Math.pow(2, 10); // ✅ 1024
```

### Отрицательное переполнение

```typescript
// -1e308 - 1e308 = -Infinity
SafeMath.subtract(-1e308, 1e308);
// ❌ Err(ArithmeticOverflowError)

// Number.MIN_VALUE (самое малое положительное) не переполняется
SafeMath.subtract(0, Number.MIN_VALUE);
// ✅ Ok(-5e-324)
```

### Граничные значения

```typescript
// Максимальное безопасное целое
const max = Number.MAX_SAFE_INTEGER; // 9007199254740991
SafeMath.add(max, 1); // ✅ Ok(9007199254740992) - все еще конечное

// Но за пределами MAX_SAFE_INTEGER точность теряется
SafeMath.add(Number.MAX_SAFE_INTEGER, 2); // ✅ Ok(...) - но может быть неточным

// Number.MAX_VALUE
SafeMath.multiply(Number.MAX_VALUE, 2); // ❌ Err(ArithmeticOverflowError)
```

### Деление с переполнением (редкий случай)

```typescript
// Деление очень малого на очень большое
SafeMath.divide(Number.MIN_VALUE, Number.MAX_VALUE);
// ✅ Ok(0) или очень малое число

// Деление очень большого на очень малое может привести к Infinity
SafeMath.divide(Number.MAX_VALUE, Number.MIN_VALUE);
// ❌ Err(ArithmeticOverflowError) - результат Infinity
```

---

## Обработка ошибок

### По типу ошибки

```typescript
import { ArithmeticOverflowError } from '@polymarket/errors';

try {
  const result = calculateTotal(values);
} catch (error) {
  if (ArithmeticOverflowError.is(error)) {
    console.error('Arithmetic overflow:', error.context);

    const operation = error.context?.operation as string;
    const result = error.context?.result;

    showUserMessage(
      `Calculation resulted in overflow. ` +
      `The ${operation} operation produced ${result}.`
    );

    // Использовать decimal.js или другую библиотеку для больших чисел
    return calculateWithBigNumbers(values);
  } else {
    console.error('Unexpected error:', error);
    throw error;
  }
}
```

### По коду ошибки

```typescript
import { ArithmeticOverflowError, DivisionByZeroError } from '@polymarket/errors';

const result = SafeMath.divide(a, b);

if (result.ok) {
  processValue(result.value);
} else {
  if (result.error.code === ArithmeticOverflowError.code) {
    showError('Calculation overflow - result too large', result.error.context);
  } else if (result.error.code === DivisionByZeroError.code) {
    showError('Cannot divide by zero', result.error.context);
  } else {
    showError('Unexpected error', result.error);
  }
}
```

### С fallback на decimal.js

```typescript
import Decimal from 'decimal.js';
import { ArithmeticOverflowError } from '@polymarket/errors';

function multiplyWithFallback(a: number, b: number): number {
  const result = SafeMath.multiply(a, b);

  if (result.ok) {
    return result.value;
  } else {
    if (ArithmeticOverflowError.is(result.error)) {
      logger.warn('Overflow detected, using decimal.js', result.error.toJSON());

      // Fallback на decimal.js для больших чисел
      const decimalA = new Decimal(a);
      const decimalB = new Decimal(b);
      const decimalResult = decimalA.mul(decimalB);

      return decimalResult.toNumber();
    }
    throw result.error;
  }
}
```

### С логированием

```typescript
import { ArithmeticOverflowError } from '@polymarket/errors';

function calculateWithLogging(
  operation: string,
  fn: () => Result<number, ArithmeticOverflowError>
): Result<number, ArithmeticOverflowError> {
  const result = fn();

  if (result.ok) {
    logger.info('Calculation successful', {
      operation,
      result: result.value
    });
  } else {
    logger.error('Arithmetic overflow', {
      operation,
      error: result.error.toJSON()
    });
  }

  return result;
}

// Использование
const result = calculateWithLogging('compound interest', () =>
  InterestCalculator.calculateCompoundInterest(1000, 0.1, 100)
);
```

---

## Связанные ошибки

- [DivisionByZeroError](./division-by-zero.md) - деление на ноль (также может привести к Infinity)
- [InvalidAmountError](./invalid-amount.md) - универсальная валидация чисел

## См. также

- [Value Objects Errors](./README.md) - Обзор категории
- [Обработка ошибок](../error-handling.md) - Best practices
- [Главная документация](../README.md)
