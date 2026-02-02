import Decimal from 'decimal.js';
import { Money, SupportedCurrency } from '../../money/core/Money.js';
import { MoneyService } from '../../money/facade/MoneyService.js';
import { BalanceInvariantViolation } from './BalanceInvariantViolation.js';

/**
 * Balance - баланс денежных средств с разделением на available/reserved
 *
 * @remarks
 * Представляет баланс с разделением средств на:
 * - **available** - доступные для использования средства
 * - **reserved** - зарезервированные средства (например, для открытых ордеров)
 *
 * **Инварианты (проверяются в constructor):**
 * 1. available >= 0 (доступные средства не могут быть отрицательными)
 * 2. reserved >= 0 (зарезервированные средства не могут быть отрицательными)
 * 3. available.currency === reserved.currency (одинаковая валюта)
 *
 * **Derived values:**
 * - total = available + reserved (общая сумма средств)
 *
 * **Immutability:**
 * Это immutable value object. Все операции (reserve, release, update)
 * выполняются через BalanceService и возвращают НОВЫЙ экземпляр Balance.
 *
 * **Архитектура Throws+Facade:**
 * - Core Layer (Balance) - может бросать BalanceInvariantViolation при нарушении инвариантов
 * - Facade Layer (BalanceService) - ловит исключения и возвращает Result
 *
 * Пользователи должны использовать BalanceService для безопасных операций.
 *
 * @example
 * ```typescript
 * import { Balance } from '@polymarket/value-objects/balance';
 * import { Money } from '@polymarket/value-objects/money';
 *
 * // Создание баланса (может throw при нарушении инвариантов)
 * const balance = Balance.of(
 *   Money.fromUSDC(10000),  // available
 *   Money.fromUSDC(2000)    // reserved
 * );
 *
 * // Query методы (чистые, не могут fail)
 * console.log(balance.total().value());           // 12000
 * console.log(balance.available().value());       // 10000
 * console.log(balance.reserved().value());        // 2000
 * console.log(balance.reservedPercentage());       // 16.67
 * console.log(balance.canAfford(Money.fromUSDC(5000))); // true
 *
 * // Helpers
 * const empty = Balance.zero('USDC');
 * const withZero = Balance.withZeroReserved(Money.fromUSDC(10000));
 * ```
 */
export class Balance {
  /**
   * Private constructor для защиты инвариантов
   *
   * @param avail - Доступные средства
   * @param res - Зарезервированные средства
   * @throws {BalanceInvariantViolation} Если нарушены инварианты
   */
  private constructor(
    private readonly avail: Money,
    private readonly res: Money
  ) {
    // Инвариант 1: available >= 0
    if (avail.value().isNegative()) {
      throw new BalanceInvariantViolation(
        'Available amount cannot be negative',
        {
          reason: 'NEGATIVE_AVAILABLE',
          available: avail.value().toNumber()
        }
      );
    }

    // Инвариант 2: reserved >= 0
    if (res.value().isNegative()) {
      throw new BalanceInvariantViolation(
        'Reserved amount cannot be negative',
        {
          reason: 'NEGATIVE_RESERVED',
          reserved: res.value().toNumber()
        }
      );
    }

    // Инвариант 3: same currency
    if (avail.currency() !== res.currency()) {
      throw new BalanceInvariantViolation(
        'Available and reserved must have the same currency',
        {
          reason: 'CURRENCY_MISMATCH',
          availableCurrency: avail.currency(),
          reservedCurrency: res.currency()
        }
      );
    }
  }

  /**
   * Создаёт Balance из available и reserved Money
   *
   * @param available - Доступные средства
   * @param reserved - Зарезервированные средства
   * @returns Новый Balance объект
   * @throws {BalanceInvariantViolation} Если нарушены инварианты
   *
   * @remarks
   * Это главный способ создания Balance.
   * Проверяет все инварианты и бросает BalanceInvariantViolation при нарушении.
   *
   * Для безопасного создания с Result используй BalanceService.create().
   *
   * @example
   * ```typescript
   * // Прямое создание (может throw)
   * const balance = Balance.of(
   *   Money.fromUSDC(10000),
   *   Money.fromUSDC(2000)
   * );
   *
   * // Или через BalanceService (Result-based)
   * const result = BalanceService.create(
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
   * @throws {BalanceInvariantViolation} Если available < 0
   *
   * @remarks
   * Convenience метод для создания баланса без зарезервированных средств.
   *
   * @example
   * ```typescript
   * const balance = Balance.withZeroReserved(Money.fromUSDC(10000));
   * // available: 10000, reserved: 0
   * ```
   */
  public static withZeroReserved(available: Money): Balance {
    const zeroReserved = Money.of(0, available.currency());
    return new Balance(available, zeroReserved);
  }

  /**
   * Создаёт пустой Balance (available = 0, reserved = 0)
   *
   * @param currency - Валюта баланса
   * @returns Новый пустой Balance
   * @throws Никогда - zero значения всегда валидны
   *
   * @remarks
   * Convenience метод для создания пустого баланса.
   * Полезно для инициализации или default значений.
   *
   * @example
   * ```typescript
   * const balance = Balance.zero('USDC');
   * // available: 0, reserved: 0, currency: 'USDC'
   * ```
   */
  public static zero(currency: SupportedCurrency): Balance {
    const zero = Money.of(0, currency);
    return new Balance(zero, zero);
  }

  // ==================== Getters ====================

  /**
   * Возвращает доступные средства
   *
   * @returns Money с available amount
   *
   * @example
   * ```typescript
   * const available = balance.available();
   * console.log(available.value().toNumber()); // 10000
   * ```
   */
  public available(): Money {
    return this.avail;
  }

  /**
   * Возвращает зарезервированные средства
   *
   * @returns Money с reserved amount
   *
   * @example
   * ```typescript
   * const reserved = balance.reserved();
   * console.log(reserved.value().toNumber()); // 2000
   * ```
   */
  public reserved(): Money {
    return this.res;
  }

  /**
   * Вычисляет общую сумму (available + reserved)
   *
   * @returns Money с total суммой
   * @throws Никогда - сложение Money не может fail для валидных балансов
   *
   * @remarks
   * Derived value - вычисляется каждый раз при вызове.
   * Для валидных балансов эта операция всегда успешна, потому что:
   * - Оба значения имеют одинаковую валюту (инвариант)
   * - Оба значения >= 0 (инварианты)
   * - Сумма не превысит MAX_AMOUNT (гарантируется бизнес-логикой)
   *
   * Использует MoneyService.add() и unwrap результат (безопасно для валидных балансов).
   *
   * @example
   * ```typescript
   * const balance = Balance.of(
   *   Money.fromUSDC(10000),
   *   Money.fromUSDC(2000)
   * );
   * console.log(balance.total().value().toNumber()); // 12000
   * ```
   */
  public total(): Money {
    const result = MoneyService.add(this.avail, this.res);
    // Для валидного баланса сложение всегда успешно (одинаковая валюта, не переполнение)
    // Если fail - это баг в Balance invariants, нужно throw
    if (!result.ok) {
      throw new Error(`Invariant violation: failed to calculate total: ${result.error.message}`);
    }
    return result.value;
  }

  /**
   * Возвращает валюту баланса
   *
   * @returns Валюта (available и reserved всегда имеют одинаковую валюту)
   *
   * @example
   * ```typescript
   * console.log(balance.currency()); // 'USDC'
   * ```
   */
  public currency(): SupportedCurrency {
    return this.avail.currency();
  }

  // ==================== Query Methods ====================

  /**
   * Проверяет, пустой ли баланс (total = 0)
   *
   * @returns true если available = 0 AND reserved = 0
   *
   * @remarks
   * Баланс считается пустым только если ОБА значения равны нулю.
   *
   * @example
   * ```typescript
   * const empty = Balance.zero('USDC');
   * console.log(empty.isEmpty()); // true
   *
   * const withReserved = Balance.of(Money.fromUSDC(0), Money.fromUSDC(100));
   * console.log(withReserved.isEmpty()); // false
   * ```
   */
  public isEmpty(): boolean {
    return this.total().value().equals(0);
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
    return this.res.value().greaterThan(0);
  }

  /**
   * Вычисляет процент зарезервированных средств от total
   *
   * @returns Decimal с процентами (0-100), или 0 если total = 0
   *
   * @remarks
   * Formula: (reserved / total) * 100
   * Если total = 0, возвращает 0 (избегаем деления на ноль).
   *
   * @example
   * ```typescript
   * const balance = Balance.of(
   *   Money.fromUSDC(8000),
   *   Money.fromUSDC(2000)
   * );
   * console.log(balance.reservedPercentage().toFixed(2)); // "20.00"
   *
   * const empty = Balance.zero('USDC');
   * console.log(empty.reservedPercentage().toFixed(2)); // "0.00"
   * ```
   */
  public reservedPercentage(): Decimal {
    const totalAmount = this.total().value();
    if (totalAmount.equals(0)) {
      return new Decimal(0);
    }

    return this.res.value().dividedBy(totalAmount).times(100);
  }

  /**
   * Проверяет, достаточно ли available средств для указанной суммы
   *
   * @param amount - Требуемая сумма
   * @returns true если available >= amount
   *
   * @remarks
   * Используется для проверки возможности резервирования или траты средств.
   * Не проверяет валюту - caller должен обеспечить совпадение валют.
   *
   * @example
   * ```typescript
   * const balance = Balance.of(
   *   Money.fromUSDC(10000),
   *   Money.fromUSDC(2000)
   * );
   *
   * console.log(balance.canAfford(Money.fromUSDC(5000)));  // true
   * console.log(balance.canAfford(Money.fromUSDC(15000))); // false
   * ```
   */
  public canAfford(amount: Money): boolean {
    return this.avail.value().greaterThanOrEqualTo(amount.value());
  }

  /**
   * Сравнивает с другим балансом на равенство (с точностью до epsilon)
   *
   * @param other - Другой баланс для сравнения
   * @param epsilon - Порог для сравнения сумм (например, new Decimal(0.01))
   * @returns true если оба баланса идентичны в пределах epsilon
   *
   * @remarks
   * Балансы считаются равными если:
   * - available совпадают в пределах epsilon
   * - reserved совпадают в пределах epsilon
   * - валюты совпадают (проверяется неявно через сравнение amount)
   *
   * @example
   * ```typescript
   * const balance1 = Balance.of(Money.fromUSDC(10000), Money.fromUSDC(2000));
   * const balance2 = Balance.of(Money.fromUSDC(10000.001), Money.fromUSDC(2000));
   *
   * console.log(balance1.equals(balance2, new Decimal(0.01)));  // true
   * console.log(balance1.equals(balance2, new Decimal(0.0001))); // false
   * ```
   */
  public equals(other: Balance, epsilon: Decimal): boolean {
    // Сравниваем available
    const availDiff = this.avail.value().minus(other.avail.value()).abs();
    if (availDiff.greaterThan(epsilon)) {
      return false;
    }

    // Сравниваем reserved
    const resDiff = this.res.value().minus(other.res.value()).abs();
    if (resDiff.greaterThan(epsilon)) {
      return false;
    }

    // Проверяем валюту
    return this.currency() === other.currency();
  }
}
