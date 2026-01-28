# Money Value Object: План рефакторинга и имплементации

## Метаданные

- **Value Object:** Money
- **Текущий файл:** `packages/domain/value-objects/src/Money.ts` (888 lines)
- **Сложность:** High (currency-aware, используется везде)
- **Зависимости:** `@polymarket/math`, `@polymarket/errors`, `@polymarket/result`
- **Приоритет:** 🔴 ВЫСОКИЙ (cash, fees, PnL)

---

## Специфика Money

### Характеристики

**Назначение:** Представляет денежные суммы с валютой.

**Currency:** `USDC` (пока единственная поддерживаемая)

**MAX_AMOUNT:** `1e15` (1 квадриллион центов)

**Поля:**
- `amount: Decimal` - сумма
- `currency: SupportedCurrency` - валюта

**Константы:**
```typescript
Money.ZERO_USDC = Money(0, 'USDC')
```

### Инварианты

1. ✅ `amount.isFinite()` 
2. ✅ `amount <= MAX_AMOUNT`
3. ✅ `currency in SUPPORTED_CURRENCIES`

### Бизнес-правила (контекстуальные)

1. 🔶 `amount >= 0` (для некоторых операций)
2. 🔶 `currency1 === currency2` (для операций между Money)
3. 🔶 `amount >= minPayment` (для платежей)

---

## Целевая архитектура

### Слои

#### Core Layer
```typescript
class Money {
  private constructor(
    private readonly amt: Decimal,
    private readonly cur: SupportedCurrency
  ) {
    if (!amt.isFinite()) throw new MoneyInvariantViolation('must be finite');
    if (amt.greaterThan(Money.MAX_AMOUNT)) {
      throw new MoneyInvariantViolation('exceeds MAX_AMOUNT');
    }
    if (!Money.SUPPORTED_CURRENCIES.has(cur)) {
      throw new MoneyInvariantViolation('unsupported currency');
    }
  }

  public static of(amount: Decimal, currency: SupportedCurrency): Money {
    return new Money(amount, currency);
  }

  public amount(): Decimal { return this.amt; }
  public currency(): SupportedCurrency { return this.cur; }

  public equals(other: Money, epsilon: Decimal): boolean {
    return this.cur === other.cur &&
           this.amt.minus(other.amt).abs().lessThan(epsilon);
  }

  public hasSameCurrency(other: Money): boolean {
    return this.cur === other.cur;
  }
}
```

#### Rules Layer

**ValidateCurrency.ts:**
```typescript
class ValidateCurrency {
  public static check(money1: Money, money2: Money): Result<void, CurrencyMismatchError> {
    if (!money1.hasSameCurrency(money2)) {
      return Err(new CurrencyMismatchError(...));
    }
    return Ok(undefined);
  }
}
```

**ValidateNonNegativeAmount.ts:**
```typescript
class ValidateNonNegativeAmount {
  public static check(amount: Decimal): Result<void, InvalidAmountError> {
    if (amount.isNegative()) {
      return Err(new InvalidAmountError('Amount cannot be negative'));
    }
    return Ok(undefined);
  }
}
```

#### Policy Layer

**PaymentPolicy.ts:**
```typescript
class PaymentPolicy {
  public static validateForPayment(
    money: Money,
    minPayment: Decimal
  ): Result<void, InvalidAmountError> {
    // 1. Amount >= 0
    const nonNegResult = ValidateNonNegativeAmount.check(money.amount());
    if (!nonNegResult.ok) return nonNegResult;

    // 2. Amount >= minPayment
    if (money.amount().lessThan(minPayment)) {
      return Err(new InvalidAmountError(`Below minimum payment ${minPayment}`));
    }

    return Ok(undefined);
  }
}
```

**FeeCalculationPolicy.ts:**
```typescript
class FeeCalculationPolicy {
  public static calculateFee(
    amount: Money,
    feeRate: Decimal
  ): Result<Money, InvalidAmountError> {
    // feeRate должен быть в [0, 1]
    if (feeRate.isNegative() || feeRate.greaterThan(1)) {
      return Err(new InvalidAmountError('Fee rate must be in [0, 1]'));
    }

    const feeAmount = multiplyDecimal(amount.amount(), feeRate);
    return MoneyService.create(feeAmount, amount.currency());
  }
}
```

#### Facade Layer

**MoneyService.ts:**
```typescript
class MoneyService {
  public static create(
    amount: Decimal,
    currency: SupportedCurrency
  ): Result<Money, InvalidAmountError> {
    try {
      return Ok(Money.of(amount, currency));
    } catch (error) {
      return Err(new InvalidAmountError(error.message));
    }
  }

  public static add(m1: Money, m2: Money): Result<Money, CurrencyMismatchError> {
    const currResult = ValidateCurrency.check(m1, m2);
    if (!currResult.ok) return Err(currResult.error);

    const sum = addDecimal(m1.amount(), m2.amount());
    return this.create(sum, m1.currency());
  }

  public static subtract(
    m1: Money,
    m2: Money
  ): Result<Money, CurrencyMismatchError | InvalidAmountError> {
    const currResult = ValidateCurrency.check(m1, m2);
    if (!currResult.ok) return Err(currResult.error);

    const diff = subtractDecimal(m1.amount(), m2.amount());
    return this.create(diff, m1.currency());
  }

  public static multiply(
    money: Money,
    factor: Decimal
  ): Result<Money, InvalidAmountError> {
    const result = multiplyDecimal(money.amount(), factor);
    return this.create(result, money.currency());
  }

  public static divide(
    money: Money,
    divisor: Decimal
  ): Result<Money, InvalidAmountError> {
    const result = divideDecimal(money.amount(), divisor);
    return this.create(result, money.currency());
  }
}
```

#### Adapters Layer

**MoneySerializer.ts, MoneyFormatter.ts** - аналогично Price/Quantity

---

## Детальный план по фазам

| Фаза | Описание | Время |
|------|----------|-------|
| 0 | Подготовка структуры | 15 мин |
| 1 | Core Layer | 30 мин |
| 2 | Rules Layer | 35 мин |
| 3 | Policy Layer | 30 мин |
| 4 | Facade Layer | 50 мин |
| 5 | Adapters Layer | 15 мин |
| 6 | Index exports | 10 мин |
| 7 | Integration тесты | 40 мин |
| 8 | Package.json exports | 5 мин |
| **Итого** | | **~4 часа** |

---

## План тестирования

| Слой | Unit | Integration |
|------|------|-------------|
| Core | 30 | - |
| Rules | 18 | - |
| Policy | 20 | - |
| Facade | 35 | - |
| Adapters | 12 | - |
| Integration | - | 25 |
| **ВСЕГО** | **115** | **25** |
| **TOTAL** | **140 тестов** | |

---

## Миграция

```typescript
// Было:
const money = Money.fromUSDC(100);
const sum = money.add(other);

// Стало:
const money = MoneyService.create(new Decimal(100), 'USDC');
const sum = MoneyService.add(money.value, other);
```

---

**Конец плана для Money**
