/**
 * Money - value object для денежных сумм
 *
 * @remarks
 * Представляет денежную сумму с валютой.
 * Неизменяемый value object для финансовых вычислений с высокой точностью.
 *
 * Использует decimal.js для точных вычислений и Railway-Oriented Programming
 * для явной обработки ошибок через Result<T, E>.
 *
 * В текущей версии поддерживается только USDC, но архитектура позволяет
 * легко добавить другие валюты в будущем.
 *
 * @example
 * ```typescript
 * import { Money } from '@polymarket/value-objects';
 *
 * // Создание Money (USDC по умолчанию)
 * const moneyResult = Money.fromAmount(100);
 * moneyResult.match({
 *   ok: (money) => console.log(money.getAmount()), // 100
 *   err: (error) => console.error(error.message)
 * });
 *
 * // Короткий синтаксис с unwrap (USDC по умолчанию)
 * const money = Money.fromAmount(100).unwrap();
 *
 * // Математические операции
 * const m1 = Money.fromAmount(100).unwrap();
 * const m2 = Money.fromAmount(50).unwrap();
 *
 * const sum = m1.add(m2);
 * sum.match({
 *   ok: (result) => console.log(result.getAmount()), // 150
 *   err: (error) => console.error(error)
 * });
 *
 * // Точность decimal.js
 * const m3 = Money.fromString('0.1').unwrap();
 * const m4 = Money.fromString('0.2').unwrap();
 * const precise = m3.add(m4).unwrap();
 * precise.toDecimal().toString(); // "0.3" (точно!)
 * ```
 */

import Decimal from 'decimal.js';
import { type Result, Ok, Err } from '@polymarket/result';
import {
  InvalidMoneyError,
  CurrencyMismatchError,
  DivisionByZeroError,
  ArithmeticOverflowError,
} from '@polymarket/errors';

/**
 * Поддерживаемые валюты
 *
 * @remark
 * В текущей версии поддерживается только USDC.
 * Для добавления новых валют: 'USDC' | 'BTC' | 'ETH'
 */
export type SupportedCurrency = 'USDC';

/**
 * Money - неизменяемый value object для денежных сумм
 *
 * @remarks
 * Использует decimal.js для высокоточных финансовых расчётов.
 * Все операции возвращают Result<T, E> для явной обработки ошибок.
 */
export class Money {
  /**
   * Поддерживаемые валюты (пока только USDC)
   */
  private static readonly SUPPORTED_CURRENCIES: ReadonlySet<SupportedCurrency> = new Set(['USDC']);

  /**
   * Максимальная допустимая сумма (1e15 = 1 квадриллион центов = 10 триллионов долларов)
   */
  private static readonly MAX_AMOUNT = new Decimal('1e15');

  private constructor(
    private readonly amount: Decimal,
    private readonly currency: SupportedCurrency
  ) {}

  // ============================================================================
  // Factory Methods
  // ============================================================================

  /**
   * Создать Money из числа
   *
   * @param amount - Сумма (number)
   * @param currency - Валюта (по умолчанию 'USDC')
   * @returns Result с Money или InvalidMoneyError
   *
   * @example
   * ```typescript
   * const money = Money.fromAmount(100);
   * const money2 = Money.fromAmount(100, 'USDC');
   * ```
   */
  static fromAmount(
    amount: number,
    currency: SupportedCurrency = 'USDC'
  ): Result<Money, InvalidMoneyError> {
    // Валидация валюты
    if (!Money.SUPPORTED_CURRENCIES.has(currency)) {
      return Err(
        new InvalidMoneyError(
          `Unsupported currency: ${currency}. Only USDC is supported.`,
          {
            code: InvalidMoneyError.code,
            context: { amount, currency }
          }
        )
      );
    }

    try {
      const decimal = new Decimal(amount);

      // Проверка NaN через Decimal
      if (decimal.isNaN()) {
        return Err(
          new InvalidMoneyError(
            'Amount cannot be NaN',
            {
              code: InvalidMoneyError.code,
              context: { amount, currency, reason: 'NaN' }
            }
          )
        );
      }

      // Проверка конечности через Decimal
      if (!decimal.isFinite()) {
        return Err(
          new InvalidMoneyError(
            'Amount must be finite',
            {
              code: InvalidMoneyError.code,
              context: { amount, currency, reason: 'Infinity' }
            }
          )
        );
      }

      return Ok(new Money(decimal, currency));
    } catch (error) {
      return Err(
        new InvalidMoneyError(
          `Invalid amount: ${amount}`,
          {
            code: InvalidMoneyError.code,
            context: { amount, currency, error: String(error) }
          }
        )
      );
    }
  }

  /**
   * Создать Money из Decimal
   *
   * @param amount - Сумма (Decimal)
   * @param currency - Валюта (по умолчанию 'USDC')
   * @returns Result с Money или InvalidMoneyError
   *
   * @example
   * ```typescript
   * const decimal = new Decimal('100.123456789');
   * const money = Money.fromDecimal(decimal);
   * ```
   */
  static fromDecimal(
    amount: Decimal,
    currency: SupportedCurrency = 'USDC'
  ): Result<Money, InvalidMoneyError> {
    // Валидация валюты
    if (!Money.SUPPORTED_CURRENCIES.has(currency)) {
      return Err(
        new InvalidMoneyError(
          `Unsupported currency: ${currency}. Only USDC is supported.`,
          {
            code: InvalidMoneyError.code,
            context: { amount: amount.toString(), currency }
          }
        )
      );
    }

    // Валидация конечности
    if (!amount.isFinite()) {
      return Err(
        new InvalidMoneyError(
          'Amount must be finite',
          {
            code: InvalidMoneyError.code,
            context: { amount: amount.toString(), currency, reason: 'not finite' }
          }
        )
      );
    }

    return Ok(new Money(amount, currency));
  }

  /**
   * Создать Money из строки
   *
   * @param amount - Сумма (string)
   * @param currency - Валюта (по умолчанию 'USDC')
   * @returns Result с Money или InvalidMoneyError
   *
   * @remarks
   * Используйте для высокоточного ввода, например '0.123456789'
   *
   * @example
   * ```typescript
   * const money = Money.fromString('100.123456789');
   * ```
   */
  static fromString(
    amount: string,
    currency: SupportedCurrency = 'USDC'
  ): Result<Money, InvalidMoneyError> {
    try {
      const decimal = new Decimal(amount);
      return Money.fromDecimal(decimal, currency);
    } catch (error) {
      return Err(
        new InvalidMoneyError(
          `Invalid amount format: "${amount}"`,
          {
            code: InvalidMoneyError.code,
            context: { amount, currency, error: String(error) }
          }
        )
      );
    }
  }

  /**
   * Создать нулевую сумму
   *
   * @param currency - Валюта (по умолчанию 'USDC')
   * @returns Money с нулевой суммой
   *
   * @example
   * ```typescript
   * const zero = Money.zero();
   * zero.isZero(); // true
   * ```
   */
  static zero(currency: SupportedCurrency = 'USDC'): Money {
    return new Money(new Decimal(0), currency);
  }

  // ============================================================================
  // Getters
  // ============================================================================

  /**
   * Получить сумму как number
   *
   * @returns Сумма
   *
   * @remarks
   * Для высокоточных вычислений используйте toDecimal()
   */
  getAmount(): number {
    return this.amount.toNumber();
  }

  /**
   * Получить валюту
   *
   * @returns Код валюты
   */
  getCurrency(): SupportedCurrency {
    return this.currency;
  }

  /**
   * Получить сумму как Decimal
   *
   * @returns Decimal значение
   *
   * @remarks
   * Используйте для высокоточных вычислений
   */
  toDecimal(): Decimal {
    return this.amount;
  }

  // ============================================================================
  // Math Operations
  // ============================================================================

  /**
   * Сложить две денежные суммы
   *
   * @param other - Другая сумма
   * @returns Result с новым Money или CurrencyMismatchError
   *
   * @example
   * ```typescript
   * const m1 = Money.fromAmount(100).unwrap();
   * const m2 = Money.fromAmount(50).unwrap();
   * const sum = m1.add(m2);
   * sum.match({
   *   ok: (money) => console.log(money.getAmount()), // 150
   *   err: (error) => console.error(error)
   * });
   * ```
   */
  add(other: Money): Result<Money, CurrencyMismatchError> {
    if (this.currency !== other.currency) {
      return Err(
        new CurrencyMismatchError(
          (ctx: Record<string, unknown>) =>
            `Cannot add ${ctx.actual} to ${ctx.expected}`,
          {
            code: CurrencyMismatchError.code,
            context: {
              operation: 'add',
              expected: this.currency,
              actual: other.currency
            }
          }
        )
      );
    }

    const sum = this.amount.plus(other.amount);
    return Ok(new Money(sum, this.currency));
  }

  /**
   * Вычесть денежную сумму
   *
   * @param other - Другая сумма
   * @returns Result с новым Money или ошибкой
   *
   * @remarks
   * Разрешает отрицательный результат для PnL расчётов.
   * Если нужна защита от отрицательных значений, используйте Balance.
   *
   * @example
   * ```typescript
   * const m1 = Money.fromUSDC(100).unwrap();
   * const m2 = Money.fromUSDC(150).unwrap();
   * const diff = m1.subtract(m2).unwrap();
   * diff.isNegative(); // true (PnL = -50)
   * ```
   */
  subtract(other: Money): Result<Money, CurrencyMismatchError> {
    if (this.currency !== other.currency) {
      return Err(
        new CurrencyMismatchError(
          (ctx: Record<string, unknown>) =>
            `Cannot subtract ${ctx.actual} from ${ctx.expected}`,
          {
            code: CurrencyMismatchError.code,
            context: {
              operation: 'subtract',
              expected: this.currency,
              actual: other.currency
            }
          }
        )
      );
    }

    const diff = this.amount.minus(other.amount);
    return Ok(new Money(diff, this.currency));
  }

  /**
   * Умножить на коэффициент
   *
   * @param factor - Коэффициент (number или Decimal)
   * @returns Result с новым Money или ArithmeticOverflowError
   *
   * @example
   * ```typescript
   * const money = Money.fromAmount(100).unwrap();
   * const doubled = money.multiply(2);
   * doubled.match({
   *   ok: (m) => console.log(m.getAmount()), // 200
   *   err: (error) => console.error('Overflow')
   * });
   * ```
   */
  multiply(factor: number | Decimal): Result<Money, ArithmeticOverflowError> {
    try {
      const factorDecimal = factor instanceof Decimal ? factor : new Decimal(factor);
      const result = this.amount.times(factorDecimal);

      // Проверка конечности
      if (!result.isFinite()) {
        return Err(
          new ArithmeticOverflowError(
            (ctx: Record<string, unknown>) =>
              `Multiplication overflow: ${ctx.a} * ${ctx.b} = ${ctx.result}`,
            {
              code: ArithmeticOverflowError.code,
              context: {
                operation: 'multiply',
                a: this.amount.toNumber(),
                b: factorDecimal.toNumber(),
                result: Infinity
              }
            }
          )
        );
      }

      // Проверка превышения максимальной суммы
      if (result.abs().greaterThan(Money.MAX_AMOUNT)) {
        return Err(
          new ArithmeticOverflowError(
            (ctx: Record<string, unknown>) =>
              `Multiplication overflow: result ${ctx.result} exceeds maximum ${ctx.max}`,
            {
              code: ArithmeticOverflowError.code,
              context: {
                operation: 'multiply',
                a: this.amount.toString(),
                b: factorDecimal.toString(),
                result: result.toString(),
                max: Money.MAX_AMOUNT.toString()
              }
            }
          )
        );
      }

      return Ok(new Money(result, this.currency));
    } catch (error) {
      return Err(
        new ArithmeticOverflowError(
          `Multiplication error: ${error}`,
          {
            code: ArithmeticOverflowError.code,
            context: {
              operation: 'multiply',
              error: String(error)
            }
          }
        )
      );
    }
  }

  /**
   * Разделить на коэффициент
   *
   * @param divisor - Делитель (number или Decimal)
   * @returns Result с новым Money или DivisionByZeroError
   *
   * @example
   * ```typescript
   * const money = Money.fromAmount(100).unwrap();
   * const half = money.divide(2);
   * half.match({
   *   ok: (m) => console.log(m.getAmount()), // 50
   *   err: (error) => console.error('Division by zero')
   * });
   * ```
   */
  divide(divisor: number | Decimal): Result<Money, DivisionByZeroError> {
    try {
      const divisorDecimal = divisor instanceof Decimal ? divisor : new Decimal(divisor);

      // Проверка деления на ноль
      if (divisorDecimal.isZero()) {
        return Err(
          new DivisionByZeroError(
            (ctx: Record<string, unknown>) =>
              `Cannot divide ${ctx.amount} by ${ctx.divisor}`,
            {
              code: DivisionByZeroError.code,
              context: {
                amount: this.amount.toNumber(),
                divisor: 0,
                operation: 'divide money'
              }
            }
          )
        );
      }

      const result = this.amount.dividedBy(divisorDecimal);
      return Ok(new Money(result, this.currency));
    } catch (error) {
      return Err(
        new DivisionByZeroError(
          `Division error: ${error}`,
          {
            code: DivisionByZeroError.code,
            context: {
              error: String(error)
            }
          }
        )
      );
    }
  }

  // ============================================================================
  // Comparison
  // ============================================================================

  /**
   * Проверить равенство двух сумм
   *
   * @param other - Другая сумма
   * @returns true если суммы равны
   *
   * @example
   * ```typescript
   * const m1 = Money.fromUSDC(100).unwrap();
   * const m2 = Money.fromUSDC(100).unwrap();
   * m1.equals(m2); // true
   * ```
   */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.amount.equals(other.amount);
  }

  /**
   * Проверить больше ли эта сумма
   *
   * @param other - Другая сумма
   * @returns Result с boolean или CurrencyMismatchError
   *
   * @example
   * ```typescript
   * const m1 = Money.fromAmount(100).unwrap();
   * const m2 = Money.fromAmount(50).unwrap();
   * const result = m1.greaterThan(m2);
   * result.match({
   *   ok: (isGreater) => console.log(isGreater), // true
   *   err: (error) => console.error('Currency mismatch')
   * });
   * ```
   */
  greaterThan(other: Money): Result<boolean, CurrencyMismatchError> {
    if (this.currency !== other.currency) {
      return Err(
        new CurrencyMismatchError(
          (ctx: Record<string, unknown>) =>
            `Cannot compare ${ctx.expected} with ${ctx.actual}`,
          {
            code: CurrencyMismatchError.code,
            context: {
              operation: 'compare',
              expected: this.currency,
              actual: other.currency
            }
          }
        )
      );
    }

    return Ok(this.amount.greaterThan(other.amount));
  }

  /**
   * Проверить меньше ли эта сумма
   *
   * @param other - Другая сумма
   * @returns Result с boolean или CurrencyMismatchError
   */
  lessThan(other: Money): Result<boolean, CurrencyMismatchError> {
    if (this.currency !== other.currency) {
      return Err(
        new CurrencyMismatchError(
          (ctx: Record<string, unknown>) =>
            `Cannot compare ${ctx.expected} with ${ctx.actual}`,
          {
            code: CurrencyMismatchError.code,
            context: {
              operation: 'compare',
              expected: this.currency,
              actual: other.currency
            }
          }
        )
      );
    }

    return Ok(this.amount.lessThan(other.amount));
  }

  /**
   * Проверить больше или равно
   *
   * @param other - Другая сумма
   * @returns Result с boolean или CurrencyMismatchError
   */
  greaterThanOrEqual(other: Money): Result<boolean, CurrencyMismatchError> {
    if (this.currency !== other.currency) {
      return Err(
        new CurrencyMismatchError(
          (ctx: Record<string, unknown>) =>
            `Cannot compare ${ctx.expected} with ${ctx.actual}`,
          {
            code: CurrencyMismatchError.code,
            context: {
              operation: 'compare',
              expected: this.currency,
              actual: other.currency
            }
          }
        )
      );
    }

    return Ok(this.amount.greaterThanOrEqualTo(other.amount));
  }

  /**
   * Проверить меньше или равно
   *
   * @param other - Другая сумма
   * @returns Result с boolean или CurrencyMismatchError
   */
  lessThanOrEqual(other: Money): Result<boolean, CurrencyMismatchError> {
    if (this.currency !== other.currency) {
      return Err(
        new CurrencyMismatchError(
          (ctx: Record<string, unknown>) =>
            `Cannot compare ${ctx.expected} with ${ctx.actual}`,
          {
            code: CurrencyMismatchError.code,
            context: {
              operation: 'compare',
              expected: this.currency,
              actual: other.currency
            }
          }
        )
      );
    }

    return Ok(this.amount.lessThanOrEqualTo(other.amount));
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  /**
   * Проверить является ли сумма нулевой
   *
   * @returns true если ноль
   */
  isZero(): boolean {
    return this.amount.isZero();
  }

  /**
   * Проверить является ли сумма положительной
   *
   * @returns true если положительная (больше нуля)
   */
  isPositive(): boolean {
    return this.amount.greaterThan(0);
  }

  /**
   * Проверить является ли сумма отрицательной
   *
   * @returns true если отрицательная
   *
   * @remarks
   * Используется для PnL расчётов (отрицательное значение = убыток)
   */
  isNegative(): boolean {
    return this.amount.isNegative();
  }

  /**
   * Получить абсолютное значение
   *
   * @returns Новый Money с абсолютным значением
   *
   * @example
   * ```typescript
   * const loss = Money.fromUSDC(-50).unwrap();
   * const absLoss = loss.abs();
   * absLoss.getAmount(); // 50
   * ```
   */
  abs(): Money {
    return new Money(this.amount.abs(), this.currency);
  }

  /**
   * Изменить знак
   *
   * @returns Новый Money с противоположным знаком
   *
   * @example
   * ```typescript
   * const profit = Money.fromUSDC(50).unwrap();
   * const loss = profit.negate();
   * loss.getAmount(); // -50
   * ```
   */
  negate(): Money {
    return new Money(this.amount.negated(), this.currency);
  }

  /**
   * Представление в виде строки
   *
   * @param decimals - Количество десятичных знаков (по умолчанию 2)
   * @returns Отформатированная строка
   *
   * @example
   * ```typescript
   * const money = Money.fromUSDC(100.5).unwrap();
   * money.toString();    // "$100.50 USDC"
   * money.toString(4);   // "$100.5000 USDC"
   * ```
   */
  toString(decimals: number = 2): string {
    return `$${this.amount.toFixed(decimals)} ${this.currency}`;
  }
}
