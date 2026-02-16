import { Result, Ok, Err } from '@polymarket/result';
import { InvalidMoneyError, ErrorSource } from '@polymarket/errors';
import Decimal from 'decimal.js';
import { MoneyErrorReason } from '../errors/MoneyErrorReason.js';

/**
 * Правило: Factor для операции умножения Money должен быть finite и не NaN
 *
 * @remarks
 * Policy конкретной операции умножения Money.
 *
 * Проверяет:
 * - factor не NaN (иначе результат станет NaN, нарушит инвариант)
 * - factor isFinite (иначе результат может стать infinite, нарушит инвариант)
 *
 * Возвращает InvalidMoneyError — стандарт домена Polymarket для валидации Money.
 *
 * @param factor - Factor для проверки (ТОЛЬКО Decimal)
 * @returns Result<void, InvalidMoneyError>
 *
 * @example
 * ```typescript
 * const validateResult = ValidateFactorForMoneyMultiplication.check(new Decimal(2));
 * if (!validateResult.ok) {
 *   console.error(validateResult.error.context); // { factor, reason }
 * }
 * ```
 */
export class ValidateFactorForMoneyMultiplication {
  public static check(factor: Decimal): Result<void, InvalidMoneyError> {
    // Проверка 1: factor не должен быть NaN
    if (factor.isNaN()) {
      return Err(
        new InvalidMoneyError('Factor cannot be NaN', {
          context: {
            source: ErrorSource.RULE_VALIDATION,
            factor: factor.toString(),
            reason: MoneyErrorReason.NAN
          }
        })
      );
    }

    // Проверка 2: factor должен быть finite (исключает Infinity, -Infinity)
    if (!factor.isFinite()) {
      return Err(
        new InvalidMoneyError('Factor must be finite', {
          context: {
            source: ErrorSource.RULE_VALIDATION,
            factor: factor.toString(),
            reason: MoneyErrorReason.NON_FINITE
          }
        })
      );
    }

    return Ok(undefined);
  }
}
