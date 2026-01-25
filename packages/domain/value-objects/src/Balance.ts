/**
 * Balance - баланс пользователя на рынке
 *
 * @remarks
 * Представляет денежный баланс пользователя в определённой валюте.
 * В отличие от Money (который используется для любых денежных сумм),
 * Balance специфичен для балансов счетов и может включать дополнительную логику:
 * - Проверку достаточности средств
 * - Резервирование средств под ордера
 * - Разделение на available/locked балансы
 *
 * Используется decimal.js для высокоточных финансовых расчётов.
 *
 * @example
 * ```typescript
 * import { Balance } from '@polymarket/value-objects';
 * import { InvalidMoneyError } from '@polymarket/errors';
 *
 * // Создание баланса
 * const balanceResult = Balance.fromAmount(1000, 'USDC');
 * balanceResult.match({
 *   ok: (balance) => console.log(`Balance: ${balance.getAmount()} ${balance.getCurrency()}`),
 *   err: (error) => console.error('Invalid balance:', error.message)
 * });
 *
 * // Проверка достаточности средств
 * const balance = Balance.fromAmount(1000, 'USDC').unwrap();
 * const hasEnough = balance.hasEnough(500); // true
 *
 * // Резервирование средств
 * const reserveResult = balance.reserve(300);
 * reserveResult.match({
 *   ok: ([newBalance, reserved]) => {
 *     console.log(`Available: ${newBalance.getAvailable()}`); // 700
 *     console.log(`Reserved: ${reserved.getAmount()}`); // 300
 *   },
 *   err: (error) => console.error('Insufficient funds')
 * });
 * ```
 */

import Decimal from 'decimal.js';
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidMoneyError, CurrencyMismatchError } from '@polymarket/errors';

/**
 * Balance - баланс пользователя
 *
 * @remarks
 * Неизменяемый value object, представляющий денежный баланс.
 * Использует decimal.js для точных вычислений.
 */
export class Balance {
  private constructor(
    private readonly amount: Decimal,
    private readonly currency: string
  ) {}

  /**
   * Создать Balance из Decimal значения
   *
   * @param amount - Сумма (Decimal)
   * @param currency - Валюта (например, 'USDC', 'BTC')
   * @returns Result с Balance или InvalidMoneyError
   *
   * @example
   * ```typescript
   * const balance = Balance.fromDecimal(new Decimal('1000.50'), 'USDC');
   * ```
   */
  static fromDecimal(
    amount: Decimal,
    currency: string
  ): Result<Balance, InvalidMoneyError> {
    // Валидация валюты
    if (!currency || currency.trim().length === 0) {
      return Err(
        new InvalidMoneyError(
          'Currency must be a non-empty string',
          {
            code: InvalidMoneyError.code,
            context: { amount: amount.toString(), currency: currency || '(empty)' }
          }
        )
      );
    }

    // Валидация конечности
    if (!amount.isFinite()) {
      return Err(
        new InvalidMoneyError(
          'Balance amount must be finite',
          {
            code: InvalidMoneyError.code,
            context: { amount: amount.toString(), currency, reason: 'not finite' }
          }
        )
      );
    }

    // Валидация неотрицательности (баланс не может быть отрицательным)
    if (amount.isNegative()) {
      return Err(
        new InvalidMoneyError(
          (ctx) => `Balance cannot be negative: ${ctx.amount} ${ctx.currency}`,
          {
            code: InvalidMoneyError.code,
            context: { amount: amount.toString(), currency }
          }
        )
      );
    }

    return Ok(new Balance(amount, currency));
  }

  /**
   * Создать Balance из числа
   *
   * @param amount - Сумма (number)
   * @param currency - Валюта
   * @returns Result с Balance или InvalidMoneyError
   *
   * @example
   * ```typescript
   * const balance = Balance.fromAmount(1000, 'USDC');
   * ```
   */
  static fromAmount(
    amount: number,
    currency: string
  ): Result<Balance, InvalidMoneyError> {
    try {
      return Balance.fromDecimal(new Decimal(amount), currency);
    } catch (error) {
      return Err(
        new InvalidMoneyError(
          (ctx) => `Invalid balance format: ${ctx.amount}`,
          {
            code: InvalidMoneyError.code,
            context: { amount, currency, error: String(error) }
          }
        )
      );
    }
  }

  /**
   * Создать Balance из строки
   *
   * @param amount - Сумма (string)
   * @param currency - Валюта
   * @returns Result с Balance или InvalidMoneyError
   *
   * @example
   * ```typescript
   * const balance = Balance.fromString('1000.50', 'USDC');
   * ```
   */
  static fromString(
    amount: string,
    currency: string
  ): Result<Balance, InvalidMoneyError> {
    try {
      return Balance.fromDecimal(new Decimal(amount), currency);
    } catch (error) {
      return Err(
        new InvalidMoneyError(
          (ctx) => `Invalid balance format: "${ctx.amount}"`,
          {
            code: InvalidMoneyError.code,
            context: { amount, currency, error: String(error) }
          }
        )
      );
    }
  }

  /**
   * Получить сумму баланса как number
   *
   * @returns Сумма баланса
   *
   * @remarks
   * Для высокоточных вычислений используйте toDecimal()
   */
  getAmount(): number {
    return this.amount.toNumber();
  }

  /**
   * Получить валюту баланса
   *
   * @returns Код валюты
   */
  getCurrency(): string {
    return this.currency;
  }

  /**
   * Получить сумму как Decimal
   *
   * @returns Decimal значение суммы
   */
  toDecimal(): Decimal {
    return this.amount;
  }

  /**
   * Проверить достаточность средств
   *
   * @param required - Требуемая сумма
   * @returns true если баланса достаточно
   *
   * @example
   * ```typescript
   * const balance = Balance.fromAmount(1000, 'USDC').unwrap();
   * balance.hasEnough(500); // true
   * balance.hasEnough(1500); // false
   * ```
   */
  hasEnough(required: number | Decimal): boolean {
    const requiredDecimal = required instanceof Decimal ? required : new Decimal(required);
    return this.amount.greaterThanOrEqualTo(requiredDecimal);
  }

  /**
   * Добавить к балансу
   *
   * @param other - Другой баланс для добавления
   * @returns Result с новым Balance или CurrencyMismatchError
   *
   * @example
   * ```typescript
   * const b1 = Balance.fromAmount(1000, 'USDC').unwrap();
   * const b2 = Balance.fromAmount(500, 'USDC').unwrap();
   * const sumResult = b1.add(b2);
   * // Result.ok(Balance(1500, 'USDC'))
   * ```
   */
  add(other: Balance): Result<Balance, CurrencyMismatchError> {
    if (this.currency !== other.currency) {
      return Err(
        new CurrencyMismatchError(
          (ctx) => `Cannot add ${ctx.actual} to ${ctx.expected}`,
          {
            code: CurrencyMismatchError.code,
            context: {
              operation: 'add balance',
              expected: this.currency,
              actual: other.currency
            }
          }
        )
      );
    }

    const sum = this.amount.plus(other.amount);
    return Ok(new Balance(sum, this.currency));
  }

  /**
   * Вычесть из баланса
   *
   * @param other - Другой баланс для вычитания
   * @returns Result с новым Balance или ошибкой
   *
   * @example
   * ```typescript
   * const b1 = Balance.fromAmount(1000, 'USDC').unwrap();
   * const b2 = Balance.fromAmount(300, 'USDC').unwrap();
   * const result = b1.subtract(b2);
   * // Result.ok(Balance(700, 'USDC'))
   * ```
   */
  subtract(other: Balance): Result<Balance, CurrencyMismatchError | InvalidMoneyError> {
    if (this.currency !== other.currency) {
      return Err(
        new CurrencyMismatchError(
          (ctx) => `Cannot subtract ${ctx.actual} from ${ctx.expected}`,
          {
            code: CurrencyMismatchError.code,
            context: {
              operation: 'subtract balance',
              expected: this.currency,
              actual: other.currency
            }
          }
        )
      );
    }

    const diff = this.amount.minus(other.amount);

    // Баланс не может стать отрицательным
    if (diff.isNegative()) {
      return Err(
        new InvalidMoneyError(
          (ctx) => `Insufficient balance: ${ctx.available} - ${ctx.required} = ${ctx.result}`,
          {
            code: InvalidMoneyError.code,
            context: {
              available: this.amount.toNumber(),
              required: other.amount.toNumber(),
              result: diff.toNumber(),
              currency: this.currency
            }
          }
        )
      );
    }

    return Ok(new Balance(diff, this.currency));
  }

  /**
   * Сравнить два баланса на равенство
   *
   * @param other - Другой баланс
   * @returns true если балансы равны
   *
   * @example
   * ```typescript
   * const b1 = Balance.fromAmount(1000, 'USDC').unwrap();
   * const b2 = Balance.fromAmount(1000, 'USDC').unwrap();
   * b1.equals(b2); // true
   * ```
   */
  equals(other: Balance): boolean {
    return this.currency === other.currency && this.amount.equals(other.amount);
  }

  /**
   * Представление в виде строки
   *
   * @returns Строка вида "1000 USDC"
   */
  toString(): string {
    return `${this.amount.toString()} ${this.currency}`;
  }
}