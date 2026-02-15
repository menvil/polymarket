import Decimal from 'decimal.js';
import { Result, Ok, Err } from '@polymarket/result';
import { InvalidRatioError } from '@polymarket/errors';
import { RatioErrorReason } from '../errors/RatioErrorReason.js';

/**
 * Business rule: Ratio должен быть <= 1
 *
 * @remarks
 * Используется для операций типа `amount * (1 - ratio)`, где:
 * - Ratio > 1 приведёт к отрицательному результату
 * - Примеры: discount (скидка), fee (комиссия), slippage
 *
 * @example
 * ```typescript
 * // Discount 10% (0.1)
 * const discountRatio = new Decimal(0.1);
 * const check = ValidateRatioLteOne.check(discountRatio, 'fromPercent');
 * // OK: 0.1 <= 1
 *
 * // Invalid discount 150% (1.5)
 * const invalidDiscount = new Decimal(1.5);
 * const check2 = ValidateRatioLteOne.check(invalidDiscount, 'fromPercent');
 * // Err: 1.5 > 1, invalid для oneMinus()
 * ```
 */
export class ValidateRatioLteOne {
  /**
   * Проверить, что ratio <= 1
   *
   * @param value - Значение ratio (как Decimal)
   * @param operation - Название операции (для error context)
   * @returns Result<void, InvalidRatioError>
   */
  public static check(value: Decimal, operation: string): Result<void, InvalidRatioError> {
    if (value.greaterThan(1)) {
      return Err(
        new InvalidRatioError(`Ratio must be <= 1 for oneMinus() operations, got ${value.toString()}`, {
          context: {
            op: operation,
            ratioValue: value.toString(),
            reason: RatioErrorReason.GREATER_THAN_ONE,
            maxAllowed: '1',
          },
        })
      );
    }

    return Ok(undefined);
  }
}
