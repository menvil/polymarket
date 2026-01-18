/**
 * Value Object для денежной суммы
 *
 * @remarks
 * Представляет денежную сумму с валютой.
 * Иммутабельный value object для финансовых вычислений.
 *
 * Алгоритм:
 * - Хранит сумму как число с фиксированной точностью
 * - Предоставляет арифметические операции (сложение, вычитание, умножение, деление)
 * - Проверяет, что сумма неотрицательна
 * - Обеспечивает точность при вычислениях
 *
 * @example
 * ```typescript
 * const money = Money.fromUSDC(100.50);
 * const doubled = money.multiply(2);
 * console.log(doubled.amount); // 201.00
 * ```
 */
export class Money {
  public readonly amount: number;
  public readonly currency: string;

  private static readonly EPSILON = 0.000001;

  private constructor(amount: number, currency: string) {
    this.amount = Number(amount.toFixed(6)); // 6 знаков после запятой
    this.currency = currency;
  }

  /**
   * Создаёт Money из суммы в USDC
   *
   * @param amount - Сумма в USDC (должна быть неотрицательной)
   * @returns Экземпляр Money
   * @throws {Error} Если сумма отрицательная
   *
   * @example
   * ```typescript
   * const money = Money.fromUSDC(100);
   * ```
   */
  public static fromUSDC(amount: number): Money {
    if (amount < 0) {
      throw new Error(`Amount cannot be negative: ${amount}`);
    }
    return new Money(amount, 'USDC');
  }

  /**
   * Создаёт Money из суммы в USDC со знаком (может быть отрицательной)
   *
   * @param amount - Сумма в USDC (может быть отрицательной для PnL)
   * @returns Экземпляр Money
   *
   * @remarks
   * Используется для расчётов PnL, где отрицательные значения представляют убытки.
   *
   * @example
   * ```typescript
   * const profit = Money.fromSignedUSDC(10.5);   // прибыль
   * const loss = Money.fromSignedUSDC(-5.2);     // убыток
   * ```
   */
  public static fromSignedUSDC(amount: number): Money {
    return new Money(amount, 'USDC');
  }

  /**
   * Создаёт нулевую денежную сумму
   *
   * @returns Экземпляр Money с нулевой суммой
   */
  public static zero(): Money {
    return new Money(0, 'USDC');
  }

  /**
   * Складывает две денежные суммы
   *
   * @param other - Money для сложения
   * @returns Новый экземпляр Money с суммой
   * @throws {Error} Если валюты не совпадают
   */
  public add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount + other.amount, this.currency);
  }

  /**
   * Вычитает денежную сумму
   *
   * @param other - Money для вычитания
   * @returns Новый экземпляр Money с разностью
   * @throws {Error} Если валюты не совпадают или результат отрицательный
   */
  public subtract(other: Money): Money {
    this.assertSameCurrency(other);
    const result = this.amount - other.amount;
    if (result < 0) {
      throw new Error(`Cannot subtract: result would be negative (${result})`);
    }
    return new Money(result, this.currency);
  }

  /**
   * Умножает на коэффициент
   *
   * @param factor - Коэффициент умножения
   * @returns Новый экземпляр Money
   */
  public multiply(factor: number): Money {
    return new Money(this.amount * factor, this.currency);
  }

  /**
   * Делит на коэффициент
   *
   * @param divisor - Делитель
   * @returns Новый экземпляр Money
   * @throws {Error} Если делитель равен нулю
   */
  public divide(divisor: number): Money {
    if (divisor === 0) {
      throw new Error('Cannot divide by zero');
    }
    return new Money(this.amount / divisor, this.currency);
  }

  /**
   * Проверяет, больше ли эта сумма чем другая
   *
   * @param other - Money для сравнения
   * @returns True если больше
   */
  public isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amount > other.amount;
  }

  /**
   * Проверяет, меньше ли эта сумма чем другая
   *
   * @param other - Money для сравнения
   * @returns True если меньше
   */
  public isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.amount < other.amount;
  }

  /**
   * Проверяет, равна ли эта сумма другой
   *
   * @param other - Money для сравнения
   * @returns True если равны
   */
  public equals(other: Money): boolean {
    return this.currency === other.currency &&
           Math.abs(this.amount - other.amount) < Money.EPSILON;
  }

  /**
   * Проверяет, равна ли сумма нулю
   *
   * @returns True если ноль
   */
  public isZero(): boolean {
    return this.amount === 0;
  }

  /**
   * Проверяет, положительная ли сумма
   *
   * @returns True если положительная
   */
  public isPositive(): boolean {
    return this.amount > 0;
  }

  /**
   * Форматирует как строку
   *
   * @param decimals - Количество десятичных знаков
   * @returns Отформатированная строка
   */
  public toString(decimals: number = 2): string {
    return `$${this.amount.toFixed(decimals)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error(
        `Currency mismatch: ${this.currency} vs ${other.currency}`
      );
    }
  }
}