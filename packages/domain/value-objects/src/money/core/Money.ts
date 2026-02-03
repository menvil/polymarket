import Decimal from 'decimal.js';
import { MoneyInvariantViolation } from './MoneyInvariantViolation';
import { MoneyErrorReason } from '../errors/MoneyErrorReason';
import { SUPPORTED_CURRENCIES, SupportedCurrency } from '../../shared/currency/SupportedCurrencies';

// Re-export SupportedCurrency для удобства
export type { SupportedCurrency };

/**
 * Представляет денежную сумму с валютой.
 *
 * @remarks
 * ## Архитектура: Core (throws)
 *
 * Money - core value object, который:
 * - Бросает исключения при нарушении инвариантов
 * - НЕ содержит математических методов
 * - НЕ возвращает Result
 *
 * Для безопасного создания используйте {@link MoneyService}.
 *
 * ## Инварианты (enforced в core)
 *
 * 1. Валюта поддерживается (USDC)
 * 2. Сумма finite
 * 3. Сумма не NaN
 * 4. |Сумма| <= MAX_AMOUNT (1e15)
 *
 * ## НЕ инварианты (не в core)
 *
 * - Формат входных данных — парсинг делегируется Decimal
 *
 * ## Контекстные правила (НЕ в core)
 *
 * - Неотрицательность — бизнес-логика
 * - Минимальная сумма — PaymentPolicy
 * - Совпадение валют — MoneyService
 *
 * ## Математика — через MoneyService
 *
 * @see {@link MoneyService}
 * @see {@link MoneyInvariantViolation}
 */
export class Money {
  // Константы
  public static readonly SUPPORTED_CURRENCIES = new Set<SupportedCurrency>(SUPPORTED_CURRENCIES);
  public static readonly MAX_AMOUNT = new Decimal('1e15');

  /**
   * Singleton константы для нулевых сумм каждой валюты
   *
   * @remarks
   * Автоматически создаётся для всех валют из SUPPORTED_CURRENCIES.
   * При добавлении новой валюты - singleton создаётся автоматически.
   *
   * @example
   * ```typescript
   * const zero = Money.ZERO.USDC;
   * console.log(zero.value().toNumber()); // 0
   *
   * // После добавления EUR в SUPPORTED_CURRENCIES:
   * const zeroEur = Money.ZERO.EUR; // ✅ Автоматически доступен!
   * ```
   */
  public static readonly ZERO: Record<SupportedCurrency, Money> =
    Object.fromEntries(
      SUPPORTED_CURRENCIES.map(currency => [
        currency,
        Money.fromDecimal(new Decimal(0), currency)
      ])
    ) as Record<SupportedCurrency, Money>;

  private constructor(
    private readonly amt: Decimal,
    private readonly cur: SupportedCurrency
  ) {}

  /**
   * Единственная точка создания с проверкой инвариантов.
   *
   * @param amount - Decimal сумма
   * @param currency - Валюта
   * @returns Money
   * @throws {MoneyInvariantViolation}
   *
   * @remarks
   * PRIVATE метод. Внешний код использует: of(), fromDecimal(), zero().
   *
   * Проверяет все инварианты в одном месте.
   */
  private static create(amount: Decimal, currency: SupportedCurrency): Money {
    // Инвариант 1: Not NaN (самое базовое)
    if (amount.isNaN()) {
      throw new MoneyInvariantViolation('Amount is NaN', MoneyErrorReason.NAN);
    }

    // Инвариант 2: Finite
    if (!amount.isFinite()) {
      throw new MoneyInvariantViolation('Amount must be finite', MoneyErrorReason.NON_FINITE);
    }

    // Инвариант 3: Supported currency
    if (!Money.SUPPORTED_CURRENCIES.has(currency)) {
      throw new MoneyInvariantViolation(
        `Unsupported currency: ${currency}`,
        MoneyErrorReason.UNSUPPORTED_CURRENCY
      );
    }

    // Инвариант 4: Max amount
    if (amount.abs().greaterThan(Money.MAX_AMOUNT)) {
      throw new MoneyInvariantViolation(
        `Amount exceeds maximum: ${Money.MAX_AMOUNT}`,
        MoneyErrorReason.EXCEEDS_MAX_AMOUNT
      );
    }

    return new Money(amount, currency);
  }

  /**
   * Создаёт Money из числа или строки.
   *
   * @param value - Сумма (число или строка)
   * @param currency - Валюта (default 'USDC')
   * @returns Money
   * @throws {Error} Ошибка парсинга Decimal (если value невалидный)
   * @throws {MoneyInvariantViolation} Нарушение инвариантов
   *
   * @remarks
   * Парсит value в Decimal, затем вызывает create().
   *
   * Философия: данные должны быть адекватными на входе.
   * Parse fail → бросит ошибку Decimal.
   * Invariant fail → MoneyInvariantViolation.
   *
   * @example
   * ```typescript
   * const m1 = Money.of(100);
   * const m2 = Money.of('42.50', 'USDC');
   * ```
   */
  public static of(value: number | string, currency: SupportedCurrency = 'USDC'): Money {
    // Decimal бросит свою ошибку если value невалидный
    // create() бросит MoneyInvariantViolation если нарушены инварианты
    return Money.create(new Decimal(value), currency);
  }

  /**
   * Создаёт Money из Decimal.
   *
   * @param value - Decimal сумма
   * @param currency - Валюта (default 'USDC')
   * @returns Money
   * @throws {MoneyInvariantViolation}
   *
   * @remarks
   * НЕ парсит — принимает Decimal as-is.
   * Используется в MoneyService после math ops.
   *
   * @example
   * ```typescript
   * const decimal = new Decimal('123.456');
   * const money = Money.fromDecimal(decimal);
   * ```
   */
  public static fromDecimal(value: Decimal, currency: SupportedCurrency = 'USDC'): Money {
    return Money.create(value, currency);
  }

  /**
   * Создаёт Money с нулевой суммой.
   *
   * @param currency - Валюта (default 'USDC')
   * @returns Money с суммой 0
   *
   * @remarks
   * Для константного нуля используйте {@link ZERO}.
   * Alias для удобства. Рекомендуется использовать Money.ZERO.USDC напрямую.
   *
   * @example
   * ```typescript
   * const zero = Money.zero();
   * // Или лучше:
   * const zero = Money.ZERO.USDC;
   * ```
   */
  public static zero(currency: SupportedCurrency = 'USDC'): Money {
    // Переиспользуем константу из Record
    if (currency in Money.ZERO) {
      return Money.ZERO[currency];
    }
    return Money.create(new Decimal(0), currency);
  }

  /**
   * Возвращает сумму как Decimal.
   *
   * @returns Decimal
   *
   * @example
   * ```typescript
   * const money = Money.of(100.5);
   * const decimal = money.value(); // Decimal
   * ```
   */
  public value(): Decimal {
    return this.amt;
  }

  /**
   * Возвращает валюту.
   *
   * @returns Код валюты
   */
  public currency(): SupportedCurrency {
    return this.cur;
  }

  /**
   * Преобразует в number (lossy).
   *
   * @returns number
   *
   * @remarks
   * ⚠️ Может потерять точность. Для вычислений используйте {@link value}.
   *
   * @example
   * ```typescript
   * const money = Money.of(100.5);
   * const num = money.toNumber(); // 100.5
   * ```
   */
  public toNumber(): number {
    return this.amt.toNumber();
  }

  /**
   * Проверяет совпадение валют.
   *
   * @param other - Другой Money
   * @returns true если валюты совпадают
   *
   * @remarks
   * Используется в MoneyService для проверки совместимости.
   *
   * @example
   * ```typescript
   * const m1 = Money.of(100, 'USDC');
   * const m2 = Money.of(200, 'USDC');
   * console.log(m1.hasSameCurrency(m2)); // true
   * ```
   */
  public hasSameCurrency(other: Money): boolean {
    return this.cur === other.cur;
  }

  /**
   * Проверяет что сумма равна нулю.
   *
   * @returns true если сумма равна 0
   *
   * @remarks
   * Точное сравнение без epsilon.
   *
   * @example
   * ```typescript
   * Money.ZERO.USDC.isZero(); // true
   * Money.of(0).isZero();     // true
   * Money.of(100).isZero();   // false
   * ```
   */
  public isZero(): boolean {
    return this.amt.isZero();
  }

  /**
   * Проверяет что сумма положительная (> 0).
   *
   * @returns true если сумма > 0
   *
   * @example
   * ```typescript
   * Money.of(100).isPositive();   // true
   * Money.ZERO.USDC.isPositive(); // false
   * Money.of(-100).isPositive();  // false
   * ```
   */
  public isPositive(): boolean {
    return this.amt.greaterThan(0);
  }

  /**
   * Проверяет что сумма отрицательная (< 0).
   *
   * @returns true если сумма < 0
   *
   * @example
   * ```typescript
   * Money.of(-100).isNegative(); // true
   * Money.of(100).isNegative();  // false
   * Money.ZERO.USDC.isNegative(); // false
   * ```
   */
  public isNegative(): boolean {
    return this.amt.lessThan(0);
  }
}
