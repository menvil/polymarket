import Decimal from 'decimal.js';
import { MoneyInvariantViolation } from './MoneyInvariantViolation';
import { MoneyParseError } from './MoneyParseError';

export type SupportedCurrency = 'USDC';

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
 * - Формат входных данных — это parse error, см. {@link MoneyParseError}
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
  public static readonly SUPPORTED_CURRENCIES = new Set<SupportedCurrency>(['USDC']);
  public static readonly MAX_AMOUNT = new Decimal('1e15');

  // Lazy initialization
  private static _zeroUSDC?: Money;

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
    // Инвариант 1: поддерживаемая валюта
    if (!Money.SUPPORTED_CURRENCIES.has(currency)) {
      throw new MoneyInvariantViolation(
        `Unsupported currency: ${currency}`,
        'UNSUPPORTED_CURRENCY'
      );
    }

    // Инвариант 2: не NaN
    if (amount.isNaN()) {
      throw new MoneyInvariantViolation('Amount is NaN', 'NAN');
    }

    // Инвариант 3: finite
    if (!amount.isFinite()) {
      throw new MoneyInvariantViolation('Amount must be finite', 'NON_FINITE');
    }

    // Инвариант 4: не превышает MAX_AMOUNT
    if (amount.abs().greaterThan(Money.MAX_AMOUNT)) {
      throw new MoneyInvariantViolation(
        `Amount exceeds maximum: ${Money.MAX_AMOUNT}`,
        'EXCEEDS_MAX_AMOUNT'
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
   * @throws {MoneyParseError} Ошибка парсинга
   * @throws {MoneyInvariantViolation} Нарушение инвариантов
   *
   * @remarks
   * Парсит value в Decimal, затем вызывает create().
   *
   * Parse fail → MoneyParseError (НЕ инвариант).
   * Invariant fail → MoneyInvariantViolation.
   *
   * @example
   * ```typescript
   * const m1 = Money.of(100);
   * const m2 = Money.of('42.50', 'USDC');
   * ```
   */
  public static of(value: number | string, currency: SupportedCurrency = 'USDC'): Money {
    let decimal: Decimal;

    try {
      decimal = new Decimal(value);
    } catch (error) {
      // Ошибка парсинга → MoneyParseError (НЕ инвариант!)
      throw new MoneyParseError(String(value));
    }

    // create() бросит MoneyInvariantViolation если нарушены инварианты
    return Money.create(decimal, currency);
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
   * Для константного нуля используйте {@link ZERO_USDC}.
   *
   * @example
   * ```typescript
   * const zero = Money.zero();
   * console.log(zero.amount().toNumber()); // 0
   * ```
   */
  public static zero(currency: SupportedCurrency = 'USDC'): Money {
    return Money.create(new Decimal(0), currency);
  }

  /**
   * Константа для нулевой суммы USDC.
   *
   * @remarks
   * Ленивая инициализация. Singleton.
   *
   * @example
   * ```typescript
   * const zero = Money.ZERO_USDC;
   * ```
   */
  public static get ZERO_USDC(): Money {
    // ✅ ИСПРАВЛЕНО: используем create() НЕ прямой конструктор
    return this._zeroUSDC ??= Money.create(new Decimal(0), 'USDC');
  }

  /**
   * Возвращает сумму как Decimal.
   *
   * @returns Decimal
   *
   * @example
   * ```typescript
   * const money = Money.of(100.5);
   * const decimal = money.amount(); // Decimal
   * ```
   */
  public amount(): Decimal {
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
   * ⚠️ Может потерять точность. Для вычислений используйте {@link amount}.
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
   * Алиас для {@link amount}.
   *
   * @returns Decimal
   */
  public toDecimal(): Decimal {
    return this.amt;
  }

  /**
   * Проверяет строгое равенство.
   *
   * @param other - Другой Money
   * @returns true если валюта и сумма идентичны
   *
   * @example
   * ```typescript
   * const m1 = Money.of(100);
   * const m2 = Money.of(100);
   * console.log(m1.equals(m2)); // true
   * ```
   */
  public equals(other: Money): boolean {
    return this.cur === other.cur && this.amt.equals(other.amt);
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
}
