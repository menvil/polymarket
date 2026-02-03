import Decimal from 'decimal.js';
import { PercentageInvariantViolation } from './PercentageInvariantViolation';
import { PercentageErrorReason } from '../errors/PercentageErrorReason';

/**
 * Percentage - неизменяемый Value Object для процентных значений
 *
 * @remarks
 * ## Архитектура: Core (throws)
 *
 * Percentage - core value object, который:
 * - Бросает исключения при нарушении инвариантов
 * - НЕ содержит математических операций (используй PercentageService)
 * - НЕ возвращает Result
 *
 * Для безопасного создания и операций используйте {@link PercentageService}.
 *
 * ## Инварианты (enforced в core)
 *
 * 1. Значение конечно (не NaN, не Infinity)
 * 2. Значение >= MIN_PERCENTAGE (-1e6)
 * 3. Значение <= MAX_PERCENTAGE (1e6)
 *
 * ## НЕ инварианты (не в core)
 *
 * - Формат входных данных — это parse error в Service
 * - Неотрицательность — бизнес-логика в Rules
 * - Минимальная/максимальная комиссия — Rules
 *
 * ## Контекстные правила (НЕ в core)
 *
 * - Неотрицательность (для комиссий) — ValidateFeeForTrading
 * - Диапазон [0, 5] (для торговых комиссий) — ValidateFeeForTrading
 * - Суммарные лимиты — ValidateTotalFee
 *
 * ## Математика — через PercentageService
 *
 * **Представления:**
 * - Процент: 50 = 50%
 * - Дробь: 0.5 = 50%
 * - Базисные пункты: 5000 bp = 50%
 *
 * @see {@link PercentageService}
 * @see {@link PercentageInvariantViolation}
 *
 * @example
 * ```typescript
 * // ❌ НЕ используй Core напрямую в публичном коде
 * const pct = Percentage.of(50); // throws на ошибку
 *
 * // ✅ Используй Service (Result-based API)
 * const result = PercentageService.create(50);
 * if (result.ok) {
 *   console.log(result.value.value()); // Decimal(50)
 * }
 *
 * // Использование констант
 * const zero = Percentage.ZERO;        // 0%
 * const full = Percentage.ONE_HUNDRED; // 100%
 *
 * // Доступ к значению
 * pct.value();           // Decimal(50)
 * pct.toDecimal();       // 0.5 (fraction 0-1)
 * pct.toBasisPoints();   // 5000 (bp)
 * ```
 */
export class Percentage {
  /**
   * Максимальное значение: 1,000,000%
   *
   * @remarks
   * Защита от overflow. Достаточно для любых реальных расчётов.
   */
  private static readonly MAX_PERCENTAGE = new Decimal('1e6');

  /**
   * Минимальное значение: -1,000,000%
   *
   * @remarks
   * Поддержка отрицательных значений для PnL, изменений цен.
   */
  private static readonly MIN_PERCENTAGE = new Decimal('-1e6');

  /**
   * Константа: 0%
   */
  public static readonly ZERO = new Percentage(new Decimal(0));

  /**
   * Константа: 100%
   */
  public static readonly ONE_HUNDRED = new Percentage(new Decimal(100));

  /**
   * Private constructor - используйте static factory methods
   *
   * @param v - Значение процента (шкала 0-100)
   * @throws {PercentageInvariantViolation} если инварианты нарушены
   */
  private constructor(private readonly v: Decimal) {
    // Инвариант 1: Not NaN
    if (v.isNaN()) {
      throw new PercentageInvariantViolation('Percentage cannot be NaN', PercentageErrorReason.NAN);
    }

    // Инвариант 2: Must be finite
    if (!v.isFinite()) {
      throw new PercentageInvariantViolation('Percentage must be finite', PercentageErrorReason.NON_FINITE);
    }

    // Инвариант 3: Диапазон [MIN, MAX]
    if (v.lessThan(Percentage.MIN_PERCENTAGE)) {
      throw new PercentageInvariantViolation(
        `Percentage ${v} is below minimum ${Percentage.MIN_PERCENTAGE}`,
        PercentageErrorReason.OUT_OF_RANGE_LOW
      );
    }

    if (v.greaterThan(Percentage.MAX_PERCENTAGE)) {
      throw new PercentageInvariantViolation(
        `Percentage ${v} exceeds maximum ${Percentage.MAX_PERCENTAGE}`,
        PercentageErrorReason.OUT_OF_RANGE_HIGH
      );
    }
  }

  /**
   * Создаёт Percentage из Decimal значения (ТОЛЬКО для Core!)
   *
   * @internal ТОЛЬКО для внутреннего использования в Core и Facade
   *
   * @remarks
   * Бросает PercentageInvariantViolation при нарушении инвариантов.
   * Все проверки инвариантов выполняются в конструкторе.
   * Для публичного API используйте PercentageService.create().
   *
   * @param decimal - Decimal значение процента (шкала 0-100)
   * @returns Percentage объект
   * @throws {PercentageInvariantViolation} При нарушении инвариантов
   *
   * @example
   * ```typescript
   * // ✅ В Core и Facade
   * const pct = Percentage.fromDecimal(new Decimal(50));
   *
   * // ❌ В публичном коде - используй PercentageService.create()
   * const result = PercentageService.create(50);
   * if (!result.ok) {
   *   console.error(result.error);
   * }
   * ```
   */
  public static fromDecimal(decimal: Decimal): Percentage {
    return new Percentage(decimal);
  }

  /**
   * Создаёт Percentage из значения (ТОЛЬКО для Core!)
   *
   * @internal ТОЛЬКО для внутреннего использования в Core и Facade
   *
   * @remarks
   * Бросает PercentageInvariantViolation при нарушении инвариантов.
   * Для публичного API используйте PercentageService.create().
   *
   * @param value - Значение процента (number, string или Decimal)
   * @returns Percentage объект
   * @throws {PercentageInvariantViolation} При нарушении инвариантов
   *
   * @example
   * ```typescript
   * // ✅ В Core и Facade
   * const pct = Percentage.of(50);
   *
   * // ❌ В публичном коде - используй PercentageService.create()
   * const result = PercentageService.create(50);
   * if (!result.ok) {
   *   console.error(result.error);
   * }
   * ```
   */
  public static of(value: number | string | Decimal): Percentage {
    return value instanceof Decimal
      ? Percentage.fromDecimal(value)
      : new Percentage(new Decimal(value));
  }

  /**
   * Возвращает минимальный процент (-1,000,000%)
   *
   * @returns Percentage объект с минимальным значением
   *
   * @example
   * ```typescript
   * const minPct = Percentage.min();
   * console.log(minPct.toNumber()); // -1000000
   * ```
   */
  public static min(): Percentage {
    return Percentage.fromDecimal(Percentage.MIN_PERCENTAGE);
  }

  /**
   * Возвращает максимальный процент (1,000,000%)
   *
   * @returns Percentage объект с максимальным значением
   *
   * @example
   * ```typescript
   * const maxPct = Percentage.max();
   * console.log(maxPct.toNumber()); // 1000000
   * ```
   */
  public static max(): Percentage {
    return Percentage.fromDecimal(Percentage.MAX_PERCENTAGE);
  }

  /**
   * Возвращает внутреннее значение (percent scale 0-100)
   *
   * @returns Decimal значение процента
   *
   * @example
   * ```typescript
   * const pct = Percentage.of(50);
   * const decimal = pct.value(); // Decimal(50)
   * ```
   */
  public value(): Decimal {
    return this.v;
  }

  /**
   * Преобразует в number (lossy)
   *
   * @returns number представление процента
   *
   * @remarks
   * ⚠️ Может потерять точность. Для вычислений используйте {@link value}.
   *
   * @example
   * ```typescript
   * const pct = Percentage.of(50);
   * const num = pct.toNumber(); // 50
   * ```
   */
  public toNumber(): number {
    return this.v.toNumber();
  }

  /**
   * Преобразует в десятичную дробь (scale 0-1)
   *
   * @returns Decimal дробь (50% → 0.5)
   *
   * @remarks
   * Конвертирует из процентной шкалы (0-100) в десятичную (0-1).
   * Используется для применения процентов к значениям.
   *
   * @example
   * ```typescript
   * const pct = Percentage.of(50);
   * const decimal = pct.toDecimal(); // Decimal(0.5)
   *
   * const pct2 = Percentage.of(25);
   * const decimal2 = pct2.toDecimal(); // Decimal(0.25)
   * ```
   */
  public toDecimal(): Decimal {
    return this.v.dividedBy(100);
  }

  /**
   * Преобразует в базисные пункты (100 bp = 1%)
   *
   * @returns Decimal базисных пунктов (50% → 5000 bp)
   *
   * @remarks
   * 1 базисный пункт (bp) = 0.01%
   * Используется в финансовых расчётах для точного представления малых процентов.
   *
   * @example
   * ```typescript
   * const pct = Percentage.of(50);
   * const bp = pct.toBasisPoints(); // Decimal(5000)
   *
   * const pct2 = Percentage.of(0.01); // 0.01%
   * const bp2 = pct2.toBasisPoints(); // Decimal(1)
   * ```
   */
  public toBasisPoints(): Decimal {
    return this.v.times(100);
  }

  /**
   * Проверяет строгое равенство
   *
   * @param other - Другой Percentage
   * @returns true если значения идентичны
   *
   * @example
   * ```typescript
   * const pct1 = Percentage.of(50);
   * const pct2 = Percentage.of(50);
   * console.log(pct1.equals(pct2)); // true
   * ```
   */
  public equals(other: Percentage): boolean {
    return this.v.equals(other.v);
  }

  /**
   * Проверяет, является ли процент нулевым
   *
   * @returns true если значение равно 0
   *
   * @example
   * ```typescript
   * const zero = Percentage.ZERO;
   * console.log(zero.isZero()); // true
   *
   * const fifty = Percentage.of(50);
   * console.log(fifty.isZero()); // false
   * ```
   */
  public isZero(): boolean {
    return this.v.isZero();
  }

  /**
   * Проверяет, является ли процент положительным
   *
   * @returns true если значение > 0
   *
   * @example
   * ```typescript
   * const pct = Percentage.of(50);
   * console.log(pct.isPositive()); // true
   *
   * const zero = Percentage.ZERO;
   * console.log(zero.isPositive()); // false
   * ```
   */
  public isPositive(): boolean {
    return this.v.isPositive();
  }

  /**
   * Проверяет, является ли процент отрицательным
   *
   * @returns true если значение < 0
   *
   * @example
   * ```typescript
   * const pct = Percentage.of(-10);
   * console.log(pct.isNegative()); // true
   *
   * const zero = Percentage.ZERO;
   * console.log(zero.isNegative()); // false
   * ```
   */
  public isNegative(): boolean {
    return this.v.isNegative();
  }

  /**
   * Сравнивает с другим процентом (<)
   *
   * @param other - Другой Percentage
   * @returns true если this < other
   *
   * @example
   * ```typescript
   * const pct1 = Percentage.of(25);
   * const pct2 = Percentage.of(50);
   * console.log(pct1.isLessThan(pct2)); // true
   * ```
   */
  public isLessThan(other: Percentage): boolean {
    return this.v.lessThan(other.v);
  }

  /**
   * Сравнивает с другим процентом (<=)
   *
   * @param other - Другой Percentage
   * @returns true если this <= other
   *
   * @example
   * ```typescript
   * const pct1 = Percentage.of(50);
   * const pct2 = Percentage.of(50);
   * console.log(pct1.isLessThanOrEqual(pct2)); // true
   * ```
   */
  public isLessThanOrEqual(other: Percentage): boolean {
    return this.v.lessThanOrEqualTo(other.v);
  }

  /**
   * Сравнивает с другим процентом (>)
   *
   * @param other - Другой Percentage
   * @returns true если this > other
   *
   * @example
   * ```typescript
   * const pct1 = Percentage.of(75);
   * const pct2 = Percentage.of(50);
   * console.log(pct1.isGreaterThan(pct2)); // true
   * ```
   */
  public isGreaterThan(other: Percentage): boolean {
    return this.v.greaterThan(other.v);
  }

  /**
   * Сравнивает с другим процентом (>=)
   *
   * @param other - Другой Percentage
   * @returns true если this >= other
   *
   * @example
   * ```typescript
   * const pct1 = Percentage.of(50);
   * const pct2 = Percentage.of(50);
   * console.log(pct1.isGreaterThanOrEqual(pct2)); // true
   * ```
   */
  public isGreaterThanOrEqual(other: Percentage): boolean {
    return this.v.greaterThanOrEqualTo(other.v);
  }
}
