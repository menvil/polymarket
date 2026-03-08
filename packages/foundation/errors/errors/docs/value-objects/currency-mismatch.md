# CurrencyMismatchError

Ошибка несоответствия валют при операциях с денежными суммами в торговой системе Polymarket.

## Описание

Выбрасывается при попытке выполнить операцию с денежными значениями в разных валютах без явной конвертации. Операции с разными валютами (например, сложение USDC и BTC) математически некорректны и требуют предварительной конвертации.

## Свойства

| Свойство | Значение |
|----------|----------|
| **Код** | `CURRENCY_MISMATCH` |
| **Severity** | `low` |
| **Класс** | `CurrencyMismatchError` |
| **Пакет** | `@polymarket/errors` |
| **Категория** | Value Objects |

## Когда использовать

- Сложение: `Money(100, 'USDC') + Money(50, 'EUR')`
- Вычитание: `Money(100, 'USDC') - Money(50, 'BTC')`
- Сравнение: `Money(100, 'USDC') > Money(50, 'EUR')`
- Любые операции между Money с разными валютами
- Проверка совместимости валют перед расчетами
- Валидация при объединении балансов

## Импорт

```typescript
import { CurrencyMismatchError } from '@polymarket/errors';

// Для примеров с Result<T,E> также понадобятся:
import { InvalidMoneyError } from '@polymarket/errors';
import { Result, Ok, Err } from '@polymarket/result';
```

---

## Примеры использования

### 1. Базовое использование (throw)

```typescript
import { CurrencyMismatchError } from '@polymarket/errors';

class Money {
  constructor(
    private readonly amount: number,
    public readonly currency: string
  ) {}

  add(other: Money): Money {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(
        (ctx) => `Cannot add ${ctx.actual} to ${ctx.expected}`,
        {
          code: CurrencyMismatchError.code,
          context: {
            operation: 'add',
            expected: this.currency,
            actual: other.currency
          }
        }
      );
    }

    return new Money(this.amount + other.amount, this.currency);
  }

  getAmount(): number {
    return this.amount;
  }

  getCurrency(): string {
    return this.currency;
  }
}

// Использование
try {
  const usdc = new Money(100, 'USDC');
  const btc = new Money(0.5, 'BTC');
  const total = usdc.add(btc); // Несоответствие валют!
} catch (error) {
  if (CurrencyMismatchError.is(error)) {
    console.error('Currency mismatch:', error.context);
    // { operation: 'add', expected: 'USDC', actual: 'BTC' }
  }
}
```

### 2. С Result<T,E> (рекомендуется)

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { CurrencyMismatchError, InvalidMoneyError } from '@polymarket/errors';

class Money {
  private constructor(
    private readonly amount: number,
    public readonly currency: string
  ) {}

  static fromAmount(amount: number, currency: string): Result<Money, InvalidMoneyError> {
    // ... валидация
    return Ok(new Money(amount, currency));
  }

  add(other: Money): Result<Money, CurrencyMismatchError> {
    if (this.currency !== other.currency) {
      return Err(
        new CurrencyMismatchError(
          (ctx) => `Cannot add ${ctx.actual} to ${ctx.expected}. Convert currencies first.`,
          {
            code: CurrencyMismatchError.code,
            context: {
              operation: 'add',
              expected: this.currency,
              actual: other.currency,
              expectedAmount: this.amount,
              actualAmount: other.amount
            }
          }
        )
      );
    }

    return Ok(new Money(this.amount + other.amount, this.currency));
  }

  subtract(other: Money): Result<Money, CurrencyMismatchError | InvalidMoneyError> {
    if (this.currency !== other.currency) {
      return Err(
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

    if (newAmount < 0) {
      return Err(
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

    return Ok(new Money(newAmount, this.currency));
  }

  getAmount(): number {
    return this.amount;
  }

  getCurrency(): string {
    return this.currency;
  }
}

// Использование
const usdcResult = Money.fromAmount(100, 'USDC');
const eurResult = Money.fromAmount(50, 'EUR');

if (usdcResult.ok && eurResult.ok) {
  const result = usdcResult.value.add(eurResult.value);

  if (result.ok) {
    console.log(`Total: ${result.value.getAmount()} ${result.value.getCurrency()}`);
  } else {
    console.error('Error:', result.error.message);
  }
}
```

### 3. Сравнение денежных сумм

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { CurrencyMismatchError } from '@polymarket/errors';

class Money {
  private constructor(
    private readonly amount: number,
    public readonly currency: string
  ) {}

  /**
   * Сравнить с другой денежной суммой
   * Возвращает: -1 (меньше), 0 (равно), 1 (больше)
   */
  compareTo(other: Money): Result<number, CurrencyMismatchError> {
    if (this.currency !== other.currency) {
      return Err(
        new CurrencyMismatchError(
          (ctx) => `Cannot compare ${ctx.expected} with ${ctx.actual}`,
          {
            code: CurrencyMismatchError.code,
            context: {
              operation: 'compare',
              expected: this.currency,
              actual: other.currency
            }
          }
        )
      );
    }

    if (this.amount < other.amount) return Ok(-1);
    if (this.amount > other.amount) return Ok(1);
    return Ok(0);
  }

  /**
   * Проверить что сумма больше другой
   */
  isGreaterThan(other: Money): Result<boolean, CurrencyMismatchError> {
    return this.compareTo(other).map(cmp => cmp > 0);
  }

  /**
   * Проверить что сумма меньше другой
   */
  isLessThan(other: Money): Result<boolean, CurrencyMismatchError> {
    return this.compareTo(other).map(cmp => cmp < 0);
  }

  /**
   * Проверить что суммы равны
   */
  equals(other: Money): Result<boolean, CurrencyMismatchError> {
    return this.compareTo(other).map(cmp => cmp === 0);
  }
}

// Использование
const usdc1Result = Money.fromAmount(100, 'USDC');
const usdc2Result = Money.fromAmount(50, 'USDC');
const btcResult = Money.fromAmount(0.5, 'BTC');

if (usdc1Result.ok && usdc2Result.ok && btcResult.ok) {
  // Сравнение одинаковых валют
  const comparisonResult = usdc1Result.value.isGreaterThan(usdc2Result.value);
  if (comparisonResult.ok) {
    console.log('100 USDC > 50 USDC:', comparisonResult.value); // true
  } else {
    console.error('Error:', comparisonResult.error.message);
  }

  // Сравнение разных валют
  const btcComparisonResult = usdc1Result.value.isGreaterThan(btcResult.value);
  if (btcComparisonResult.ok) {
    console.log('Result:', btcComparisonResult.value);
  } else {
    console.error('Cannot compare USDC with BTC'); // ❌
  }
}
```

### 4. Конвертация валют

```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { CurrencyMismatchError } from '@polymarket/errors';

interface ExchangeRate {
  from: string;
  to: string;
  rate: number;
}

class CurrencyConverter {
  constructor(private readonly rates: Map<string, Map<string, number>>) {}

  /**
   * Получить курс конвертации
   */
  getRate(from: string, to: string): Result<number, Error> {
    if (from === to) {
      return Ok(1);
    }

    const fromRates = this.rates.get(from);
    if (!fromRates) {
      return Err(new Error(`No rates available for ${from}`));
    }

    const rate = fromRates.get(to);
    if (rate === undefined) {
      return Err(new Error(`No rate available for ${from} -> ${to}`));
    }

    return Ok(rate);
  }

  /**
   * Конвертировать Money в другую валюту
   */
  convert(money: Money, toCurrency: string): Result<Money, Error> {
    return this.getRate(money.getCurrency(), toCurrency).flatMap(rate => {
      const convertedAmount = money.getAmount() * rate;
      return Money.fromAmount(convertedAmount, toCurrency);
    });
  }
}

class Money {
  // ... предыдущие методы

  /**
   * Сложить с Money в другой валюте (с автоконвертацией)
   */
  addWithConversion(
    other: Money,
    converter: CurrencyConverter
  ): Result<Money, CurrencyMismatchError | Error> {
    // Если валюты совпадают - обычное сложение
    if (this.currency === other.currency) {
      return this.add(other);
    }

    // Конвертируем другую сумму в нашу валюту
    return converter.convert(other, this.currency).flatMap(converted =>
      this.add(converted)
    );
  }
}

// Использование
const rates = new Map([
  ['USDC', new Map([['EUR', 0.92], ['BTC', 0.000024]])],
  ['EUR', new Map([['USDC', 1.09], ['BTC', 0.000026]])],
  ['BTC', new Map([['USDC', 41666.67], ['EUR', 38461.54]])]
]);

const converter = new CurrencyConverter(rates);

const usdcResult = Money.fromAmount(100, 'USDC');
const eurResult = Money.fromAmount(50, 'EUR');

if (usdcResult.ok && eurResult.ok) {
  const totalResult = usdcResult.value.addWithConversion(eurResult.value, converter);

  if (totalResult.ok) {
    console.log(`Total: ${totalResult.value.getAmount()} ${totalResult.value.getCurrency()}`);
    // Total: 154.5 USDC (100 USDC + 50 EUR * 1.09)
  } else {
    console.error('Conversion error:', totalResult.error.message);
  }
}
```

### 5. Интеграция с decimal.js

```typescript
import Decimal from 'decimal.js';
import { Result, Ok, Err } from '@polymarket/result';
import { CurrencyMismatchError, InvalidMoneyError } from '@polymarket/errors';

class DecimalMoney {
  private constructor(
    private readonly amount: Decimal,
    public readonly currency: string
  ) {}

  static fromDecimal(amount: Decimal, currency: string): Result<DecimalMoney, InvalidMoneyError> {
    // ... валидация
    return Ok(new DecimalMoney(amount, currency));
  }

  add(other: DecimalMoney): Result<DecimalMoney, CurrencyMismatchError> {
    if (this.currency !== other.currency) {
      return Err(
        new CurrencyMismatchError(
          (ctx) => `Cannot add ${ctx.actual} to ${ctx.expected}`,
          {
            code: CurrencyMismatchError.code,
            context: {
              operation: 'add',
              expected: this.currency,
              actual: other.currency,
              expectedAmount: this.amount.toString(),
              actualAmount: other.amount.toString()
            }
          }
        )
      );
    }

    const sum = this.amount.plus(other.amount);
    return Ok(new DecimalMoney(sum, this.currency));
  }

  subtract(other: DecimalMoney): Result<DecimalMoney, CurrencyMismatchError | InvalidMoneyError> {
    if (this.currency !== other.currency) {
      return Err(
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

    const difference = this.amount.minus(other.amount);

    if (difference.isNegative()) {
      return Err(
        new InvalidMoneyError(
          'Insufficient funds',
          {
            code: InvalidMoneyError.code,
            context: {
              available: this.amount.toString(),
              required: other.amount.toString(),
              result: difference.toString(),
              currency: this.currency
            }
          }
        )
      );
    }

    return Ok(new DecimalMoney(difference, this.currency));
  }

  toDecimal(): Decimal {
    return this.amount;
  }

  getCurrency(): string {
    return this.currency;
  }
}
```

---

## Edge Cases

### Одинаковые валюты (регистр)

```typescript
const usdc1Result = Money.fromAmount(100, 'USDC');
const usdc2Result = Money.fromAmount(50, 'usdc'); // lowercase

if (usdc1Result.ok && usdc2Result.ok) {
  const result = usdc1Result.value.add(usdc2Result.value);
  // ❌ Err(CurrencyMismatchError) - 'USDC' !== 'usdc'
}

// Решение: нормализация валюты при создании
class Money {
  static fromAmount(amount: number, currency: string): Result<Money, InvalidMoneyError> {
    const normalizedCurrency = currency.toUpperCase();
    // ... валидация
    return Ok(new Money(amount, normalizedCurrency));
  }
}
```

### Пустые или некорректные валюты

```typescript
const money1Result = Money.fromAmount(100, 'USDC');
const money2Result = Money.fromAmount(50, ''); // Пустая валюта

if (money1Result.ok && money2Result.ok) {
  const result = money1Result.value.add(money2Result.value);
  // ❌ Err(CurrencyMismatchError) - 'USDC' !== ''
}

// Лучше: валидировать при создании
class Money {
  static fromAmount(amount: number, currency: string): Result<Money, InvalidMoneyError> {
    if (!currency || currency.trim().length === 0) {
      return Err(
        new InvalidMoneyError(
          'Currency must be a non-empty string',
          {
            code: InvalidMoneyError.code,
            context: { amount, currency }
          }
        )
      );
    }
    // ...
  }
}
```

### Несколько валют в операции

```typescript
// Попытка сложить три разные валюты
const usdcResult = Money.fromAmount(100, 'USDC');
const eurResult = Money.fromAmount(50, 'EUR');
const btcResult = Money.fromAmount(0.5, 'BTC');

// Предполагаем что все Result успешны для примера
if (!usdcResult.ok || !eurResult.ok || !btcResult.ok) {
  throw new Error('Invalid amounts');
}

const usdc = usdcResult.value;
const eur = eurResult.value;
const btc = btcResult.value;

const result = toChain(usdc.add(eur))
  .flatMap(total => total.add(btc))
  .toResult();

// ❌ Err(CurrencyMismatchError) на первой же операции (USDC + EUR)

// Решение: конвертация перед операциями
const result2 = toChain(converter.convert(eur, 'USDC'))
  .flatMap(eurInUsdc => usdc.add(eurInUsdc))
  .flatMap(total => converter.convert(btc, 'USDC'))
  .flatMap(btcInUsdc => total.add(btcInUsdc))
  .toResult(); // ✅ Все в USDC
```

### Операции с нулевыми суммами

```typescript
const usdcResult = Money.fromAmount(100, 'USDC');
const zeroEurResult = Money.fromAmount(0, 'EUR');

if (usdcResult.ok && zeroEurResult.ok) {
  const result = usdcResult.value.add(zeroEurResult.value);
  // ❌ Err(CurrencyMismatchError)
  // Даже если сумма 0, валюты разные
}

// Если нужна специальная логика для нуля:
class Money {
  add(other: Money): Result<Money, CurrencyMismatchError> {
    // Специальный случай: добавление нуля любой валюты
    if (other.amount === 0) {
      return Ok(this); // Возвращаем текущую сумму без изменений
    }

    if (this.currency !== other.currency) {
      return Err(/* ... */);
    }

    return Ok(new Money(this.amount + other.amount, this.currency));
  }
}
```

---

## Обработка ошибок

### По типу ошибки

```typescript
import { CurrencyMismatchError } from '@polymarket/errors';

try {
  const total = calculateTotal(moneyList);
} catch (error) {
  if (CurrencyMismatchError.is(error)) {
    console.error('Currency mismatch:', error.context);

    const operation = error.context?.operation as string;
    const expected = error.context?.expected as string;
    const actual = error.context?.actual as string;

    showUserMessage(
      `Cannot ${operation}: expected ${expected}, got ${actual}. ` +
      `Please convert currencies first.`
    );

    // Предложить конвертацию
    return promptUserForConversion(expected, actual);
  } else {
    console.error('Unexpected error:', error);
    throw error;
  }
}
```

### По коду ошибки

```typescript
import { CurrencyMismatchError, InvalidMoneyError } from '@polymarket/errors';

const result = money1.subtract(money2);

if (result.ok) {
  processMoney(result.value);
} else {
  const error = result.error;
  if (error.code === CurrencyMismatchError.code) {
    const expected = error.context?.expected as string;
    const actual = error.context?.actual as string;

    showError(`Currency mismatch: ${expected} vs ${actual}`, error.context);

    // Предложить конвертацию
    offerConversion(money2, expected);
  } else if (error.code === InvalidMoneyError.code) {
    showError('Insufficient funds', error.context);
  } else {
    showError('Unexpected error', error);
  }
}
```

### С автоматической конвертацией

```typescript
import { CurrencyMismatchError } from '@polymarket/errors';

function addWithAutoConvert(
  money1: Money,
  money2: Money,
  converter: CurrencyConverter
): Result<Money, Error> {
  const result = money1.add(money2);

  if (result.ok) {
    return Ok(result.value);
  } else {
    if (CurrencyMismatchError.is(result.error)) {
      logger.info('Currency mismatch, attempting conversion', result.error.toJSON());

      // Автоматическая конвертация
      return money1.addWithConversion(money2, converter);
    }

    return Err(result.error);
  }
}
```

### С логированием

```typescript
import { CurrencyMismatchError } from '@polymarket/errors';

function operateWithLogging(
  money1: Money,
  money2: Money,
  operation: 'add' | 'subtract'
): Result<Money, CurrencyMismatchError | InvalidMoneyError> {
  const result = operation === 'add' ? money1.add(money2) : money1.subtract(money2);

  if (result.ok) {
    logger.info('Operation successful', {
      operation,
      currency: result.value.getCurrency(),
      result: result.value.getAmount()
    });
  } else {
    if (CurrencyMismatchError.is(result.error)) {
      logger.error('Currency mismatch', {
        operation,
        error: result.error.toJSON()
      });
    }
  }

  return result;
}
```

---

## Связанные ошибки

- [InvalidMoneyError](./invalid-money.md) - валидация денежных сумм
- [InvalidAmountError](./invalid-amount.md) - универсальная валидация чисел

## См. также

- [Value Objects Errors](./README.md) - Обзор категории
- [Обработка ошибок](../error-handling.md) - Best practices
- [Главная документация](../README.md)
