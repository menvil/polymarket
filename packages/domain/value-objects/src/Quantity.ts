/**
 * Value Object для количества
 *
 * @remarks
 * Представляет количество/размер акций на рынках предсказаний.
 * Иммутабельный value object с валидацией и округлением до размера тика.
 *
 * @example
 * ```typescript
 * import { unwrap } from '@polymarket/result';
 *
 * const result = Quantity.fromValue(10.5);
 * if (result.ok) {
 *   const qty = result.value;
 *   const rounded = unwrap(qty.toTick(0.1));
 *   console.log(rounded.value); // 10.5
 * }
 *
 * // Или используя unwrap
 * const qty = unwrap(Quantity.fromValue(10.5));
 * const rounded = unwrap(qty.toTick(0.1));
 * console.log(rounded.value); // 10.5
 * ```
 */
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidQuantityError, ArithmeticOverflowError, DivisionByZeroError } from '@polymarket/errors';
import Decimal from 'decimal.js';

export class Quantity {
  public readonly value: number;

  // КРИТИЧНО: По умолчанию MIN_SIZE = 1 акция (минимум Polymarket)
  // Реальный orderMinSize из информации о рынке должен переопределять это значение
  private static readonly MIN_SIZE = 1;
  private static readonly DEFAULT_TICK = 0.01;
  private static readonly EPSILON = 0.0001;

  /**
   * Нулевое количество (0 акций)
   */
  public static readonly ZERO = new Quantity(0);

  /**
   * Одна акция
   */
  public static readonly ONE = new Quantity(1);

  private constructor(value: number) {
    this.value = value;
  }

  /**
   * Создаёт нулевое количество
   *
   * @returns Quantity с нулевым значением
   */
  public static zero(): Quantity {
    return Quantity.ZERO;
  }

  /**
   * Создаёт Quantity из рыночных данных без валидации минимального размера
   *
   * @param value - Значение количества (должно быть >= 0)
   * @returns Result с Quantity или InvalidQuantityError
   *
   * @remarks
   * Используйте для входящих рыночных данных (сделки, исполнения), где биржа
   * может отправлять количества меньше нашего MIN_SIZE для ордеров.
   * Для создания ордеров используйте `fromValue()`, который проверяет MIN_SIZE.
   *
   * @example
   * ```typescript
   * import { unwrap } from '@polymarket/result';
   *
   * // Для входящей сделки с биржи
   * const result = Quantity.fromMarketData(0.07);
   * if (result.ok) {
   *   const qty = result.value;
   * }
   *
   * // Или используя unwrap
   * const qty = unwrap(Quantity.fromMarketData(0.07));
   * ```
   */
  public static fromMarketData(value: number): Result<Quantity, InvalidQuantityError> {
    if (typeof value !== 'number') {
      return Err(
        new InvalidQuantityError(
          (ctx) => `Invalid quantity ${ctx.value}: must be a number`,
          {
            context: { value }
          }
        )
      );
    }

    // Используем Decimal для проверки isFinite и >= 0
    const decimal = new Decimal(value);
    if (!decimal.isFinite()) {
      return Err(
        new InvalidQuantityError(
          (ctx) => `Invalid quantity ${ctx.value}: must be a finite number`,
          {
            context: { value }
          }
        )
      );
    }

    if (decimal.lessThan(0)) {
      return Err(
        new InvalidQuantityError(
          (ctx) => `Invalid quantity ${ctx.value}: must be >= ${ctx.min}`,
          { context: { value, min: 0 } }
        )
      );
    }

    return Ok(new Quantity(value));
  }

  /**
   * Создаёт Quantity из различных типов значений
   *
   * @param value - Значение: number, string или Decimal
   * @param minSize - Минимальный размер (по умолчанию 1 акция, используйте orderMinSize из рынка)
   * @returns Result с Quantity или InvalidQuantityError
   *
   * @remarks
   * Универсальный метод для создания Quantity.
   * Автоматически определяет тип входного значения и выполняет все необходимые проверки:
   * - Парсинг строки в число
   * - Валидация формата (конечное значение, не NaN)
   * - Проверка минимального размера (minSize)
   * - Использует Decimal.js для точных сравнений
   *
   * КРИТИЧНО: Всегда передавайте minSize из market info (orderMinSize)!
   * По умолчанию = 1 акция, но каждый маркет может иметь свой минимум.
   *
   * @throws Никогда - все ошибки возвращаются через Result
   *
   * @example
   * ```typescript
   * import { unwrap } from '@polymarket/result';
   *
   * // Из числа (по умолчанию minSize = 1)
   * const q1 = unwrap(Quantity.fromValue(100));
   *
   * // С минимальным размером из рынка
   * const q2 = unwrap(Quantity.fromValue(10, marketInfo.orderMinSize || 1));
   *
   * // Из строки
   * const q3 = unwrap(Quantity.fromValue('100.5'));
   *
   * // Из Decimal
   * const q4 = unwrap(Quantity.fromValue(new Decimal(100)));
   *
   * // Обработка ошибок
   * const result = Quantity.fromValue(0.5, 1);
   * if (!result.ok) {
   *   console.error(result.error.message); // "Invalid quantity: must be >= 1"
   * }
   * ```
   */
  public static fromValue(value: number | string | Decimal, minSize: number = Quantity.MIN_SIZE): Result<Quantity, InvalidQuantityError> {
    // Преобразование в число с обработкой ошибок
    let numValue: number;
    try {
      if (value instanceof Decimal) {
        numValue = value.toNumber();
      } else if (typeof value === 'string') {
        // Используем Decimal для парсинга
        const decimal = new Decimal(value);
        if (!decimal.isFinite()) {
          return Err(
            new InvalidQuantityError(
              (ctx) => `Invalid quantity "${ctx.value}": not a valid number`,
              { context: { value } }
            )
          );
        }
        numValue = decimal.toNumber();
      } else {
        numValue = value;
      }
    } catch (error) {
      return Err(
        new InvalidQuantityError(
          (ctx) => `Invalid quantity format: ${ctx.value}`,
          { context: { value: String(value) } }
        )
      );
    }

    // Валидация с использованием Decimal для точных сравнений
    if (!Quantity.isValid(numValue, minSize)) {
      return Err(
        new InvalidQuantityError(
          (ctx) => `Invalid quantity ${ctx.value}: must be >= ${ctx.min}`,
          {
            context: { value: numValue, min: minSize }
          }
        )
      );
    }

    return Ok(new Quantity(numValue));
  }

  /**
   * Проверяет валидность количества
   *
   * @param value - Значение для проверки
   * @param minSize - Минимальный размер
   * @returns True если валидно
   *
   * @remarks
   * Использует Decimal.js для точных сравнений с минимальным размером.
   */
  public static isValid(value: number, minSize: number = Quantity.MIN_SIZE): boolean {
    // Используем Decimal для проверки isFinite и точных сравнений
    const decimal = new Decimal(value);
    if (!decimal.isFinite()) {
      return false;
    }

    const minDecimal = new Decimal(minSize);

    // Значение должно быть >= 0 И >= minSize
    return (
      !decimal.lessThan(0) &&
      !decimal.lessThan(minDecimal)
    );
  }

  /**
   * Округляет до размера тика
   *
   * @param tickSize - Размер тика (по умолчанию 0.01)
   * @returns Result с новым Quantity округлённым до тика или InvalidQuantityError
   *
   * @remarks
   * Округляет количество до ближайшего размера тика.
   *
   * @example
   * ```typescript
   * import { unwrap } from '@polymarket/result';
   *
   * const qty = unwrap(Quantity.fromValue(10.567));
   * const result = qty.toTick(0.01);
   * if (result.ok) {
   *   console.log(result.value.value); // 10.57
   * }
   * ```
   */
  public toTick(tickSize: number = Quantity.DEFAULT_TICK): Result<Quantity, InvalidQuantityError> {
    return this.roundToTick(tickSize, Math.round);
  }

  /**
   * Округляет вниз до размера тика
   *
   * @param tickSize - Размер тика
   * @returns Result с новым Quantity округлённым вниз до тика или InvalidQuantityError
   */
  public floorToTick(tickSize: number = Quantity.DEFAULT_TICK): Result<Quantity, InvalidQuantityError> {
    return this.roundToTick(tickSize, Math.floor);
  }

  /**
   * Округляет вверх до размера тика
   *
   * @param tickSize - Размер тика
   * @returns Result с новым Quantity округлённым вверх до тика или InvalidQuantityError
   */
  public ceilToTick(tickSize: number = Quantity.DEFAULT_TICK): Result<Quantity, InvalidQuantityError> {
    return this.roundToTick(tickSize, Math.ceil);
  }

  /**
   * Внутренний метод для округления количества до размера тика
   *
   * @param tickSize - Размер тика (например, 0.1 для 10 центов)
   * @param roundFn - Функция округления (Math.round, Math.floor, Math.ceil)
   * @returns Новый Quantity округлённый до тика
   *
   * @remarks
   * Алгоритм:
   * 1. Делит this.value на tickSize (10.567 / 0.01 = 1056.7)
   * 2. Применяет roundFn (Math.round(1056.7) = 1057)
   * 3. Умножает обратно на tickSize (1057 * 0.01 = 10.57)
   * 4. Фиксирует количество знаков по tickSize
   * 5. Зажимает в минимум 0
   *
   * Использует Decimal.js для точных вычислений и избежания floating-point ошибок.
   *
   * @throws {RangeError} Если tickSize невалидный (не конечное число или <= 0)
   *
   * @example
   * // roundToTick(0.01, Math.round)
   * // 10.567 → 10.567 / 0.01 → 1056.7 → round(1056.7) → 1057 → 1057 * 0.01 → 10.57
   */
  private roundToTick(tickSize: number, roundFn: (x: number) => number): Result<Quantity, InvalidQuantityError> {
    // Используем Decimal для проверки isFinite
    const tickSizeDecimal = new Decimal(tickSize);
    if (!tickSizeDecimal.isFinite()) {
      return Err(
        new InvalidQuantityError(
          (ctx) => `Invalid tickSize ${ctx.tickSize}: must be a finite number`,
          { context: { tickSize } }
        )
      );
    }
    if (tickSizeDecimal.lessThanOrEqualTo(0)) {
      return Err(
        new InvalidQuantityError(
          (ctx) => `Invalid tickSize ${ctx.tickSize}: must be positive`,
          { context: { tickSize } }
        )
      );
    }

    // Используем Decimal для точных вычислений
    const divided = new Decimal(this.value).dividedBy(tickSize).toNumber();
    const roundedValue = roundFn(divided);
    const rounded = new Decimal(roundedValue).times(tickSize).toNumber();

    // Вычисляем количество десятичных знаков в tickSize используя Decimal
    // Это правильно обрабатывает экспоненциальную нотацию (1e-7)
    const decimals = tickSizeDecimal.decimalPlaces();

    // Фиксируем количество знаков и зажимаем в минимум 0
    return Ok(new Quantity(Math.max(0, Number(rounded.toFixed(decimals)))));
  }

  /**
   * Складывает количества
   *
   * @param other - Quantity для сложения
   * @returns Result с новым Quantity или ArithmeticOverflowError
   */
  public add(other: Quantity): Result<Quantity, ArithmeticOverflowError> {
    const result = new Decimal(this.value).plus(other.value).toNumber();
    // Используем Decimal для проверки isFinite
    const resultDecimal = new Decimal(result);
    if (!resultDecimal.isFinite()) {
      return Err(
        new ArithmeticOverflowError(
          (ctx) => `Addition overflow: ${ctx.a} + ${ctx.b} = ${ctx.result}`,
          {
            context: { a: this.value, b: other.value, result }
          }
        )
      );
    }
    return Ok(new Quantity(result));
  }

  /**
   * Вычитает количество
   *
   * @param other - Quantity для вычитания
   * @returns Result с новым Quantity или InvalidQuantityError
   */
  public subtract(other: Quantity): Result<Quantity, InvalidQuantityError> {
    const resultDecimal = new Decimal(this.value).minus(other.value);
    if (resultDecimal.lessThan(0)) {
      return Err(
        new InvalidQuantityError(
          (ctx) => `Cannot subtract: result would be negative (${ctx.result})`,
          { context: { result: resultDecimal.toString() } }
        )
      );
    }
    return Ok(new Quantity(resultDecimal.toNumber()));
  }

  /**
   * Умножает на коэффициент
   *
   * @param factor - Коэффициент умножения (должен быть неотрицательным конечным числом)
   * @returns Result с новым Quantity или InvalidQuantityError/ArithmeticOverflowError
   */
  public multiply(factor: number): Result<Quantity, InvalidQuantityError | ArithmeticOverflowError> {
    // Используем Decimal для проверки isFinite
    const factorDecimal = new Decimal(factor);
    if (!factorDecimal.isFinite()) {
      return Err(
        new InvalidQuantityError(
          (ctx) => `Invalid factor ${ctx.factor}: must be a finite number`,
          { context: { factor } }
        )
      );
    }
    if (factorDecimal.lessThan(0)) {
      return Err(
        new InvalidQuantityError(
          (ctx) => `Invalid factor ${ctx.factor}: must be non-negative`,
          { context: { factor } }
        )
      );
    }
    const result = new Decimal(this.value).times(factor).toNumber();
    const resultDecimal = new Decimal(result);
    if (!resultDecimal.isFinite()) {
      return Err(
        new ArithmeticOverflowError(
          (ctx) => `Multiplication overflow: ${ctx.a} * ${ctx.b} = ${ctx.result}`,
          { context: { a: this.value, b: factor, result } }
        )
      );
    }
    return Ok(new Quantity(result));
  }

  /**
   * Делит на коэффициент
   *
   * @param divisor - Делитель (должен быть положительным конечным числом)
   * @returns Result с новым Quantity или InvalidQuantityError/ArithmeticOverflowError/DivisionByZeroError
   */
  public divide(divisor: number): Result<Quantity, InvalidQuantityError | ArithmeticOverflowError | DivisionByZeroError> {
    // Используем Decimal для проверки isFinite
    const divisorDecimal = new Decimal(divisor);
    if (!divisorDecimal.isFinite()) {
      return Err(
        new InvalidQuantityError(
          (ctx) => `Invalid divisor ${ctx.divisor}: must be a finite number`,
          { context: { divisor } }
        )
      );
    }
    if (divisorDecimal.equals(0)) {
      return Err(
        new DivisionByZeroError(
          () => `Cannot divide by zero`,
          { context: {} }
        )
      );
    }
    if (divisorDecimal.lessThan(0)) {
      return Err(
        new InvalidQuantityError(
          (ctx) => `Invalid divisor ${ctx.divisor}: must be positive`,
          { context: { divisor } }
        )
      );
    }
    const result = new Decimal(this.value).dividedBy(divisor).toNumber();
    const resultDecimal = new Decimal(result);
    if (!resultDecimal.isFinite()) {
      return Err(
        new ArithmeticOverflowError(
          (ctx) => `Division overflow: ${ctx.a} / ${ctx.b} = ${ctx.result}`,
          { context: { a: this.value, b: divisor, result } }
        )
      );
    }
    return Ok(new Quantity(result));
  }

  /**
   * Проверяет, больше ли чем другое
   *
   * @param other - Quantity для сравнения
   * @returns True если больше
   *
   * @remarks
   * Использует Decimal.js для точного сравнения, избегая ошибок floating-point.
   */
  public isGreaterThan(other: Quantity): boolean {
    const thisDecimal = new Decimal(this.value);
    const otherDecimal = new Decimal(other.value);
    return thisDecimal.greaterThan(otherDecimal);
  }

  /**
   * Проверяет, меньше ли чем другое
   *
   * @param other - Quantity для сравнения
   * @returns True если меньше
   *
   * @remarks
   * Использует Decimal.js для точного сравнения, избегая ошибок floating-point.
   */
  public isLessThan(other: Quantity): boolean {
    const thisDecimal = new Decimal(this.value);
    const otherDecimal = new Decimal(other.value);
    return thisDecimal.lessThan(otherDecimal);
  }

  /**
   * Сериализует в JSON
   *
   * @returns Объект для JSON сериализации
   *
   * @example
   * ```typescript
   * const qty = unwrap(Quantity.fromValue(100));
   * const json = qty.toJSON();
   * console.log(json); // { value: 100 }
   * ```
   */
  public toJSON(): { value: number } {
    return { value: this.value };
  }

  /**
   * Создаёт Quantity из JSON объекта
   *
   * @param json - JSON объект с полем value и опциональным minSize
   * @returns Result с Quantity или InvalidQuantityError
   *
   * @remarks
   * Если JSON содержит поле minSize, оно будет использовано для валидации.
   * Это важно для правильной обработки данных с разных рынков,
   * где orderMinSize может отличаться.
   *
   * @example
   * ```typescript
   * import { unwrap } from '@polymarket/result';
   *
   * // Без minSize (используется дефолтное значение 1)
   * const json1 = { value: 100 };
   * const result1 = Quantity.fromJSON(json1);
   * if (result1.ok) {
   *   console.log(result1.value.value); // 100
   * }
   *
   * // С minSize из данных рынка
   * const json2 = { value: 0.5, minSize: 0.1 };
   * const result2 = Quantity.fromJSON(json2);
   * if (result2.ok) {
   *   console.log(result2.value.value); // 0.5
   * }
   * ```
   */
  public static fromJSON(json: { value: number; minSize?: number }): Result<Quantity, InvalidQuantityError> {
    return Quantity.fromValue(json.value, json.minSize);
  }

  /**
   * Проверяет равенство
   *
   * @param other - Quantity для сравнения
   * @returns True если равны (в пределах epsilon)
   *
   * @remarks
   * Использует Decimal.js для точного вычисления разницы и сравнения с epsilon.
   */
  public equals(other: Quantity): boolean {
    const diff = new Decimal(this.value).minus(other.value).abs();
    const epsilonDecimal = new Decimal(Quantity.EPSILON);
    return diff.lessThan(epsilonDecimal);
  }

  /**
   * Проверяет, равно ли нулю
   *
   * @returns True если ноль (в пределах epsilon)
   *
   * @remarks
   * Использует Decimal.js для точного сравнения с epsilon.
   */
  public isZero(): boolean {
    const valueDecimal = new Decimal(this.value).abs();
    const epsilonDecimal = new Decimal(Quantity.EPSILON);
    return valueDecimal.lessThan(epsilonDecimal);
  }

  /**
   * Проверяет, положительное ли значение
   *
   * @returns True если положительное
   *
   * @remarks
   * Использует Decimal.js для точного сравнения с нулём.
   */
  public isPositive(): boolean {
    const valueDecimal = new Decimal(this.value);
    return valueDecimal.greaterThan(0);
  }

  /**
   * Преобразует в строку
   *
   * @param decimals - Количество десятичных знаков
   * @returns Отформатированная строка
   */
  public toString(decimals: number = 2): string {
    return this.value.toFixed(decimals);
  }

  public static get minSize(): number {
    return Quantity.MIN_SIZE;
  }
}
