/**
 * Ratio - value object для представления относительных величин (коэффициентов, долей)
 *
 * @remarks
 * ## Архитектура
 * - Core слой (Ratio.of) БРОСАЕТ исключения RatioInvariantViolation
 * - Facade слой (RatioService) возвращает Result<T, E> и НИКОГДА не бросает
 *
 * ## Способы создания
 *
 * ### 1. Через Facade (рекомендуется для большинства случаев)
 * ```typescript
 * const result = RatioService.fromPercent(2); // Result<Ratio, InvalidRatioError>
 * if (result.ok) {
 *   const ratio = result.value; // безопасно
 * }
 * ```
 *
 * ### 2. Через Core API (когда нужны исключения)
 * ```typescript
 * try {
 *   const ratio = Ratio.of(new Decimal(0.02)); // может бросить RatioInvariantViolation
 * } catch (e) {
 *   if (e instanceof RatioInvariantViolation) {
 *     // обработка нарушения инвариантов
 *   }
 * }
 * ```
 *
 * ## Инварианты
 * Ratio гарантирует:
 * - Значение не NaN
 * - Значение конечно (finite)
 *
 * ## НЕ-инварианты (не проверяются на этом уровне)
 * - Минимальные/максимальные границы (проверяются Rules при необходимости)
 * - Парсинг строк делает фасад через toDecimal
 * - Валидация precondition для операций (делает Rules)
 *
 * ## ⚠️ Важно: Ratio хранит ДРОБЬ (fraction), не процент!
 * - `0.02` означает 2% (дробь 0.02, не число 2)
 * - `0.0025` означает 25 bps (дробь 0.0025)
 * - `1.0` означает 100% (дробь 1.0)
 * - `2.0` означает 200% (дробь 2.0, не 2%)
 * - `-0.1` означает -10% (дробь -0.1)
 *
 * Для ясной семантики используйте factory methods:
 * - `RatioService.fromPercent(2)` → 0.02 (2%)
 * - `RatioService.fromBps(200)` → 0.02 (200 basis points)
 * - `RatioService.fromDecimal(0.02)` → 0.02 (явное указание дроби)
 *
 * ## Важно: Ratio НЕ содержит операций между Ratio
 * Но содержит helpers для compound operations:
 * - onePlus(): вычислить (1 + ratio) для операций "добавить %"
 * - oneMinus(): вычислить (1 - ratio) для операций "вычесть %"
 *
 * Арифметика с другими VO живет в целевых классах:
 * - Money.addRate(ratio: Ratio): добавить процент к сумме
 * - Price.take(ratio: Ratio): взять процент от цены
 * - Quantity.applyDiscount(ratio: Ratio): применить скидку
 *
 * @see {@link RatioService} для безопасного создания через Result
 * @see {@link Ratio.of} для прямого создания (бросает исключения)
 *
 * @example
 * ```typescript
 * // ✅ РЕКОМЕНДУЕТСЯ: Через RatioService (безопасно, Result)
 * const ratioResult = RatioService.fromPercent(2); // 2% => 0.02
 * if (ratioResult.ok) {
 *   const ratio = ratioResult.value;
 *   console.log(ratio.toDecimal()); // Decimal(0.02)
 *   console.log(ratio.onePlus());   // Decimal(1.02) - для amount * (1 + ratio)
 *   console.log(ratio.oneMinus());  // Decimal(0.98) - для amount * (1 - ratio)
 * }
 *
 * // ⚠️ АЛЬТЕРНАТИВА: Прямой вызов Ratio.of() (бросает исключения)
 * try {
 *   const ratio = Ratio.of(new Decimal(0.02));
 *   console.log(ratio.toDecimal()); // Decimal(0.02)
 * } catch (e) {
 *   if (e instanceof RatioInvariantViolation) {
 *     console.error('Invariant violation:', e.reason);
 *   }
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
   * Создать Ratio из дроби (fraction) - Core API
   *
   * @remarks
   * **⚠️ ВНИМАНИЕ: Этот метод БРОСАЕТ исключения при нарушении инвариантов.**
   *
   * Используйте этот метод когда:
   * - Вы работаете в контексте, где исключения предпочтительнее Result
   * - Вы уверены что значение валидно (например, константы)
   * - Вам нужен прямой доступ к Core API
   *
   * Для большинства случаев рекомендуется использовать RatioService.fromDecimal(),
   * который возвращает Result<Ratio, InvalidRatioError> и не бросает исключения.
   *
   * @param value - Дробь: 0.02 для 2%, 0.5 для 50%
   * @returns Ratio instance
   * @throws {RatioInvariantViolation} если value - NaN или не конечно
   *
   * @example
   * ```typescript
   * // ✅ Безопасно - валидное значение
   * const ratio = Ratio.of(new Decimal(0.02));
   *
   * // ✅ С обработкой исключений
   * try {
   *   const ratio = Ratio.of(new Decimal(userInput));
   *   console.log(ratio.toDecimal());
   * } catch (e) {
   *   if (e instanceof RatioInvariantViolation) {
   *     console.error('Invalid ratio:', e.reason);
   *   }
   * }
   *
   * // ✅ РЕКОМЕНДУЕТСЯ: Через RatioService (безопаснее, Result)
   * const result = RatioService.fromDecimal(0.02);
   * if (result.ok) {
   *   const ratio = result.value;
   * }
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
   * - amount * (1 + ratio) - добавить markup/discount
   * - price * (1 + ratio) - увеличить/уменьшить цену
   *
   * @returns Decimal значение (1 + ratio)
   *
   * @example
   * ```typescript
   * const ratioResult = RatioService.fromPercent(10); // 10% markup
   * if (ratioResult.ok) {
   *   const markup = ratioResult.value;
   *   console.log(markup.onePlus().toString()); // "1.1"
   *
   *   // Usage: amount * (1 + markup)
   *   const newAmount = amount.mul(markup.onePlus()); // amount * 1.1
   * }
   * ```
   */
  public onePlus(): Decimal {
    return new Decimal(1).plus(this._value);
  }

  /**
   * Вычислить (1 - ratio) для subtraction operations
   *
   * @remarks
   * Используется для операций типа "вычесть X процентов":
   * - amount * (1 - ratio) - вычесть fee/tax/discount
   * - price * (1 - ratio) - взять процент (оставить остаток)
   *
   * @returns Decimal значение (1 - ratio)
   *
   * @example
   * ```typescript
   * const ratioResult = RatioService.fromPercent(2); // 2% fee
   * if (ratioResult.ok) {
   *   const fee = ratioResult.value;
   *   console.log(fee.oneMinus().toString()); // "0.98"
   *
   *   // Usage: amount * (1 - fee) - оставить 98%
   *   const afterFee = amount.mul(fee.oneMinus()); // amount * 0.98
   * }
   *
   * // Пример с discount
   * const discountResult = RatioService.fromPercent(15); // 15% discount
   * if (discountResult.ok) {
   *   const discount = discountResult.value;
   *   const finalPrice = price.mul(discount.oneMinus()); // price * 0.85
   * }
   * ```
   */
  public oneMinus(): Decimal {
    return new Decimal(1).minus(this._value);
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
  public static readonly ZERO: Ratio = Ratio.of(new Decimal(0));

  /**
   * Константа: единичный коэффициент (100%)
   */
  public static readonly ONE: Ratio = Ratio.of(new Decimal(1));
}
