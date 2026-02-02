import { Result, Ok, Err } from '@polymarket/result';
import { InvalidPercentageError } from '@polymarket/errors';
import { Percentage } from '../core/Percentage';
import { PercentageErrorReason } from '../core/PercentageErrorReason';

/**
 * Правило: Суммарная fee (комиссия) не должна превышать 10%
 *
 * @remarks
 * Policy для валидации суммарной комиссии в торговых операциях.
 *
 * Проверяет:
 * - totalFee <= 10% (максимальная суммарная комиссия)
 *
 * Возвращает InvalidPercentageError — стандарт домена Polymarket для валидации Percentage.
 *
 * Используется для проверки суммы всех комиссий (например, maker fee + taker fee).
 *
 * @param totalFee - Суммарная комиссия для проверки
 * @returns Result<void, InvalidPercentageError>
 *
 * @example
 * ```typescript
 * const validTotalFee = Percentage.of(8);
 * const validateResult = ValidateTotalFee.check(validTotalFee);
 * // validateResult.ok === true
 *
 * const tooHighFee = Percentage.of(12);
 * const invalidResult = ValidateTotalFee.check(tooHighFee);
 * // invalidResult.ok === false, reason: EXCEEDS_MAX_TOTAL_FEE
 *
 * // Пример с суммой комиссий
 * const makerFee = Percentage.of(3);
 * const takerFee = Percentage.of(4);
 * const addResult = PercentageService.add(makerFee, takerFee);
 * if (addResult.ok) {
 *   const totalFee = addResult.value;
 *   const validateResult = ValidateTotalFee.check(totalFee);
 *   // validateResult.ok === true (3% + 4% = 7% <= 10%)
 * }
 * ```
 */
export class ValidateTotalFee {
  /**
   * Максимальная суммарная комиссия: 10%
   */
  private static readonly MAX_TOTAL_FEE = Percentage.of(10);

  public static check(totalFee: Percentage): Result<void, InvalidPercentageError> {
    // Проверка: totalFee должна быть <= 10%
    if (totalFee.isGreaterThan(ValidateTotalFee.MAX_TOTAL_FEE)) {
      return Err(
        new InvalidPercentageError(
          `Total fee ${totalFee.value()}% exceeds maximum ${ValidateTotalFee.MAX_TOTAL_FEE.value()}%`,
          {
            context: {
              totalFee: totalFee.value().toString(),
              maxTotalFee: ValidateTotalFee.MAX_TOTAL_FEE.value().toString(),
              reason: PercentageErrorReason.EXCEEDS_MAX_TOTAL_FEE
            }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
