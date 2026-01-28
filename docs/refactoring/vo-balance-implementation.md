# Balance Value Object: Детальный план рефакторинга и имплементации

## Метаданные

- **Value Object:** Balance
- **Текущий файл:** `packages/domain/value-objects/src/Balance.ts` (565 lines)
- **Сложность:** Medium (cash management with available/reserved split)
- **Зависимости:** `Money`, `@polymarket/math`, `@polymarket/errors`, `@polymarket/result`
- **Приоритет:** 🔴 ВЫСОКИЙ (Portfolio cash management, order execution)

---

## Специфика Balance

### Характеристики

**Назначение:** Представляет баланс денежных средств с разделением на available (доступные) и reserved (зарезервированные).

**Особенности:**
- Управляет доступными и зарезервированными средствами
- Гарантирует, что reserved <= total
- Поддерживает операции: reserve, release, update
- Используется в Portfolio для управления кэшем

**Поля:**
- `available: Money` - доступные средства
- `reserved: Money` - зарезервированные средства

**Derived values:**
- `total = available + reserved` - общая сумма

**Инварианты:**

1. ✅ `available >= 0`
2. ✅ `reserved >= 0`
3. ✅ `available.currency === reserved.currency` (одинаковая валюта)

**Бизнес-правила (контекстуальные):**

1. 🔶 `reserveAmount <= available` (для операции reserve)
2. 🔶 `releaseAmount <= reserved` (для операции release)
3. 🔶 `newTotal >= 0` после update (нельзя уйти в отрицательный баланс)

---

## Проблемы текущей имплементации

### 1. Нет четкого разделения слоёв (HIGH)
Все операции (reserve, release, update) смешаны с валидацией в одном файле.

### 2. Операции не возвращают Result (HIGH)
```typescript
public reserve(amount: Money): Balance {
  if (this.available.isLessThan(amount)) {
    throw new InsufficientFundsError(...);  // ❌
  }
  // ...
}
```

**Решение:** Все операции должны возвращать `Result<Balance, E>`

### 3. Отсутствие Rules Layer (MEDIUM)
Валидация разбросана по методам, нет переиспользуемых rules.

### 4. Отсутствие Policy Layer (MEDIUM)
Нет специфичных политик для разных типов операций (order reserve, margin calls, etc.)

---

## Целевая архитектура

### Слои

#### Core Layer

```typescript
/**
 * Balance - баланс денежных средств с разделением на available/reserved
 *
 * Инварианты:
 * - available >= 0
 * - reserved >= 0
 * - available и reserved имеют одинаковую валюту
 *
 * @example
 * ```typescript
 * const balance = Balance.of(
 *   Money.fromUSDC(10000),  // available
 *   Money.fromUSDC(2000)    // reserved
 * );
 *
 * console.log(balance.total().amount); // 12000
 * console.log(balance.available().amount); // 10000
 * ```
 */
export class Balance {
  private constructor(
    private readonly avail: Money,
    private readonly res: Money
  ) {
    // Инвариант: available >= 0
    if (avail.amount().isNegative()) {
      throw new BalanceInvariantViolation(
        'Available amount cannot be negative',
        { available: avail.amount().toNumber() }
      );
    }

    // Инвариант: reserved >= 0
    if (res.amount().isNegative()) {
      throw new BalanceInvariantViolation(
        'Reserved amount cannot be negative',
        { reserved: res.amount().toNumber() }
      );
    }

    // Инвариант: same currency
    if (avail.currency() !== res.currency()) {
      throw new BalanceInvariantViolation(
        'Available and reserved must have the same currency',
        {
          availableCurrency: avail.currency(),
          reservedCurrency: res.currency()
        }
      );
    }
  }

  /**
   * Создаёт Balance из available и reserved
   *
   * @param available - Доступные средства
   * @param reserved - Зарезервированные средства
   * @returns Новый Balance объект
   *
   * @throws {BalanceInvariantViolation} Если нарушены инварианты
   *
   * @example
   * ```typescript
   * const balance = Balance.of(
   *   Money.fromUSDC(10000),
   *   Money.fromUSDC(2000)
   * );
   * ```
   */
  public static of(available: Money, reserved: Money): Balance {
    return new Balance(available, reserved);
  }

  /**
   * Создаёт Balance с нулевым reserved
   *
   * @param available - Доступные средства
   * @returns Новый Balance с reserved = 0
   *
   * @example
   * ```typescript
   * const balance = Balance.withZeroReserved(Money.fromUSDC(10000));
   * // available: 10000, reserved: 0
   * ```
   */
  public static withZeroReserved(available: Money): Balance {
    const zeroReserved = Money.of(new Decimal(0), available.currency());
    return new Balance(available, zeroReserved);
  }

  /**
   * Создаёт пустой Balance (available = 0, reserved = 0)
   *
   * @param currency - Валюта баланса
   * @returns Новый пустой Balance
   *
   * @example
   * ```typescript
   * const balance = Balance.zero('USDC');
   * // available: 0, reserved: 0
   * ```
   */
  public static zero(currency: SupportedCurrency): Balance {
    const zero = Money.of(new Decimal(0), currency);
    return new Balance(zero, zero);
  }

  // Getters

  public available(): Money {
    return this.avail;
  }

  public reserved(): Money {
    return this.res;
  }

  /**
   * Вычисляет общую сумму (available + reserved)
   *
   * @returns Money с total суммой
   *
   * @example
   * ```typescript
   * const balance = Balance.of(
   *   Money.fromUSDC(10000),
   *   Money.fromUSDC(2000)
   * );
   * console.log(balance.total().amount()); // 12000
   * ```
   */
  public total(): Money {
    return this.avail.add(this.res);
  }

  /**
   * Получает валюту баланса
   *
   * @returns Валюта
   */
  public currency(): SupportedCurrency {
    return this.avail.currency();
  }

  // Query methods

  /**
   * Проверяет, пустой ли баланс (total = 0)
   *
   * @returns true если total = 0
   *
   * @example
   * ```typescript
   * const balance = Balance.zero('USDC');
   * console.log(balance.isEmpty()); // true
   * ```
   */
  public isEmpty(): boolean {
    return this.total().amount().equals(0);
  }

  /**
   * Проверяет, есть ли зарезервированные средства
   *
   * @returns true если reserved > 0
   *
   * @example
   * ```typescript
   * const balance = Balance.of(
   *   Money.fromUSDC(10000),
   *   Money.fromUSDC(2000)
   * );
   * console.log(balance.hasReserved()); // true
   * ```
   */
  public hasReserved(): boolean {
    return this.res.amount().greaterThan(0);
  }

  /**
   * Вычисляет процент зарезервированных средств от total
   *
   * @returns Decimal с процентами или 0 если total = 0
   *
   * @example
   * ```typescript
   * const balance = Balance.of(
   *   Money.fromUSDC(8000),
   *   Money.fromUSDC(2000)
   * );
   * console.log(balance.reservedPercentage().toFixed(2)); // "20.00"
   * ```
   */
  public reservedPercentage(): Decimal {
    const totalAmount = this.total().amount();
    if (totalAmount.equals(0)) {
      return new Decimal(0);
    }

    return this.res.amount().dividedBy(totalAmount).times(100);
  }

  /**
   * Проверяет, достаточно ли available средств
   *
   * @param amount - Требуемая сумма
   * @returns true если available >= amount
   *
   * @example
   * ```typescript
   * const balance = Balance.of(
   *   Money.fromUSDC(10000),
   *   Money.fromUSDC(2000)
   * );
   * console.log(balance.canAfford(Money.fromUSDC(5000))); // true
   * console.log(balance.canAfford(Money.fromUSDC(15000))); // false
   * ```
   */
  public canAfford(amount: Money): boolean {
    return this.avail.amount().greaterThanOrEqualTo(amount.amount());
  }

  /**
   * Сравнивает с другим балансом
   *
   * @param other - Другой баланс
   * @param epsilon - Порог для сравнения сумм
   * @returns true если балансы идентичны
   *
   * @example
   * ```typescript
   * if (balance1.equals(balance2, new Decimal(0.01))) {
   *   console.log('Balances are equal');
   * }
   * ```
   */
  public equals(other: Balance, epsilon: Decimal): boolean {
    return this.avail.equals(other.avail, epsilon) &&
           this.res.equals(other.res, epsilon);
  }
}
```

---

#### Rules Layer

**ValidateNonNegativeBalance.ts:**
```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidBalanceError } from '@polymarket/errors';
import { Money } from '../core/Money.js';

/**
 * Проверяет, что available и reserved >= 0
 *
 * @remarks
 * Базовое правило для любого валидного баланса
 *
 * @example
 * ```typescript
 * const result = ValidateNonNegativeBalance.check(available, reserved);
 * if (!result.ok) {
 *   console.error(result.error.message);
 * }
 * ```
 */
export class ValidateNonNegativeBalance {
  /**
   * Проверяет non-negative constraint
   *
   * @param available - Доступные средства
   * @param reserved - Зарезервированные средства
   * @returns Result с void или InvalidBalanceError
   */
  public static check(
    available: Money,
    reserved: Money
  ): Result<void, InvalidBalanceError> {
    if (available.amount().isNegative()) {
      return Err(
        new InvalidBalanceError(
          `Available amount cannot be negative: ${available.amount()}`,
          { field: 'available', value: available.amount().toNumber() }
        )
      );
    }

    if (reserved.amount().isNegative()) {
      return Err(
        new InvalidBalanceError(
          `Reserved amount cannot be negative: ${reserved.amount()}`,
          { field: 'reserved', value: reserved.amount().toNumber() }
        )
      );
    }

    return Ok(undefined);
  }
}
```

**ValidateCurrency.ts:**
```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidBalanceError } from '@polymarket/errors';
import { Money } from '../core/Money.js';

/**
 * Проверяет, что available и reserved имеют одинаковую валюту
 *
 * @remarks
 * Необходимо для корректных арифметических операций
 *
 * @example
 * ```typescript
 * const result = ValidateCurrency.check(available, reserved);
 * ```
 */
export class ValidateCurrency {
  /**
   * Проверяет currency consistency
   *
   * @param available - Доступные средства
   * @param reserved - Зарезервированные средства
   * @returns Result с void или InvalidBalanceError
   */
  public static check(
    available: Money,
    reserved: Money
  ): Result<void, InvalidBalanceError> {
    if (available.currency() !== reserved.currency()) {
      return Err(
        new InvalidBalanceError(
          'Available and reserved must have the same currency',
          {
            availableCurrency: available.currency(),
            reservedCurrency: reserved.currency()
          }
        )
      );
    }

    return Ok(undefined);
  }
}
```

**ValidateReserveAmount.ts:**
```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InsufficientFundsError } from '@polymarket/errors';
import { Money } from '../core/Money.js';

/**
 * Проверяет, что можно зарезервировать указанную сумму
 *
 * @remarks
 * Правило: reserveAmount <= available
 *
 * @example
 * ```typescript
 * const result = ValidateReserveAmount.check(
 *   Money.fromUSDC(10000),  // available
 *   Money.fromUSDC(5000)    // reserve amount
 * );
 * ```
 */
export class ValidateReserveAmount {
  /**
   * Проверяет достаточность средств для резервирования
   *
   * @param available - Доступные средства
   * @param reserveAmount - Сумма для резервирования
   * @returns Result с void или InsufficientFundsError
   */
  public static check(
    available: Money,
    reserveAmount: Money
  ): Result<void, InsufficientFundsError> {
    if (reserveAmount.amount().greaterThan(available.amount())) {
      return Err(
        new InsufficientFundsError(
          reserveAmount.amount().toNumber(),
          available.amount().toNumber()
        )
      );
    }

    return Ok(undefined);
  }
}
```

**ValidateReleaseAmount.ts:**
```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidBalanceError } from '@polymarket/errors';
import { Money } from '../core/Money.js';

/**
 * Проверяет, что можно освободить указанную сумму из reserved
 *
 * @remarks
 * Правило: releaseAmount <= reserved
 *
 * @example
 * ```typescript
 * const result = ValidateReleaseAmount.check(
 *   Money.fromUSDC(2000),  // reserved
 *   Money.fromUSDC(1000)   // release amount
 * );
 * ```
 */
export class ValidateReleaseAmount {
  /**
   * Проверяет возможность освобождения средств
   *
   * @param reserved - Зарезервированные средства
   * @param releaseAmount - Сумма для освобождения
   * @returns Result с void или InvalidBalanceError
   */
  public static check(
    reserved: Money,
    releaseAmount: Money
  ): Result<void, InvalidBalanceError> {
    if (releaseAmount.amount().greaterThan(reserved.amount())) {
      return Err(
        new InvalidBalanceError(
          `Cannot release ${releaseAmount.amount()}: only ${reserved.amount()} reserved`,
          {
            requested: releaseAmount.amount().toNumber(),
            available: reserved.amount().toNumber()
          }
        )
      );
    }

    return Ok(undefined);
  }
}
```

**ValidateMinimumBalance.ts:**
```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidBalanceError } from '@polymarket/errors';
import { Money } from '../core/Money.js';

/**
 * Проверяет, что total баланс не меньше минимума
 *
 * @remarks
 * Используется для enforcement минимального остатка на счёте
 *
 * @example
 * ```typescript
 * const result = ValidateMinimumBalance.check(
 *   balance.total(),
 *   Money.fromUSDC(100)  // minimum
 * );
 * ```
 */
export class ValidateMinimumBalance {
  /**
   * Проверяет минимальный баланс
   *
   * @param total - Общая сумма баланса
   * @param minimum - Минимально допустимая сумма
   * @returns Result с void или InvalidBalanceError
   */
  public static check(
    total: Money,
    minimum: Money
  ): Result<void, InvalidBalanceError> {
    if (total.amount().lessThan(minimum.amount())) {
      return Err(
        new InvalidBalanceError(
          `Total balance ${total.amount()} is below minimum ${minimum.amount()}`,
          {
            total: total.amount().toNumber(),
            minimum: minimum.amount().toNumber()
          }
        )
      );
    }

    return Ok(undefined);
  }
}
```

---

#### Policy Layer

**CashManagementPolicy.ts:**
```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidBalanceError, InsufficientFundsError } from '@polymarket/errors';
import { Decimal } from '@polymarket/math';
import { Money } from '../core/Money.js';
import { Balance } from '../core/Balance.js';
import { ValidateNonNegativeBalance } from '../rules/ValidateNonNegativeBalance.js';
import { ValidateCurrency } from '../rules/ValidateCurrency.js';
import { ValidateReserveAmount } from '../rules/ValidateReserveAmount.js';
import { ValidateReleaseAmount } from '../rules/ValidateReleaseAmount.js';

/**
 * Политика для управления кэшем в Portfolio
 *
 * @remarks
 * Правила:
 * 1. Available >= 0, Reserved >= 0
 * 2. Одинаковая валюта
 * 3. Reserve amount <= available
 * 4. Release amount <= reserved
 * 5. После update total >= 0
 *
 * @example
 * ```typescript
 * const result = CashManagementPolicy.reserve(balance, amount);
 * if (result.ok) {
 *   const newBalance = result.value;
 * }
 * ```
 */
export class CashManagementPolicy {
  /**
   * Резервирует средства для ордера
   *
   * @param balance - Текущий баланс
   * @param amount - Сумма для резервирования
   * @returns Result с новым Balance или ошибкой
   *
   * @remarks
   * Алгоритм:
   * 1. Проверяем, что amount <= available
   * 2. available -= amount
   * 3. reserved += amount
   *
   * @example
   * ```typescript
   * const result = CashManagementPolicy.reserve(
   *   balance,
   *   Money.fromUSDC(1000)
   * );
   * ```
   */
  public static reserve(
    balance: Balance,
    amount: Money
  ): Result<Balance, InsufficientFundsError | InvalidBalanceError> {
    // 1. Проверяем валюту
    const currencyResult = ValidateCurrency.check(
      balance.available(),
      amount
    );
    if (!currencyResult.ok) {
      return Err(
        new InvalidBalanceError(
          'Reserve amount must have same currency as balance',
          {
            balanceCurrency: balance.currency(),
            amountCurrency: amount.currency()
          }
        )
      );
    }

    // 2. Проверяем достаточность средств
    const reserveResult = ValidateReserveAmount.check(
      balance.available(),
      amount
    );
    if (!reserveResult.ok) {
      return Err(reserveResult.error);
    }

    // 3. Вычисляем новые значения
    const newAvailable = balance.available().subtract(amount);
    const newReserved = balance.reserved().add(amount);

    // 4. Создаём новый Balance
    try {
      return Ok(Balance.of(newAvailable, newReserved));
    } catch (error) {
      return Err(
        new InvalidBalanceError(
          `Failed to create balance after reserve: ${error.message}`,
          {}
        )
      );
    }
  }

  /**
   * Освобождает зарезервированные средства
   *
   * @param balance - Текущий баланс
   * @param amount - Сумма для освобождения
   * @returns Result с новым Balance или ошибкой
   *
   * @remarks
   * Алгоритм:
   * 1. Проверяем, что amount <= reserved
   * 2. reserved -= amount
   * 3. available += amount
   *
   * @example
   * ```typescript
   * const result = CashManagementPolicy.release(
   *   balance,
   *   Money.fromUSDC(500)
   * );
   * ```
   */
  public static release(
    balance: Balance,
    amount: Money
  ): Result<Balance, InvalidBalanceError> {
    // 1. Проверяем валюту
    const currencyResult = ValidateCurrency.check(
      balance.reserved(),
      amount
    );
    if (!currencyResult.ok) {
      return Err(
        new InvalidBalanceError(
          'Release amount must have same currency as balance',
          {
            balanceCurrency: balance.currency(),
            amountCurrency: amount.currency()
          }
        )
      );
    }

    // 2. Проверяем возможность освобождения
    const releaseResult = ValidateReleaseAmount.check(
      balance.reserved(),
      amount
    );
    if (!releaseResult.ok) {
      return Err(releaseResult.error);
    }

    // 3. Вычисляем новые значения
    const newReserved = balance.reserved().subtract(amount);
    const newAvailable = balance.available().add(amount);

    // 4. Создаём новый Balance
    try {
      return Ok(Balance.of(newAvailable, newReserved));
    } catch (error) {
      return Err(
        new InvalidBalanceError(
          `Failed to create balance after release: ${error.message}`,
          {}
        )
      );
    }
  }

  /**
   * Обновляет available баланс (например, после исполнения ордера)
   *
   * @param balance - Текущий баланс
   * @param delta - Изменение (может быть отрицательным)
   * @returns Result с новым Balance или ошибкой
   *
   * @remarks
   * Алгоритм:
   * 1. available += delta
   * 2. Проверяем, что available >= 0
   *
   * @example
   * ```typescript
   * // Добавить средства
   * const result = CashManagementPolicy.updateAvailable(
   *   balance,
   *   Money.fromUSDC(1000)
   * );
   *
   * // Вычесть средства
   * const result = CashManagementPolicy.updateAvailable(
   *   balance,
   *   Money.fromUSDC(-500)
   * );
   * ```
   */
  public static updateAvailable(
    balance: Balance,
    delta: Money
  ): Result<Balance, InvalidBalanceError> {
    // 1. Проверяем валюту
    const currencyResult = ValidateCurrency.check(
      balance.available(),
      delta
    );
    if (!currencyResult.ok) {
      return Err(
        new InvalidBalanceError(
          'Delta must have same currency as balance',
          {
            balanceCurrency: balance.currency(),
            deltaCurrency: delta.currency()
          }
        )
      );
    }

    // 2. Вычисляем новый available
    const newAvailable = delta.amount().isNegative()
      ? balance.available().subtract(Money.of(delta.amount().abs(), delta.currency()))
      : balance.available().add(delta);

    // 3. Проверяем non-negative
    const nonNegResult = ValidateNonNegativeBalance.check(
      newAvailable,
      balance.reserved()
    );
    if (!nonNegResult.ok) {
      return Err(nonNegResult.error);
    }

    // 4. Создаём новый Balance
    try {
      return Ok(Balance.of(newAvailable, balance.reserved()));
    } catch (error) {
      return Err(
        new InvalidBalanceError(
          `Failed to create balance after update: ${error.message}`,
          {}
        )
      );
    }
  }
}
```

**MarginCallPolicy.ts:**
```typescript
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidBalanceError } from '@polymarket/errors';
import { Decimal } from '@polymarket/math';
import { Money } from '../core/Money.js';
import { Balance } from '../core/Balance.js';
import { ValidateMinimumBalance } from '../rules/ValidateMinimumBalance.js';

/**
 * Политика для margin calls и liquidation checks
 *
 * @remarks
 * Проверяет, что баланс не упал ниже критических уровней:
 * - Maintenance margin (минимальный баланс для поддержания позиций)
 * - Liquidation threshold (порог для принудительной ликвидации)
 *
 * @example
 * ```typescript
 * const result = MarginCallPolicy.checkMarginRequirement(
 *   balance,
 *   Money.fromUSDC(1000),  // maintenance margin
 *   Money.fromUSDC(500)    // liquidation threshold
 * );
 * ```
 */
export class MarginCallPolicy {
  /**
   * Уровни margin call
   */
  public enum MarginLevel {
    HEALTHY = 'HEALTHY',           // Баланс выше maintenance margin
    WARNING = 'WARNING',           // Баланс между maintenance и liquidation
    CRITICAL = 'CRITICAL'          // Баланс ниже liquidation threshold
  }

  /**
   * Результат проверки margin
   */
  public interface MarginCheckResult {
    level: MarginLevel;
    total: Money;
    maintenanceMargin: Money;
    liquidationThreshold: Money;
    marginRatio: Decimal;  // total / maintenanceMargin
  }

  /**
   * Проверяет margin requirement
   *
   * @param balance - Текущий баланс
   * @param maintenanceMargin - Минимальный баланс для поддержания позиций
   * @param liquidationThreshold - Порог для ликвидации
   * @returns Result с MarginCheckResult или ошибкой
   *
   * @example
   * ```typescript
   * const result = MarginCallPolicy.checkMarginRequirement(
   *   balance,
   *   Money.fromUSDC(1000),
   *   Money.fromUSDC(500)
   * );
   *
   * if (result.ok) {
   *   const check = result.value;
   *   if (check.level === MarginLevel.CRITICAL) {
   *     console.log('LIQUIDATION REQUIRED!');
   *   }
   * }
   * ```
   */
  public static checkMarginRequirement(
    balance: Balance,
    maintenanceMargin: Money,
    liquidationThreshold: Money
  ): Result<MarginCheckResult, InvalidBalanceError> {
    const total = balance.total();

    // Вычисляем margin ratio
    const marginRatio = maintenanceMargin.amount().equals(0)
      ? new Decimal(Infinity)
      : total.amount().dividedBy(maintenanceMargin.amount());

    // Определяем уровень
    let level: MarginLevel;

    if (total.amount().lessThan(liquidationThreshold.amount())) {
      level = MarginLevel.CRITICAL;
    } else if (total.amount().lessThan(maintenanceMargin.amount())) {
      level = MarginLevel.WARNING;
    } else {
      level = MarginLevel.HEALTHY;
    }

    return Ok({
      level,
      total,
      maintenanceMargin,
      liquidationThreshold,
      marginRatio
    });
  }

  /**
   * Проверяет, требуется ли margin call
   *
   * @param balance - Текущий баланс
   * @param maintenanceMargin - Минимальный баланс
   * @returns Result с boolean
   *
   * @example
   * ```typescript
   * const result = MarginCallPolicy.requiresMarginCall(
   *   balance,
   *   Money.fromUSDC(1000)
   * );
   *
   * if (result.ok && result.value) {
   *   console.log('Margin call required!');
   * }
   * ```
   */
  public static requiresMarginCall(
    balance: Balance,
    maintenanceMargin: Money
  ): Result<boolean, InvalidBalanceError> {
    const total = balance.total();
    return Ok(total.amount().lessThan(maintenanceMargin.amount()));
  }

  /**
   * Проверяет, требуется ли liquidation
   *
   * @param balance - Текущий баланс
   * @param liquidationThreshold - Порог ликвидации
   * @returns Result с boolean
   *
   * @example
   * ```typescript
   * const result = MarginCallPolicy.requiresLiquidation(
   *   balance,
   *   Money.fromUSDC(500)
   * );
   * ```
   */
  public static requiresLiquidation(
    balance: Balance,
    liquidationThreshold: Money
  ): Result<boolean, InvalidBalanceError> {
    const total = balance.total();
    return Ok(total.amount().lessThan(liquidationThreshold.amount()));
  }
}
```

---

#### Facade Layer

**BalanceService.ts:**
```typescript
import { Result, Ok, Err } from '@polymarket/result';
import {
  InvalidBalanceError,
  InsufficientFundsError
} from '@polymarket/errors';
import { Decimal } from '@polymarket/math';
import { Money } from '../core/Money.js';
import { Balance } from '../core/Balance.js';
import { CashManagementPolicy } from '../policy/CashManagementPolicy.js';

/**
 * Фасад для работы с балансами
 *
 * @remarks
 * Предоставляет высокоуровневые операции:
 * - Создание балансов
 * - Резервирование/освобождение средств
 * - Обновление available баланса
 * - Проверки и запросы
 *
 * @example
 * ```typescript
 * const result = BalanceService.create(
 *   Money.fromUSDC(10000),
 *   Money.fromUSDC(2000)
 * );
 * ```
 */
export class BalanceService {
  /**
   * Создаёт Balance из Money значений
   *
   * @param available - Доступные средства
   * @param reserved - Зарезервированные средства
   * @returns Result с Balance или ошибкой
   *
   * @example
   * ```typescript
   * const result = BalanceService.create(
   *   Money.fromUSDC(10000),
   *   Money.fromUSDC(2000)
   * );
   *
   * if (result.ok) {
   *   const balance = result.value;
   * }
   * ```
   */
  public static create(
    available: Money,
    reserved: Money
  ): Result<Balance, InvalidBalanceError> {
    try {
      return Ok(Balance.of(available, reserved));
    } catch (error) {
      return Err(
        new InvalidBalanceError(
          `Failed to create balance: ${error.message}`,
          {}
        )
      );
    }
  }

  /**
   * Создаёт Balance из Decimal значений
   *
   * @param availableAmount - Доступная сумма
   * @param reservedAmount - Зарезервированная сумма
   * @param currency - Валюта
   * @returns Result с Balance или ошибкой
   *
   * @example
   * ```typescript
   * const result = BalanceService.fromAmounts(
   *   new Decimal(10000),
   *   new Decimal(2000),
   *   'USDC'
   * );
   * ```
   */
  public static fromAmounts(
    availableAmount: Decimal,
    reservedAmount: Decimal,
    currency: SupportedCurrency
  ): Result<Balance, InvalidBalanceError> {
    try {
      const available = Money.of(availableAmount, currency);
      const reserved = Money.of(reservedAmount, currency);
      return Ok(Balance.of(available, reserved));
    } catch (error) {
      return Err(
        new InvalidBalanceError(
          `Failed to create balance from amounts: ${error.message}`,
          { availableAmount: availableAmount.toNumber(), reservedAmount: reservedAmount.toNumber() }
        )
      );
    }
  }

  /**
   * Резервирует средства из баланса
   *
   * @param balance - Текущий баланс
   * @param amount - Сумма для резервирования
   * @returns Result с новым Balance или ошибкой
   *
   * @example
   * ```typescript
   * const result = BalanceService.reserve(
   *   balance,
   *   Money.fromUSDC(1000)
   * );
   * ```
   */
  public static reserve(
    balance: Balance,
    amount: Money
  ): Result<Balance, InsufficientFundsError | InvalidBalanceError> {
    return CashManagementPolicy.reserve(balance, amount);
  }

  /**
   * Освобождает зарезервированные средства
   *
   * @param balance - Текущий баланс
   * @param amount - Сумма для освобождения
   * @returns Result с новым Balance или ошибкой
   *
   * @example
   * ```typescript
   * const result = BalanceService.release(
   *   balance,
   *   Money.fromUSDC(500)
   * );
   * ```
   */
  public static release(
    balance: Balance,
    amount: Money
  ): Result<Balance, InvalidBalanceError> {
    return CashManagementPolicy.release(balance, amount);
  }

  /**
   * Обновляет available баланс
   *
   * @param balance - Текущий баланс
   * @param delta - Изменение (положительное или отрицательное)
   * @returns Result с новым Balance или ошибкой
   *
   * @example
   * ```typescript
   * // Добавить средства
   * const result = BalanceService.updateAvailable(
   *   balance,
   *   Money.fromUSDC(1000)
   * );
   *
   * // Вычесть средства
   * const result = BalanceService.updateAvailable(
   *   balance,
   *   Money.fromUSDC(-500)
   * );
   * ```
   */
  public static updateAvailable(
    balance: Balance,
    delta: Money
  ): Result<Balance, InvalidBalanceError> {
    return CashManagementPolicy.updateAvailable(balance, delta);
  }

  /**
   * Добавляет средства к available
   *
   * @param balance - Текущий баланс
   * @param amount - Сумма для добавления
   * @returns Result с новым Balance или ошибкой
   *
   * @example
   * ```typescript
   * const result = BalanceService.addAvailable(
   *   balance,
   *   Money.fromUSDC(1000)
   * );
   * ```
   */
  public static addAvailable(
    balance: Balance,
    amount: Money
  ): Result<Balance, InvalidBalanceError> {
    return CashManagementPolicy.updateAvailable(balance, amount);
  }

  /**
   * Вычитает средства из available
   *
   * @param balance - Текущий баланс
   * @param amount - Сумма для вычитания
   * @returns Result с новым Balance или ошибкой
   *
   * @example
   * ```typescript
   * const result = BalanceService.subtractAvailable(
   *   balance,
   *   Money.fromUSDC(500)
   * );
   * ```
   */
  public static subtractAvailable(
    balance: Balance,
    amount: Money
  ): Result<Balance, InvalidBalanceError> {
    const negativeDelta = Money.of(
      amount.amount().negated(),
      amount.currency()
    );
    return CashManagementPolicy.updateAvailable(balance, negativeDelta);
  }

  /**
   * Проверяет, достаточно ли средств для операции
   *
   * @param balance - Баланс
   * @param amount - Требуемая сумма
   * @returns true если available >= amount
   *
   * @example
   * ```typescript
   * if (BalanceService.canAfford(balance, Money.fromUSDC(1000))) {
   *   console.log('Can afford operation');
   * }
   * ```
   */
  public static canAfford(balance: Balance, amount: Money): boolean {
    return balance.canAfford(amount);
  }

  /**
   * Получает процент зарезервированных средств
   *
   * @param balance - Баланс
   * @returns Decimal с процентами
   *
   * @example
   * ```typescript
   * const pct = BalanceService.getReservedPercentage(balance);
   * console.log(`Reserved: ${pct.toFixed(2)}%`);
   * ```
   */
  public static getReservedPercentage(balance: Balance): Decimal {
    return balance.reservedPercentage();
  }
}
```

---

#### Adapters Layer

**BalanceSerializer.ts:**
```typescript
import { Balance } from '../core/Balance.js';
import { Money } from '../core/Money.js';
import { Decimal } from '@polymarket/math';

/**
 * Интерфейс для JSON представления Balance
 */
export interface BalanceJSON {
  available: number;
  reserved: number;
  currency: string;
}

/**
 * Serializer для Balance
 *
 * @remarks
 * Конвертирует Balance в/из JSON представления
 *
 * @example
 * ```typescript
 * const json = BalanceSerializer.toJSON(balance);
 * const balance = BalanceSerializer.fromJSON(json);
 * ```
 */
export class BalanceSerializer {
  /**
   * Конвертирует Balance в JSON
   *
   * @param balance - Balance объект
   * @returns JSON представление
   *
   * @example
   * ```typescript
   * const json = BalanceSerializer.toJSON(balance);
   * // { available: 10000, reserved: 2000, currency: 'USDC' }
   * ```
   */
  public static toJSON(balance: Balance): BalanceJSON {
    return {
      available: balance.available().amount().toNumber(),
      reserved: balance.reserved().amount().toNumber(),
      currency: balance.currency()
    };
  }

  /**
   * Создаёт Balance из JSON
   *
   * @param json - JSON представление
   * @returns Balance объект
   * @throws {BalanceInvariantViolation} Если JSON невалиден
   *
   * @example
   * ```typescript
   * const balance = BalanceSerializer.fromJSON({
   *   available: 10000,
   *   reserved: 2000,
   *   currency: 'USDC'
   * });
   * ```
   */
  public static fromJSON(json: BalanceJSON): Balance {
    const available = Money.of(new Decimal(json.available), json.currency);
    const reserved = Money.of(new Decimal(json.reserved), json.currency);

    return Balance.of(available, reserved);
  }
}
```

**BalanceFormatter.ts:**
```typescript
import { Balance } from '../core/Balance.js';

/**
 * Форматтер для Balance
 *
 * @remarks
 * Конвертирует Balance в человекочитаемые строки
 *
 * @example
 * ```typescript
 * const str = BalanceFormatter.toString(balance);
 * // "Balance[Available: $10,000.00, Reserved: $2,000.00, Total: $12,000.00]"
 * ```
 */
export class BalanceFormatter {
  /**
   * Конвертирует Balance в строку
   *
   * @param balance - Balance объект
   * @returns Строковое представление
   *
   * @example
   * ```typescript
   * const str = BalanceFormatter.toString(balance);
   * console.log(str);
   * // "Balance[Available: $10,000.00, Reserved: $2,000.00, Total: $12,000.00]"
   * ```
   */
  public static toString(balance: Balance): string {
    const available = balance.available().amount().toFixed(2);
    const reserved = balance.reserved().amount().toFixed(2);
    const total = balance.total().amount().toFixed(2);
    const currency = balance.currency();

    return `Balance[Available: ${currency} ${available}, Reserved: ${currency} ${reserved}, Total: ${currency} ${total}]`;
  }

  /**
   * Форматирует с процентом зарезервированных средств
   *
   * @param balance - Balance объект
   * @returns Строка с процентом
   *
   * @example
   * ```typescript
   * const str = BalanceFormatter.toStringWithPercentage(balance);
   * // "Balance[Total: $12,000.00, Reserved: $2,000.00 (16.67%)]"
   * ```
   */
  public static toStringWithPercentage(balance: Balance): string {
    const total = balance.total().amount().toFixed(2);
    const reserved = balance.reserved().amount().toFixed(2);
    const percentage = balance.reservedPercentage().toFixed(2);
    const currency = balance.currency();

    return `Balance[Total: ${currency} ${total}, Reserved: ${currency} ${reserved} (${percentage}%)]`;
  }

  /**
   * Форматирует в краткую форму
   *
   * @param balance - Balance объект
   * @returns Краткая строка
   *
   * @example
   * ```typescript
   * const str = BalanceFormatter.toShortString(balance);
   * // "A: $10,000 / R: $2,000"
   * ```
   */
  public static toShortString(balance: Balance): string {
    const available = balance.available().amount().toFixed(0);
    const reserved = balance.reserved().amount().toFixed(0);
    const currency = balance.currency();

    return `A: ${currency} ${available} / R: ${currency} ${reserved}`;
  }
}
```

---

## Детальный план по фазам

| Фаза | Описание | Время |
|------|----------|-------|
| 0 | Подготовка структуры директорий | 10 мин |
| 1 | Core Layer (Balance class) | 35 мин |
| 2 | Rules Layer (5 rules) | 40 мин |
| 3 | Policy Layer (2 policies) | 40 мин |
| 4 | Facade Layer (BalanceService) | 45 мин |
| 5 | Adapters Layer (Serializer, Formatter) | 15 мин |
| 6 | Index exports | 10 мин |
| 7 | Unit тесты | 55 мин |
| 8 | Integration тесты | 25 мин |
| 9 | Package.json exports | 5 мин |
| **Итого** | | **~4 часа** |

---

## План тестирования

### Unit тесты

**Core Layer (Balance.test.ts):**
- ✅ `of()` с валидными параметрами
- ✅ `of()` throw когда available < 0
- ✅ `of()` throw когда reserved < 0
- ✅ `of()` throw когда разные валюты
- ✅ `withZeroReserved()` создаёт баланс с reserved = 0
- ✅ `zero()` создаёт пустой баланс
- ✅ `total()` вычисляет правильно
- ✅ `isEmpty()` работает корректно
- ✅ `hasReserved()` работает корректно
- ✅ `reservedPercentage()` вычисляет правильно
- ✅ `canAfford()` проверяет корректно
- ✅ `equals()` сравнивает корректно

**Итого Core:** ~15 тестов

**Rules Layer:**
- ValidateNonNegativeBalance: 4 теста
- ValidateCurrency: 3 теста
- ValidateReserveAmount: 3 теста
- ValidateReleaseAmount: 3 теста
- ValidateMinimumBalance: 3 теста

**Итого Rules:** ~16 тестов

**Policy Layer:**
- CashManagementPolicy.reserve: 6 тестов
- CashManagementPolicy.release: 6 тестов
- CashManagementPolicy.updateAvailable: 6 тестов
- MarginCallPolicy.checkMarginRequirement: 6 тестов
- MarginCallPolicy.requiresMarginCall: 3 теста
- MarginCallPolicy.requiresLiquidation: 3 теста

**Итого Policy:** ~30 тестов

**Facade Layer (BalanceService.test.ts):**
- `create()`: 4 теста
- `fromAmounts()`: 4 теста
- `reserve()`: 4 теста
- `release()`: 4 теста
- `updateAvailable()`: 4 теста
- `addAvailable()`: 3 теста
- `subtractAvailable()`: 3 теста
- `canAfford()`: 2 теста
- `getReservedPercentage()`: 2 теста

**Итого Facade:** ~30 тестов

**Adapters Layer:**
- BalanceSerializer: 4 теста
- BalanceFormatter: 5 тестов

**Итого Adapters:** ~9 тестов

### Integration тесты

**BalanceIntegration.test.ts:**
1. Полный флоу: create → reserve → release
2. Cash management полный цикл
3. Margin call detection chain
4. Serialization round-trip
5. Formatting различных балансов
6. Negative update detection
7. Currency mismatch handling
8. Reserve/release balance

**Итого Integration:** ~15 тестов

### Итоговая статистика

| Слой | Unit | Integration |
|------|------|-------------|
| Core | 15 | - |
| Rules | 16 | - |
| Policy | 30 | - |
| Facade | 30 | - |
| Adapters | 9 | - |
| Integration | - | 15 |
| **ВСЕГО** | **100** | **15** |
| **TOTAL** | **115 тестов** | |

---

## Миграция

### API Changes

**До:**
```typescript
// Создание Balance
const balance = Balance.create(Money.fromUSDC(10000), Money.fromUSDC(2000));

// Reserve (throw)
const updated = balance.reserve(Money.fromUSDC(1000));
```

**После:**
```typescript
// Создание Balance
const balance = Balance.of(Money.fromUSDC(10000), Money.fromUSDC(2000));

// Reserve (Result pattern)
const result = BalanceService.reserve(balance, Money.fromUSDC(1000));
if (result.ok) {
  const updated = result.value;
} else {
  console.error(result.error.message);
}
```

### Breaking Changes

1. **Constructor → private**
   - Используйте `Balance.of()` вместо `new Balance()`

2. **reserve() → BalanceService.reserve() с Result**
   - Не бросает исключения, возвращает Result

3. **release() → BalanceService.release() с Result**
   - Не бросает исключения, возвращает Result

4. **update() → BalanceService.updateAvailable() с Result**
   - Не бросает исключения, возвращает Result

---

## Примеры использования

### 1. Создание баланса

```typescript
import { Balance, BalanceService } from '@polymarket/value-objects';
import { Money } from '@polymarket/value-objects';
import { Decimal } from '@polymarket/math';

// Вариант 1: через Core
const balance = Balance.of(
  Money.fromUSDC(10000),  // available
  Money.fromUSDC(2000)    // reserved
);

// Вариант 2: через Facade
const result = BalanceService.create(
  Money.fromUSDC(10000),
  Money.fromUSDC(2000)
);

// Вариант 3: из amounts
const result = BalanceService.fromAmounts(
  new Decimal(10000),
  new Decimal(2000),
  'USDC'
);

// Пустой баланс
const empty = Balance.zero('USDC');

// С нулевым reserved
const withZero = Balance.withZeroReserved(Money.fromUSDC(10000));
```

### 2. Резервирование средств

```typescript
// Резервируем для Buy ордера
const reserveResult = BalanceService.reserve(
  balance,
  Money.fromUSDC(1000)
);

if (reserveResult.ok) {
  const newBalance = reserveResult.value;
  console.log(`Available: ${newBalance.available().amount()}`);  // 9000
  console.log(`Reserved: ${newBalance.reserved().amount()}`);   // 3000
} else {
  console.error('Insufficient funds:', reserveResult.error.message);
}
```

### 3. Освобождение зарезервированных средств

```typescript
// После отмены ордера
const releaseResult = BalanceService.release(
  balance,
  Money.fromUSDC(500)
);

if (releaseResult.ok) {
  const newBalance = releaseResult.value;
  console.log(`Available: ${newBalance.available().amount()}`);  // 10500
  console.log(`Reserved: ${newBalance.reserved().amount()}`);   // 1500
}
```

### 4. Обновление available баланса

```typescript
// Добавить средства (депозит)
const addResult = BalanceService.addAvailable(
  balance,
  Money.fromUSDC(1000)
);

// Вычесть средства (вывод)
const subtractResult = BalanceService.subtractAvailable(
  balance,
  Money.fromUSDC(500)
);

// Update с delta (может быть положительным или отрицательным)
const updateResult = BalanceService.updateAvailable(
  balance,
  Money.fromUSDC(-500)  // отрицательная delta
);
```

### 5. Margin call detection

```typescript
import { MarginCallPolicy } from '@polymarket/value-objects';

const checkResult = MarginCallPolicy.checkMarginRequirement(
  balance,
  Money.fromUSDC(5000),   // maintenance margin
  Money.fromUSDC(2000)    // liquidation threshold
);

if (checkResult.ok) {
  const check = checkResult.value;

  switch (check.level) {
    case MarginLevel.HEALTHY:
      console.log('Balance is healthy');
      break;

    case MarginLevel.WARNING:
      console.log('WARNING: Approaching maintenance margin');
      console.log(`Margin ratio: ${check.marginRatio.toFixed(2)}`);
      break;

    case MarginLevel.CRITICAL:
      console.log('CRITICAL: Liquidation required!');
      break;
  }
}
```

### 6. Serialization

```typescript
import { BalanceSerializer, BalanceFormatter } from '@polymarket/value-objects';

// JSON serialization
const json = BalanceSerializer.toJSON(balance);
console.log(json);
// { available: 10000, reserved: 2000, currency: 'USDC' }

// Deserialization
const restoredBalance = BalanceSerializer.fromJSON(json);

// Formatting
const str = BalanceFormatter.toString(balance);
console.log(str);
// "Balance[Available: USDC 10,000.00, Reserved: USDC 2,000.00, Total: USDC 12,000.00]"

const withPct = BalanceFormatter.toStringWithPercentage(balance);
console.log(withPct);
// "Balance[Total: USDC 12,000.00, Reserved: USDC 2,000.00 (16.67%)]"

const short = BalanceFormatter.toShortString(balance);
console.log(short);
// "A: USDC 10,000 / R: USDC 2,000"
```

### 7. Проверки баланса

```typescript
// Проверка достаточности средств
if (BalanceService.canAfford(balance, Money.fromUSDC(5000))) {
  console.log('Can execute order');
} else {
  console.log('Insufficient funds');
}

// Процент зарезервированных средств
const pct = BalanceService.getReservedPercentage(balance);
console.log(`Reserved: ${pct.toFixed(2)}%`);

// Проверка на пустоту
if (balance.isEmpty()) {
  console.log('Balance is empty');
}

// Проверка наличия reserved
if (balance.hasReserved()) {
  console.log('Has reserved funds');
}
```

---

## Зависимости и интеграция

### Package Dependencies

```json
{
  "dependencies": {
    "@polymarket/math": "workspace:*",
    "@polymarket/errors": "workspace:*",
    "@polymarket/result": "workspace:*"
  }
}
```

### Package Exports

**packages/domain/value-objects/package.json:**
```json
{
  "exports": {
    "./Balance": {
      "import": "./dist/Balance/index.js",
      "types": "./dist/Balance/index.d.ts"
    },
    "./BalanceService": {
      "import": "./dist/Balance/facade/BalanceService.js",
      "types": "./dist/Balance/facade/BalanceService.d.ts"
    },
    "./BalanceSerializer": {
      "import": "./dist/Balance/adapters/BalanceSerializer.js",
      "types": "./dist/Balance/adapters/BalanceSerializer.d.ts"
    },
    "./BalanceFormatter": {
      "import": "./dist/Balance/adapters/BalanceFormatter.js",
      "types": "./dist/Balance/adapters/BalanceFormatter.d.ts"
    },
    "./CashManagementPolicy": {
      "import": "./dist/Balance/policy/CashManagementPolicy.js",
      "types": "./dist/Balance/policy/CashManagementPolicy.d.ts"
    },
    "./MarginCallPolicy": {
      "import": "./dist/Balance/policy/MarginCallPolicy.js",
      "types": "./dist/Balance/policy/MarginCallPolicy.d.ts"
    }
  }
}
```

### Использование из других пакетов

```typescript
// В packages/domain/entities
import { Balance, BalanceService } from '@polymarket/value-objects/Balance';
import { CashManagementPolicy } from '@polymarket/value-objects/CashManagementPolicy';
import { MarginCallPolicy } from '@polymarket/value-objects/MarginCallPolicy';
```

---

## Дополнительные заметки

### Почему available/reserved разделение?

**Причины:**
- Order execution требует резервирования средств до исполнения
- Нельзя использовать зарезервированные средства для новых ордеров
- Необходимо track "свободные" vs "занятые" средства

**Альтернативы (отвергнуты):**
- Один total баланс - не позволяет отслеживать резервы
- Два отдельных VO - избыточно и усложняет операции

### Почему operations через Service?

**Преимущества:**
- Единая точка входа для всех операций
- Result pattern для error handling
- Легко расширять функциональность
- Проще тестировать

### Margin Call Policy

**Назначение:**
Контролирует риски при margin trading:
- **Maintenance margin** - минимальный баланс для поддержания позиций
- **Liquidation threshold** - порог принудительной ликвидации

**Три уровня:**
1. **HEALTHY** - баланс > maintenance margin
2. **WARNING** - maintenance > баланс > liquidation
3. **CRITICAL** - баланс < liquidation (требуется ликвидация)

---

**Конец детального плана для Balance**
