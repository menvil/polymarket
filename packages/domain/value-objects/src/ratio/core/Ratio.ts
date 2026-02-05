/**
 * Ratio - value object для представления относительных величин (коэффициентов, долей)
 *
 * @remarks
 * ## Архитектура
 * - Core слой БРОСАЕТ исключения RatioInvariantViolation
 * - Facade слой (RatioService) возвращает Result<T, E> и НИКОГДА не бросает
 * - Для безопасного создания используйте RatioService.create()
 *
 * ## Инварианты
 * Ratio гарантирует:
 * - Значение не NaN
 * - Значение конечно (finite)
 *
 * ## НЕ-инварианты (не проверяются на этом уровне)
 * - Минимальные/максимальные границы (проверяются Rules при необходимости)
 * - Парсинг строк (делает RatioFormatter в Adapters)
 * - Валидация precondition для операций (делает Rules)
 *
 * ## Семантика
 * Ratio хранит дробь (fraction):
 * - `0.02` означает 2% (two percent)
 * - `0.0025` означает 25 bps (basis points)
 * - `1.0` означает 100%
 * - `-0.1` означает -10% (discount)
 *
 * ## Важно: Ratio НЕ содержит арифметических операций
 * Операции живут в целевых value objects:
 * - Money.addRate(ratio: Ratio): добавить процент к сумме
 * - Price.take(ratio: Ratio): взять процент от цены
 * - Quantity.applyDiscount(ratio: Ratio): применить скидку
 *
 * @see {@link RatioService} для безопасного создания и операций
 *
 * @example
 * ```typescript
 * // ❌ WRONG: Никогда не вызывайте конструктор напрямую
 * const ratio = new Ratio(value);
 *
 * // ✅ CORRECT: Используйте RatioService
 * const ratioResult = RatioService.fromPercent(2); // 2% => 0.02
 * if (ratioResult.ok) {
 *   const ratio = ratioResult.value;
 *   console.log(ratio.toDecimal()); // Decimal(0.02)
 * }
 * ```
 */
import Decimal from 'decimal.js';
import { RatioInvariantViolation } from './RatioInvariantViolation.js';
import { RatioErrorReason } from '../errors/RatioErrorReason.js';

export class Ratio {
  /**
   * Единственный приватный конструктор
   * @throws {RatioInvariantViolation} если нарушены инварианты
   */
  private constructor(private readonly _value: Decimal) {
    // Invariant 1: value не может быть NaN
    if (_value.isNaN()) {
      throw new RatioInvariantViolation('Ratio value cannot be NaN', RatioErrorReason.NAN);
    }

    // Invariant 2: value должно быть конечным
    if (!_value.isFinite()) {
      throw new RatioInvariantViolation('Ratio value must be finite', RatioErrorReason.NON_FINITE);
    }
  }

  /**
   * Создать Ratio из дроби (fraction)
   *
   * @param value - Дробь: 0.02 для 2%, 0.5 для 50%
   * @returns Ratio instance
   * @throws {RatioInvariantViolation} если нарушены инварианты
   *
   * @example
   * ```typescript
   * const ratio = Ratio.of(new Decimal(0.02)); // 2%
   * const ratio2 = Ratio.of(new Decimal(0.5)); // 50%
   * ```
   */
  public static of(value: Decimal): Ratio {
    return new Ratio(value);
  }

  /**
   * Получить значение как Decimal (fraction)
   *
   * @returns Decimal значение (0.02 для 2%)
   *
   * @example
   * ```typescript
   * const ratio = Ratio.of(new Decimal(0.02));
   * console.log(ratio.toDecimal().toString()); // "0.02"
   * ```
   */
  public toDecimal(): Decimal {
    return this._value;
  }

  /**
   * Получить значение как number (lossy!)
   *
   * @remarks
   * ⚠️ ВНИМАНИЕ: Преобразование в number может потерять точность
   * Используйте только для отображения, НЕ для вычислений
   *
   * @returns number значение (0.02 для 2%)
   *
   * @example
   * ```typescript
   * const ratio = Ratio.of(new Decimal(0.02));
   * console.log(ratio.toNumber()); // 0.02
   * ```
   */
  public toNumber(): number {
    return this._value.toNumber();
  }

  /**
   * Вычислить (1 + ratio) для compound operations
   *
   * @remarks
   * Используется для операций типа "добавить X процентов":
   * - amount * (1 + ratio)
   * - price * (1 + markup)
   *
   * @returns Decimal значение (1 + ratio)
   *
   * @example
   * ```typescript
   * const markup = Ratio.of(new Decimal(0.1)); // 10%
   * console.log(markup.onePlus().toString()); // "1.1"
   *
   * // Usage: price * (1 + markup)
   * const newPrice = price.toDecimal().mul(markup.onePlus());
   * ```
   */
  public onePlus(): Decimal {
    return new Decimal(1).plus(this._value);
  }

  /**
   * Проверить равенство с другим Ratio
   *
   * @param other - Другой Ratio для сравнения
   * @returns true если значения равны
   *
   * @example
   * ```typescript
   * const r1 = Ratio.of(new Decimal(0.02));
   * const r2 = Ratio.of(new Decimal(0.02));
   * console.log(r1.equals(r2)); // true
   * ```
   */
  public equals(other: Ratio): boolean {
    return this._value.equals(other._value);
  }

  /**
   * Проверить, равно ли значение нулю
   *
   * @returns true если ratio === 0
   *
   * @example
   * ```typescript
   * const zero = Ratio.of(new Decimal(0));
   * console.log(zero.isZero()); // true
   * ```
   */
  public isZero(): boolean {
    return this._value.isZero();
  }

  /**
   * Проверить, положительно ли значение
   *
   * @returns true если ratio > 0
   *
   * @example
   * ```typescript
   * const markup = Ratio.of(new Decimal(0.1));
   * console.log(markup.isPositive()); // true
   * ```
   */
  public isPositive(): boolean {
    return this._value.greaterThan(0);
  }

  /**
   * Проверить, отрицательно ли значение
   *
   * @returns true если ratio < 0
   *
   * @example
   * ```typescript
   * const discount = Ratio.of(new Decimal(-0.1));
   * console.log(discount.isNegative()); // true
   * ```
   */
  public isNegative(): boolean {
    return this._value.lessThan(0);
  }

  /**
   * Константа: нулевой коэффициент
   */
  public static readonly ZERO: Ratio = new Ratio(new Decimal(0));

  /**
   * Константа: единичный коэффициент (100%)
   */
  public static readonly ONE: Ratio = new Ratio(new Decimal(1));
}
