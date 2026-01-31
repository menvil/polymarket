import { Result, Ok, Err } from '@polymarket/result';
import Decimal from 'decimal.js';
import {
  InvalidMoneyError,
  ArithmeticOverflowError,
  CurrencyMismatchError,
  DivisionByZeroError,
} from '@polymarket/errors';
import { addDecimal, subtractDecimal, multiplyDecimal, divideDecimal } from '@polymarket/math';
import { Money, SupportedCurrency } from '../core/Money';
import { MoneyInvariantViolation } from '../core/MoneyInvariantViolation';

/**
 * Facade для безопасного создания и операций с Money.
 *
 * @remarks
 * Возвращает Result вместо throw.
 * Ловит MoneyInvariantViolation и мапит в доменные ошибки.
 */
export class MoneyService {
  /**
   * Создаёт Money с обработкой через Result.
   *
   * @param value - Сумма (number, string, Decimal)
   * @param currency - Валюта (default 'USDC')
   * @returns Result<Money, InvalidMoneyError>
   *
   * @remarks
   * Процесс:
   * 1. Парсит в Decimal через `new Decimal(value as any)`
   * 2. Вызывает Money.fromDecimal() (ловим MoneyInvariantViolation)
   * 3. Мапит в InvalidMoneyError
   *
   * Разделение parse errors и invariant errors:
   * - Parse fail (Decimal parse error) → InvalidMoneyError(reason: 'INVALID_FORMAT', value: raw)
   * - Invariant fail (MoneyInvariantViolation) → InvalidMoneyError(reason: из core, value: normalized)
   *
   * НЕ использует Money.of() - парсит сам через Decimal.
   *
   * @example
   * ```typescript
   * const result = MoneyService.create(100);
   * if (result.ok) {
   *   console.log(result.value.amount());
   * }
   * ```
   */
  public static create(
    value: number | string | Decimal,
    currency: SupportedCurrency = 'USDC'
  ): Result<Money, InvalidMoneyError> {
    // Шаг 1: парсинг через Decimal (НЕ через Money.of)
    let decimal: Decimal;
    try {
      // Runtime guard: Decimal constructor принимает number | string | Decimal
      // TypeScript тип параметра: number | string | Decimal
      // as any безопасен т.к. catch обработает невалидные типы
      decimal = new Decimal(value as any);
    } catch {
      // Decimal parse error → InvalidMoneyError с INVALID_FORMAT и raw value
      return Err(
        new InvalidMoneyError('Failed to create Money', {
          context: {
            op: 'create',
            value: String(value),
            currency,
            reason: 'INVALID_FORMAT',
          },
        })
      );
    }

    // Шаг 2: создание через core (проверка инвариантов)
    try {
      return Ok(Money.fromDecimal(decimal, currency));
    } catch (error) {
      if (error instanceof MoneyInvariantViolation) {
        // MoneyInvariantViolation → InvalidMoneyError с reason из core и normalized value
        return Err(
          new InvalidMoneyError('Failed to create Money', {
            code: InvalidMoneyError.code,
            context: {
              op: 'create',
              value: decimal.toString(),
              currency,
              reason: error.reason,
            },
          })
        );
      }

      // Unexpected
      throw error;
    }
  }

  /**
   * Мапит MoneyInvariantViolation → ArithmeticOverflowError.
   *
   * @param op - Операция (add/subtract/...)
   * @param ctx - Контекст (a, b, result, ...)
   * @param e - MoneyInvariantViolation
   * @returns Err(ArithmeticOverflowError)
   * @throws Error если reason unexpected
   *
   * @remarks
   * DRY helper для всех math ops.
   * Ожидаемые reason: EXCEEDS_MAX_AMOUNT, NON_FINITE, NAN.
   * Остальные → unexpected (throw).
   */
  private static mapInvariantToOverflow(
    op: string,
    ctx: Record<string, unknown>,
    e: MoneyInvariantViolation
  ): Result<never, ArithmeticOverflowError> {
    const { reason } = e;

    if (reason === 'EXCEEDS_MAX_AMOUNT' || reason === 'NON_FINITE' || reason === 'NAN') {
      return Err(
        new ArithmeticOverflowError(`${op} result is invalid`, {
          context: {
            op,
            ...ctx,
            reason,
          },
        })
      );
    }

    // UNSUPPORTED_CURRENCY / INVALID_FORMAT не должны возникать в math ops
    throw new Error(`Unexpected MoneyInvariantViolation in ${op}: ${reason}`);
  }

  /**
   * Складывает две суммы.
   *
   * @param a - Первая
   * @param b - Вторая
   * @returns Result<Money, CurrencyMismatchError | ArithmeticOverflowError>
   *
   * @remarks
   * Процесс:
   * 1. Проверка валют
   * 2. Операция через @polymarket/math
   * 3. Money.fromDecimal() (проверит инварианты)
   * 4. Маппинг через helper
   *
   * Service НЕ проверяет MAX руками.
   *
   * @example
   * ```typescript
   * const result = MoneyService.add(Money.of(100), Money.of(50));
   * if (result.ok) {
   *   console.log(result.value.amount().toNumber()); // 150
   * }
   * ```
   */
  public static add(
    a: Money,
    b: Money
  ): Result<Money, CurrencyMismatchError | ArithmeticOverflowError> {
    // 1. Контекстная проверка
    if (!a.hasSameCurrency(b)) {
      return Err(
        new CurrencyMismatchError('Cannot add Money with different currencies', {
          context: {
            op: 'add',
            expected: a.currency(),
            actual: b.currency(),
          },
        })
      );
    }

    // 2. Операция через @polymarket/math
    const sum = addDecimal(a.amount(), b.amount());

    // 3. Создание через core (он проверит инварианты)
    try {
      const result = Money.fromDecimal(sum, a.currency());
      return Ok(result);
    } catch (error) {
      if (error instanceof MoneyInvariantViolation) {
        // ✅ ИСПРАВЛЕНО: используем helper (DRY)
        // ✅ ИСПРАВЛЕНО: контекст с normalized decimal.toString()
        return MoneyService.mapInvariantToOverflow('add', {
          a: a.amount().toString(),
          b: b.amount().toString(),
          result: sum.toString(),
        }, error);
      }

      throw error;
    }
  }

  /**
   * Вычитает одну сумму из другой.
   *
   * @param a - Уменьшаемое
   * @param b - Вычитаемое
   * @returns Result<Money, CurrencyMismatchError | ArithmeticOverflowError>
   *
   * @remarks
   * Процесс аналогичен add().
   *
   * @example
   * ```typescript
   * const result = MoneyService.subtract(Money.of(100), Money.of(30));
   * if (result.ok) {
   *   console.log(result.value.amount().toNumber()); // 70
   * }
   * ```
   */
  public static subtract(
    a: Money,
    b: Money
  ): Result<Money, CurrencyMismatchError | ArithmeticOverflowError> {
    if (!a.hasSameCurrency(b)) {
      return Err(
        new CurrencyMismatchError('Cannot subtract Money with different currencies', {
          context: {
            op: 'subtract',
            expected: a.currency(),
            actual: b.currency(),
          },
        })
      );
    }

    // Используем @polymarket/math
    const diff = subtractDecimal(a.amount(), b.amount());

    try {
      return Ok(Money.fromDecimal(diff, a.currency()));
    } catch (error) {
      if (error instanceof MoneyInvariantViolation) {
        return MoneyService.mapInvariantToOverflow('subtract', {
          a: a.amount().toString(),
          b: b.amount().toString(),
          result: diff.toString(),
        }, error);
      }
      throw error;
    }
  }

  /**
   * Умножает сумму на фактор.
   *
   * @param m - Money
   * @param factor - Множитель (number, string, или Decimal)
   * @returns Result<Money, InvalidMoneyError | ArithmeticOverflowError>
   *
   * @remarks
   * Проверяет валидность фактора (не NaN, finite).
   * Service проверяет INPUTS, не результат (делегирует core).
   *
   * @example
   * ```typescript
   * const result = MoneyService.multiply(Money.of(100), 1.5);
   * if (result.ok) {
   *   console.log(result.value.amount().toNumber()); // 150
   * }
   * ```
   */
  public static multiply(
    m: Money,
    factor: number | string | Decimal
  ): Result<Money, InvalidMoneyError | ArithmeticOverflowError> {
    let factorDecimal: Decimal;

    try {
      // Runtime guard: Decimal constructor принимает number | string | Decimal
      // as any безопасен т.к. catch обработает невалидные типы
      factorDecimal = new Decimal(factor as any);
    } catch {
      return Err(
        new InvalidMoneyError('Invalid factor', {
          context: {
            op: 'multiply',
            factor: String(factor),
            reason: 'INVALID_FORMAT',
          },
        })
      );
    }

    if (factorDecimal.isNaN()) {
      return Err(
        new InvalidMoneyError('Factor is NaN', {
          context: {
            op: 'multiply',
            factor: String(factor),
            reason: 'NAN',
          },
        })
      );
    }

    if (!factorDecimal.isFinite()) {
      return Err(
        new InvalidMoneyError('Factor must be finite', {
          context: {
            op: 'multiply',
            factor: String(factor),
            reason: 'NON_FINITE',
          },
        })
      );
    }

    // Используем @polymarket/math
    const product = multiplyDecimal(m.amount(), factorDecimal);

    try {
      return Ok(Money.fromDecimal(product, m.currency()));
    } catch (error) {
      if (error instanceof MoneyInvariantViolation) {
        return MoneyService.mapInvariantToOverflow('multiply', {
          amount: m.amount().toString(),
          factor: factorDecimal.toString(),
          result: product.toString(),
        }, error);
      }
      throw error;
    }
  }

  /**
   * Делит сумму на делитель.
   *
   * @param m - Money
   * @param divisor - Делитель (number, string, или Decimal)
   * @returns Result<Money, DivisionByZeroError | InvalidMoneyError | ArithmeticOverflowError>
   *
   * @remarks
   * Проверяет валидность делителя (не NaN, finite, не ноль).
   * Service проверяет INPUTS, не результат (делегирует core).
   *
   * @example
   * ```typescript
   * const result = MoneyService.divide(Money.of(100), 2);
   * if (result.ok) {
   *   console.log(result.value.amount().toNumber()); // 50
   * }
   * ```
   */
  public static divide(
    m: Money,
    divisor: number | string | Decimal
  ): Result<Money, DivisionByZeroError | InvalidMoneyError | ArithmeticOverflowError> {
    let divisorDecimal: Decimal;

    try {
      // Runtime guard: Decimal constructor принимает number | string | Decimal
      // as any безопасен т.к. catch обработает невалидные типы
      divisorDecimal = new Decimal(divisor as any);
    } catch {
      return Err(
        new InvalidMoneyError('Invalid divisor', {
          context: {
            op: 'divide',
            divisor: String(divisor),
            reason: 'INVALID_FORMAT',
          },
        })
      );
    }

    if (divisorDecimal.isNaN()) {
      return Err(
        new InvalidMoneyError('Divisor is NaN', {
          context: {
            op: 'divide',
            divisor: String(divisor),
            reason: 'NAN',
          },
        })
      );
    }

    if (!divisorDecimal.isFinite()) {
      return Err(
        new InvalidMoneyError('Divisor must be finite', {
          context: {
            op: 'divide',
            divisor: String(divisor),
            reason: 'NON_FINITE',
          },
        })
      );
    }

    if (divisorDecimal.isZero()) {
      return Err(
        new DivisionByZeroError('Cannot divide by zero', {
          context: {
            op: 'divide',
            amount: m.amount().toString(),
          },
        })
      );
    }

    // Используем @polymarket/math
    const quotient = divideDecimal(m.amount(), divisorDecimal);

    try {
      return Ok(Money.fromDecimal(quotient, m.currency()));
    } catch (error) {
      if (error instanceof MoneyInvariantViolation) {
        return MoneyService.mapInvariantToOverflow('divide', {
          amount: m.amount().toString(),
          divisor: divisorDecimal.toString(),
          result: quotient.toString(),
        }, error);
      }
      throw error;
    }
  }
}
