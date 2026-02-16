# InvalidPercentageError

Ошибка валидации процентного значения в торговой системе Polymarket.

## Описание

Процентное значение может быть представлено в двух форматах:

- **[0, 100]** - обычный формат (50 = 50%)
- **[0, 1]** - дробный формат (0.5 = 50%)

Значение должно находиться в указанном диапазоне и быть конечным числом.

## Свойства

| Свойство | Значение |
|----------|----------|
| **Код** | `INVALID_PERCENTAGE` |
| **Severity** | `low` |
| **Класс** | `InvalidPercentageError` |
| **Пакет** | `@polymarket/errors` |
| **Категория** | Value Objects |

## Когда использовать

- Валидация комиссий (fees)
- Валидация slippage tolerance
- Валидация процентов прибыли/убытков
- Валидация discount/markup значений
- Создание value object `Percentage` из пользовательского ввода
- Парсинг процентных данных из API

## Импорт

```typescript
import { InvalidPercentageError } from '@polymarket/errors';

// Для примеров с Result<T,E>:
import { Result, Ok, Err } from '@polymarket/result';
```

---

## Примеры использования

### 1. Базовое использование (throw)

```typescript
import { InvalidPercentageError } from '@polymarket/errors';

class Percentage {
  constructor(
    private readonly value: number,
    private readonly format: 'decimal' | 'whole' = 'whole' // [0,1] or [0,100]
  ) {
    const [min, max] = format === 'decimal' ? [0, 1] : [0, 100];

    if (!isFinite(value) || isNaN(value)) {
      throw new InvalidPercentageError(
        'Percentage must be a finite number',
        {
          code: InvalidPercentageError.code,
          context: { value, min, max, format }
        }
      );
    }

    if (value < min || value > max) {
      throw new InvalidPercentageError(
        (ctx) => `Invalid percentage ${ctx.value}: must be in [${ctx.min}, ${ctx.max}]`,
        {
          code: InvalidPercentageError.code,
          context: { value, min, max, format }
        }
      );
    }
  }

  getValue(): number {
    return this.value;
  }

  toDecimal(): number {
    return this.format === 'whole' ? this.value / 100 : this.value;
  }
}

// Использование
try {
  const percentage = new Percentage(150); // Выше максимума
} catch (error) {
  if (InvalidPercentageError.is(error)) {
    console.error('Invalid percentage:', error.context?.value);
    // Invalid percentage: 150
  }
}
```

### 2. С Result<T,E> (рекомендуется)

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidPercentageError } from '@polymarket/errors';

class Percentage {
  private constructor(
    private readonly value: number,
    private readonly format: 'decimal' | 'whole'
  ) {}

  /**
   * Создать процент из обычного формата [0, 100]
   */
  static fromWhole(value: number): Result<Percentage, InvalidPercentageError> {
    const min = 0;
    const max = 100;

    if (!isFinite(value) || isNaN(value)) {
      return Err(
        new InvalidPercentageError(
          'Percentage must be a finite number',
          {
            code: InvalidPercentageError.code,
            context: { value, min, max, format: 'whole', reason: 'not finite' }
          }
        )
      );
    }

    if (value < min || value > max) {
      return Err(
        new InvalidPercentageError(
          (ctx) => `Invalid percentage ${ctx.value}%: must be in [${ctx.min}, ${ctx.max}]`,
          {
            code: InvalidPercentageError.code,
            context: { value, min, max, format: 'whole' }
          }
        )
      );
    }

    return Ok(new Percentage(value, 'whole'));
  }

  /**
   * Создать процент из дробного формата [0, 1]
   */
  static fromDecimal(value: number): Result<Percentage, InvalidPercentageError> {
    const min = 0;
    const max = 1;

    if (!isFinite(value) || isNaN(value)) {
      return Err(
        new InvalidPercentageError(
          'Percentage must be a finite number',
          {
            code: InvalidPercentageError.code,
            context: { value, min, max, format: 'decimal', reason: 'not finite' }
          }
        )
      );
    }

    if (value < min || value > max) {
      return Err(
        new InvalidPercentageError(
          (ctx) => `Invalid percentage ${ctx.value}: must be in [${ctx.min}, ${ctx.max}]`,
          {
            code: InvalidPercentageError.code,
            context: { value, min, max, format: 'decimal' }
          }
        )
      );
    }

    return Ok(new Percentage(value, 'decimal'));
  }

  getValue(): number {
    return this.value;
  }

  /**
   * Всегда возвращает дробный формат [0, 1]
   */
  toDecimal(): number {
    return this.format === 'whole' ? this.value / 100 : this.value;
  }

  /**
   * Всегда возвращает обычный формат [0, 100]
   */
  toWhole(): number {
    return this.format === 'decimal' ? this.value * 100 : this.value;
  }
}

// Использование
const result1 = Percentage.fromWhole(50); // 50%
const result2 = Percentage.fromDecimal(0.5); // 50%

result1.match({
  ok: (pct) => console.log('Valid:', pct.toWhole() + '%'),
  err: (error) => console.error('Error:', error.message)
});
```

### 3. Slippage Tolerance с кастомными сообщениями

```typescript
import { InvalidPercentageError } from '@polymarket/errors';

class SlippageTolerance {
  private static readonly DEFAULT_MAX = 5; // 5% по умолчанию
  private static readonly ABSOLUTE_MAX = 50; // 50% абсолютный максимум

  private constructor(private readonly percentage: Percentage) {}

  static fromPercentage(
    value: number,
    maxAllowed: number = SlippageTolerance.DEFAULT_MAX
  ): Result<SlippageTolerance, InvalidPercentageError> {
    if (value < 0) {
      return Err(
        new InvalidPercentageError(
          'Slippage cannot be negative',
          {
            code: InvalidPercentageError.code,
            context: { value, min: 0, max: maxAllowed, field: 'slippage' }
          }
        )
      );
    }

    if (value > SlippageTolerance.ABSOLUTE_MAX) {
      return Err(
        new InvalidPercentageError(
          (ctx) => `Slippage ${ctx.value}% is too high (max: ${ctx.max}%)`,
          {
            code: InvalidPercentageError.code,
            context: { value, min: 0, max: SlippageTolerance.ABSOLUTE_MAX, field: 'slippage' }
          }
        )
      );
    }

    if (value > maxAllowed) {
      return Err(
        new InvalidPercentageError(
          (ctx) => `Warning: High slippage ${ctx.value}% (recommended max: ${ctx.recommended}%)`,
          {
            code: InvalidPercentageError.code,
            context: { value, min: 0, max: SlippageTolerance.ABSOLUTE_MAX, recommended: maxAllowed, field: 'slippage' }
          }
        )
      );
    }

    return Percentage.fromWhole(value).map(pct => new SlippageTolerance(pct));
  }

  getPercentage(): Percentage {
    return this.percentage;
  }
}
```

### 4. Обработка в форме настроек

```typescript
import { InvalidPercentageError } from '@polymarket/errors';

function handleSlippageInput(input: string): void {
  // Используем Number() для более строгого парсинга
  const value = Number(input);

  // Проверка что парсинг успешен
  if (isNaN(value)) {
    showFieldError('slippage', 'Please enter a valid number');
    return;
  }

  const result = SlippageTolerance.fromPercentage(value);

  result.match({
    ok: (slippage) => {
      // Обновляем настройки
      setSlippage(slippage);
      clearError('slippage');

      // Показываем предупреждение для высоких значений
      if (slippage.getPercentage().toWhole() > 1) {
        showWarning('High slippage tolerance may result in unfavorable trades');
      }
    },
    err: (error) => {
      if (InvalidPercentageError.is(error)) {
        const value = error.context?.value as number;
        const max = error.context?.max as number;

        let userMessage = `Slippage must be between 0% and ${max}%`;

        if (value < 0) {
          userMessage = 'Slippage cannot be negative';
        } else if (value > 50) {
          userMessage = 'Slippage is too high (maximum: 50%)';
        }

        showFieldError('slippage', userMessage);
      }
    }
  });
}
```

### 5. Интеграция с decimal.js для точных процентов

```typescript
import Decimal from 'decimal.js';
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidPercentageError } from '@polymarket/errors';

class Percentage {
  private static readonly MIN_DECIMAL = new Decimal('0');
  private static readonly MAX_DECIMAL = new Decimal('1');
  private static readonly MIN_WHOLE = new Decimal('0');
  private static readonly MAX_WHOLE = new Decimal('100');

  private constructor(
    private readonly value: Decimal,
    private readonly format: 'decimal' | 'whole'
  ) {}

  static fromDecimalValue(value: Decimal): Result<Percentage, InvalidPercentageError> {
    if (!value.isFinite()) {
      return Err(
        new InvalidPercentageError(
          'Percentage must be finite',
          {
            code: InvalidPercentageError.code,
            context: { value: value.toString(), min: 0, max: 1, format: 'decimal' }
          }
        )
      );
    }

    if (value.lessThan(Percentage.MIN_DECIMAL) || value.greaterThan(Percentage.MAX_DECIMAL)) {
      return Err(
        new InvalidPercentageError(
          (ctx) => `Invalid percentage ${ctx.value}: must be in [${ctx.min}, ${ctx.max}]`,
          {
            code: InvalidPercentageError.code,
            context: { value: value.toNumber(), min: 0, max: 1, format: 'decimal' }
          }
        )
      );
    }

    return Ok(new Percentage(value, 'decimal'));
  }

  static fromWholeValue(value: Decimal): Result<Percentage, InvalidPercentageError> {
    if (!value.isFinite()) {
      return Err(
        new InvalidPercentageError(
          'Percentage must be finite',
          {
            code: InvalidPercentageError.code,
            context: { value: value.toString(), min: 0, max: 100, format: 'whole' }
          }
        )
      );
    }

    if (value.lessThan(Percentage.MIN_WHOLE) || value.greaterThan(Percentage.MAX_WHOLE)) {
      return Err(
        new InvalidPercentageError(
          (ctx) => `Invalid percentage ${ctx.value}%: must be in [${ctx.min}, ${ctx.max}]`,
          {
            code: InvalidPercentageError.code,
            context: { value: value.toNumber(), min: 0, max: 100, format: 'whole' }
          }
        )
      );
    }

    return Ok(new Percentage(value, 'whole'));
  }

  toDecimal(): Decimal {
    return this.format === 'whole' ? this.value.div(100) : this.value;
  }

  toWhole(): Decimal {
    return this.format === 'decimal' ? this.value.mul(100) : this.value;
  }

  /**
   * Применить процент к сумме
   */
  applyTo(amount: Decimal): Decimal {
    return amount.mul(this.toDecimal());
  }
}

// Пример: расчет комиссии
const feePercent = Percentage.fromWholeValue(new Decimal('0.5')).unwrap(); // 0.5%
const orderAmount = new Decimal('1000');
const fee = feePercent.applyTo(orderAmount); // 5 USDC
```

---

## Edge Cases

### Граничные значения

```typescript
// Формат [0, 100]
Percentage.fromWhole(0); // ✅ Ok(Percentage) - 0%
Percentage.fromWhole(100); // ✅ Ok(Percentage) - 100%
Percentage.fromWhole(50.5); // ✅ Ok(Percentage) - 50.5%

Percentage.fromWhole(-1); // ❌ Err(InvalidPercentageError)
Percentage.fromWhole(101); // ❌ Err(InvalidPercentageError)

// Формат [0, 1]
Percentage.fromDecimal(0); // ✅ Ok(Percentage) - 0%
Percentage.fromDecimal(1); // ✅ Ok(Percentage) - 100%
Percentage.fromDecimal(0.505); // ✅ Ok(Percentage) - 50.5%

Percentage.fromDecimal(-0.01); // ❌ Err(InvalidPercentageError)
Percentage.fromDecimal(1.01); // ❌ Err(InvalidPercentageError)
```

### Специальные значения

```typescript
// NaN
Percentage.fromWhole(NaN); // ❌ Err(InvalidPercentageError)
Percentage.fromDecimal(NaN); // ❌ Err(InvalidPercentageError)

// Infinity
Percentage.fromWhole(Infinity); // ❌ Err(InvalidPercentageError)
Percentage.fromWhole(-Infinity); // ❌ Err(InvalidPercentageError)
Percentage.fromDecimal(Infinity); // ❌ Err(InvalidPercentageError)

// Очень малые значения
Percentage.fromWhole(0.0001); // ✅ Ok(Percentage) - 0.0001%
Percentage.fromDecimal(0.000001); // ✅ Ok(Percentage) - 0.0001%
```

### Конвертация между форматами

```typescript
// Из обычного в дробный
const pct1 = Percentage.fromWhole(50).unwrap();
console.log(pct1.toDecimal()); // 0.5
console.log(pct1.toWhole()); // 50

// Из дробного в обычный
const pct2 = Percentage.fromDecimal(0.5).unwrap();
console.log(pct2.toDecimal()); // 0.5
console.log(pct2.toWhole()); // 50

// Точность при конвертации
const pct3 = Percentage.fromWhole(33.33).unwrap();
console.log(pct3.toDecimal()); // 0.3333 (возможна потеря точности с float)

// Использование decimal.js для точности
const pct4 = Percentage.fromWholeValue(new Decimal('33.33')).unwrap();
console.log(pct4.toDecimal().toString()); // "0.3333" (точно)
```

### Применение процентов к суммам

```typescript
// Расчет комиссии
const tradingFee = Percentage.fromWhole(0.1).unwrap(); // 0.1%
const tradeAmount = 10000;
const fee = tradeAmount * tradingFee.toDecimal(); // 10

// Расчет со slippage
const price = 100;
const slippage = Percentage.fromWhole(1).unwrap(); // 1%
const maxPrice = price * (1 + slippage.toDecimal()); // 101
const minPrice = price * (1 - slippage.toDecimal()); // 99

// Расчет прибыли
const costBasis = 1000;
const currentValue = 1200;
const profitAmount = currentValue - costBasis; // 200
const profitPercent = (profitAmount / costBasis) * 100; // 20%

Percentage.fromWhole(profitPercent); // ✅ Ok(Percentage)
```

---

## Обработка ошибок

### По типу ошибки

```typescript
import { InvalidPercentageError } from '@polymarket/errors';

try {
  const percentage = createPercentage(userInput);
} catch (error) {
  if (InvalidPercentageError.is(error)) {
    console.error('Percentage validation failed:', error.context);

    const value = error.context?.value as number;
    const format = error.context?.format as string;
    const max = error.context?.max as number;

    if (format === 'whole') {
      showUserMessage(`Percentage must be between 0% and ${max}%`);
    } else {
      showUserMessage(`Percentage must be between 0 and ${max}`);
    }
  } else {
    console.error('Unexpected error:', error);
    throw error;
  }
}
```

### По коду ошибки

```typescript
import { InvalidPercentageError } from '@polymarket/errors';

const result = Percentage.fromWhole(userInput);

result.match({
  ok: (percentage) => applyPercentage(percentage),
  err: (error) => {
    if (error.code === InvalidPercentageError.code) {
      showError('Invalid percentage', error.context);
    } else {
      showError('Unexpected error', error);
    }
  }
});
```

### С логированием

```typescript
import { InvalidPercentageError } from '@polymarket/errors';

function validateAndLogPercentage(
  value: number,
  field: string
): Result<Percentage, InvalidPercentageError> {
  const result = Percentage.fromWhole(value);

  result.match({
    ok: (pct) => {
      logger.info('Percentage validated', {
        field,
        value: pct.toWhole() + '%'
      });
    },
    err: (error) => {
      logger.error('Percentage validation failed', {
        field,
        error: error.toJSON(),
        userInput: value
      });
    }
  });

  return result;
}
```

---

## Связанные ошибки

- [InvalidAmountError](./invalid-amount.md) - универсальная валидация чисел
- [InvalidPriceError](./invalid-price.md) - валидация цен (похожая логика диапазона)

## См. также

- [Value Objects Errors](./README.md) - Обзор категории
- [Обработка ошибок](../error-handling.md) - Best practices
- [Главная документация](../README.md)
