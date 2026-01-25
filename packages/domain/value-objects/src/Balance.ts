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
 * const balanceResult = Balance.fromValue(1000, 'USDC');
 * balanceResult.match({
 *   ok: (balance) => console.log(`Balance: ${balance.getAmount()} ${balance.getCurrency()}`),
 *   err: (error) => console.error('Invalid balance:', error.message)
 * });
 *
 * // Проверка достаточности средств
 * const balance = Balance.fromValue(1000, 'USDC').unwrap();
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
   * Создать нулевой баланс в указанной валюте
   *
   * @param currency - Валюта (по умолчанию 'USDC')
   * @returns Balance с нулевой суммой
   *
   * @example
   * ```typescript
   * const zero = Balance.zero();
   * console.log(zero.getAmount()); // 0
   * console.log(zero.isZero()); // true
   * ```
   */
  public static zero(currency: string = 'USDC'): Balance {
    return new Balance(new Decimal(0), currency);
  }

  /**
   * Создать Balance из различных типов значений
   *
   * @param amount - Значение: number, string или Decimal
   * @param currency - Валюта (например, 'USDC', 'BTC')
   * @returns Result с Balance или InvalidMoneyError
   *
   * @remarks
   * Универсальный метод для создания Balance.
   * Автоматически определяет тип входного значения и выполняет все необходимые проверки:
   * - Валидация валюты (непустая строка)
   * - Валидация формата числа (конечное значение)
   * - Проверка неотрицательности (баланс >= 0)
   *
   * @throws Никогда - все ошибки возвращаются через Result
   *
   * @example
   * ```typescript
   * import { unwrap } from '@polymarket/result';
   *
   * // Из числа
   * const b1 = unwrap(Balance.fromValue(1000, 'USDC'));
   *
   * // Из строки
   * const b2 = unwrap(Balance.fromValue('1000.50', 'USDC'));
   *
   * // Из Decimal
   * const b3 = unwrap(Balance.fromValue(new Decimal(1000), 'USDC'));
   *
   * // Обработка ошибок
   * const result = Balance.fromValue(-100, 'USDC');
   * if (!result.ok) {
   *   console.error(result.error.message); // "Balance cannot be negative"
   * }
   * ```
   */
  static fromValue(
    amount: number | string | Decimal,
    currency: string
  ): Result<Balance, InvalidMoneyError> {
    // Валидация валюты
    if (!currency || currency.trim().length === 0) {
      return Err(
        new InvalidMoneyError(
          'Currency must be a non-empty string',
          {
            context: { amount: String(amount), currency: currency || '(empty)' }
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
          (ctx) => `Invalid balance format: ${ctx.amount}`,
          {
            context: { amount: String(amount), currency, error: String(error) }
          }
        )
      );
    }

    // Валидация конечности
    if (!decimalAmount.isFinite()) {
      return Err(
        new InvalidMoneyError(
          'Balance amount must be finite',
          {
            context: { amount: decimalAmount.toString(), currency, reason: 'not finite' }
          }
        )
      );
    }

    // Валидация неотрицательности (баланс не может быть отрицательным)
    if (decimalAmount.isNegative()) {
      return Err(
        new InvalidMoneyError(
          (ctx) => `Balance cannot be negative: ${ctx.amount} ${ctx.currency}`,
          {
            context: { amount: decimalAmount.toString(), currency }
          }
        )
      );
    }

    return Ok(new Balance(decimalAmount, currency));
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
   * const balance = Balance.fromValue(1000, 'USDC').unwrap();
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
   * const b1 = Balance.fromValue(1000, 'USDC').unwrap();
   * const b2 = Balance.fromValue(500, 'USDC').unwrap();
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
   * const b1 = Balance.fromValue(1000, 'USDC').unwrap();
   * const b2 = Balance.fromValue(300, 'USDC').unwrap();
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
   * const b1 = Balance.fromValue(1000, 'USDC').unwrap();
   * const b2 = Balance.fromValue(1000, 'USDC').unwrap();
   * b1.equals(b2); // true
   * ```
   */
  equals(other: Balance): boolean {
    return this.currency === other.currency && this.amount.equals(other.amount);
  }

  /**
   * Проверить, больше ли текущий баланс чем другой
   *
   * @param other - Другой баланс для сравнения
   * @returns Result с boolean или CurrencyMismatchError если разные валюты
   *
   * @example
   * ```typescript
   * const b1 = unwrap(Balance.fromValue(1000, 'USDC'));
   * const b2 = unwrap(Balance.fromValue(500, 'USDC'));
   *
   * const result = b1.greaterThan(b2);
   * if (result.ok) {
   *   console.log(result.value); // true
   * }
   * ```
   */
  greaterThan(other: Balance): Result<boolean, CurrencyMismatchError> {
    if (this.currency !== other.currency) {
      return Err(
        new CurrencyMismatchError(
          (ctx) => `Cannot compare ${ctx.actual} with ${ctx.expected}`,
          {
            context: {
              operation: 'compare balance',
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
   * Проверить, меньше ли текущий баланс чем другой
   *
   * @param other - Другой баланс для сравнения
   * @returns Result с boolean или CurrencyMismatchError если разные валюты
   *
   * @example
   * ```typescript
   * const b1 = unwrap(Balance.fromValue(500, 'USDC'));
   * const b2 = unwrap(Balance.fromValue(1000, 'USDC'));
   *
   * const result = b1.lessThan(b2);
   * if (result.ok) {
   *   console.log(result.value); // true
   * }
   * ```
   */
  lessThan(other: Balance): Result<boolean, CurrencyMismatchError> {
    if (this.currency !== other.currency) {
      return Err(
        new CurrencyMismatchError(
          (ctx) => `Cannot compare ${ctx.actual} with ${ctx.expected}`,
          {
            context: {
              operation: 'compare balance',
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
   * Проверить, больше или равен ли текущий баланс чем другой
   *
   * @param other - Другой баланс для сравнения
   * @returns Result с boolean или CurrencyMismatchError если разные валюты
   *
   * @example
   * ```typescript
   * const b1 = unwrap(Balance.fromValue(1000, 'USDC'));
   * const b2 = unwrap(Balance.fromValue(1000, 'USDC'));
   *
   * const result = b1.greaterThanOrEqual(b2);
   * if (result.ok) {
   *   console.log(result.value); // true
   * }
   * ```
   */
  greaterThanOrEqual(other: Balance): Result<boolean, CurrencyMismatchError> {
    if (this.currency !== other.currency) {
      return Err(
        new CurrencyMismatchError(
          (ctx) => `Cannot compare ${ctx.actual} with ${ctx.expected}`,
          {
            context: {
              operation: 'compare balance',
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
   * Проверить, меньше или равен ли текущий баланс чем другой
   *
   * @param other - Другой баланс для сравнения
   * @returns Result с boolean или CurrencyMismatchError если разные валюты
   *
   * @example
   * ```typescript
   * const b1 = unwrap(Balance.fromValue(500, 'USDC'));
   * const b2 = unwrap(Balance.fromValue(1000, 'USDC'));
   *
   * const result = b1.lessThanOrEqual(b2);
   * if (result.ok) {
   *   console.log(result.value); // true
   * }
   * ```
   */
  lessThanOrEqual(other: Balance): Result<boolean, CurrencyMismatchError> {
    if (this.currency !== other.currency) {
      return Err(
        new CurrencyMismatchError(
          (ctx) => `Cannot compare ${ctx.actual} with ${ctx.expected}`,
          {
            context: {
              operation: 'compare balance',
              expected: this.currency,
              actual: other.currency
            }
          }
        )
      );
    }

    return Ok(this.amount.lessThanOrEqualTo(other.amount));
  }

  /**
   * Проверить, равен ли баланс нулю
   *
   * @returns true если баланс равен нулю
   *
   * @example
   * ```typescript
   * const empty = unwrap(Balance.fromValue(0, 'USDC'));
   * console.log(empty.isZero()); // true
   *
   * const full = unwrap(Balance.fromValue(1000, 'USDC'));
   * console.log(full.isZero()); // false
   * ```
   */
  isZero(): boolean {
    return this.amount.isZero();
  }

  /**
   * Проверить, является ли баланс положительным (больше нуля)
   *
   * @returns true если баланс больше нуля
   *
   * @remarks
   * Нулевой баланс НЕ считается положительным
   *
   * @example
   * ```typescript
   * const balance = unwrap(Balance.fromValue(1000, 'USDC'));
   * console.log(balance.isPositive()); // true
   *
   * const empty = unwrap(Balance.fromValue(0, 'USDC'));
   * console.log(empty.isPositive()); // false
   * ```
   */
  isPositive(): boolean {
    return this.amount.greaterThan(0);
  }

  /**
   * Сериализует в JSON
   *
   * @returns Объект для JSON сериализации
   *
   * @example
   * ```typescript
   * const balance = unwrap(Balance.fromValue(1000, 'USDC'));
   * const json = balance.toJSON();
   * console.log(json); // { amount: "1000", currency: "USDC" }
   * ```
   */
  public toJSON(): { amount: string; currency: string } {
    return {
      amount: this.amount.toString(),
      currency: this.currency,
    };
  }

  /**
   * Создаёт Balance из JSON объекта
   *
   * @param json - JSON объект с полями amount и currency
   * @returns Result с Balance или InvalidMoneyError
   *
   * @example
   * ```typescript
   * const json = { amount: "1000", currency: "USDC" };
   * const result = Balance.fromJSON(json);
   * if (result.ok) {
   *   console.log(result.value.getAmount()); // 1000
   * }
   * ```
   */
  public static fromJSON(json: {
    amount: string;
    currency: string;
  }): Result<Balance, InvalidMoneyError> {
    return Balance.fromValue(json.amount, json.currency);
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
