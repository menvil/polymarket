/**
 * Value Object для цены
 *
 * @remarks
 * Представляет цену на рынках предсказаний [0.0001, 0.9999].
 * Иммутабельный value object с валидацией и округлением.
 *
 * Диапазон расширен с [0.01, 0.99] до [0.0001, 0.9999] для:
 * - Обработки edge-case цен близких к 0 или 1
 * - Предотвращения InvalidPriceError на граничных значениях
 *
 * @example
 * ```typescript
* import { unwrap } from '@polymarket/result';
 *
 * const result = Price.fromValue(0.5234);
 * if (result.ok) {
 *   console.log(result.value.value); // 0.5234
 *   console.log(result.value.toTick(0.0001).value); // 0.5234 (rounded to tick)
 * }
 *
 * // Или используя unwrap
 * const price = unwrap(Price.fromValue(0.5234));
 * console.log(price.value); // 0.5234
 *
 * // Edge cases теперь поддерживаются:
 * const lowPrice = unwrap(Price.fromValue(0.001));
 * const highPrice = unwrap(Price.fromValue(0.999));
 * ```
 */
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidPriceError } from '@polymarket/errors';
import Decimal from 'decimal.js';

export class Price {
  public readonly value: number;

  private static readonly MIN_PRICE = 0.0001;
  private static readonly MAX_PRICE = 0.9999;
  private static readonly DEFAULT_TICK = 0.0001; // 1 базисный пункт
  private static readonly EPSILON = 0.0000001;

  /**
   * Минимально возможная цена (0.01%)
   */
  public static readonly MIN = new Price(0.0001);

  /**
   * Максимально возможная цена (99.99%)
   */
  public static readonly MAX = new Price(0.9999);

  /**
   * Цена 50% (справедливая для начального рынка)
   */
  public static readonly HALF = new Price(0.5);

  private constructor(value: number) {
    this.value = value;
  }

  /**
   * Создаёт Price из различных типов значений
   *
   * @param value - Значение: number, string или Decimal [0.0001, 0.9999]
   * @returns Result с Price или InvalidPriceError
   *
   * @remarks
   * Универсальный метод для создания Price.
   * Автоматически определяет тип входного значения и выполняет все необходимые проверки:
   * - Парсинг строки в число
   * - Валидация формата (конечное значение, не NaN)
   * - Проверка диапазона [0.0001, 0.9999]
   * - Использует Decimal.js для точных сравнений
   *
   * @throws Никогда - все ошибки возвращаются через Result
   *
   * @example
   * ```typescript
   * import { unwrap } from '@polymarket/result';
   *
   * // Из числа
   * const p1 = unwrap(Price.fromValue(0.5));
   * const p2 = unwrap(Price.fromValue(0.001)); // Edge case
   *
   * // Из строки
   * const p3 = unwrap(Price.fromValue('0.5234'));
   *
   * // Из Decimal
   * const p4 = unwrap(Price.fromValue(new Decimal('0.5234')));
   *
   * // Обработка ошибок
   * const result = Price.fromValue(1.5);
   * if (!result.ok) {
   *   console.error(result.error.message); // "Invalid price: must be in range"
   * }
   * ```
   */
  public static fromValue(value: number | string | Decimal): Result<Price, InvalidPriceError> {
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
            new InvalidPriceError(
              (ctx) => `Invalid price "${ctx.value}": not a valid number`,
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
        new InvalidPriceError(
          (ctx) => `Invalid price format: ${ctx.value}`,
          { context: { value: String(value) } }
        )
      );
    }

    // Валидация с использованием Decimal для точных сравнений
    if (!Price.isValid(numValue)) {
      return Err(
        new InvalidPriceError(
          (ctx) => `Invalid price ${ctx.value}: must be in range [${ctx.min}, ${ctx.max}]`,
          { context: { value: numValue, min: Price.MIN_PRICE, max: Price.MAX_PRICE } }
        )
      );
    }

    return Ok(new Price(numValue));
  }

  /**
   * Проверяет валидность цены
   *
   * @param value - Цена для проверки
   * @returns True если валидна
   *
   * @remarks
   * Использует Decimal.js для точных сравнений с границами диапазона.
   */
  public static isValid(value: number): boolean {
    // Используем Decimal для проверки isFinite и точных сравнений
    const decimal = new Decimal(value);
    if (!decimal.isFinite()) {
      return false;
    }

    return (
      !decimal.lessThan(Price.MIN_PRICE) &&
      !decimal.greaterThan(Price.MAX_PRICE)
    );
  }

  /**
   * Округляет до размера тика
   *
   * @param tickSize - Размер тика (по умолчанию 0.0001)
   * @returns Result с новым Price округлённым до тика или InvalidPriceError
   *
   * @remarks
   * Округляет цену до ближайшего размера тика.
   * Пример: 0.5234 с тиком 0.01 становится 0.52
   *
   * @example
   * ```typescript
   * import { unwrap } from '@polymarket/result';
   *
   * const price = unwrap(Price.fromValue(0.5234));
   * const result = price.toTick(0.01);
   * if (result.ok) {
   *   console.log(result.value.value); // 0.52
   * }
   * ```
   */
  public toTick(tickSize: number = Price.DEFAULT_TICK): Result<Price, InvalidPriceError> {
    return this.roundToTick(tickSize, Math.round);
  }

  /**
   * Округляет вниз до размера тика
   *
   * @param tickSize - Размер тика
   * @returns Result с новым Price округлённым вниз до тика или InvalidPriceError
   */
  public floorToTick(tickSize: number = Price.DEFAULT_TICK): Result<Price, InvalidPriceError> {
    return this.roundToTick(tickSize, Math.floor);
  }

  /**
   * Округляет вверх до размера тика
   *
   * @param tickSize - Размер тика
   * @returns Result с новым Price округлённым вверх до тика или InvalidPriceError
   */
  public ceilToTick(tickSize: number = Price.DEFAULT_TICK): Result<Price, InvalidPriceError> {
    return this.roundToTick(tickSize, Math.ceil);
  }

  /**
   * Внутренний метод для округления цены до размера тика
   *
   * @param tickSize - Размер тика (например, 0.01 для центов)
   * @param roundFn - Функция округления (Math.round, Math.floor, Math.ceil)
   * @returns Result с новым Price округлённым до тика или InvalidPriceError
   *
   * @remarks
   * Алгоритм:
   * 1. Делит this.value на tickSize (0.5234 / 0.01 = 52.34)
   * 2. Применяет roundFn (Math.round(52.34) = 52)
   * 3. Умножает обратно на tickSize (52 * 0.01 = 0.52)
   * 4. Фиксирует количество знаков по tickSize
   * 5. Зажимает в диапазон [MIN_PRICE, MAX_PRICE]
   *
   * Использует Decimal.js для точных вычислений и избежания floating-point ошибок.
   *
   * @example
   * // roundToTick(0.01, Math.round)
   * // 0.5234 → 0.5234 / 0.01 → 52.34 → round(52.34) → 52 → 52 * 0.01 → 0.52
   */
  private roundToTick(tickSize: number, roundFn: (x: number) => number): Result<Price, InvalidPriceError> {
    // Используем Decimal для проверки isFinite
    const tickSizeDecimal = new Decimal(tickSize);
    if (!tickSizeDecimal.isFinite()) {
      return Err(
        new InvalidPriceError(
          (ctx) => `Invalid tickSize ${ctx.tickSize}: must be a finite number`,
          { context: { tickSize } }
        )
      );
    }
    if (tickSizeDecimal.lessThanOrEqualTo(0)) {
      return Err(
        new InvalidPriceError(
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

    // Фиксируем количество знаков и зажимаем в допустимый диапазон
    const fixed = Number(rounded.toFixed(decimals));
    return Price.fromValue(Math.max(Price.MIN_PRICE, Math.min(Price.MAX_PRICE, fixed)));
  }

  /**
   * Прибавляет к цене
   *
   * @param amount - Сумма для прибавления (должна быть >= 0 и конечным числом)
   * @returns Result с новым Price (зажатый в MAX_PRICE) или InvalidPriceError
   *
   * @example
   * ```typescript
   * import { unwrap } from '@polymarket/result';
   *
   * const price = unwrap(Price.fromValue(0.5));
   * const result = price.add(0.1);
   * if (result.ok) {
   *   console.log(result.value.value); // 0.6
   * }
   * ```
   */
  public add(amount: number): Result<Price, InvalidPriceError> {
    // Используем Decimal для проверки isFinite
    const amountDecimal = new Decimal(amount);
    if (!amountDecimal.isFinite()) {
      return Err(
        new InvalidPriceError(
          (ctx) => `Invalid amount ${ctx.amount}: must be a finite number`,
          { context: { amount } }
        )
      );
    }
    if (amountDecimal.lessThan(0)) {
      return Err(
        new InvalidPriceError(
          (ctx) => `Invalid amount ${ctx.amount}: must be non-negative`,
          { context: { amount } }
        )
      );
    }
    const result = new Decimal(this.value).plus(amount).toNumber();
    return Price.fromValue(Math.min(Price.MAX_PRICE, result));
  }

  /**
   * Вычитает из цены
   *
   * @param amount - Сумма для вычитания (должна быть >= 0 и конечным числом)
   * @returns Result с новым Price (зажатый в MIN_PRICE) или InvalidPriceError
   *
   * @example
   * ```typescript
   * import { unwrap } from '@polymarket/result';
   *
   * const price = unwrap(Price.fromValue(0.5));
   * const result = price.subtract(0.1);
   * if (result.ok) {
   *   console.log(result.value.value); // 0.4
   * }
   * ```
   */
  public subtract(amount: number): Result<Price, InvalidPriceError> {
    // Используем Decimal для проверки isFinite
    const amountDecimal = new Decimal(amount);
    if (!amountDecimal.isFinite()) {
      return Err(
        new InvalidPriceError(
          (ctx) => `Invalid amount ${ctx.amount}: must be a finite number`,
          { context: { amount } }
        )
      );
    }
    if (amountDecimal.lessThan(0)) {
      return Err(
        new InvalidPriceError(
          (ctx) => `Invalid amount ${ctx.amount}: must be non-negative`,
          { context: { amount } }
        )
      );
    }
    const result = new Decimal(this.value).minus(amount).toNumber();
    return Price.fromValue(Math.max(Price.MIN_PRICE, result));
  }

  /**
   * Умножает цену на коэффициент
   *
   * @param factor - Коэффициент умножения (должен быть >= 0 и конечным числом)
   * @returns Result с новым Price (зажатый в [MIN_PRICE, MAX_PRICE]) или InvalidPriceError
   *
   * @example
   * ```typescript
   * import { unwrap } from '@polymarket/result';
   *
   * const price = unwrap(Price.fromValue(0.5));
   * const result = price.multiply(2);
   * if (result.ok) {
   *   console.log(result.value.value); // 0.9999 (clamped to MAX)
   * }
   * ```
   */
  public multiply(factor: number): Result<Price, InvalidPriceError> {
    // Используем Decimal для проверки isFinite
    const factorDecimal = new Decimal(factor);
    if (!factorDecimal.isFinite()) {
      return Err(
        new InvalidPriceError(
          (ctx) => `Invalid factor ${ctx.factor}: must be a finite number`,
          { context: { factor } }
        )
      );
    }
    if (factorDecimal.lessThan(0)) {
      return Err(
        new InvalidPriceError(
          (ctx) => `Invalid factor ${ctx.factor}: must be non-negative`,
          { context: { factor } }
        )
      );
    }
    const result = new Decimal(this.value).times(factor).toNumber();
    return Price.fromValue(Math.max(Price.MIN_PRICE, Math.min(Price.MAX_PRICE, result)));
  }

  /**
   * Проверяет, больше ли цена чем другая
   *
   * @param other - Цена для сравнения
   * @returns True если больше
   *
   * @remarks
   * Использует Decimal.js для точного сравнения, избегая ошибок floating-point.
   */
  public isGreaterThan(other: Price): boolean {
    const thisDecimal = new Decimal(this.value);
    const otherDecimal = new Decimal(other.value);
    return thisDecimal.greaterThan(otherDecimal);
  }

  /**
   * Проверяет, меньше ли цена чем другая
   *
   * @param other - Цена для сравнения
   * @returns True если меньше
   *
   * @remarks
   * Использует Decimal.js для точного сравнения, избегая ошибок floating-point.
   */
  public isLessThan(other: Price): boolean {
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
   * const price = unwrap(Price.fromValue(0.65));
   * const json = price.toJSON();
   * console.log(json); // { value: 0.65 }
   * ```
   */
  public toJSON(): { value: number } {
    return { value: this.value };
  }

  /**
   * Создаёт Price из JSON объекта
   *
   * @param json - JSON объект с полем value
   * @returns Result с Price или InvalidPriceError
   *
   * @example
   * ```typescript
   * const json = { value: 0.65 };
   * const result = Price.fromJSON(json);
   * if (result.ok) {
   *   console.log(result.value.value); // 0.65
   * }
   * ```
   */
  public static fromJSON(json: { value: number }): Result<Price, InvalidPriceError> {
    return Price.fromValue(json.value);
  }

  /**
   * Проверяет равенство цен
   *
   * @param other - Цена для сравнения
   * @returns True если равны (в пределах epsilon)
   *
   * @remarks
   * Использует Decimal.js для точного вычисления разницы и сравнения с epsilon.
   */
  public equals(other: Price): boolean {
    const diff = new Decimal(this.value).minus(other.value).abs();
    const epsilonDecimal = new Decimal(Price.EPSILON);
    return diff.lessThan(epsilonDecimal);
  }

  /**
   * Преобразует в строку
   *
   * @param decimals - Количество десятичных знаков
   * @returns Отформатированная строка
   */
  public toString(decimals: number = 4): string {
    return this.value.toFixed(decimals);
  }

  /**
   * Преобразует в процентную строку
   *
   * @returns Процентная строка (например, "52.34%")
   */
  public toPercentage(): string {
    const percentage = new Decimal(this.value).times(100).toNumber();
    return `${percentage.toFixed(2)}%`;
  }

  public static get minPrice(): number {
    return Price.MIN_PRICE;
  }

  public static get maxPrice(): number {
    return Price.MAX_PRICE;
  }
}
