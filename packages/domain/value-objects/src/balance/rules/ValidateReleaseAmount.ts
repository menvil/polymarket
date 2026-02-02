import { Result, Ok, Err } from '@polymarket/result';
import { InvalidBalanceError } from '@polymarket/errors';
import { Money } from '../../money/core/Money.js';
import { BalanceErrorReason } from '../errors/BalanceErrorReason.js';

/**
 * Правило: Освобождаемая сумма должна быть <= зарезервированным средствам
 *
 * @remarks
 * Policy для операции release() баланса.
 *
 * Проверяет:
 * - releaseAmount <= reserved (достаточно зарезервированных средств для освобождения)
 * - releaseAmount > 0 (нельзя освобождать нулевую или отрицательную сумму)
 * - releaseAmount isFinite (защита от Infinity/NaN)
 *
 * Возвращает InvalidBalanceError — стандарт домена Polymarket для валидации Balance.
 *
 * **ВАЖНО:** Не проверяет валюту — это делает отдельное правило ValidateCurrencyMatch.
 *
 * @param releaseAmount - Сумма для освобождения
 * @param reserved - Зарезервированные средства
 * @returns Result<void, InvalidBalanceError>
 *
 * @example
 * ```typescript
 * import { ValidateReleaseAmount } from '@polymarket/value-objects/balance';
 * import { Money } from '@polymarket/value-objects/money';
 *
 * const reserved = Money.fromUSDC(5000);
 * const releaseAmount = Money.fromUSDC(2000);
 *
 * // ✅ Достаточно зарезервированных средств
 * const result1 = ValidateReleaseAmount.check(releaseAmount, reserved);
 * // result1.ok === true
 *
 * // ❌ Недостаточно зарезервированных средств
 * const result2 = ValidateReleaseAmount.check(
 *   Money.fromUSDC(10000),
 *   reserved
 * );
 * if (!result2.ok) {
 *   console.error(result2.error.context?.reason);
 *   // BalanceErrorReason.INSUFFICIENT_RESERVED
 * }
 *
 * // ❌ Попытка освободить 0 или отрицательную сумму
 * const result3 = ValidateReleaseAmount.check(
 *   Money.fromUSDC(0),
 *   reserved
 * );
 * if (!result3.ok) {
 *   console.error(result3.error.context?.reason);
 *   // BalanceErrorReason.INVALID_FORMAT
 * }
 * ```
 */
export class ValidateReleaseAmount {
  public static check(
    releaseAmount: Money,
    reserved: Money
  ): Result<void, InvalidBalanceError> {
    const amount = releaseAmount.value();
    const reservedAmount = reserved.value();

    // Проверка 1: releaseAmount должен быть finite
    if (!amount.isFinite()) {
      return Err(
        new InvalidBalanceError('Release amount must be finite', {
          context: {
            reason: BalanceErrorReason.INVALID_FORMAT,
            releaseAmount: amount.toString(),
            reserved: reservedAmount.toString()
          }
        })
      );
    }

    // Проверка 2: releaseAmount должен быть > 0
    if (amount.lessThanOrEqualTo(0)) {
      return Err(
        new InvalidBalanceError(
          (ctx) => `Release amount must be positive, got ${ctx.releaseAmount}`,
          {
            context: {
              reason: BalanceErrorReason.INVALID_FORMAT,
              releaseAmount: amount.toString(),
              reserved: reservedAmount.toString()
            }
          }
        )
      );
    }

    // Проверка 3: releaseAmount <= reserved (основная проверка)
    if (amount.greaterThan(reservedAmount)) {
      return Err(
        new InvalidBalanceError(
          (ctx) =>
            `Cannot release ${ctx.requested}: only ${ctx.reserved} reserved`,
          {
            context: {
              reason: BalanceErrorReason.INSUFFICIENT_RESERVED,
              requested: amount.toNumber(),
              reserved: reservedAmount.toNumber()
            }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
