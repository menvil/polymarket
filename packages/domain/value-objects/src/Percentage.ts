/**
 * Percentage - value object для процентных значений
 *
 * @remarks
 * Представляет процентное значение с высокой точностью вычислений.
 * Неизменяемый value object для финансовых процентных расчётов.
 *
 * Использует decimal.js для точных вычислений и Railway-Oriented Programming
 * для явной обработки ошибок через Result<T, E>.
 *
 * **Диапазон значений:**
 * - Поддерживает любые числа (включая отрицательные для PnL, изменений)
 * - Для ограниченного диапазона [0, 100%] используйте явную валидацию
 *
 * **Представления:**
 * - Процент (0-100): `50` означает 50%
 * - Десятичное (0-1): `0.5` означает 50%
 * - Базисные пункты: `5000` bp означает 50%
 *
 * @example
 * ```typescript
 * import { Percentage } from '@polymarket/value-objects';
 *
 * // Создание процентов
 * const fee = Percentage.fromNumber(2.5);  // 2.5%
 * const gain = Percentage.fromDecimal(0.15); // 15%
 * const loss = Percentage.fromNumber(-5); // -5% (убыток)
 *
 * // Арифметические операции
 * fee.match({
 *   ok: (pct) => {
 *     const total = pct.add(gain);
 *     total.match({
 *       ok: (result) => console.log(result.getValue()), // 17.5
 *       err: (error) => console.error(error)
 *     });
 *   },
 *   err: (error) => console.error(error)
 * });
 *
 * // Применение к значению
 * const amount = 1000;
 * const feeAmount = unwrap(fee).of(amount); // 25
 *
 * // Точность decimal.js
 * const p1 = unwrap(Percentage.fromDecimal(0.1));
 * const p2 = unwrap(Percentage.fromDecimal(0.2));
 * const sum = unwrap(p1.add(p2));
 * sum.toDecimal().toString(); // "0.3" (точно!)
 * ```
 */

import Decimal from 'decimal.js';
import { type Result, Ok, Err } from '@polymarket/result';
import {
  InvalidPercentageError,
  ArithmeticOverflowError,
  DivisionByZeroError,
} from '@polymarket/errors';

/**
 * Percentage - неизменяемый value object для процентных значений
 *
 * @remarks
 * Использует decimal.js для высокоточных финансовых расчётов.
 * Все операции возвращают Result<T, E> для явной обработки ошибок.
 */
export class Percentage {
  /**
   * Максимальное допустимое значение процента (1e6 = 1,000,000%)
   *
   * @remarks
   * Защита от overflow. Достаточно для любых реальных финансовых расчётов.
   */
  private static readonly MAX_PERCENTAGE = new Decimal('1e6');

  /**
   * Минимальное допустимое значение процента (-1e6 = -1,000,000%)
   */
  private static readonly MIN_PERCENTAGE = new Decimal('-1e6');

  private constructor(
    private readonly value: Decimal
  ) {}

  // ============================================================================
  // Factory Methods
  // ============================================================================

  /**
   * Создать Percentage из числа (шкала 0-100)
   *
   * @param value - Процентное значение (50 = 50%)
   * @returns Result с Percentage или InvalidPercentageError
   *
   * @example
   * ```typescript
   * const pct = Percentage.fromNumber(25.5); // 25.5%
   * const fee = Percentage.fromNumber(2.5);  // 2.5%
   * const loss = Percentage.fromNumber(-10); // -10%
   * ```
   */
  static fromNumber(value: number): Result<Percentage, InvalidPercentageError> {
    try {
      const decimal = new Decimal(value);

      // Проверка NaN
      if (decimal.isNaN()) {
        return Err(
          new InvalidPercentageError(
            'Percentage cannot be NaN',
            {
              code: InvalidPercentageError.code,
              context: { value, reason: 'NaN' }
            }
          )
        );
      }

      // Проверка конечности
      if (!decimal.isFinite()) {
        return Err(
          new InvalidPercentageError(
            'Percentage must be finite',
            {
              code: InvalidPercentageError.code,
              context: { value, reason: 'Infinity' }
            }
          )
        );
      }

      // Проверка диапазона
      if (decimal.lessThan(Percentage.MIN_PERCENTAGE) || decimal.greaterThan(Percentage.MAX_PERCENTAGE)) {
        return Err(
          new InvalidPercentageError(
            (ctx: Record<string, unknown>) =>
              `Percentage ${ctx.value} is out of range [${ctx.min}, ${ctx.max}]`,
            {
              code: InvalidPercentageError.code,
              context: {
                value: decimal.toString(),
                min: Percentage.MIN_PERCENTAGE.toString(),
                max: Percentage.MAX_PERCENTAGE.toString()
              }
            }
          )
        );
      }

      return Ok(new Percentage(decimal));
    } catch (error) {
      return Err(
        new InvalidPercentageError(
          `Invalid percentage value: ${value}`,
          {
            code: InvalidPercentageError.code,
            context: { value, error: String(error) }
          }
        )
      );
    }
  }

  /**
   * Создать Percentage из Decimal
   *
   * @param value - Процентное значение (Decimal)
   * @returns Result с Percentage или InvalidPercentageError
   *
   * @example
   * ```typescript
   * const decimal = new Decimal('25.123456789');
   * const pct = Percentage.fromDecimal(decimal);
   * ```
   */
  static fromDecimalValue(value: Decimal): Result<Percentage, InvalidPercentageError> {
    // Проверка конечности
    if (!value.isFinite()) {
      return Err(
        new InvalidPercentageError(
          'Percentage must be finite',
          {
            code: InvalidPercentageError.code,
            context: { value: value.toString(), reason: 'not finite' }
          }
        )
      );
    }

    // Проверка диапазона
    if (value.lessThan(Percentage.MIN_PERCENTAGE) || value.greaterThan(Percentage.MAX_PERCENTAGE)) {
      return Err(
        new InvalidPercentageError(
          (ctx: Record<string, unknown>) =>
            `Percentage ${ctx.value} is out of range [${ctx.min}, ${ctx.max}]`,
          {
            code: InvalidPercentageError.code,
            context: {
              value: value.toString(),
              min: Percentage.MIN_PERCENTAGE.toString(),
              max: Percentage.MAX_PERCENTAGE.toString()
            }
          }
        )
      );
    }

    return Ok(new Percentage(value));
  }

  /**
   * Создать Percentage из десятичной дроби (шкала 0-1)
   *
   * @param decimal - Десятичное значение (0.5 = 50%)
   * @returns Result с Percentage или InvalidPercentageError
   *
   * @remarks
   * Преобразует десятичное представление в процент.
   * Пример: 0.5 становится 50%, 0.025 становится 2.5%
   *
   * @example
   * ```typescript
   * const pct = Percentage.fromDecimal(0.5);   // 50%
   * const fee = Percentage.fromDecimal(0.025); // 2.5%
   * ```
   */
  static fromDecimal(decimal: number): Result<Percentage, InvalidPercentageError> {
    try {
      const decimalValue = new Decimal(decimal);

      // Проверка конечности
      if (!decimalValue.isFinite()) {
        return Err(
          new InvalidPercentageError(
            'Decimal value must be finite',
            {
              code: InvalidPercentageError.code,
              context: { decimal, reason: 'not finite' }
            }
          )
        );
      }

      const percentage = decimalValue.times(100);
      return Percentage.fromDecimalValue(percentage);
    } catch (error) {
      return Err(
        new InvalidPercentageError(
          `Invalid decimal value: ${decimal}`,
          {
            code: InvalidPercentageError.code,
            context: { decimal, error: String(error) }
          }
        )
      );
    }
  }

  /**
   * Создать Percentage из строки
   *
   * @param value - Процент в виде строки (с символом '%' или без)
   * @returns Result с Percentage или InvalidPercentageError
   *
   * @example
   * ```typescript
   * const pct1 = Percentage.fromString("25.5");  // 25.5%
   * const pct2 = Percentage.fromString("25.5%"); // 25.5%
   * const pct3 = Percentage.fromString("-10%");  // -10%
   * ```
   */
  static fromString(value: string): Result<Percentage, InvalidPercentageError> {
    try {
      const cleaned = value.replace('%', '').trim();
      const decimal = new Decimal(cleaned);
      return Percentage.fromDecimalValue(decimal);
    } catch (error) {
      return Err(
        new InvalidPercentageError(
          `Invalid percentage string: "${value}"`,
          {
            code: InvalidPercentageError.code,
            context: { value, error: String(error) }
          }
        )
      );
    }
  }

  /**
   * Создать Percentage из базисных пунктов
   *
   * @param bps - Базисные пункты (100 bp = 1%)
   * @returns Result с Percentage или InvalidPercentageError
   *
   * @remarks
   * Преобразует базисные пункты в процент.
   * Пример: 100 bps = 1%, 250 bps = 2.5%
   *
   * @example
   * ```typescript
   * const pct = Percentage.fromBasisPoints(250); // 2.5%
   * const fee = Percentage.fromBasisPoints(50);  // 0.5%
   * ```
   */
  static fromBasisPoints(bps: number): Result<Percentage, InvalidPercentageError> {
    try {
      const bpsDecimal = new Decimal(bps);

      if (!bpsDecimal.isFinite()) {
        return Err(
          new InvalidPercentageError(
            'Basis points must be finite',
            {
              code: InvalidPercentageError.code,
              context: { bps, reason: 'not finite' }
            }
          )
        );
      }

      const percentage = bpsDecimal.dividedBy(100);
      return Percentage.fromDecimalValue(percentage);
    } catch (error) {
      return Err(
        new InvalidPercentageError(
          `Invalid basis points: ${bps}`,
          {
            code: InvalidPercentageError.code,
            context: { bps, error: String(error) }
          }
        )
      );
    }
  }

  /**
   * Создать нулевой процент
   *
   * @returns Percentage со значением 0%
   *
   * @example
   * ```typescript
   * const zero = Percentage.zero();
   * zero.getValue(); // 0
   * ```
   */
  static zero(): Percentage {
    return new Percentage(new Decimal(0));
  }

  /**
   * Создать 100% процент
   *
   * @returns Percentage со значением 100%
   *
   * @example
   * ```typescript
   * const full = Percentage.oneHundred();
   * full.getValue(); // 100
   * ```
   */
  static oneHundred(): Percentage {
    return new Percentage(new Decimal(100));
  }

  // ============================================================================
  // Getters
  // ============================================================================

  /**
   * Получить значение процента как number
   *
   * @returns Процентное значение
   *
   * @remarks
   * Для высокоточных вычислений используйте toDecimal()
   */
  getValue(): number {
    return this.value.toNumber();
  }

  /**
   * Получить значение как Decimal
   *
   * @returns Decimal значение
   *
   * @remarks
   * Используйте для высокоточных вычислений
   */
  toDecimal(): Decimal {
    return this.value;
  }

  /**
   * Преобразовать в десятичную дробь (шкала 0-1)
   *
   * @returns Десятичное представление
   *
   * @remarks
   * Преобразует процент в десятичную дробь для вычислений.
   * Пример: 50% становится 0.5, 2.5% становится 0.025
   *
   * @example
   * ```typescript
   * const pct = unwrap(Percentage.fromNumber(50));
   * pct.toDecimalFraction(); // 0.5
   * ```
   */
  toDecimalFraction(): Decimal {
    return this.value.dividedBy(100);
  }

  /**
   * Преобразовать в базисные пункты
   *
   * @returns Базисные пункты (100 bp = 1%)
   *
   * @remarks
   * Преобразует процент в базисные пункты.
   * Пример: 2.5% становится 250 bps, 1% становится 100 bps
   *
   * @example
   * ```typescript
   * const pct = unwrap(Percentage.fromNumber(2.5));
   * pct.toBasisPoints(); // 250
   * ```
   */
  toBasisPoints(): Decimal {
    return this.value.times(100);
  }

  // ============================================================================
  // Math Operations
  // ============================================================================

  /**
   * Сложить проценты
   *
   * @param other - Другой процент
   * @returns Result с новым Percentage или ArithmeticOverflowError
   *
   * @remarks
   * Возвращает ошибку если результат выходит за допустимый диапазон
   *
   * @example
   * ```typescript
   * const fee = unwrap(Percentage.fromNumber(2.5));
   * const gain = unwrap(Percentage.fromNumber(15));
   * const total = fee.add(gain);
   * total.match({
   *   ok: (pct) => console.log(pct.getValue()), // 17.5
   *   err: (error) => console.error('Overflow')
   * });
   * ```
   */
  add(other: Percentage): Result<Percentage, ArithmeticOverflowError> {
    const result = this.value.plus(other.value);

    if (result.greaterThan(Percentage.MAX_PERCENTAGE)) {
      return Err(
        new ArithmeticOverflowError(
          (ctx: Record<string, unknown>) =>
            `Addition overflow: ${ctx.a} + ${ctx.b} = ${ctx.result} exceeds max ${ctx.max}`,
          {
            code: ArithmeticOverflowError.code,
            context: {
              operation: 'add',
              a: this.value.toString(),
              b: other.value.toString(),
              result: result.toString(),
              max: Percentage.MAX_PERCENTAGE.toString()
            }
          }
        )
      );
    }

    if (result.lessThan(Percentage.MIN_PERCENTAGE)) {
      return Err(
        new ArithmeticOverflowError(
          (ctx: Record<string, unknown>) =>
            `Addition underflow: ${ctx.a} + ${ctx.b} = ${ctx.result} below min ${ctx.min}`,
          {
            code: ArithmeticOverflowError.code,
            context: {
              operation: 'add',
              a: this.value.toString(),
              b: other.value.toString(),
              result: result.toString(),
              min: Percentage.MIN_PERCENTAGE.toString()
            }
          }
        )
      );
    }

    return Ok(new Percentage(result));
  }

  /**
   * Вычесть процент
   *
   * @param other - Другой процент
   * @returns Result с новым Percentage или ArithmeticOverflowError
   *
   * @example
   * ```typescript
   * const total = unwrap(Percentage.fromNumber(17.5));
   * const fee = unwrap(Percentage.fromNumber(2.5));
   * const net = total.subtract(fee);
   * net.match({
   *   ok: (pct) => console.log(pct.getValue()), // 15
   *   err: (error) => console.error(error)
   * });
   * ```
   */
  subtract(other: Percentage): Result<Percentage, ArithmeticOverflowError> {
    const result = this.value.minus(other.value);

    if (result.greaterThan(Percentage.MAX_PERCENTAGE)) {
      return Err(
        new ArithmeticOverflowError(
          (ctx: Record<string, unknown>) =>
            `Subtraction overflow: ${ctx.a} - ${ctx.b} = ${ctx.result} exceeds max ${ctx.max}`,
          {
            code: ArithmeticOverflowError.code,
            context: {
              operation: 'subtract',
              a: this.value.toString(),
              b: other.value.toString(),
              result: result.toString(),
              max: Percentage.MAX_PERCENTAGE.toString()
            }
          }
        )
      );
    }

    if (result.lessThan(Percentage.MIN_PERCENTAGE)) {
      return Err(
        new ArithmeticOverflowError(
          (ctx: Record<string, unknown>) =>
            `Subtraction underflow: ${ctx.a} - ${ctx.b} = ${ctx.result} below min ${ctx.min}`,
          {
            code: ArithmeticOverflowError.code,
            context: {
              operation: 'subtract',
              a: this.value.toString(),
              b: other.value.toString(),
              result: result.toString(),
              min: Percentage.MIN_PERCENTAGE.toString()
            }
          }
        )
      );
    }

    return Ok(new Percentage(result));
  }

  /**
   * Умножить на коэффициент
   *
   * @param factor - Коэффициент (number или Decimal)
   * @returns Result с новым Percentage или ArithmeticOverflowError
   *
   * @example
   * ```typescript
   * const base = unwrap(Percentage.fromNumber(10));
   * const doubled = base.multiply(2);
   * doubled.match({
   *   ok: (pct) => console.log(pct.getValue()), // 20
   *   err: (error) => console.error('Overflow')
   * });
   * ```
   */
  multiply(factor: number | Decimal): Result<Percentage, ArithmeticOverflowError> {
    try {
      const factorDecimal = factor instanceof Decimal ? factor : new Decimal(factor);
      const result = this.value.times(factorDecimal);

      if (!result.isFinite()) {
        return Err(
          new ArithmeticOverflowError(
            'Multiplication resulted in non-finite value',
            {
              code: ArithmeticOverflowError.code,
              context: {
                operation: 'multiply',
                a: this.value.toString(),
                b: factorDecimal.toString()
              }
            }
          )
        );
      }

      if (result.abs().greaterThan(Percentage.MAX_PERCENTAGE)) {
        return Err(
          new ArithmeticOverflowError(
            (ctx: Record<string, unknown>) =>
              `Multiplication overflow: ${ctx.a} * ${ctx.b} = ${ctx.result} exceeds limit`,
            {
              code: ArithmeticOverflowError.code,
              context: {
                operation: 'multiply',
                a: this.value.toString(),
                b: factorDecimal.toString(),
                result: result.toString(),
                max: Percentage.MAX_PERCENTAGE.toString()
              }
            }
          )
        );
      }

      return Ok(new Percentage(result));
    } catch (error) {
      return Err(
        new ArithmeticOverflowError(
          `Multiplication error: ${error}`,
          {
            code: ArithmeticOverflowError.code,
            context: { error: String(error) }
          }
        )
      );
    }
  }

  /**
   * Разделить на коэффициент
   *
   * @param divisor - Делитель (number или Decimal)
   * @returns Result с новым Percentage или DivisionByZeroError
   *
   * @example
   * ```typescript
   * const total = unwrap(Percentage.fromNumber(20));
   * const half = total.divide(2);
   * half.match({
   *   ok: (pct) => console.log(pct.getValue()), // 10
   *   err: (error) => console.error('Division by zero')
   * });
   * ```
   */
  divide(divisor: number | Decimal): Result<Percentage, DivisionByZeroError> {
    try {
      const divisorDecimal = divisor instanceof Decimal ? divisor : new Decimal(divisor);

      if (divisorDecimal.isZero()) {
        return Err(
          new DivisionByZeroError(
            (ctx: Record<string, unknown>) =>
              `Cannot divide percentage ${ctx.value} by zero`,
            {
              code: DivisionByZeroError.code,
              context: {
                value: this.value.toString(),
                divisor: 0,
                operation: 'divide percentage'
              }
            }
          )
        );
      }

      const result = this.value.dividedBy(divisorDecimal);
      return Ok(new Percentage(result));
    } catch (error) {
      return Err(
        new DivisionByZeroError(
          `Division error: ${error}`,
          {
            code: DivisionByZeroError.code,
            context: { error: String(error) }
          }
        )
      );
    }
  }

  /**
   * Применить процент к значению
   *
   * @param value - Базовое значение (number или Decimal)
   * @returns Вычисленная сумма (value * percentage)
   *
   * @remarks
   * Вычисляет процентную долю от значения.
   * Пример: 10% от 1000 = 100
   *
   * @example
   * ```typescript
   * const fee = unwrap(Percentage.fromNumber(2.5));
   * const orderValue = 1000;
   * const feeAmount = fee.of(orderValue); // 25
   * ```
   */
  of(value: number | Decimal): Decimal {
    const valueDecimal = value instanceof Decimal ? value : new Decimal(value);
    return valueDecimal.times(this.toDecimalFraction());
  }

  // ============================================================================
  // Comparison
  // ============================================================================

  /**
   * Проверить равенство процентов
   *
   * @param other - Другой процент
   * @returns true если равны
   *
   * @example
   * ```typescript
   * const a = unwrap(Percentage.fromNumber(10));
   * const b = unwrap(Percentage.fromNumber(10));
   * a.equals(b); // true
   * ```
   */
  equals(other: Percentage): boolean {
    return this.value.equals(other.value);
  }

  /**
   * Проверить больше ли этот процент
   *
   * @param other - Другой процент
   * @returns true если больше
   */
  greaterThan(other: Percentage): boolean {
    return this.value.greaterThan(other.value);
  }

  /**
   * Проверить меньше ли этот процент
   *
   * @param other - Другой процент
   * @returns true если меньше
   */
  lessThan(other: Percentage): boolean {
    return this.value.lessThan(other.value);
  }

  /**
   * Проверить больше или равно
   *
   * @param other - Другой процент
   * @returns true если больше или равно
   */
  greaterThanOrEqual(other: Percentage): boolean {
    return this.value.greaterThanOrEqualTo(other.value);
  }

  /**
   * Проверить меньше или равно
   *
   * @param other - Другой процент
   * @returns true если меньше или равно
   */
  lessThanOrEqual(other: Percentage): boolean {
    return this.value.lessThanOrEqualTo(other.value);
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  /**
   * Проверить является ли ноль
   *
   * @returns true если ноль
   */
  isZero(): boolean {
    return this.value.isZero();
  }

  /**
   * Проверить является ли положительным
   *
   * @returns true если положительное (> 0)
   */
  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  /**
   * Проверить является ли отрицательным
   *
   * @returns true если отрицательное (< 0)
   *
   * @remarks
   * Полезно для определения убытков в PnL расчётах
   */
  isNegative(): boolean {
    return this.value.isNegative();
  }

  /**
   * Получить абсолютное значение
   *
   * @returns Новый Percentage с абсолютным значением
   *
   * @example
   * ```typescript
   * const loss = unwrap(Percentage.fromNumber(-10));
   * const absLoss = loss.abs();
   * absLoss.getValue(); // 10
   * ```
   */
  abs(): Percentage {
    return new Percentage(this.value.abs());
  }

  /**
   * Изменить знак
   *
   * @returns Новый Percentage с противоположным знаком
   *
   * @example
   * ```typescript
   * const gain = unwrap(Percentage.fromNumber(10));
   * const loss = gain.negate();
   * loss.getValue(); // -10
   * ```
   */
  negate(): Percentage {
    return new Percentage(this.value.negated());
  }

  /**
   * Представление в виде строки
   *
   * @param decimals - Количество десятичных знаков (по умолчанию 2)
   * @returns Отформатированная строка
   *
   * @example
   * ```typescript
   * const pct = unwrap(Percentage.fromNumber(25.5));
   * pct.toString();    // "25.50%"
   * pct.toString(1);   // "25.5%"
   * ```
   */
  toString(decimals: number = 2): string {
    return `${this.value.toFixed(decimals)}%`;
  }

  /**
   * Представление без символа процента
   *
   * @param decimals - Количество десятичных знаков (по умолчанию 2)
   * @returns Отформатированная строка без '%'
   *
   * @example
   * ```typescript
   * const pct = unwrap(Percentage.fromNumber(25.5));
   * pct.toFixedString(); // "25.50"
   * ```
   */
  toFixedString(decimals: number = 2): string {
    return this.value.toFixed(decimals);
  }
}