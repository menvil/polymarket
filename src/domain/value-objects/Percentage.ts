/**
 * Value Object для процента
 *
 * @remarks
 * Представляет процентное значение в диапазоне [0, 100].
 * Иммутабельный value object с валидацией, арифметическими операциями и форматированием.
 * Используется для представления прибыли, убытков, комиссий и других процентных метрик.
 *
 * Алгоритм:
 * 1. Проверяет, что значение конечное и в диапазоне [0, 100]
 * 2. Хранит значение как десятичный процент (например, 50 для 50%)
 * 3. Предоставляет конвертацию в/из десятичной дроби (0.5 для 50%) и базисных пунктов
 * 4. Все арифметические операции возвращают новые экземпляры Percentage (иммутабельность)
 * 5. Поддерживает операции сравнения с epsilon для равенства чисел с плавающей точкой
 *
 * @example
 * ```typescript
 * const fee = Percentage.fromNumber(2.5); // 2.5%
 * const gain = Percentage.fromDecimal(0.15); // 15%
 * const total = fee.add(gain); // 17.5%
 * console.log(total.toDecimal()); // 0.175
 * console.log(total.toString()); // "17.50%"
 * ```
 */
import { TradingError } from '../../shared/errors/TradingError.js';

/**
 * Ошибка невалидного процента
 *
 * @remarks
 * Выбрасывается когда процентное значение вне допустимого диапазона [0, 100] или не является конечным числом.
 */
export class InvalidPercentageError extends TradingError {
  constructor(public readonly percentage: number) {
    super(
      `Invalid percentage: ${percentage}. Must be between 0 and 100`,
      'INVALID_PERCENTAGE'
    );
  }
}

export class Percentage {
  public readonly value: number;

  private static readonly MIN_PERCENTAGE = 0;
  private static readonly MAX_PERCENTAGE = 100;
  private static readonly EPSILON = 0.0001;

  private constructor(value: number) {
    this.value = value;
  }

  /**
   * Создаёт Percentage из числа (шкала 0-100)
   *
   * @param value - Процентное значение [0, 100]
   * @returns Экземпляр Percentage
   * @throws {InvalidPercentageError} Если процент вне диапазона или не конечный
   *
   * @example
   * ```typescript
   * const pct = Percentage.fromNumber(25.5); // 25.5%
   * ```
   */
  public static fromNumber(value: number): Percentage {
    if (!Percentage.isValid(value)) {
      throw new InvalidPercentageError(value);
    }
    return new Percentage(value);
  }

  /**
   * Создаёт Percentage из десятичной дроби (шкала 0-1)
   *
   * @param decimal - Десятичное значение [0, 1]
   * @returns Экземпляр Percentage
   * @throws {InvalidPercentageError} Если десятичное значение вне диапазона
   *
   * @remarks
   * Преобразует десятичное представление в процент.
   * Пример: 0.5 становится 50%, 0.025 становится 2.5%
   *
   * @example
   * ```typescript
   * const pct = Percentage.fromDecimal(0.5); // 50%
   * const fee = Percentage.fromDecimal(0.025); // 2.5%
   * ```
   */
  public static fromDecimal(decimal: number): Percentage {
    const percentage = decimal * 100;
    if (!Percentage.isValid(percentage)) {
      throw new InvalidPercentageError(percentage);
    }
    return new Percentage(percentage);
  }

  /**
   * Создаёт Percentage из базисных пунктов
   *
   * @param bps - Базисные пункты (1 bp = 0.01%)
   * @returns Экземпляр Percentage
   * @throws {InvalidPercentageError} Если результирующий процент вне диапазона
   *
   * @remarks
   * Преобразует базисные пункты в процент.
   * Пример: 100 bps = 1%, 250 bps = 2.5%
   *
   * @example
   * ```typescript
   * const pct = Percentage.fromBasisPoints(250); // 2.5%
   * ```
   */
  public static fromBasisPoints(bps: number): Percentage {
    const percentage = bps / 100;
    if (!Percentage.isValid(percentage)) {
      throw new InvalidPercentageError(percentage);
    }
    return new Percentage(percentage);
  }

  /**
   * Создаёт Percentage из строки
   *
   * @param value - Процент в виде строки (с символом '%' или без)
   * @returns Экземпляр Percentage
   * @throws {InvalidPercentageError} Если строка невалидна
   *
   * @example
   * ```typescript
   * const pct1 = Percentage.fromString("25.5"); // 25.5%
   * const pct2 = Percentage.fromString("25.5%"); // 25.5%
   * ```
   */
  public static fromString(value: string): Percentage {
    const cleaned = value.replace('%', '').trim();
    const numValue = parseFloat(cleaned);
    if (isNaN(numValue)) {
      throw new InvalidPercentageError(NaN);
    }
    return Percentage.fromNumber(numValue);
  }

  /**
   * Создаёт нулевой процент
   *
   * @returns Percentage со значением 0%
   *
   * @example
   * ```typescript
   * const zero = Percentage.zero();
   * console.log(zero.value); // 0
   * ```
   */
  public static zero(): Percentage {
    return new Percentage(0);
  }

  /**
   * Создаёт 100% процент
   *
   * @returns Percentage со значением 100%
   *
   * @example
   * ```typescript
   * const max = Percentage.oneHundred();
   * console.log(max.value); // 100
   * ```
   */
  public static oneHundred(): Percentage {
    return new Percentage(100);
  }

  /**
   * Проверяет валидность процентного значения
   *
   * @param value - Значение для проверки
   * @returns True если валидно
   *
   * @remarks
   * Валидный процент должен быть:
   * - Конечным числом
   * - Между 0 и 100 (включительно)
   */
  public static isValid(value: number): boolean {
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= Percentage.MIN_PERCENTAGE &&
      value <= Percentage.MAX_PERCENTAGE
    );
  }

  /**
   * Преобразует в десятичную дробь (шкала 0-1)
   *
   * @returns Десятичное представление
   *
   * @remarks
   * Преобразует процент в десятичную дробь для вычислений.
   * Пример: 50% становится 0.5, 2.5% становится 0.025
   *
   * @example
   * ```typescript
   * const pct = Percentage.fromNumber(50);
   * console.log(pct.toDecimal()); // 0.5
   * ```
   */
  public toDecimal(): number {
    return this.value / 100;
  }

  /**
   * Преобразует в базисные пункты
   *
   * @returns Базисные пункты (1 bp = 0.01%)
   *
   * @remarks
   * Преобразует процент в базисные пункты.
   * Пример: 2.5% становится 250 bps, 1% становится 100 bps
   *
   * @example
   * ```typescript
   * const pct = Percentage.fromNumber(2.5);
   * console.log(pct.toBasisPoints()); // 250
   * ```
   */
  public toBasisPoints(): number {
    return this.value * 100;
  }

  /**
   * Складывает проценты
   *
   * @param other - Процент для сложения
   * @returns Новый Percentage ограниченный диапазоном [0, 100]
   *
   * @remarks
   * Складывает два процента, ограничивая результат максимумом 100%
   *
   * @example
   * ```typescript
   * const fee = Percentage.fromNumber(2.5);
   * const gain = Percentage.fromNumber(15);
   * const total = fee.add(gain); // 17.5%
   * ```
   */
  public add(other: Percentage): Percentage {
    return new Percentage(
      Math.min(Percentage.MAX_PERCENTAGE, this.value + other.value)
    );
  }

  /**
   * Вычитает процент
   *
   * @param other - Процент для вычитания
   * @returns Новый Percentage ограниченный диапазоном [0, 100]
   *
   * @remarks
   * Вычитает процент, ограничивая результат минимумом 0%
   *
   * @example
   * ```typescript
   * const total = Percentage.fromNumber(17.5);
   * const fee = Percentage.fromNumber(2.5);
   * const net = total.subtract(fee); // 15%
   * ```
   */
  public subtract(other: Percentage): Percentage {
    return new Percentage(
      Math.max(Percentage.MIN_PERCENTAGE, this.value - other.value)
    );
  }

  /**
   * Умножает на коэффициент
   *
   * @param factor - Коэффициент умножения
   * @returns Новый Percentage ограниченный диапазоном [0, 100]
   *
   * @remarks
   * Умножает процент на коэффициент, ограничивая до допустимого диапазона
   *
   * @example
   * ```typescript
   * const base = Percentage.fromNumber(10);
   * const doubled = base.multiply(2); // 20%
   * ```
   */
  public multiply(factor: number): Percentage {
    const result = this.value * factor;
    return new Percentage(
      Math.max(
        Percentage.MIN_PERCENTAGE,
        Math.min(Percentage.MAX_PERCENTAGE, result)
      )
    );
  }

  /**
   * Делит на коэффициент
   *
   * @param divisor - Делитель
   * @returns Новый Percentage
   * @throws {Error} Если делитель равен нулю
   *
   * @remarks
   * Делит процент на коэффициент
   *
   * @example
   * ```typescript
   * const total = Percentage.fromNumber(20);
   * const half = total.divide(2); // 10%
   * ```
   */
  public divide(divisor: number): Percentage {
    if (divisor === 0) {
      throw new Error('Cannot divide by zero');
    }
    return new Percentage(this.value / divisor);
  }

  /**
   * Применяет процент к значению
   *
   * @param value - Базовое значение
   * @returns Вычисленная сумма (value * percentage)
   *
   * @remarks
   * Вычисляет процентную долю от значения.
   * Пример: 10% от 1000 = 100
   *
   * @example
   * ```typescript
   * const fee = Percentage.fromNumber(2.5);
   * const orderValue = 1000;
   * const feeAmount = fee.of(orderValue); // 25
   * ```
   */
  public of(value: number): number {
    return value * this.toDecimal();
  }

  /**
   * Проверяет, больше ли чем другой
   *
   * @param other - Процент для сравнения
   * @returns True если больше
   *
   * @example
   * ```typescript
   * const a = Percentage.fromNumber(15);
   * const b = Percentage.fromNumber(10);
   * console.log(a.isGreaterThan(b)); // true
   * ```
   */
  public isGreaterThan(other: Percentage): boolean {
    return this.value > other.value;
  }

  /**
   * Проверяет, меньше ли чем другой
   *
   * @param other - Процент для сравнения
   * @returns True если меньше
   *
   * @example
   * ```typescript
   * const a = Percentage.fromNumber(10);
   * const b = Percentage.fromNumber(15);
   * console.log(a.isLessThan(b)); // true
   * ```
   */
  public isLessThan(other: Percentage): boolean {
    return this.value < other.value;
  }

  /**
   * Проверяет равенство процентов
   *
   * @param other - Процент для сравнения
   * @returns True если равны (в пределах epsilon)
   *
   * @remarks
   * Использует сравнение с epsilon для равенства чисел с плавающей точкой
   *
   * @example
   * ```typescript
   * const a = Percentage.fromNumber(10.0001);
   * const b = Percentage.fromNumber(10.0000);
   * console.log(a.equals(b)); // true (в пределах epsilon)
   * ```
   */
  public equals(other: Percentage): boolean {
    return Math.abs(this.value - other.value) < Percentage.EPSILON;
  }

  /**
   * Проверяет, равно ли нулю
   *
   * @returns True если ноль
   *
   * @example
   * ```typescript
   * const zero = Percentage.zero();
   * console.log(zero.isZero()); // true
   * ```
   */
  public isZero(): boolean {
    return Math.abs(this.value) < Percentage.EPSILON;
  }

  /**
   * Проверяет, положительное ли значение
   *
   * @returns True если положительное (> 0)
   *
   * @example
   * ```typescript
   * const pct = Percentage.fromNumber(5);
   * console.log(pct.isPositive()); // true
   * ```
   */
  public isPositive(): boolean {
    return this.value > Percentage.EPSILON;
  }

  /**
   * Преобразует в строку с символом процента
   *
   * @param decimals - Количество десятичных знаков (по умолчанию 2)
   * @returns Отформатированная строка (например, "25.50%")
   *
   * @example
   * ```typescript
   * const pct = Percentage.fromNumber(25.5);
   * console.log(pct.toString()); // "25.50%"
   * console.log(pct.toString(1)); // "25.5%"
   * ```
   */
  public toString(decimals: number = 2): string {
    return `${this.value.toFixed(decimals)}%`;
  }

  /**
   * Преобразует в простую числовую строку
   *
   * @param decimals - Количество десятичных знаков (по умолчанию 2)
   * @returns Отформатированная числовая строка (например, "25.50")
   *
   * @example
   * ```typescript
   * const pct = Percentage.fromNumber(25.5);
   * console.log(pct.toNumber()); // "25.50"
   * ```
   */
  public toNumber(decimals: number = 2): string {
    return this.value.toFixed(decimals);
  }

  public static get minPercentage(): number {
    return Percentage.MIN_PERCENTAGE;
  }

  public static get maxPercentage(): number {
    return Percentage.MAX_PERCENTAGE;
  }
}