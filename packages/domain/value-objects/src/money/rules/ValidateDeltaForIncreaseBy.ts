import { Result, Ok, Err } from '@polymarket/result';
import { InvalidMoneyError, ErrorSource } from '@polymarket/errors';
import Decimal from 'decimal.js';
import { Ratio } from '../../ratio/core/Ratio.js';
import { MoneyErrorReason } from '../errors/MoneyErrorReason.js';

/**
 * Правило: Delta для increaseBy должен быть >= -1
 *
 * @remarks
 * Business rule для операции increaseBy (увеличение на процент).
 * Запрещает delta < -1, так как это приведёт к отрицательному factor.
 *
 * factor = 1 + delta
 * - delta = 0.1 → factor = 1.1 (увеличение на 10%)
 * - delta = -0.5 → factor = 0.5 (уменьшение на 50%)
 * - delta = -1 → factor = 0 (уменьшение на 100%, zero result)
 * - delta = -1.5 → factor = -0.5 ❌ (отрицательный factor)
 *
 * Проверяет:
 * - delta >= -1
 *
 * @param delta - Ratio для проверки
 * @returns Result<void, InvalidMoneyError>
 *
 * @example
 * ```typescript
 * const validateResult = ValidateDeltaForIncreaseBy.check(
 *   Ratio.of(new Decimal(-1.5)) // -150%
 * );
 * if (!validateResult.ok) {
 *   console.error(validateResult.error.context.reason); // DELTA_LESS_THAN_MINUS_ONE
 * }
 * ```
 */
export class ValidateDeltaForIncreaseBy {
  public static check(delta: Ratio): Result<void, InvalidMoneyError> {
    // Проверка: delta >= -1
    const minusOne = new Decimal(-1);
    if (delta.toDecimal().lessThan(minusOne)) {
      return Err(
        new InvalidMoneyError('Delta must be >= -1 (factor = 1 + delta must be non-negative)', {
          context: {
            source: ErrorSource.RULE_VALIDATION,
            delta: delta.toDecimal().toString(),
            reason: MoneyErrorReason.DELTA_LESS_THAN_MINUS_ONE
          }
        })
      );
    }

    return Ok(undefined);
  }
}
