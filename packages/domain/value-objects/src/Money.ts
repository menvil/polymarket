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
 * import { unwrap } from '@polymarket/result';
 *
 * // Создание Money (USDC по умолчанию)
 * const moneyResult = unwrap(Money.fromValue(100);
 * moneyResult.match({
 *   ok: (money) => console.log(money.getAmount()), // 100
 *   err: (error) => console.error(error.message)
 * });
 *
 * // Короткий синтаксис с unwrap (USDC по умолчанию)
 * const money = unwrap(Money.fromValue(100));
 *
 * // Математические операции
 * const m1 = unwrap(Money.fromValue(100));
 * const m2 = unwrap(Money.fromValue(50));
 *
 * const sum = m1.add(m2);
 * sum.match({
 *   ok: (result) => console.log(result.getAmount()), // 150
 *   err: (error) => console.error(error)
 * });
 *
 * // Точность decimal.js
 * const m3 = unwrap(Money.fromValue('0.1'));
 * const m4 = unwrap(Money.fromValue('0.2'));
 * const precise = unwrap(m3.add(m4));
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
  // Constants & Factory Methods
  // ============================================================================

  /**
   * Создать нулевую сумму в указанной валюте
   *
   * @param currency - Валюта (по умолчанию 'USDC')
   * @returns Money с нулевой суммой
   *
   * @example
   * ```typescript
   * const zero = Money.zero();
   * console.log(zero.getAmount()); // 0
   * ```
   */
  public static zero(currency: SupportedCurrency = 'USDC'): Money {
    return new Money(new Decimal(0), currency);
  }

  /**
   * Создать Money из различных типов значений
   *
   * @param amount - Значение: number, string или Decimal
   * @param currency - Валюта (по умолчанию 'USDC')
   * @returns Result с Money или InvalidMoneyError
   *
   * @remarks
   * Универсальный метод для создания Money.
   * Автоматически определяет тип входного значения и выполняет все необходимые проверки:
   * - Валидация поддерживаемой валюты (только USDC)
   * - Валидация формата числа (конечное значение, не NaN)
   * - Преобразование в Decimal для точных вычислений
   *
   * @throws Никогда - все ошибки возвращаются через Result
   *
   * @example
   * ```typescript
   * import { unwrap } from '@polymarket/result';
   *
   * // Из числа
   * const m1 = unwrap(Money.fromValue(100));
   * const m2 = unwrap(Money.fromValue(100, 'USDC'));
   *
   * // Из строки (высокая точность)
   * const m3 = unwrap(Money.fromValue('100.123456789'));
   *
   * // Из Decimal
   * const m4 = unwrap(Money.fromValue(new Decimal(100)));
   *
   * // Обработка ошибок
   * const result = unwrap(Money.fromValue(NaN);
   * if (!result.ok) {
   *   console.error(result.error.message); // "Amount cannot be NaN"
   * }
   * ```
   */
  static fromValue(
    amount: number | string | Decimal,
    currency: SupportedCurrency = 'USDC'
  ): Result<Money, InvalidMoneyError> {
    // Валидация валюты
    if (!Money.SUPPORTED_CURRENCIES.has(currency)) {
      return Err(
        new InvalidMoneyError(
          `Unsupported currency: ${currency}. Only USDC is supported.`,
          {
            context: { amount: String(amount), currency }
          }
        )
      );
    }

    // Преобразование в Decimal с обработкой ошибок
    let decimalAmount: Decimal;
    try {
      decimalAmount = amount instanceof Decimal ? amount : new Decimal(amount);
    } catch (error) {
      return Err(
        new InvalidMoneyError(
          `Invalid amount format: ${String(amount)}`,
          {
            context: { amount: String(amount), currency, error: String(error) }
          }
        )
      );
    }

    // Проверка NaN через Decimal
    if (decimalAmount.isNaN()) {
      return Err(
        new InvalidMoneyError(
          'Amount cannot be NaN',
          {
            context: { amount: String(amount), currency, reason: 'NaN' }
          }
        )
      );
    }

    // Проверка конечности через Decimal
    if (!decimalAmount.isFinite()) {
      return Err(
        new InvalidMoneyError(
          'Amount must be finite',
          {
            context: { amount: decimalAmount.toString(), currency, reason: 'Infinity' }
          }
        )
      );
    }

    // Проверка превышения максимальной суммы
    if (decimalAmount.abs().greaterThan(Money.MAX_AMOUNT)) {
      return Err(
        new InvalidMoneyError(
          (ctx) => `Amount ${ctx.amount} exceeds MAX_AMOUNT (${ctx.max})`,
          {
            context: {
              amount: decimalAmount.toString(),
              currency,
              max: Money.MAX_AMOUNT.toString()
            }
          }
        )
      );
    }

    return Ok(new Money(decimalAmount, currency));
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
   * const m1 = unwrap(Money.fromValue(100));
   * const m2 = unwrap(Money.fromValue(50));
   * const sum = m1.add(m2);
   * sum.match({
   *   ok: (money) => console.log(money.getAmount()), // 150
   *   err: (error) => console.error(error)
   * });
   * ```
   */
  add(other: Money): Result<Money, CurrencyMismatchError | ArithmeticOverflowError> {
    if (this.currency !== other.currency) {
      return Err(
        new CurrencyMismatchError(
          (ctx: Record<string, unknown>) =>
            `Cannot add ${ctx.actual} to ${ctx.expected}`,
          {
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

    // Проверка overflow
    if (!sum.isFinite()) {
      return Err(
        new ArithmeticOverflowError(
          (ctx: Record<string, unknown>) =>
            `Addition overflow: ${ctx.a} + ${ctx.b} = ${ctx.result}`,
          {
            context: {
              operation: 'add',
              a: this.amount.toNumber(),
              b: other.amount.toNumber(),
              result: Infinity
            }
          }
        )
      );
    }

    if (sum.abs().greaterThan(Money.MAX_AMOUNT)) {
      return Err(
        new ArithmeticOverflowError(
          (ctx: Record<string, unknown>) =>
            `Addition overflow: result ${ctx.result} exceeds maximum ${ctx.max}`,
          {
            context: {
              operation: 'add',
              a: this.amount.toString(),
              b: other.amount.toString(),
              result: sum.toString(),
              max: Money.MAX_AMOUNT.toString()
            }
          }
        )
      );
    }

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
   * import { unwrap } from '@polymarket/result';
   *
   * const m1 = unwrap(Money.fromValue(100));
   * const m2 = unwrap(Money.fromValue(150));
   * const diff = unwrap(m1.subtract(m2));
   * diff.isNegative(); // true (PnL = -50)
   * ```
   */
  subtract(other: Money): Result<Money, CurrencyMismatchError | ArithmeticOverflowError> {
    if (this.currency !== other.currency) {
      return Err(
        new CurrencyMismatchError(
          (ctx: Record<string, unknown>) =>
            `Cannot subtract ${ctx.actual} from ${ctx.expected}`,
          {
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

    // Проверка overflow
    if (!diff.isFinite()) {
      return Err(
        new ArithmeticOverflowError(
          (ctx: Record<string, unknown>) =>
            `Subtraction overflow: ${ctx.a} - ${ctx.b} = ${ctx.result}`,
          {
            context: {
              operation: 'subtract',
              a: this.amount.toNumber(),
              b: other.amount.toNumber(),
              result: Infinity
            }
          }
        )
      );
    }

    if (diff.abs().greaterThan(Money.MAX_AMOUNT)) {
      return Err(
        new ArithmeticOverflowError(
          (ctx: Record<string, unknown>) =>
            `Subtraction overflow: result ${ctx.result} exceeds maximum ${ctx.max}`,
          {
            context: {
              operation: 'subtract',
              a: this.amount.toString(),
              b: other.amount.toString(),
              result: diff.toString(),
              max: Money.MAX_AMOUNT.toString()
            }
          }
        )
      );
    }

    return Ok(new Money(diff, this.currency));
  }

  /**
   * Умножить на коэффициент
   *
   * @param factor - Коэффициент (number или Decimal)
   * @returns Result с новым Money или ошибкой (InvalidMoneyError | ArithmeticOverflowError)
   *
   * @throws {InvalidMoneyError} Если factor невалиден (не конечное число)
   * @throws {ArithmeticOverflowError} Если результат превышает максимальное значение
   *
   * @example
   * ```typescript
   * import { unwrap } from '@polymarket/result';
   *
   * const money = unwrap(Money.fromValue(100));
   * const doubled = money.multiply(2);
   * doubled.match({
   *   ok: (m) => console.log(m.getAmount()), // 200
   *   err: (error) => console.error('Error:', error.message)
   * });
   * ```
   */
  multiply(factor: number | Decimal): Result<Money, InvalidMoneyError | ArithmeticOverflowError> {
    // Валидация параметра factor
    let factorDecimal: Decimal;
    try {
      factorDecimal = factor instanceof Decimal ? factor : new Decimal(factor);
    } catch (error) {
      return Err(
        new InvalidMoneyError(
          (ctx: Record<string, unknown>) =>
            `Invalid factor: ${ctx.factor}`,
          {
            context: {
              factor: String(factor),
              error: String(error)
            }
          }
        )
      );
    }

    // Проверка что factor является конечным числом
    if (!factorDecimal.isFinite()) {
      return Err(
        new InvalidMoneyError(
          (ctx: Record<string, unknown>) =>
            `Invalid factor ${ctx.factor}: must be a finite number`,
          {
            context: {
              factor: factorDecimal.toString(),
              operation: 'multiply money'
            }
          }
        )
      );
    }

    const result = this.amount.times(factorDecimal);

    // Проверка конечности результата
    if (!result.isFinite()) {
      return Err(
        new ArithmeticOverflowError(
          (ctx: Record<string, unknown>) =>
            `Multiplication overflow: ${ctx.a} * ${ctx.b} = ${ctx.result}`,
          {
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
  }

  /**
   * Разделить на коэффициент
   *
   * @param divisor - Делитель (number или Decimal)
   * @returns Result с новым Money или ошибкой:
   *   - DivisionByZeroError: если делитель равен нулю или не является конечным числом
   *   - ArithmeticOverflowError: если результат превышает MAX_AMOUNT или произошла непредвиденная ошибка
   *
   * @example
   * ```typescript
   * const money = unwrap(Money.fromValue(100));
   * const half = money.divide(2);
   * half.match({
   *   ok: (m) => console.log(m.getAmount()), // 50
   *   err: (error) => console.error('Division error')
   * });
   * ```
   */
  divide(divisor: number | Decimal): Result<Money, DivisionByZeroError | ArithmeticOverflowError> {
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
                amount: this.amount.toNumber(),
                divisor: divisorDecimal.toString(),
                operation: 'divide money'
              }
            }
          )
        );
      }

      // Проверка деления на ноль
      if (divisorDecimal.isZero()) {
        return Err(
          new DivisionByZeroError(
            (ctx: Record<string, unknown>) =>
              `Cannot divide ${ctx.amount} by ${ctx.divisor}`,
            {
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

      // Проверка что результат является конечным числом
      if (!result.isFinite()) {
        return Err(
          new DivisionByZeroError(
            (ctx: Record<string, unknown>) =>
              `Division resulted in non-finite value: ${ctx.result}`,
            {
              context: {
                amount: this.amount.toNumber(),
                divisor: divisorDecimal.toNumber(),
                result: result.toString(),
                operation: 'divide money'
              }
            }
          )
        );
      }

      // Проверка что результат не превышает MAX_AMOUNT
      if (result.abs().greaterThan(Money.MAX_AMOUNT)) {
        return Err(
          new ArithmeticOverflowError(
            (ctx: Record<string, unknown>) =>
              `Division overflow: result ${ctx.result} exceeds maximum ${ctx.max}`,
            {
              context: {
                operation: 'divide',
                amount: this.amount.toString(),
                divisor: divisorDecimal.toString(),
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
          (ctx: Record<string, unknown>) =>
            `Unexpected division error: ${ctx.error}`,
          {
            context: {
              operation: 'divide money',
              amount: this.amount.toString(),
              currency: this.currency,
              divisor: String(divisor),
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
   * import { unwrap } from '@polymarket/result';
   *
   * const m1 = unwrap(Money.fromValue(100));
   * const m2 = unwrap(Money.fromValue(100));
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
   * const m1 = unwrap(Money.fromValue(100));
   * const m2 = unwrap(Money.fromValue(50));
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
   * const loss = unwrap(Money.fromValue(-50));
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
   * const profit = unwrap(Money.fromValue(50));
   * const loss = profit.negate();
   * loss.getAmount(); // -50
   * ```
   */
  negate(): Money {
    return new Money(this.amount.negated(), this.currency);
  }

  /**
   * Сериализует в JSON
   *
   * @returns Объект для JSON сериализации
   *
   * @example
   * ```typescript
   * const money = unwrap(Money.fromValue(100.50));
   * const json = money.toJSON();
   * console.log(json); // { amount: "100.5", currency: "USDC" }
   * ```
   */
  public toJSON(): { amount: string; currency: SupportedCurrency } {
    return {
      amount: this.amount.toString(),
      currency: this.currency,
    };
  }

  /**
   * Создаёт Money из JSON объекта
   *
   * @param json - JSON объект с полями amount и currency
   * @returns Result с Money или InvalidMoneyError
   *
   * @example
   * ```typescript
   * const json = { amount: "100.50", currency: "USDC" };
   * const result = Money.fromJSON(json);
   * if (result.ok) {
   *   console.log(result.value.getAmount()); // 100.5
   * }
   * ```
   */
  public static fromJSON(json: {
    amount: string;
    currency: SupportedCurrency;
  }): Result<Money, InvalidMoneyError> {
    return Money.fromValue(json.amount, json.currency);
  }

  /**
   * Представление в виде строки
   *
   * @param decimals - Количество десятичных знаков (по умолчанию 2)
   * @returns Отформатированная строка
   *
   * @example
   * ```typescript
   * const money = unwrap(Money.fromValue(100.5));
   * money.toString();    // "$100.50 USDC"
   * money.toString(4);   // "$100.5000 USDC"
   * ```
   */
  toString(decimals: number = 2): string {
    return `$${this.amount.toFixed(decimals)} ${this.currency}`;
  }
}
