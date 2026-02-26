import { Result, Ok, Err } from '@polymarket/result';
import { InvalidSignedQuantityError, ErrorSource } from '@polymarket/errors';
import Decimal from 'decimal.js';
import { SignedQuantityErrorReason } from '../errors/SignedQuantityErrorReason.js';

/**
 * Правило: При adjustBy с allowCrossZero = false результат не должен пересекать ноль
 *
 * @remarks
 * Policy для безопасного изменения SignedQuantity на процент без смены знака.
 *
 * Проверяет:
 * - original === 0 && result !== 0 → ошибка CANNOT_ADJUST_ZERO (нельзя сдвигать 0 в неноль при запрете cross-zero)
 * - original === 0 && result === 0 → OK (идемпотентная операция, delta=0)
 * - sign(original) !== sign(result) && result !== 0 → ошибка RESULT_CROSSES_ZERO
 * - result === 0 → OK (граничный случай, допустимо)
 *
 * Возвращает InvalidSignedQuantityError с reason для дифференциации ошибок.
 *
 * @param original - Исходное значение SignedQuantity
 * @param result - Результат после применения delta
 * @returns Result<void, InvalidSignedQuantityError>
 *
 * @example
 * ```typescript
 * const original = new Decimal(100);
 * const result = new Decimal(-50);
 * const validateResult = ValidateDeltaForAdjustByNoCrossZero.check(original, result);
 * // Err: positive → negative crossing
 * ```
 */
export class ValidateDeltaForAdjustByNoCrossZero {
  public static check(original: Decimal, result: Decimal): Result<void, InvalidSignedQuantityError> {
    // Проверка 1: Нельзя сдвигать ноль в неноль при allowCrossZero = false
    // Но идемпотентная операция (0 → 0) разрешена
    if (original.isZero()) {
      if (result.isZero()) {
        return Ok(undefined); // delta=0 на ноле - OK (идемпотентно)
      }
      return Err(
        new InvalidSignedQuantityError(
          () => `Cannot adjust zero SignedQuantity to non-zero when allowCrossZero is false`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              reason: SignedQuantityErrorReason.CANNOT_ADJUST_ZERO,
              original: original.toString(),
              result: result.toString()
            }
          }
        )
      );
    }

    // Проверка 2: Результат не должен пересекать ноль (но может быть равен нулю)
    if (!result.isZero()) {
      const originalPositive = original.greaterThan(0);
      const resultPositive = result.greaterThan(0);

      if (originalPositive !== resultPositive) {
        return Err(
          new InvalidSignedQuantityError(
            (ctx) =>
              `Result crosses zero: original ${ctx.original} → result ${ctx.result} (allowCrossZero is false)`,
            {
              context: {
                source: ErrorSource.RULE_VALIDATION,
                reason: SignedQuantityErrorReason.RESULT_CROSSES_ZERO,
                original: original.toString(),
                result: result.toString()
              }
            }
          )
        );
      }
    }

    return Ok(undefined);
  }
}
