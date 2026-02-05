/**
 * Ratio - value object для представления относительных величин (коэффициентов, долей)
 *
 * @remarks
 * ## Архитектура
 * - Core слой БРОСАЕТ исключения RatioInvariantViolation
 * - Facade слой (RatioService) возвращает Result<T, E> и НИКОГДА не бросает
 * - **Создание ТОЛЬКО через RatioService** - метод .of() приватный
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
 * ## Важно: Ratio НЕ содержит арифметических операций
 * Операции живут в целевых value objects:
 * - Money.addRate(ratio: Ratio): добавить процент к сумме
 * - Price.take(ratio: Ratio): взять процент от цены
 * - Quantity.applyDiscount(ratio: Ratio): применить скидку
 *
 * @see {@link RatioService} для создания Ratio (единственный способ)
 *
 * @example
 * ```typescript
 * // ❌ WRONG: .of() приватный, нельзя вызвать напрямую
 * const ratio = Ratio.of(value); // ERROR: of() is private
 *
 * // ✅ CORRECT: Используйте RatioService
 * const ratioResult = RatioService.fromPercent(2); // 2% => 0.02
 * if (ratioResult.ok) {
 *   const ratio = ratioResult.value;
 *   console.log(ratio.toDecimal()); // Decimal(0.02)
 *   console.log(ratio.onePlus());   // Decimal(1.02) - для amount * (1 + ratio)
 *   console.log(ratio.oneMinus());  // Decimal(0.98) - для amount * (1 - ratio)
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
   * Создать Ratio из дроби (fraction) - INTERNAL API
   *
   * @remarks
   * ⚠️ **НЕ ИСПОЛЬЗУЙТЕ НАПРЯМУЮ** - это внутренний API для RatioService!
   *
   * **Для пользователей:** Используйте RatioService вместо прямого вызова:
   * - `RatioService.fromDecimal(0.02)` - создать из дроби (явная семантика)
   * - `RatioService.fromPercent(2)` - создать из процента (2% => 0.02)
   * - `RatioService.fromBps(200)` - создать из basis points (200 bps => 0.02)
   *
   * **Почему не использовать .of() напрямую:**
   * - Непонятная семантика: `Ratio.of(2)` это 200% или 2%?
   * - Нет валидации опций (ensureGteMinusOne)
   * - Бросает исключения вместо Result
   *
   * @param value - Дробь: 0.02 для 2%, 0.5 для 50%
   * @returns Ratio instance
   * @throws {RatioInvariantViolation} если нарушены инварианты
   *
   * @internal - Используется только в RatioService
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
  public static readonly ZERO: Ratio = new Ratio(new Decimal(0));

  /**
   * Константа: единичный коэффициент (100%)
   */
  public static readonly ONE: Ratio = new Ratio(new Decimal(1));
}
