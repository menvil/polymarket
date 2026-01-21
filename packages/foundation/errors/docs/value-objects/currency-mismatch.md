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
import { Result } from '@polymarket/types';
import { CurrencyMismatchError } from '@polymarket/errors';

class Money {
  private constructor(
    private readonly amount: number,
    public readonly currency: string
  ) {}

  static fromAmount(amount: number, currency: string): Result<Money, InvalidMoneyError> {
    // ... валидация
    return Result.ok(new Money(amount, currency));
  }

  add(other: Money): Result<Money, CurrencyMismatchError> {
    if (this.currency !== other.currency) {
      return Result.err(
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

    return Result.ok(new Money(this.amount + other.amount, this.currency));
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

  getAmount(): number {
    return this.amount;
  }

  getCurrency(): string {
    return this.currency;
  }
}

// Использование
const usdc = Money.fromAmount(100, 'USDC').unwrap();
const eur = Money.fromAmount(50, 'EUR').unwrap();
const result = usdc.add(eur);

result.match({
  ok: (total) => console.log(`Total: ${total.getAmount()} ${total.getCurrency()}`),
  err: (error) => console.error('Error:', error.message)
});
```

### 3. Сравнение денежных сумм

```typescript
import { Result } from '@polymarket/types';
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
      return Result.err(
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

    if (this.amount < other.amount) return Result.ok(-1);
    if (this.amount > other.amount) return Result.ok(1);
    return Result.ok(0);
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
const usdc1 = Money.fromAmount(100, 'USDC').unwrap();
const usdc2 = Money.fromAmount(50, 'USDC').unwrap();
const btc = Money.fromAmount(0.5, 'BTC').unwrap();

// Сравнение одинаковых валют
usdc1.isGreaterThan(usdc2).match({
  ok: (result) => console.log('100 USDC > 50 USDC:', result), // true
  err: (error) => console.error('Error:', error.message)
});

// Сравнение разных валют
usdc1.isGreaterThan(btc).match({
  ok: (result) => console.log('Result:', result),
  err: (error) => console.error('Cannot compare USDC with BTC') // ❌
});
```

### 4. Конвертация валют

```typescript
import { Result } from '@polymarket/types';
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
      return Result.ok(1);
    }

    const fromRates = this.rates.get(from);
    if (!fromRates) {
      return Result.err(new Error(`No rates available for ${from}`));
    }

    const rate = fromRates.get(to);
    if (rate === undefined) {
      return Result.err(new Error(`No rate available for ${from} -> ${to}`));
    }

    return Result.ok(rate);
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

const usdc = Money.fromAmount(100, 'USDC').unwrap();
const eur = Money.fromAmount(50, 'EUR').unwrap();

const totalResult = usdc.addWithConversion(eur, converter);

totalResult.match({
  ok: (total) => console.log(`Total: ${total.getAmount()} ${total.getCurrency()}`),
  // Total: 154.5 USDC (100 USDC + 50 EUR * 1.09)
  err: (error) => console.error('Conversion error:', error.message)
});
```

### 5. Интеграция с decimal.js

```typescript
import Decimal from 'decimal.js';
import { Result } from '@polymarket/types';
import { CurrencyMismatchError } from '@polymarket/errors';

class DecimalMoney {
  private constructor(
    private readonly amount: Decimal,
    public readonly currency: string
  ) {}

  static fromDecimal(amount: Decimal, currency: string): Result<DecimalMoney, InvalidMoneyError> {
    // ... валидация
    return Result.ok(new DecimalMoney(amount, currency));
  }

  add(other: DecimalMoney): Result<DecimalMoney, CurrencyMismatchError> {
    if (this.currency !== other.currency) {
      return Result.err(
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
    return Result.ok(new DecimalMoney(sum, this.currency));
  }

  subtract(other: DecimalMoney): Result<DecimalMoney, CurrencyMismatchError | InvalidMoneyError> {
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

    const difference = this.amount.minus(other.amount);

    if (difference.isNegative()) {
      return Result.err(
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

    return Result.ok(new DecimalMoney(difference, this.currency));
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
const usdc1 = Money.fromAmount(100, 'USDC').unwrap();
const usdc2 = Money.fromAmount(50, 'usdc').unwrap(); // lowercase

const result = usdc1.add(usdc2);
// ❌ Result.err(CurrencyMismatchError) - 'USDC' !== 'usdc'

// Решение: нормализация валюты при создании
class Money {
  static fromAmount(amount: number, currency: string): Result<Money, InvalidMoneyError> {
    const normalizedCurrency = currency.toUpperCase();
    // ... валидация
    return Result.ok(new Money(amount, normalizedCurrency));
  }
}
```

### Пустые или некорректные валюты

```typescript
const money1 = Money.fromAmount(100, 'USDC').unwrap();
const money2 = Money.fromAmount(50, '').unwrap(); // Пустая валюта

const result = money1.add(money2);
// ❌ Result.err(CurrencyMismatchError) - 'USDC' !== ''

// Лучше: валидировать при создании
class Money {
  static fromAmount(amount: number, currency: string): Result<Money, InvalidMoneyError> {
    if (!currency || currency.trim().length === 0) {
      return Result.err(
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
const usdc = Money.fromAmount(100, 'USDC').unwrap();
const eur = Money.fromAmount(50, 'EUR').unwrap();
const btc = Money.fromAmount(0.5, 'BTC').unwrap();

const result = ResultChain
  .from(usdc.add(eur))
  .flatMap(total => total.add(btc))
  .run();

// ❌ Result.err(CurrencyMismatchError) на первой же операции (USDC + EUR)

// Решение: конвертация перед операциями
const result2 = ResultChain
  .from(converter.convert(eur, 'USDC'))
  .flatMap(eurInUsdc => usdc.add(eurInUsdc))
  .flatMap(total => converter.convert(btc, 'USDC'))
  .flatMap(btcInUsdc => total.add(btcInUsdc))
  .run(); // ✅ Все в USDC
```

### Операции с нулевыми суммами

```typescript
const usdc = Money.fromAmount(100, 'USDC').unwrap();
const zeroEur = Money.fromAmount(0, 'EUR').unwrap();

const result = usdc.add(zeroEur);
// ❌ Result.err(CurrencyMismatchError)
// Даже если сумма 0, валюты разные

// Если нужна специальная логика для нуля:
class Money {
  add(other: Money): Result<Money, CurrencyMismatchError> {
    // Специальный случай: добавление нуля любой валюты
    if (other.amount === 0) {
      return Result.ok(this); // Возвращаем текущую сумму без изменений
    }

    if (this.currency !== other.currency) {
      return Result.err(/* ... */);
    }

    return Result.ok(new Money(this.amount + other.amount, this.currency));
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

result.match({
  ok: (difference) => processMoney(difference),
  err: (error) => {
    if (error.code === CurrencyMismatchError.code) {
      const expected = error.context?.expected as string;
      const actual = error.context?.actual as string;

      showError(`Currency mismatch: ${expected} vs ${actual}`, error.context);

      // Предложить конвертацию
      return offerConversion(money2, expected);
    } else if (error.code === InvalidMoneyError.code) {
      showError('Insufficient funds', error.context);
    } else {
      showError('Unexpected error', error);
    }
  }
});
```

### С автоматической конвертацией

```typescript
import { CurrencyMismatchError } from '@polymarket/errors';

function addWithAutoConvert(
  money1: Money,
  money2: Money,
  converter: CurrencyConverter
): Result<Money, Error> {
  return money1.add(money2).match({
    ok: (sum) => Result.ok(sum),
    err: (error) => {
      if (CurrencyMismatchError.is(error)) {
        logger.info('Currency mismatch, attempting conversion', error.toJSON());

        // Автоматическая конвертация
        return money1.addWithConversion(money2, converter);
      }

      return Result.err(error);
    }
  });
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

  result.match({
    ok: (resultMoney) => {
      logger.info('Operation successful', {
        operation,
        currency: resultMoney.getCurrency(),
        result: resultMoney.getAmount()
      });
    },
    err: (error) => {
      if (CurrencyMismatchError.is(error)) {
        logger.error('Currency mismatch', {
          operation,
          error: error.toJSON()
        });
      }
    }
  });

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
