# InvalidAmountError

Ошибка универсальной валидации числовых значений в торговой системе Polymarket.

## Описание

Универсальная ошибка для валидации любых числовых параметров, которые не имеют специфичных ошибок. Используется для leverage, fees, limits и других числовых значений с произвольными диапазонами.

## Свойства

| Свойство | Значение |
|----------|----------|
| **Код** | `INVALID_AMOUNT` |
| **Severity** | `low` |
| **Класс** | `InvalidAmountError` |
| **Пакет** | `@polymarket/errors` |
| **Категория** | Value Objects |

## Когда использовать

- Валидация leverage (кредитное плечо)
- Валидация fee amounts (размер комиссий)
- Валидация limits (лимиты на операции)
- Валидация multipliers (множители)
- Любые числовые параметры без специфичной ошибки
- Универсальная валидация чисел с произвольным диапазоном

## Импорт

```typescript
import { InvalidAmountError } from '@polymarket/errors';

// Для примеров с Result<T,E>:
import { Result, Ok, Err } from '@polymarket/result';
```

---

## Примеры использования

### 1. Базовое использование (throw)

```typescript
import { InvalidAmountError } from '@polymarket/errors';

class Leverage {
  private static readonly MIN = 1;
  private static readonly MAX = 100;

  constructor(private readonly value: number) {
    if (!isFinite(value) || isNaN(value)) {
      throw new InvalidAmountError(
        'Leverage must be a finite number',
        {
          code: InvalidAmountError.code,
          context: { field: 'leverage', value, min: Leverage.MIN, max: Leverage.MAX }
        }
      );
    }

    if (value < Leverage.MIN || value > Leverage.MAX) {
      throw new InvalidAmountError(
        (ctx) => `Invalid leverage ${ctx.value}: must be in [${ctx.min}, ${ctx.max}]`,
        {
          code: InvalidAmountError.code,
          context: { field: 'leverage', value, min: Leverage.MIN, max: Leverage.MAX }
        }
      );
    }
  }

  getValue(): number {
    return this.value;
  }
}

// Использование
try {
  const leverage = new Leverage(150);
} catch (error) {
  if (InvalidAmountError.is(error)) {
    console.error('Invalid leverage:', error.context);
    // { field: 'leverage', value: 150, min: 1, max: 100 }
  }
}
```

### 2. С Result<T,E> (рекомендуется)

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidAmountError } from '@polymarket/errors';

class Amount {
  private constructor(
    private readonly value: number,
    private readonly field: string
  ) {}

  static fromNumber(
    value: number,
    field: string,
    min?: number,
    max?: number
  ): Result<Amount, InvalidAmountError> {
    // Валидация NaN
    if (isNaN(value)) {
      return Err(
        new InvalidAmountError(
          (ctx) => `${ctx.field} must be a valid number`,
          {
            code: InvalidAmountError.code,
            context: { field, value, min, max, reason: 'NaN' }
          }
        )
      );
    }

    // Валидация Infinity
    if (!isFinite(value)) {
      return Err(
        new InvalidAmountError(
          (ctx) => `${ctx.field} must be finite`,
          {
            code: InvalidAmountError.code,
            context: { field, value, min, max, reason: 'Infinity' }
          }
        )
      );
    }

    // Валидация минимума
    if (min !== undefined && value < min) {
      return Err(
        new InvalidAmountError(
          (ctx) => `${ctx.field} ${ctx.value} is below minimum of ${ctx.min}`,
          {
            code: InvalidAmountError.code,
            context: { field, value, min, max }
          }
        )
      );
    }

    // Валидация максимума
    if (max !== undefined && value > max) {
      return Err(
        new InvalidAmountError(
          (ctx) => `${ctx.field} ${ctx.value} exceeds maximum of ${ctx.max}`,
          {
            code: InvalidAmountError.code,
            context: { field, value, min, max }
          }
        )
      );
    }

    return Ok(new Amount(value, field));
  }

  getValue(): number {
    return this.value;
  }

  getField(): string {
    return this.field;
  }
}

// Использование
const result = Amount.fromNumber(50, 'leverage', 1, 100);

if (result.ok) {
  console.log(`Valid ${result.value.getField()}: ${result.value.getValue()}`);
} else {
  console.error('Error:', result.error.message);
}
```

### 3. Валидация с кастомными правилами

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidAmountError } from '@polymarket/errors';

class Multiplier {
  private constructor(private readonly value: number) {}

  static fromNumber(value: number): Result<Multiplier, InvalidAmountError> {
    // Multiplier должен быть положительным
    if (value <= 0) {
      return Err(
        new InvalidAmountError(
          'Multiplier must be positive',
          {
            code: InvalidAmountError.code,
            context: { field: 'multiplier', value, min: 0 }
          }
        )
      );
    }

    // Multiplier не может быть дробным (для некоторых случаев)
    if (!Number.isInteger(value)) {
      return Err(
        new InvalidAmountError(
          'Multiplier must be a whole number',
          {
            code: InvalidAmountError.code,
            context: { field: 'multiplier', value, reason: 'not integer' }
          }
        )
      );
    }

    // Multiplier не может быть слишком большим
    if (value > 1000) {
      return Err(
        new InvalidAmountError(
          (ctx) => `Multiplier ${ctx.value} is too large (max: ${ctx.max})`,
          {
            code: InvalidAmountError.code,
            context: { field: 'multiplier', value, max: 1000 }
          }
        )
      );
    }

    return Ok(new Multiplier(value));
  }

  getValue(): number {
    return this.value;
  }
}
```

### 4. Обработка в форме настроек торговли

```typescript
import { InvalidAmountError } from '@polymarket/errors';
import { Result, Ok, Err } from '@polymarket/result';

// Используем класс Amount из Примера 2

interface TradingSettings {
  leverage: number;
  maxOrderSize: number;
  minOrderSize: number;
}

function validateTradingSettings(
  settings: TradingSettings
): Result<TradingSettings, InvalidAmountError[]> {
  const errors: InvalidAmountError[] = [];

  // Валидация leverage
  const leverageResult = Amount.fromNumber(settings.leverage, 'leverage', 1, 100);
  if (!leverageResult.ok) {
    errors.push(leverageResult.error);
  }

  // Валидация maxOrderSize
  const maxResult = Amount.fromNumber(settings.maxOrderSize, 'maxOrderSize', 0, 1000000);
  if (!maxResult.ok) {
    errors.push(maxResult.error);
  }

  // Валидация minOrderSize
  const minResult = Amount.fromNumber(settings.minOrderSize, 'minOrderSize', 0, settings.maxOrderSize);
  if (!minResult.ok) {
    errors.push(minResult.error);
  }

  // Проверка что min <= max
  if (settings.minOrderSize > settings.maxOrderSize) {
    errors.push(
      new InvalidAmountError(
        (ctx) => `Min order size ${ctx.min} cannot exceed max order size ${ctx.max}`,
        {
          code: InvalidAmountError.code,
          context: { field: 'orderSize', min: settings.minOrderSize, max: settings.maxOrderSize }
        }
      )
    );
  }

  if (errors.length > 0) {
    return Err(errors);
  }

  return Ok(settings);
}

// Использование
const settingsResult = validateTradingSettings({
  leverage: 50,
  maxOrderSize: 10000,
  minOrderSize: 100
});

if (settingsResult.ok) {
  saveSettings(settingsResult.value);
  showSuccess('Settings saved');
} else {
  settingsResult.error.forEach((error) => {
    const field = error.context?.field as string;
    showFieldError(field, error.message);
  });
}
```

### 5. Интеграция с decimal.js

```typescript
import Decimal from 'decimal.js';
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidAmountError } from '@polymarket/errors';

class DecimalAmount {
  private constructor(
    private readonly value: Decimal,
    private readonly field: string
  ) {}

  static fromDecimal(
    value: Decimal,
    field: string,
    min?: Decimal,
    max?: Decimal
  ): Result<DecimalAmount, InvalidAmountError> {
    // Валидация finite
    if (!value.isFinite()) {
      return Err(
        new InvalidAmountError(
          (ctx) => `${ctx.field} must be finite`,
          {
            code: InvalidAmountError.code,
            context: { field, value: value.toString(), reason: 'not finite' }
          }
        )
      );
    }

    // Валидация минимума
    if (min !== undefined && value.lessThan(min)) {
      return Err(
        new InvalidAmountError(
          (ctx) => `${ctx.field} ${ctx.value} is below minimum of ${ctx.min}`,
          {
            code: InvalidAmountError.code,
            context: { field, value: value.toNumber(), min: min.toNumber(), max: max?.toNumber() }
          }
        )
      );
    }

    // Валидация максимума
    if (max !== undefined && value.greaterThan(max)) {
      return Err(
        new InvalidAmountError(
          (ctx) => `${ctx.field} ${ctx.value} exceeds maximum of ${ctx.max}`,
          {
            code: InvalidAmountError.code,
            context: { field, value: value.toNumber(), min: min?.toNumber(), max: max.toNumber() }
          }
        )
      );
    }

    return Ok(new DecimalAmount(value, field));
  }

  static fromNumber(
    value: number,
    field: string,
    min?: number,
    max?: number
  ): Result<DecimalAmount, InvalidAmountError> {
    try {
      const decimal = new Decimal(value);
      const minDecimal = min !== undefined ? new Decimal(min) : undefined;
      const maxDecimal = max !== undefined ? new Decimal(max) : undefined;

      return DecimalAmount.fromDecimal(decimal, field, minDecimal, maxDecimal);
    } catch (error) {
      return Err(
        new InvalidAmountError(
          (ctx) => `Invalid ${ctx.field} format: ${ctx.value}`,
          {
            code: InvalidAmountError.code,
            context: { field, value, error: String(error) }
          }
        )
      );
    }
  }

  toDecimal(): Decimal {
    return this.value;
  }

  getValue(): number {
    return this.value.toNumber();
  }
}
```

---

## Edge Cases

### Граничные значения

```typescript
// Использует класс Amount из Примера 2

// С минимумом и максимумом
Amount.fromNumber(50, 'leverage', 1, 100); // ✅ Ok(Amount)
Amount.fromNumber(1, 'leverage', 1, 100); // ✅ Ok(Amount) - граница
Amount.fromNumber(100, 'leverage', 1, 100); // ✅ Ok(Amount) - граница

Amount.fromNumber(0, 'leverage', 1, 100); // ❌ Err(InvalidAmountError)
Amount.fromNumber(101, 'leverage', 1, 100); // ❌ Err(InvalidAmountError)

// Без минимума
Amount.fromNumber(-100, 'value'); // ✅ Ok(Amount) - нет ограничений
Amount.fromNumber(0, 'value'); // ✅ Ok(Amount)

// Только минимум
Amount.fromNumber(50, 'positive', 0); // ✅ Ok(Amount)
Amount.fromNumber(-1, 'positive', 0); // ❌ Err(InvalidAmountError)

// Только максимум
Amount.fromNumber(50, 'limited', undefined, 100); // ✅ Ok(Amount)
Amount.fromNumber(150, 'limited', undefined, 100); // ❌ Err(InvalidAmountError)
```

### Специальные значения

```typescript
// NaN
Amount.fromNumber(NaN, 'value'); // ❌ Err(InvalidAmountError)

// Infinity
Amount.fromNumber(Infinity, 'value'); // ❌ Err(InvalidAmountError)
Amount.fromNumber(-Infinity, 'value'); // ❌ Err(InvalidAmountError)

// Очень большие числа
Amount.fromNumber(Number.MAX_VALUE, 'value'); // ✅ Ok(Amount)
Amount.fromNumber(Number.MAX_SAFE_INTEGER, 'value'); // ✅ Ok(Amount)

// Очень малые числа
Amount.fromNumber(Number.MIN_VALUE, 'value'); // ✅ Ok(Amount)
Amount.fromNumber(Number.EPSILON, 'value'); // ✅ Ok(Amount)
```

### Различные типы полей

```typescript
// Leverage
Amount.fromNumber(10, 'leverage', 1, 100); // ✅ Кредитное плечо

// Fee
Amount.fromNumber(5, 'fee', 0, 1000); // ✅ Размер комиссии

// Limit
Amount.fromNumber(10000, 'orderLimit', 100, 100000); // ✅ Лимит ордера

// Multiplier
Amount.fromNumber(3, 'multiplier', 1, 10); // ✅ Множитель

// Timeout (в секундах)
Amount.fromNumber(30, 'timeout', 1, 300); // ✅ Таймаут

// Max retries
Amount.fromNumber(3, 'maxRetries', 0, 10); // ✅ Максимум повторов
```

### Комбинированная валидация

```typescript
class OrderLimit {
  private constructor(
    private readonly min: number,
    private readonly max: number
  ) {}

  static fromNumbers(
    min: number,
    max: number
  ): Result<OrderLimit, InvalidAmountError> {
    // Валидация минимума
    const minResult = Amount.fromNumber(min, 'minOrderSize', 0);
    if (!minResult.ok) {
      return Err(minResult.error);
    }

    // Валидация максимума
    const maxResult = Amount.fromNumber(max, 'maxOrderSize', 0);
    if (!maxResult.ok) {
      return Err(maxResult.error);
    }

    // Проверка что min <= max
    if (min > max) {
      return Err(
        new InvalidAmountError(
          (ctx) => `Min ${ctx.min} cannot exceed max ${ctx.max}`,
          {
            code: InvalidAmountError.code,
            context: { field: 'orderLimit', min, max }
          }
        )
      );
    }

    return Ok(new OrderLimit(min, max));
  }

  getMin(): number {
    return this.min;
  }

  getMax(): number {
    return this.max;
  }

  isWithinLimit(value: number): boolean {
    return value >= this.min && value <= this.max;
  }
}

// Использование
const limitResult = OrderLimit.fromNumbers(100, 10000);

if (limitResult.ok) {
  console.log(`Order limits: ${limitResult.value.getMin()} - ${limitResult.value.getMax()}`);
  console.log(limitResult.value.isWithinLimit(500)); // true
} else {
  console.error('Invalid limits:', limitResult.error.message);
}
```

---

## Обработка ошибок

### По типу ошибки

```typescript
import { InvalidAmountError } from '@polymarket/errors';

try {
  const amount = createAmount(userInput, field, min, max);
} catch (error) {
  if (InvalidAmountError.is(error)) {
    console.error('Amount validation failed:', error.context);

    const field = error.context?.field as string;
    const value = error.context?.value as number;
    const reason = error.context?.reason as string;

    if (reason === 'NaN') {
      showUserMessage(`${field} must be a valid number`);
    } else if (reason === 'Infinity') {
      showUserMessage(`${field} value is too large`);
    } else {
      showUserMessage(`Invalid ${field}: ${value}`);
    }
  } else {
    console.error('Unexpected error:', error);
    throw error;
  }
}
```

### По коду ошибки

```typescript
import { InvalidAmountError } from '@polymarket/errors';

const result = Amount.fromNumber(value, field, min, max);

if (result.ok) {
  processAmount(result.value);
} else {
  if (result.error.code === InvalidAmountError.code) {
    const field = result.error.context?.field as string;
    showFieldError(field, result.error.message);
  } else {
    showError('Unexpected error', result.error);
  }
}
```

### С логированием

```typescript
import { InvalidAmountError } from '@polymarket/errors';

function validateAndLogAmount(
  value: number,
  field: string,
  userId: string,
  min?: number,
  max?: number
): Result<Amount, InvalidAmountError> {
  const result = Amount.fromNumber(value, field, min, max);

  if (result.ok) {
    logger.info('Amount validated', {
      userId,
      field: result.value.getField(),
      value: result.value.getValue()
    });
  } else {
    logger.error('Amount validation failed', {
      userId,
      field,
      error: result.error.toJSON(),
      userInput: { value, min, max }
    });
  }

  return result;
}
```

### Обработка множественных полей

```typescript
import { InvalidAmountError } from '@polymarket/errors';
import { toChain } from '@polymarket/result';

interface Config {
  leverage: Amount;
  maxOrderSize: Amount;
  minOrderSize: Amount;
}

function validateConfig(
  leverageInput: number,
  maxInput: number,
  minInput: number
): Result<Config, InvalidAmountError> {
  return toChain(Amount.fromNumber(leverageInput, 'leverage', 1, 100))
    .flatMap(leverage =>
      Amount.fromNumber(maxInput, 'maxOrderSize', 0).map(max => ({ leverage, max }))
    )
    .flatMap(({ leverage, max }) =>
      Amount.fromNumber(minInput, 'minOrderSize', 0, max.getValue()).map(min => ({ leverage, max, min }))
    )
    .map(({ leverage, max, min }) => ({
      leverage,
      maxOrderSize: max,
      minOrderSize: min
    }))
    .toResult();
}

// Использование
const configResult = validateConfig(50, 10000, 100);

if (configResult.ok) {
  const config = configResult.value;
  console.log('Config validated:', config);
  saveConfig(config);
} else {
  const field = configResult.error.context?.field as string;
  showFieldError(field, configResult.error.message);
}
```

---

## Связанные ошибки

- [InvalidOutcomePriceError](./invalid-price.md) - специфичная валидация цен
- [InvalidQuantityError](./invalid-quantity.md) - специфичная валидация количества
- [InvalidMoneyError](./invalid-money.md) - специфичная валидация денежных сумм
- [InvalidPercentageError](./invalid-percentage.md) - специфичная валидация процентов

## См. также

- [Value Objects Errors](./README.md) - Обзор категории
- [Обработка ошибок](../error-handling.md) - Best practices
- [Главная документация](../README.md)
