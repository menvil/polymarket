/**
 * Value Object для количества
 *
 * @remarks
 * Представляет количество/размер акций на рынках предсказаний.
 * Иммутабельный value object с валидацией и округлением до размера тика.
 *
 * @example
 * ```typescript
 * const qty = Quantity.fromNumber(10.5);
 * const rounded = qty.toTick(0.1);
 * console.log(rounded.value); // 10.5
 * ```
 */
import { InvalidQuantityError } from '../../shared/errors/index.js';

export class Quantity {
  public readonly value: number;

  // КРИТИЧНО: По умолчанию MIN_SIZE = 1 акция (минимум Polymarket)
  // Реальный orderMinSize из информации о рынке должен переопределять это значение
  private static readonly MIN_SIZE = 1;
  private static readonly DEFAULT_TICK = 0.01;
  private static readonly EPSILON = 0.0001;

  private constructor(value: number) {
    this.value = value;
  }

  /**
   * Создаёт Quantity из числа
   *
   * @param value - Значение количества (должно быть >= minSize)
   * @param minSize - Минимальный размер (по умолчанию 1 акция, используйте orderMinSize из рынка)
   * @returns Экземпляр Quantity
   * @throws {InvalidQuantityError} Если количество невалидно
   *
   * @remarks
   * КРИТИЧНО: Всегда передавайте minSize из market info (orderMinSize)!
   * По умолчанию = 1 акция, но каждый маркет может иметь свой минимум.
   *
   * @example
   * ```typescript
   * // По умолчанию (1 акция)
   * const qty = Quantity.fromNumber(10);
   *
   * // С минимальным размером из рынка
   * const qty = Quantity.fromNumber(10, marketInfo.orderMinSize || 1);
   * ```
   */
  public static fromNumber(value: number, minSize: number = Quantity.MIN_SIZE): Quantity {
    if (!Quantity.isValid(value, minSize)) {
      throw new InvalidQuantityError(value, minSize);
    }
    return new Quantity(value);
  }

  /**
   * Создаёт нулевое количество
   *
   * @returns Quantity с нулевым значением
   */
  public static zero(): Quantity {
    return new Quantity(0);
  }

  /**
   * Создаёт Quantity из рыночных данных без валидации минимального размера
   *
   * @param value - Значение количества (должно быть >= 0)
   * @returns Экземпляр Quantity
   *
   * @remarks
   * Используйте для входящих рыночных данных (сделки, исполнения), где биржа
   * может отправлять количества меньше нашего MIN_SIZE для ордеров.
   * Для создания ордеров используйте `fromNumber()`, который проверяет MIN_SIZE.
   *
   * @example
   * ```typescript
   * // Для входящей сделки с биржи
   * const qty = Quantity.fromMarketData(0.07);
   * ```
   */
  public static fromMarketData(value: number): Quantity {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new InvalidQuantityError(value, 0);
    }
    return new Quantity(value);
  }

  /**
   * Проверяет валидность количества
   *
   * @param value - Значение для проверки
   * @param minSize - Минимальный размер
   * @returns True если валидно
   */
  public static isValid(value: number, minSize: number = Quantity.MIN_SIZE): boolean {
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      (value === 0 || value >= minSize)
    );
  }

  /**
   * Округляет до размера тика
   *
   * @param tickSize - Размер тика (по умолчанию 0.01)
   * @returns Новый Quantity округлённый до тика
   *
   * @remarks
   * Округляет количество до ближайшего размера тика.
   *
   * @example
   * ```typescript
   * const qty = Quantity.fromNumber(10.567);
   * const rounded = qty.toTick(0.01);
   * console.log(rounded.value); // 10.57
   * ```
   */
  public toTick(tickSize: number = Quantity.DEFAULT_TICK): Quantity {
    return this.roundToTick(tickSize, Math.round);
  }

  /**
   * Округляет вниз до размера тика
   *
   * @param tickSize - Размер тика
   * @returns Новый Quantity округлённый вниз до тика
   */
  public floorToTick(tickSize: number = Quantity.DEFAULT_TICK): Quantity {
    return this.roundToTick(tickSize, Math.floor);
  }

  /**
   * Округляет вверх до размера тика
   *
   * @param tickSize - Размер тика
   * @returns Новый Quantity округлённый вверх до тика
   */
  public ceilToTick(tickSize: number = Quantity.DEFAULT_TICK): Quantity {
    return this.roundToTick(tickSize, Math.ceil);
  }

  private roundToTick(tickSize: number, roundFn: (x: number) => number): Quantity {
    const rounded = roundFn(this.value / tickSize) * tickSize;
    const decimals = this.getDecimalPlaces(tickSize);
    return new Quantity(Math.max(0, Number(rounded.toFixed(decimals))));
  }

  /**
   * Складывает количества
   *
   * @param other - Quantity для сложения
   * @returns Новый Quantity
   */
  public add(other: Quantity): Quantity {
    return new Quantity(this.value + other.value);
  }

  /**
   * Вычитает количество
   *
   * @param other - Quantity для вычитания
   * @returns Новый Quantity
   * @throws {Error} Если результат будет отрицательным
   */
  public subtract(other: Quantity): Quantity {
    const result = this.value - other.value;
    if (result < 0) {
      throw new Error(`Cannot subtract: result would be negative (${result})`);
    }
    return new Quantity(result);
  }

  /**
   * Умножает на коэффициент
   *
   * @param factor - Коэффициент умножения
   * @returns Новый Quantity
   */
  public multiply(factor: number): Quantity {
    return new Quantity(Math.max(0, this.value * factor));
  }

  /**
   * Делит на коэффициент
   *
   * @param divisor - Делитель (должен быть положительным)
   * @returns Новый Quantity
   * @throws {Error} Если делитель <= 0
   */
  public divide(divisor: number): Quantity {
    if (divisor <= 0) {
      throw new Error(`Divisor must be positive: ${divisor}`);
    }
    return new Quantity(this.value / divisor);
  }

  /**
   * Проверяет, больше ли чем другое
   *
   * @param other - Quantity для сравнения
   * @returns True если больше
   */
  public isGreaterThan(other: Quantity): boolean {
    return this.value > other.value;
  }

  /**
   * Проверяет, меньше ли чем другое
   *
   * @param other - Quantity для сравнения
   * @returns True если меньше
   */
  public isLessThan(other: Quantity): boolean {
    return this.value < other.value;
  }

  /**
   * Проверяет равенство
   *
   * @param other - Quantity для сравнения
   * @returns True если равны (в пределах epsilon)
   */
  public equals(other: Quantity): boolean {
    return Math.abs(this.value - other.value) < Quantity.EPSILON;
  }

  /**
   * Проверяет, равно ли нулю
   *
   * @returns True если ноль (в пределах epsilon)
   */
  public isZero(): boolean {
    return Math.abs(this.value) < Quantity.EPSILON;
  }

  /**
   * Проверяет, положительное ли значение
   *
   * @returns True если положительное
   */
  public isPositive(): boolean {
    return this.value > 0;
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

  private getDecimalPlaces(tickSize: number): number {
    if (!Number.isFinite(tickSize) || tickSize === 0) {
      return 0;
    }
    let decimals = 0;
    let value = Math.abs(tickSize);
    const maxDecimals = 15;
    while (decimals < maxDecimals && Math.abs(value - Math.round(value)) > 1e-10) {
      value *= 10;
      decimals++;
    }
    return decimals;
  }

  public static get minSize(): number {
    return Quantity.MIN_SIZE;
  }
}