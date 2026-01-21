# DivisionByZeroError

Ошибка деления на ноль в арифметических операциях торговой системы Polymarket.

## Описание

Выбрасывается при попытке выполнить деление на ноль в арифметических операциях value objects. Деление на ноль математически невозможно и приводит к неопределенности.

## Свойства

| Свойство | Значение |
|----------|----------|
| **Код** | `DIVISION_BY_ZERO` |
| **Severity** | `low` |
| **Класс** | `DivisionByZeroError` |
| **Пакет** | `@polymarket/errors` |
| **Категория** | Value Objects |

## Когда использовать

- Вычисление средней цены: `totalCost / quantity`
- Вычисление процента: `profit / investment`
- Нормализация значений: `value / total`
- Вычисление коэффициентов: `a / b`
- Любые операции деления в value objects
- Расчёт spread: `(ask - bid) / mid`

## Импорт

```typescript
import { DivisionByZeroError } from '@polymarket/errors';
```

---

## Примеры использования

### 1. Базовое использование (throw)

```typescript
import { DivisionByZeroError } from '@polymarket/errors';

class Price {
  constructor(private readonly value: number) {}

  divide(divisor: number): Price {
    if (divisor === 0) {
      throw new DivisionByZeroError(
        (ctx) => `Cannot divide ${ctx.dividend} by zero`,
        {
          code: DivisionByZeroError.code,
          context: { dividend: this.value, divisor: 0, operation: 'Price.divide' }
        }
      );
    }

    return new Price(this.value / divisor);
  }

  getValue(): number {
    return this.value;
  }
}

// Использование
try {
  const price = new Price(100);
  const result = price.divide(0);
} catch (error) {
  if (DivisionByZeroError.is(error)) {
    console.error('Division by zero:', error.context);
    // { dividend: 100, divisor: 0, operation: 'Price.divide' }
  }
}
```

### 2. С Result<T,E> (рекомендуется)

```typescript
import { Result } from '@polymarket/types';
import { DivisionByZeroError } from '@polymarket/errors';

class Money {
  private constructor(
    private readonly amount: number,
    public readonly currency: string
  ) {}

  static fromAmount(amount: number, currency: string): Result<Money, InvalidMoneyError> {
    // ... валидация
    return Result.ok(new Money(amount, currency));
  }

  divide(divisor: number): Result<Money, DivisionByZeroError> {
    if (divisor === 0) {
      return Result.err(
        new DivisionByZeroError(
          (ctx) => `Cannot divide ${ctx.dividend} ${ctx.currency} by zero`,
          {
            code: DivisionByZeroError.code,
            context: { dividend: this.amount, divisor: 0, currency: this.currency, operation: 'Money.divide' }
          }
        )
      );
    }

    return Result.ok(new Money(this.amount / divisor, this.currency));
  }

  getAmount(): number {
    return this.amount;
  }
}

// Использование
const money = Money.fromAmount(1000, 'USDC').unwrap();
const result = money.divide(userInput);

result.match({
  ok: (divided) => console.log('Result:', divided.getAmount()),
  err: (error) => console.error('Error:', error.message)
});
```

### 3. Вычисление средней цены

```typescript
import { Result } from '@polymarket/types';
import { DivisionByZeroError } from '@polymarket/errors';

class AveragePrice {
  private constructor(private readonly value: number) {}

  /**
   * Рассчитать среднюю цену: totalCost / quantity
   */
  static calculate(
    totalCost: number,
    quantity: number
  ): Result<AveragePrice, DivisionByZeroError> {
    if (quantity === 0) {
      return Result.err(
        new DivisionByZeroError(
          (ctx) => `Cannot calculate average price: quantity is zero (total cost: ${ctx.totalCost})`,
          {
            code: DivisionByZeroError.code,
            context: { dividend: totalCost, divisor: quantity, operation: 'average price', totalCost }
          }
        )
      );
    }

    const avgPrice = totalCost / quantity;
    return Result.ok(new AveragePrice(avgPrice));
  }

  getValue(): number {
    return this.value;
  }
}

// Использование
const avgResult = AveragePrice.calculate(1000, 0);

avgResult.match({
  ok: (avg) => console.log('Average price:', avg.getValue()),
  err: (error) => {
    console.error('Cannot calculate average:', error.message);
    // Использовать fallback или показать ошибку пользователю
  }
});
```

### 4. Вычисление процента прибыли

```typescript
import { Result } from '@polymarket/types';
import { DivisionByZeroError } from '@polymarket/errors';

class ProfitPercentage {
  private constructor(private readonly value: number) {}

  /**
   * Рассчитать процент прибыли: (currentValue - investment) / investment * 100
   */
  static calculate(
    investment: number,
    currentValue: number
  ): Result<ProfitPercentage, DivisionByZeroError> {
    if (investment === 0) {
      return Result.err(
        new DivisionByZeroError(
          'Cannot calculate profit percentage: investment is zero',
          {
            code: DivisionByZeroError.code,
            context: {
              dividend: currentValue - investment,
              divisor: investment,
              operation: 'profit percentage',
              investment,
              currentValue
            }
          }
        )
      );
    }

    const profit = currentValue - investment;
    const percentage = (profit / investment) * 100;

    return Result.ok(new ProfitPercentage(percentage));
  }

  getValue(): number {
    return this.value;
  }

  format(): string {
    return `${this.value >= 0 ? '+' : ''}${this.value.toFixed(2)}%`;
  }
}

// Использование
const profitResult = ProfitPercentage.calculate(1000, 1200);

profitResult.match({
  ok: (profit) => console.log('Profit:', profit.format()), // "+20.00%"
  err: (error) => console.error('Error:', error.message)
});
```

### 5. Интеграция с decimal.js для точных вычислений

```typescript
import Decimal from 'decimal.js';
import { Result } from '@polymarket/types';
import { DivisionByZeroError } from '@polymarket/errors';

class DecimalMoney {
  private constructor(
    private readonly amount: Decimal,
    public readonly currency: string
  ) {}

  static fromDecimal(amount: Decimal, currency: string): Result<DecimalMoney, InvalidMoneyError> {
    // ... валидация
    return Result.ok(new DecimalMoney(amount, currency));
  }

  divide(divisor: Decimal): Result<DecimalMoney, DivisionByZeroError> {
    if (divisor.isZero()) {
      return Result.err(
        new DivisionByZeroError(
          (ctx) => `Cannot divide ${ctx.dividend} ${ctx.currency} by zero`,
          {
            code: DivisionByZeroError.code,
            context: {
              dividend: this.amount.toString(),
              divisor: '0',
              currency: this.currency,
              operation: 'DecimalMoney.divide'
            }
          }
        )
      );
    }

    const result = this.amount.div(divisor);
    return Result.ok(new DecimalMoney(result, this.currency));
  }

  divideByNumber(divisor: number): Result<DecimalMoney, DivisionByZeroError> {
    return this.divide(new Decimal(divisor));
  }

  toDecimal(): Decimal {
    return this.amount;
  }
}

// Использование
const money = DecimalMoney.fromDecimal(new Decimal('1000.50'), 'USDC').unwrap();
const result = money.divideByNumber(0);

result.match({
  ok: (divided) => console.log('Result:', divided.toDecimal().toString()),
  err: (error) => console.error('Error:', error.message)
});
```

---

## Edge Cases

### Деление нуля на ноль

```typescript
// 0 / 0 = неопределенность (NaN в JavaScript)
const zero = new Money(0, 'USDC');
const result = zero.divide(0);
// ❌ Result.err(DivisionByZeroError)
// Важно: даже если делимое = 0, деление на ноль недопустимо
```

### Деление отрицательных чисел на ноль

```typescript
const negative = new Money(-100, 'USDC');
const result = negative.divide(0);
// ❌ Result.err(DivisionByZeroError)
// Результат: -Infinity в JavaScript, но мы перехватываем это до вычисления
```

### Очень малые делители (почти ноль)

```typescript
// Технически не ноль, но результат может быть огромным
const money = new Money(100, 'USDC');
const result = money.divide(0.0000001); // ✅ Result.ok(Money(1000000000))

// Если нужна защита от слишком малых делителей:
function safeDivide(
  money: Money,
  divisor: number,
  minDivisor: number = 0.0001
): Result<Money, DivisionByZeroError> {
  if (Math.abs(divisor) < minDivisor) {
    return Result.err(
      new DivisionByZeroError(
        (ctx) => `Divisor ${ctx.divisor} is too close to zero (min: ${ctx.minDivisor})`,
        {
          code: DivisionByZeroError.code,
          context: { dividend: money.getAmount(), divisor, minDivisor, operation: 'safeDivide' }
        }
      )
    );
  }

  return money.divide(divisor);
}
```

### Отрицательный ноль

```typescript
// JavaScript имеет -0, который === 0
const money = new Money(100, 'USDC');
const result = money.divide(-0);
// ❌ Result.err(DivisionByZeroError)
// Проверка divisor === 0 ловит и -0
```

### Цепочка делений

```typescript
import { ResultChain } from '@polymarket/types';

const result = ResultChain
  .from(Money.fromAmount(1000, 'USDC'))
  .flatMap(money => money.divide(2))    // 500
  .flatMap(money => money.divide(5))    // 100
  .flatMap(money => money.divide(0))    // ❌ DivisionByZeroError
  .run();

result.match({
  ok: (money) => console.log('Result:', money.getAmount()),
  err: (error) => {
    // Остановится на первой ошибке (деление на ноль)
    console.error('Error in chain:', error.message);
  }
});
```

---

## Обработка ошибок

### По типу ошибки

```typescript
import { DivisionByZeroError } from '@polymarket/errors';

try {
  const result = calculateAverage(totalCost, quantity);
} catch (error) {
  if (DivisionByZeroError.is(error)) {
    console.error('Division by zero:', error.context);

    const operation = error.context?.operation as string;
    const dividend = error.context?.dividend as number;

    showUserMessage(
      `Cannot calculate ${operation}: divisor is zero. ` +
      `Dividend was ${dividend}.`
    );

    // Использовать fallback значение
    return defaultValue;
  } else {
    console.error('Unexpected error:', error);
    throw error;
  }
}
```

### По коду ошибки

```typescript
import { DivisionByZeroError } from '@polymarket/errors';

const result = money.divide(divisor);

result.match({
  ok: (divided) => processMoney(divided),
  err: (error) => {
    if (error.code === DivisionByZeroError.code) {
      showError('Cannot divide by zero', error.context);

      // Использовать альтернативный подход
      return handleZeroDivisor();
    } else {
      showError('Unexpected error', error);
    }
  }
});
```

### С fallback значением

```typescript
import { DivisionByZeroError } from '@polymarket/errors';

function divideOrDefault(
  money: Money,
  divisor: number,
  defaultValue: Money
): Money {
  return money.divide(divisor).match({
    ok: (result) => result,
    err: (error) => {
      if (DivisionByZeroError.is(error)) {
        logger.warn('Division by zero, using default', {
          error: error.toJSON(),
          default: defaultValue.getAmount()
        });
        return defaultValue;
      }
      throw error;
    }
  });
}

// Использование
const result = divideOrDefault(
  money,
  userInput,
  Money.fromAmount(0, 'USDC').unwrap() // Fallback = 0
);
```

### С логированием

```typescript
import { DivisionByZeroError } from '@polymarket/errors';

function divideWithLogging(
  money: Money,
  divisor: number,
  operationName: string
): Result<Money, DivisionByZeroError> {
  const result = money.divide(divisor);

  result.match({
    ok: (divided) => {
      logger.info('Division successful', {
        operation: operationName,
        dividend: money.getAmount(),
        divisor,
        result: divided.getAmount()
      });
    },
    err: (error) => {
      logger.error('Division by zero', {
        operation: operationName,
        error: error.toJSON(),
        dividend: money.getAmount(),
        divisor
      });
    }
  });

  return result;
}
```

### Обработка в расчётах

```typescript
import { DivisionByZeroError, ArithmeticOverflowError } from '@polymarket/errors';

/**
 * Вычислить price-to-earnings ratio (P/E)
 */
function calculatePE(
  price: number,
  earnings: number
): Result<number, DivisionByZeroError | ArithmeticOverflowError> {
  // Проверка деления на ноль
  if (earnings === 0) {
    return Result.err(
      new DivisionByZeroError(
        'Cannot calculate P/E ratio: earnings are zero',
        {
          code: DivisionByZeroError.code,
          context: { dividend: price, divisor: earnings, operation: 'P/E ratio' }
        }
      )
    );
  }

  const pe = price / earnings;

  // Проверка переполнения
  if (!isFinite(pe)) {
    return Result.err(
      new ArithmeticOverflowError(
        'P/E ratio calculation resulted in overflow',
        {
          code: ArithmeticOverflowError.code,
          context: { price, earnings, result: pe, operation: 'P/E ratio' }
        }
      )
    );
  }

  return Result.ok(pe);
}

// Использование
const peResult = calculatePE(100, 0);

peResult.match({
  ok: (pe) => console.log('P/E ratio:', pe),
  err: (error) => {
    if (error.code === DivisionByZeroError.code) {
      console.error('Earnings are zero');
    } else if (error.code === ArithmeticOverflowError.code) {
      console.error('Calculation overflow');
    }
  }
});
```

---

## Связанные ошибки

- [ArithmeticOverflowError](./arithmetic-overflow.md) - переполнение при арифметических операциях (Infinity)
- [InvalidAmountError](./invalid-amount.md) - универсальная валидация чисел

## См. также

- [Value Objects Errors](./README.md) - Обзор категории
- [Обработка ошибок](../error-handling.md) - Best practices
- [Главная документация](../README.md)