# InvalidRatioError

Ошибка валидации соотношения (Ratio value object).

## Описание

Ratio представляет собой математическое соотношение двух величин:

- Может быть представлено как дробь (numerator/denominator)
- Должно быть конечным числом (не NaN, не Infinity)
- Может иметь дополнительные бизнес-ограничения (диапазон значений, знак)

Валидация проверяет математическую корректность и доменные правила.

## Свойства

| Свойство | Значение |
|----------|----------|
| **Код** | `INVALID_RATIO` |
| **Severity** | `low` |
| **Класс** | `InvalidRatioError` |
| **Пакет** | `@polymarket/errors` |
| **Категория** | Value Objects |

## Когда использовать

- Создание value object `Ratio` из пользовательского ввода
- Валидация коэффициентов, множителей, пропорций
- Расчёт leverage, margin ratio, win/loss ratio
- Проверка корректности exchange rate, price ratio

## Импорт

```typescript
import { InvalidRatioError, DivisionByZeroError } from '@polymarket/errors';

// Для примеров с Result<T,E>:
import { Result, Ok, Err } from '@polymarket/result';

// Для работы с высокой точностью:
import Decimal from 'decimal.js';
```

---

## Примеры использования

### 1. Базовое использование (throw)

```typescript
import { InvalidRatioError } from '@polymarket/errors';
import Decimal from 'decimal.js';

class Ratio {
  constructor(private readonly value: Decimal) {
    if (!value.isFinite()) {
      throw new InvalidRatioError(
        (ctx) => `Ratio must be finite, got ${ctx.value}`,
        {
          
          context: {
            value: value.toString(),
            reason: 'non-finite'
          }
        }
      );
    }
  }
}

// Использование
try {
  const ratio = new Ratio(new Decimal(NaN)); // ❌ Ошибка!
} catch (error) {
  if (InvalidRatioError.is(error)) {
    console.error('Invalid ratio:', error.context);
  }
}
```

### 2. С Result<T,E> (рекомендуется)

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidRatioError } from '@polymarket/errors';
import Decimal from 'decimal.js';

class Ratio {
  private constructor(private readonly value: Decimal) {}

  static create(value: Decimal): Result<Ratio, InvalidRatioError> {
    if (!value.isFinite()) {
      return Err(
        new InvalidRatioError(
          (ctx) => `Ratio must be finite, got ${ctx.value}`,
          {
            
            context: {
              value: value.toString(),
              reason: 'non-finite'
            }
          }
        )
      );
    }

    return Ok(new Ratio(value));
  }

  static fromFraction(
    numerator: Decimal,
    denominator: Decimal
  ): Result<Ratio, InvalidRatioError | DivisionByZeroError> {
    if (denominator.isZero()) {
      return Err(
        new DivisionByZeroError(
          (ctx) => `Cannot create ratio: denominator is zero`,
          {
            code: DivisionByZeroError.code,
            context: {
              numerator: numerator.toString(),
              denominator: '0',
              operation: 'Ratio.fromFraction'
            }
          }
        )
      );
    }

    const value = numerator.div(denominator);

    if (!value.isFinite()) {
      return Err(
        new InvalidRatioError(
          (ctx) => `Ratio calculation resulted in non-finite value: ${ctx.numerator} / ${ctx.denominator}`,
          {
            
            context: {
              numerator: numerator.toString(),
              denominator: denominator.toString(),
              result: value.toString(),
              reason: 'non-finite-result'
            }
          }
        )
      );
    }

    return Ok(new Ratio(value));
  }

  getValue(): Decimal {
    return this.value;
  }

  toNumber(): number {
    return this.value.toNumber();
  }
}

// Использование
const result = Ratio.create(new Decimal('1.5'));

if (result.ok) {
  console.log('Ratio:', result.value.toNumber()); // 1.5
} else {
  console.error('Error:', result.error.message);
}

const fractionResult = Ratio.fromFraction(
  new Decimal('3'),
  new Decimal('2')
);
// ✅ Ok (1.5)
```

### 3. С доменными ограничениями

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidRatioError } from '@polymarket/errors';
import Decimal from 'decimal.js';

class Ratio {
  private static readonly MIN_POSITIVE = new Decimal('0');
  private static readonly MAX_LEVERAGE = new Decimal('100');

  static createPositive(
    value: Decimal
  ): Result<Ratio, InvalidRatioError> {
    if (!value.isFinite()) {
      return Err(
        new InvalidRatioError(
          (ctx) => `Ratio must be finite, got ${ctx.value}`,
          {
            
            context: { value: value.toString(), reason: 'non-finite' }
          }
        )
      );
    }

    if (value.lessThanOrEqualTo(Ratio.MIN_POSITIVE)) {
      return Err(
        new InvalidRatioError(
          (ctx) => `Ratio must be positive, got ${ctx.value}`,
          {
            
            context: {
              value: value.toString(),
              min: Ratio.MIN_POSITIVE.toString(),
              reason: 'non-positive'
            }
          }
        )
      );
    }

    return Ok(new Ratio(value));
  }

  static createLeverage(
    value: Decimal
  ): Result<Ratio, InvalidRatioError> {
    const baseResult = Ratio.createPositive(value);
    if (!baseResult.ok) {
      return baseResult;
    }

    if (value.greaterThan(Ratio.MAX_LEVERAGE)) {
      return Err(
        new InvalidRatioError(
          (ctx) => `Leverage ratio cannot exceed ${ctx.max}, got ${ctx.value}`,
          {
            
            context: {
              value: value.toString(),
              max: Ratio.MAX_LEVERAGE.toString(),
              reason: 'leverage-too-high'
            }
          }
        )
      );
    }

    return baseResult;
  }

  static createPercentage(
    value: Decimal
  ): Result<Ratio, InvalidRatioError> {
    if (!value.isFinite()) {
      return Err(
        new InvalidRatioError(
          (ctx) => `Percentage ratio must be finite, got ${ctx.value}`,
          {
            
            context: { value: value.toString(), reason: 'non-finite' }
          }
        )
      );
    }

    if (value.lessThan(0) || value.greaterThan(1)) {
      return Err(
        new InvalidRatioError(
          (ctx) => `Percentage ratio must be in [0, 1], got ${ctx.value}`,
          {
            
            context: {
              value: value.toString(),
              min: '0',
              max: '1',
              reason: 'out-of-percentage-range'
            }
          }
        )
      );
    }

    return Ok(new Ratio(value));
  }
}

// Использование
Ratio.createPositive(new Decimal('1.5'));   // ✅ Ok
Ratio.createPositive(new Decimal('-1'));    // ❌ Err (non-positive)
Ratio.createPositive(new Decimal('0'));     // ❌ Err (non-positive)

Ratio.createLeverage(new Decimal('10'));    // ✅ Ok
Ratio.createLeverage(new Decimal('150'));   // ❌ Err (leverage-too-high)

Ratio.createPercentage(new Decimal('0.5')); // ✅ Ok (50%)
Ratio.createPercentage(new Decimal('1.5')); // ❌ Err (out-of-percentage-range)
```

### 4. Операции с соотношениями

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidRatioError, ArithmeticOverflowError } from '@polymarket/errors';
import Decimal from 'decimal.js';

class Ratio {
  multiply(other: Ratio): Result<Ratio, InvalidRatioError | ArithmeticOverflowError> {
    const result = this.value.times(other.value);

    if (!result.isFinite()) {
      return Err(
        new ArithmeticOverflowError(
          (ctx) => `Ratio multiplication resulted in overflow: ${ctx.a} * ${ctx.b}`,
          {
            code: ArithmeticOverflowError.code,
            context: {
              operation: 'multiply',
              a: this.value.toString(),
              b: other.value.toString(),
              result: result.toString()
            }
          }
        )
      );
    }

    return Ratio.create(result);
  }

  divide(other: Ratio): Result<Ratio, InvalidRatioError | DivisionByZeroError> {
    if (other.value.isZero()) {
      return Err(
        new DivisionByZeroError(
          (ctx) => `Cannot divide ratio by zero`,
          {
            code: DivisionByZeroError.code,
            context: {
              dividend: this.value.toString(),
              divisor: '0',
              operation: 'Ratio.divide'
            }
          }
        )
      );
    }

    const result = this.value.div(other.value);

    if (!result.isFinite()) {
      return Err(
        new ArithmeticOverflowError(
          (ctx) => `Ratio division resulted in overflow: ${ctx.a} / ${ctx.b}`,
          {
            code: ArithmeticOverflowError.code,
            context: {
              operation: 'divide',
              a: this.value.toString(),
              b: other.value.toString(),
              result: result.toString()
            }
          }
        )
      );
    }

    return Ratio.create(result);
  }

  invert(): Result<Ratio, DivisionByZeroError> {
    if (this.value.isZero()) {
      return Err(
        new DivisionByZeroError(
          (ctx) => `Cannot invert zero ratio`,
          {
            code: DivisionByZeroError.code,
            context: {
              value: '0',
              operation: 'Ratio.invert'
            }
          }
        )
      );
    }

    const result = new Decimal('1').div(this.value);
    return Ratio.create(result);
  }
}

// Использование
const ratio1 = Ratio.create(new Decimal('2')).value;
const ratio2 = Ratio.create(new Decimal('3')).value;

const product = ratio1.multiply(ratio2);
// ✅ Ok (6)

const quotient = ratio1.divide(ratio2);
// ✅ Ok (0.666...)

const inverted = ratio1.invert();
// ✅ Ok (0.5)

const zeroRatio = Ratio.create(new Decimal('0')).value;
const invertZero = zeroRatio.invert();
// ❌ Err (DivisionByZeroError)
```

### 5. Margin ratio (кастомный пример)

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidRatioError } from '@polymarket/errors';
import Decimal from 'decimal.js';

class MarginRatio extends Ratio {
  private static readonly MIN_MARGIN_RATIO = new Decimal('0.1'); // 10%
  private static readonly LIQUIDATION_RATIO = new Decimal('0.05'); // 5%

  static fromBalances(
    equity: Decimal,
    borrowed: Decimal
  ): Result<MarginRatio, InvalidRatioError | DivisionByZeroError> {
    if (borrowed.isZero()) {
      // Нет долга - margin ratio = infinity (максимально безопасно)
      // Но для практичности возвращаем условно "очень высокий" ratio
      return Ok(new MarginRatio(new Decimal('1'))); // 100%
    }

    const totalValue = equity.plus(borrowed);

    if (totalValue.isZero() || totalValue.isNegative()) {
      return Err(
        new InvalidRatioError(
          (ctx) => `Invalid total value for margin calculation: ${ctx.totalValue}`,
          {
            
            context: {
              equity: equity.toString(),
              borrowed: borrowed.toString(),
              totalValue: totalValue.toString(),
              reason: 'invalid-total-value'
            }
          }
        )
      );
    }

    const ratio = equity.div(totalValue);

    if (!ratio.isFinite()) {
      return Err(
        new InvalidRatioError(
          (ctx) => `Margin ratio calculation resulted in non-finite value`,
          {
            
            context: {
              equity: equity.toString(),
              totalValue: totalValue.toString(),
              ratio: ratio.toString(),
              reason: 'non-finite-margin'
            }
          }
        )
      );
    }

    return Ok(new MarginRatio(ratio));
  }

  isHealthy(): boolean {
    return this.value.greaterThanOrEqualTo(MarginRatio.MIN_MARGIN_RATIO);
  }

  isLiquidatable(): boolean {
    return this.value.lessThanOrEqualTo(MarginRatio.LIQUIDATION_RATIO);
  }

  getHealthLevel(): 'healthy' | 'warning' | 'critical' {
    if (this.isLiquidatable()) {
      return 'critical';
    }
    if (!this.isHealthy()) {
      return 'warning';
    }
    return 'healthy';
  }
}

// Использование
const result = MarginRatio.fromBalances(
  new Decimal('1000'), // equity
  new Decimal('9000')  // borrowed
);

if (result.ok) {
  const ratio = result.value;
  console.log('Margin ratio:', ratio.toNumber()); // 0.1 (10%)
  console.log('Health:', ratio.getHealthLevel());  // 'healthy'
  console.log('Is liquidatable?', ratio.isLiquidatable()); // false
}
```

---

## Edge Cases

### Специальные значения

```typescript
// NaN
Ratio.create(new Decimal(NaN));         // ❌ Err (non-finite)

// Infinity
Ratio.create(new Decimal(Infinity));    // ❌ Err (non-finite)
Ratio.create(new Decimal(-Infinity));   // ❌ Err (non-finite)

// Ноль (математически валиден)
Ratio.create(new Decimal('0'));         // ✅ Ok (но может быть запрещён доменными правилами)

// Отрицательные (математически валидны)
Ratio.create(new Decimal('-1.5'));      // ✅ Ok (но может быть запрещён доменными правилами)

// Очень малые/большие
Ratio.create(new Decimal('1e-100'));    // ✅ Ok
Ratio.create(new Decimal('1e100'));     // ✅ Ok
```

### Деление на ноль

```typescript
// Создание из дроби с нулевым знаменателем
Ratio.fromFraction(new Decimal('10'), new Decimal('0'));
// ❌ Err (DivisionByZeroError)

// Инверсия нулевого ratio
const zero = Ratio.create(new Decimal('0')).value;
zero.invert();
// ❌ Err (DivisionByZeroError)
```

---

## Обработка ошибок

### По причине ошибки

```typescript
import { InvalidRatioError } from '@polymarket/errors';

const result = Ratio.create(value);

if (result.ok) {
  processRatio(result.value);
} else {
  if (InvalidRatioError.is(result.error)) {
    const reason = result.error.context?.reason;

    switch (reason) {
      case 'non-finite':
        showError('Ratio must be a valid finite number');
        break;
      case 'non-positive':
        showError('Ratio must be positive');
        break;
      case 'leverage-too-high':
        showError('Leverage ratio exceeds maximum allowed');
        break;
      case 'out-of-percentage-range':
        showError('Percentage must be between 0% and 100%');
        break;
      default:
        showError('Invalid ratio');
    }
  }
}
```

### С логированием

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidRatioError } from '@polymarket/errors';

function calculateRatioWithLogging(
  numerator: Decimal,
  denominator: Decimal
): Result<Ratio, InvalidRatioError | DivisionByZeroError> {
  logger.debug('Calculating ratio', {
    numerator: numerator.toString(),
    denominator: denominator.toString()
  });

  const result = Ratio.fromFraction(numerator, denominator);

  if (result.ok) {
    logger.info('Ratio calculated', {
      value: result.value.toNumber()
    });
  } else {
    logger.error('Ratio calculation failed', {
      error: result.error.toJSON(),
      numerator: numerator.toString(),
      denominator: denominator.toString()
    });
  }

  return result;
}
```

---

## Связанные ошибки

- [DivisionByZeroError](./division-by-zero.md) - при создании из дроби с нулевым знаменателем
- [ArithmeticOverflowError](./arithmetic-overflow.md) - при переполнении в операциях
- [InvalidPercentageError](./invalid-percentage.md) - для процентных соотношений

## См. также

- [Value Objects Errors](./README.md) - Обзор категории
- [Обработка ошибок](../error-handling.md) - Best practices
- [Главная документация](../README.md)
