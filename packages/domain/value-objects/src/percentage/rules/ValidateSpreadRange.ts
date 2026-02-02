import { Result, Ok, Err } from '@polymarket/result';
import { InvalidPercentageError } from '@polymarket/errors';
import { Percentage } from '../core/Percentage';
import { PercentageErrorReason } from '../core/PercentageErrorReason';

/**
 * Правило: Spread должен быть в допустимом диапазоне
 *
 * @remarks
 * Policy для валидации спреда в торговых операциях.
 *
 * Проверяет:
 * - spread >= MIN_SPREAD (минимальный допустимый спред)
 * - spread <= MAX_SPREAD (максимальный допустимый спред)
 *
 * Возвращает InvalidPercentageError — стандарт домена Polymarket для валидации Percentage.
 *
 * @param spread - Spread для проверки
 * @param minSpread - Минимальный допустимый спред (по умолчанию 0%)
 * @param maxSpread - Максимальный допустимый спред (по умолчанию 10%)
 * @returns Result<void, InvalidPercentageError>
 *
 * @example
 * ```typescript
 * const validSpread = Percentage.of(2);
 * const validateResult = ValidateSpreadRange.check(validSpread);
 * // validateResult.ok === true
 *
 * const tooLowSpread = Percentage.of(-0.5);
 * const lowResult = ValidateSpreadRange.check(tooLowSpread);
 * // lowResult.ok === false, reason: BELOW_MIN_SPREAD
 *
 * const tooHighSpread = Percentage.of(15);
 * const highResult = ValidateSpreadRange.check(tooHighSpread);
 * // highResult.ok === false, reason: EXCEEDS_MAX_SPREAD
 *
 * // Кастомные лимиты
 * const customSpread = Percentage.of(8);
 * const customResult = ValidateSpreadRange.check(
 *   customSpread,
 *   Percentage.of(1),   // minSpread: 1%
 *   Percentage.of(5)    // maxSpread: 5%
 * );
 * // customResult.ok === false (8% > 5%)
 * ```
 */
export class ValidateSpreadRange {
  /**
   * Минимальный допустимый спред по умолчанию: 0%
   */
  private static readonly DEFAULT_MIN_SPREAD = Percentage.ZERO;

  /**
   * Максимальный допустимый спред по умолчанию: 10%
   */
  private static readonly DEFAULT_MAX_SPREAD = Percentage.of(10);

  public static check(
    spread: Percentage,
    minSpread: Percentage = ValidateSpreadRange.DEFAULT_MIN_SPREAD,
    maxSpread: Percentage = ValidateSpreadRange.DEFAULT_MAX_SPREAD
  ): Result<void, InvalidPercentageError> {
    // Проверка 1: spread должен быть >= minSpread
    if (spread.isLessThan(minSpread)) {
      return Err(
        new InvalidPercentageError(
          `Spread ${spread.value()}% is below minimum ${minSpread.value()}%`,
          {
            context: {
              spread: spread.value().toString(),
              minSpread: minSpread.value().toString(),
              maxSpread: maxSpread.value().toString(),
              reason: PercentageErrorReason.BELOW_MIN_SPREAD
            }
          }
        )
      );
    }

    // Проверка 2: spread должен быть <= maxSpread
    if (spread.isGreaterThan(maxSpread)) {
      return Err(
        new InvalidPercentageError(
          `Spread ${spread.value()}% exceeds maximum ${maxSpread.value()}%`,
          {
            context: {
              spread: spread.value().toString(),
              minSpread: minSpread.value().toString(),
              maxSpread: maxSpread.value().toString(),
              reason: PercentageErrorReason.EXCEEDS_MAX_SPREAD
            }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
