import { Result, Ok, Err } from '@polymarket/result';
import { InvalidPercentageError } from '@polymarket/errors';
import { Percentage } from '../core/Percentage';
import { PercentageErrorReason } from '../core/PercentageErrorReason';

/**
 * Правило: Fee для торговых операций должна быть в диапазоне [0%, 5%]
 *
 * @remarks
 * Policy для валидации торговых комиссий (trading fees).
 *
 * Проверяет:
 * - fee >= 0% (комиссии не могут быть отрицательными)
 * - fee <= 5% (максимальная торговая комиссия)
 *
 * Возвращает InvalidPercentageError — стандарт домена Polymarket для валидации Percentage.
 *
 * @param fee - Fee (комиссия) для проверки
 * @returns Result<void, InvalidPercentageError>
 *
 * @example
 * ```typescript
 * const validFee = Percentage.of(2.5);
 * const validateResult = ValidateFeeForTrading.check(validFee);
 * // validateResult.ok === true
 *
 * const negativeFee = Percentage.of(-0.5);
 * const negativeResult = ValidateFeeForTrading.check(negativeFee);
 * // negativeResult.ok === false, reason: NEGATIVE_FEE
 *
 * const tooHighFee = Percentage.of(6);
 * const highResult = ValidateFeeForTrading.check(tooHighFee);
 * // highResult.ok === false, reason: EXCEEDS_MAX_FEE
 * ```
 */
export class ValidateFeeForTrading {
  /**
   * Максимальная торговая комиссия: 5%
   */
  private static readonly MAX_TRADING_FEE = Percentage.of(5);

  public static check(fee: Percentage): Result<void, InvalidPercentageError> {
    // Проверка 1: fee должна быть >= 0
    if (fee.isNegative()) {
      return Err(
        new InvalidPercentageError('Trading fee cannot be negative', {
          context: {
            fee: fee.value().toString(),
            maxFee: ValidateFeeForTrading.MAX_TRADING_FEE.value().toString(),
            reason: PercentageErrorReason.NEGATIVE_FEE
          }
        })
      );
    }

    // Проверка 2: fee должна быть <= 5%
    if (fee.isGreaterThan(ValidateFeeForTrading.MAX_TRADING_FEE)) {
      return Err(
        new InvalidPercentageError(
          `Trading fee ${fee.value()}% exceeds maximum ${ValidateFeeForTrading.MAX_TRADING_FEE.value()}%`,
          {
            context: {
              fee: fee.value().toString(),
              maxFee: ValidateFeeForTrading.MAX_TRADING_FEE.value().toString(),
              reason: PercentageErrorReason.EXCEEDS_MAX_FEE
            }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
