import Decimal from 'decimal.js';
import { Money } from '../../money/core/Money.js';
import type { SupportedCurrency } from '@polymarket/ids';
import { BalanceInvariantViolation } from './BalanceInvariantViolation.js';
import { BalanceErrorReason } from '../errors/BalanceErrorReason.js';

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
 *
 * // Helpers
 * const empty = Balance.ZERO.USDC;
 * const withZero = Balance.withZeroReserved(Money.of(10000));
 * ```
 */
export class Balance {
  /**
   * Private constructor для защиты инвариантов
   *
   * @param _available - Доступные средства
   * @param _reserved - Зарезервированные средства
   * @throws {BalanceInvariantViolation} Если нарушены инварианты
   */
  private constructor(
    private readonly _available: Money,
    private readonly _reserved: Money
  ) {
    // Инвариант 0a: Not NaN
    if (_available.value().isNaN() || _reserved.value().isNaN()) {
      throw new BalanceInvariantViolation(
        'Balance amounts cannot be NaN',
        {
          reason: BalanceErrorReason.NAN,
          available: _available.value().toString(),
          reserved: _reserved.value().toString()
        }
      );
    }

    // Инвариант 0b: Must be finite
    if (!_available.value().isFinite() || !_reserved.value().isFinite()) {
      throw new BalanceInvariantViolation(
        'Balance amounts must be finite',
        {
          reason: BalanceErrorReason.NON_FINITE,
          available: _available.value().toString(),
          reserved: _reserved.value().toString()
        }
      );
    }

    // Инвариант 1: available >= 0
    if (_available.value().isNegative()) {
      throw new BalanceInvariantViolation(
        'Available amount cannot be negative',
        {
          reason: BalanceErrorReason.NEGATIVE_AVAILABLE,
          available: _available.value().toNumber()
        }
      );
    }

    // Инвариант 2: reserved >= 0
    if (_reserved.value().isNegative()) {
      throw new BalanceInvariantViolation(
        'Reserved amount cannot be negative',
        {
          reason: BalanceErrorReason.NEGATIVE_RESERVED,
          reserved: _reserved.value().toNumber()
        }
      );
    }

    // Инвариант 3: same currency
    if (_available.currency() !== _reserved.currency()) {
      throw new BalanceInvariantViolation(
        'Available and reserved must have the same currency',
        {
          reason: BalanceErrorReason.CURRENCY_MISMATCH,
          availableCurrency: _available.currency(),
          reservedCurrency: _reserved.currency()
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
   * const balance = Balance.withZeroReserved(Money.of(10000));
   * // available: 10000, reserved: 0
   * ```
   */
  public static withZeroReserved(available: Money): Balance {
    const zeroReserved = Money.ZERO[available.currency()];
    return new Balance(available, zeroReserved);
  }

  /**
   * Singleton константы для нулевых балансов
   *
   * @remarks
   * Автоматически создаётся для всех валют из Money.ZERO.
   * При добавлении новой валюты в SUPPORTED_CURRENCIES -
   * singleton создаётся автоматически.
   *
   * @example
   * ```typescript
   * const balance = Balance.ZERO.USDC;
   * console.log(balance.isZero()); // true
   * console.log(balance.currency()); // 'USDC'
   *
   * // После добавления EUR в SUPPORTED_CURRENCIES:
   * const balanceEur = Balance.ZERO.EUR; // ✅ Автоматически доступен!
   * ```
   */
  public static readonly ZERO: Record<SupportedCurrency, Balance> =
    Object.fromEntries(
      Object.entries(Money.ZERO).map(([currency, money]) => [
        currency,
        new Balance(money, money)
      ])
    ) as Record<SupportedCurrency, Balance>;

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
    return this._available;
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
    return this._reserved;
  }

  /**
   * Вычисляет общую сумму (available + reserved)
   *
   * @returns Money с total суммой
   *
   * @remarks
   * Derived value - вычисляется каждый раз при вызове.
   *
   * Безопасно потому что:
   * - Валюты гарантированно совпадают (инвариант Balance)
   * - Оба значения >= 0 (инварианты Balance)
   * - Оба значения finite и not NaN (инварианты Balance)
   * - Сумма не может превысить Money.MAX_AMOUNT (гарантируется бизнес-логикой)
   *
   * @example
   * ```typescript
   * const balance = Balance.of(
   *   Money.of(10000),
   *   Money.of(2000)
   * );
   * console.log(balance.total().value().toNumber()); // 12000
   * ```
   */
  public total(): Money {
    // Прямое вычисление через Decimal (не нужен MoneyService)
    const totalAmount = this._available.value().plus(this._reserved.value());

    // Создаём Money из результата
    // Безопасно благодаря инвариантам Balance
    return Money.of(totalAmount, this._available.currency());
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
    return this._available.currency();
  }

  /**
   * Проверяет, равен ли баланс нулю (total = 0)
   *
   * @returns true если available = 0 AND reserved = 0
   *
   * @remarks
   * Баланс считается нулевым только если ОБА значения равны нулю.
   * Консистентно с Money.isZero(), Price.isZero(), Quantity.isZero().
   *
   * @example
   * ```typescript
   * const zero = Balance.ZERO.USDC;
   * console.log(zero.isZero()); // true
   *
   * const withReserved = Balance.of(Money.ZERO.USDC, Money.of(100, 'USDC'));
   * console.log(withReserved.isZero()); // false
   * ```
   */
  public isZero(): boolean {
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
    return this._reserved.value().greaterThan(0);
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
   *   Money.of(8000, 'USDC'),
   *   Money.of(2000, 'USDC')
   * );
   * console.log(balance.reservedPercentage().toFixed(2)); // "20.00"
   *
   * const empty = Balance.ZERO.USDC;
   * console.log(empty.reservedPercentage().toFixed(2)); // "0.00"
   * ```
   */
  public reservedPercentage(): Decimal {
    const totalAmount = this.total().value();
    if (totalAmount.equals(0)) {
      return new Decimal(0);
    }

    return this._reserved.value().dividedBy(totalAmount).times(100);
  }

  /**
   * Проверяет совпадение валют
   *
   * @param other - Другой баланс для сравнения
   * @returns true если валюты совпадают
   *
   * @remarks
   * Используется в BalanceService для проверки совместимости операций.
   *
   * @example
   * ```typescript
   * const balance1 = Balance.of(Money.of(100), Money.of(50));
   * const balance2 = Balance.of(Money.of(200), Money.of(100));
   * console.log(balance1.hasSameCurrency(balance2)); // true
   * ```
   */
  public hasSameCurrency(other: Balance): boolean {
    return this.currency() === other.currency();
  }
}
