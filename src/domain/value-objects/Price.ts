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
 * const price = Price.fromNumber(0.5234);
 * console.log(price.value); // 0.5234
 * console.log(price.toTick(0.0001)); // 0.5234 (округлено до тика)
 *
 * // Edge cases теперь поддерживаются:
 * const lowPrice = Price.fromNumber(0.001);
 * const highPrice = Price.fromNumber(0.999);
 * ```
 */
import { InvalidPriceError } from '../../shared/errors/TradingError.js';

export class Price {
  public readonly value: number;

  private static readonly MIN_PRICE = 0.0001;
  private static readonly MAX_PRICE = 0.9999;
  private static readonly DEFAULT_TICK = 0.0001; // 1 базисный пункт
  private static readonly EPSILON = 0.0000001;

  private constructor(value: number) {
    this.value = value;
  }

  /**
   * Создаёт Price из числа
   *
   * @param value - Значение цены [0.0001, 0.9999]
   * @returns Экземпляр Price
   * @throws {InvalidPriceError} Если цена вне диапазона
   *
   * @example
   * ```typescript
   * const price = Price.fromNumber(0.5);
   * const edgePrice = Price.fromNumber(0.001); // Edge case поддерживается
   * ```
   */
  public static fromNumber(value: number): Price {
    if (!Price.isValid(value)) {
      throw new InvalidPriceError(value, Price.MIN_PRICE, Price.MAX_PRICE);
    }
    return new Price(value);
  }

  /**
   * Создаёт Price из строки
   *
   * @param value - Цена в виде строки
   * @returns Экземпляр Price
   * @throws {InvalidPriceError} Если цена невалидна
   */
  public static fromString(value: string): Price {
    const numValue = parseFloat(value);
    if (isNaN(numValue)) {
      throw new InvalidPriceError(numValue, Price.MIN_PRICE, Price.MAX_PRICE);
    }
    return Price.fromNumber(numValue);
  }

  /**
   * Проверяет валидность цены
   *
   * @param value - Цена для проверки
   * @returns True если валидна
   */
  public static isValid(value: number): boolean {
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= Price.MIN_PRICE &&
      value <= Price.MAX_PRICE
    );
  }

  /**
   * Округляет до размера тика
   *
   * @param tickSize - Размер тика (по умолчанию 0.0001)
   * @returns Новый Price округлённый до тика
   *
   * @remarks
   * Округляет цену до ближайшего размера тика.
   * Пример: 0.5234 с тиком 0.01 становится 0.52
   *
   * @example
   * ```typescript
   * const price = Price.fromNumber(0.5234);
   * const rounded = price.toTick(0.01);
   * console.log(rounded.value); // 0.52
   * ```
   */
  public toTick(tickSize: number = Price.DEFAULT_TICK): Price {
    return this.roundToTick(tickSize, Math.round);
  }

  /**
   * Округляет вниз до размера тика
   *
   * @param tickSize - Размер тика
   * @returns Новый Price округлённый вниз до тика
   */
  public floorToTick(tickSize: number = Price.DEFAULT_TICK): Price {
    return this.roundToTick(tickSize, Math.floor);
  }

  /**
   * Округляет вверх до размера тика
   *
   * @param tickSize - Размер тика
   * @returns Новый Price округлённый вверх до тика
   */
  public ceilToTick(tickSize: number = Price.DEFAULT_TICK): Price {
    return this.roundToTick(tickSize, Math.ceil);
  }

  private roundToTick(tickSize: number, roundFn: (x: number) => number): Price {
    const rounded = roundFn(this.value / tickSize) * tickSize;
    const decimals = this.getDecimalPlaces(tickSize);
    const fixed = Number(rounded.toFixed(decimals));
    return Price.fromNumber(
      Math.max(Price.MIN_PRICE, Math.min(Price.MAX_PRICE, fixed))
    );
  }

  /**
   * Прибавляет к цене
   *
   * @param amount - Сумма для прибавления
   * @returns Новый Price
   */
  public add(amount: number): Price {
    return Price.fromNumber(
      Math.min(Price.MAX_PRICE, this.value + amount)
    );
  }

  /**
   * Вычитает из цены
   *
   * @param amount - Сумма для вычитания
   * @returns Новый Price
   */
  public subtract(amount: number): Price {
    return Price.fromNumber(
      Math.max(Price.MIN_PRICE, this.value - amount)
    );
  }

  /**
   * Умножает цену на коэффициент
   *
   * @param factor - Коэффициент умножения
   * @returns Новый Price
   */
  public multiply(factor: number): Price {
    return Price.fromNumber(
      Math.max(Price.MIN_PRICE, Math.min(Price.MAX_PRICE, this.value * factor))
    );
  }

  /**
   * Проверяет, больше ли цена чем другая
   *
   * @param other - Цена для сравнения
   * @returns True если больше
   */
  public isGreaterThan(other: Price): boolean {
    return this.value > other.value;
  }

  /**
   * Проверяет, меньше ли цена чем другая
   *
   * @param other - Цена для сравнения
   * @returns True если меньше
   */
  public isLessThan(other: Price): boolean {
    return this.value < other.value;
  }

  /**
   * Проверяет равенство цен
   *
   * @param other - Цена для сравнения
   * @returns True если равны (в пределах epsilon)
   */
  public equals(other: Price): boolean {
    return Math.abs(this.value - other.value) < Price.EPSILON;
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
    return `${(this.value * 100).toFixed(2)}%`;
  }

  private getDecimalPlaces(tickSize: number): number {
    if (!Number.isFinite(tickSize) || tickSize === 0) {
      return 0;
    }
    let decimals = 0;
    let value = Math.abs(tickSize);
    const maxDecimals = 15; // IEEE 754 precision limit
    while (decimals < maxDecimals && Math.abs(value - Math.round(value)) > 1e-10) {
      value *= 10;
      decimals++;
    }
    return decimals;
  }

  public static get minPrice(): number {
    return Price.MIN_PRICE;
  }

  public static get maxPrice(): number {
    return Price.MAX_PRICE;
  }
}