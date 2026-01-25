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

  /**
   * Нулевой процент (0%)
   */
  public static readonly ZERO = new Percentage(new Decimal(0));

  /**
   * Сто процентов (100%)
   */
  public static readonly ONE_HUNDRED = new Percentage(new Decimal(100));

  private constructor(
    private readonly value: Decimal
  ) {}

  // ============================================================================
  // Factory Methods
  // ============================================================================

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
              context: { decimal, reason: 'not finite' }
            }
          )
        );
      }

      const percentage = decimalValue.times(100);
      return Percentage.fromValue(percentage);
    } catch (error) {
      return Err(
        new InvalidPercentageError(
          `Invalid decimal value: ${decimal}`,
          {
            context: { decimal, error: String(error) }
          }
        )
      );
    }
  }

  /**
   * Создать Percentage из различных типов значений
   *
   * @param value - Значение: number, string или Decimal (шкала 0-100, т.е. 25 = 25%)
   * @returns Result с Percentage или InvalidPercentageError
   *
   * @remarks
   * Универсальный метод для создания Percentage.
   * Автоматически определяет тип входного значения и выполняет все необходимые проверки:
   * - Парсинг строки (убирает символ '%' если есть)
   * - Валидация формата числа (конечное значение, не NaN)
   * - Проверка диапазона [-1'000'000, 1'000'000]
   * - Преобразование в Decimal для точных вычислений
   *
   * @throws Никогда - все ошибки возвращаются через Result
   *
   * @example
   * ```typescript
   * import { unwrap } from '@polymarket/result';
   *
   * // Из числа (25 = 25%)
   * const p1 = unwrap(Percentage.fromValue(25));
   * const p2 = unwrap(Percentage.fromValue(2.5));
   * const p3 = unwrap(Percentage.fromValue(-10));
   *
   * // Из строки (с % или без)
   * const p4 = unwrap(Percentage.fromValue('25.5'));
   * const p5 = unwrap(Percentage.fromValue('25.5%'));
   * const p6 = unwrap(Percentage.fromValue('-10%'));
   *
   * // Из Decimal
   * const p7 = unwrap(Percentage.fromValue(new Decimal(25)));
   *
   * // Обработка ошибок
   * const result = Percentage.fromValue(NaN);
   * if (!result.ok) {
   *   console.error(result.error.message); // "Percentage cannot be NaN"
   * }
   * ```
   */
  static fromValue(value: number | string | Decimal): Result<Percentage, InvalidPercentageError> {
    // Преобразование в Decimal с обработкой ошибок
    let decimalValue: Decimal;
    try {
      if (value instanceof Decimal) {
        decimalValue = value;
      } else if (typeof value === 'string') {
        // Убираем символ % если есть
        const cleaned = value.replace('%', '').trim();
        decimalValue = new Decimal(cleaned);
      } else {
        decimalValue = new Decimal(value);
      }
    } catch (error) {
      return Err(
        new InvalidPercentageError(
          `Invalid percentage format: ${String(value)}`,
          {
            context: { value: String(value), error: String(error) }
          }
        )
      );
    }

    // Проверка NaN
    if (decimalValue.isNaN()) {
      return Err(
        new InvalidPercentageError(
          'Percentage cannot be NaN',
          {
            context: { value: String(value), reason: 'NaN' }
          }
        )
      );
    }

    // Проверка конечности
    if (!decimalValue.isFinite()) {
      return Err(
        new InvalidPercentageError(
          'Percentage must be finite',
          {
            context: { value: decimalValue.toString(), reason: 'Infinity' }
          }
        )
      );
    }

    // Проверка диапазона
    if (decimalValue.lessThan(Percentage.MIN_PERCENTAGE) || decimalValue.greaterThan(Percentage.MAX_PERCENTAGE)) {
      return Err(
        new InvalidPercentageError(
          (ctx: Record<string, unknown>) =>
            `Percentage ${ctx.value} is out of range [${ctx.min}, ${ctx.max}]`,
          {
            context: {
              value: decimalValue.toString(),
              min: Percentage.MIN_PERCENTAGE.toString(),
              max: Percentage.MAX_PERCENTAGE.toString()
            }
          }
        )
      );
    }

    return Ok(new Percentage(decimalValue));
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
              context: { bps, reason: 'not finite' }
            }
          )
        );
      }

      const percentage = bpsDecimal.dividedBy(100);
      return Percentage.fromValue(percentage);
    } catch (error) {
      return Err(
        new InvalidPercentageError(
          `Invalid basis points: ${bps}`,
          {
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
    return Percentage.ZERO;
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
    return Percentage.ONE_HUNDRED;
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
   * @returns Result с новым Percentage или ошибкой (DivisionByZeroError | ArithmeticOverflowError)
   * @throws {DivisionByZeroError} Если делитель равен нулю, не является конечным числом, или результат деления не конечен
   * @throws {ArithmeticOverflowError} Если произошла непредвиденная ошибка при выполнении деления
   *
   * @example
   * ```typescript
   * const total = unwrap(Percentage.fromNumber(20));
   * const half = total.divide(2);
   * half.match({
   *   ok: (pct) => console.log(pct.getValue()), // 10
   *   err: (error) => console.error('Division error:', error.message)
   * });
   * ```
   */
  divide(divisor: number | Decimal): Result<Percentage, DivisionByZeroError | ArithmeticOverflowError> {
    try {
      const divisorDecimal = divisor instanceof Decimal ? divisor : new Decimal(divisor);

      // Проверка что divisor является конечным числом
      if (!divisorDecimal.isFinite()) {
        return Err(
          new DivisionByZeroError(
            (ctx: Record<string, unknown>) =>
              `Invalid divisor ${ctx.divisor}: must be a finite number`,
            {
              context: {
                value: this.value.toString(),
                divisor: divisorDecimal.toString(),
                operation: 'divide percentage'
              }
            }
          )
        );
      }

      if (divisorDecimal.isZero()) {
        return Err(
          new DivisionByZeroError(
            (ctx: Record<string, unknown>) =>
              `Cannot divide percentage ${ctx.value} by zero`,
            {
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

      // Проверка что результат является конечным числом
      if (!result.isFinite()) {
        return Err(
          new DivisionByZeroError(
            (ctx: Record<string, unknown>) =>
              `Division resulted in non-finite value: ${ctx.result}`,
            {
              context: {
                value: this.value.toString(),
                divisor: divisorDecimal.toNumber(),
                result: result.toString(),
                operation: 'divide percentage'
              }
            }
          )
        );
      }

      // Проверка что результат находится в допустимом диапазоне
      if (result.greaterThan(Percentage.MAX_PERCENTAGE)) {
        return Err(
          new ArithmeticOverflowError(
            (ctx: Record<string, unknown>) =>
              `Division result ${ctx.result} exceeds MAX_PERCENTAGE (${ctx.max})`,
            {
              context: {
                value: this.value.toString(),
                divisor: divisorDecimal.toString(),
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
              `Division result ${ctx.result} below MIN_PERCENTAGE (${ctx.min})`,
            {
              context: {
                value: this.value.toString(),
                divisor: divisorDecimal.toString(),
                result: result.toString(),
                min: Percentage.MIN_PERCENTAGE.toString()
              }
            }
          )
        );
      }

      return Ok(new Percentage(result));
    } catch (error) {
      return Err(
        new ArithmeticOverflowError(
          (ctx: Record<string, unknown>) =>
            `Unexpected division error: ${ctx.error}`,
          {
            context: {
              operation: 'divide percentage',
              value: this.value.toString(),
              divisor: String(divisor),
              error: String(error)
            }
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
   * Сериализует в JSON
   *
   * @returns Объект для JSON сериализации
   *
   * @example
   * ```typescript
   * const pct = unwrap(Percentage.fromNumber(25.5));
   * const json = pct.toJSON();
   * console.log(json); // { value: 25.5 }
   * ```
   */
  public toJSON(): { value: number } {
    return { value: this.value.toNumber() };
  }

  /**
   * Создаёт Percentage из JSON объекта
   *
   * @param json - JSON объект с полем value
   * @returns Result с Percentage или InvalidPercentageError
   *
   * @example
   * ```typescript
   * const json = { value: 25.5 };
   * const result = Percentage.fromJSON(json);
   * if (result.ok) {
   *   console.log(result.value.toNumber()); // 25.5
   * }
   * ```
   */
  public static fromJSON(json: { value: number }): Result<Percentage, InvalidPercentageError> {
    return Percentage.fromValue(json.value);
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
