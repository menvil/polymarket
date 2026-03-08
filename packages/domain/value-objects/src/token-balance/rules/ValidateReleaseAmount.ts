import { Result, Ok, Err } from '@polymarket/result';
import { ErrorSource } from '@polymarket/errors';
import { Quantity } from '../../quantity/core/Quantity.js';
import { InvalidTokenBalanceError } from '../errors/InvalidTokenBalanceError.js';
import { TokenBalanceErrorReason } from '../errors/TokenBalanceErrorReason.js';

/**
 * Правило: Освобождаемое/списываемое количество должно быть <= зарезервированным токенам
 *
 * @remarks
 * Policy для операций unfreezeReserved() и consumeReserved() баланса токенов.
 *
 * Проверяет:
 * - releaseQty <= reserved (достаточно зарезервированных токенов для освобождения/списания)
 * - releaseQty > 0 (нельзя освобождать нулевое или отрицательное количество)
 * - releaseQty isFinite (защита от Infinity/NaN)
 *
 * Возвращает InvalidTokenBalanceError — стандарт домена Polymarket для валидации TokenBalance.
 *
 * @param releaseQty - Количество для освобождения/списания
 * @param reserved - Зарезервированные токены
 * @returns Result<void, InvalidTokenBalanceError>
 *
 * @example
 * ```typescript
 * import { ValidateReleaseAmount } from '@polymarket/value-objects/token-balance';
 * import { Quantity } from '@polymarket/value-objects/quantity';
 * import Decimal from 'decimal.js';
 *
 * const reserved = Quantity.of(new Decimal(50));
 * const releaseQty = Quantity.of(new Decimal(20));
 *
 * // ✅ Достаточно зарезервированных токенов
 * const result1 = ValidateReleaseAmount.check(releaseQty, reserved);
 * // result1.ok === true
 *
 * // ❌ Недостаточно зарезервированных токенов
 * const result2 = ValidateReleaseAmount.check(
 *   Quantity.of(new Decimal(100)),
 *   reserved
 * );
 * if (!result2.ok) {
 *   console.error(result2.error.context?.reason);
 *   // TokenBalanceErrorReason.INSUFFICIENT_RESERVED
 * }
 *
 * // ❌ Попытка освободить 0 или отрицательное количество
 * const result3 = ValidateReleaseAmount.check(
 *   Quantity.ZERO,
 *   reserved
 * );
 * if (!result3.ok) {
 *   console.error(result3.error.context?.reason);
 *   // TokenBalanceErrorReason.INVALID_FORMAT
 * }
 * ```
 */
export class ValidateReleaseAmount {
  public static check(
    releaseQty: Quantity,
    reserved: Quantity
  ): Result<void, InvalidTokenBalanceError> {
    const amount = releaseQty.value();
    const reservedAmount = reserved.value();

    // Проверка 1: releaseQty должен быть finite
    if (!amount.isFinite()) {
      return Err(
        new InvalidTokenBalanceError('Release quantity must be finite', {
          context: {
            source: ErrorSource.RULE_VALIDATION,
            reason: TokenBalanceErrorReason.INVALID_FORMAT,
            releaseQty: amount.toString(),
            reserved: reservedAmount.toString()
          }
        })
      );
    }

    // Проверка 2: releaseQty должен быть > 0
    if (amount.lessThanOrEqualTo(0)) {
      return Err(
        new InvalidTokenBalanceError(
          (ctx: Record<string, unknown>) => `Release quantity must be positive, got ${ctx.releaseQty}`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              reason: TokenBalanceErrorReason.INVALID_FORMAT,
              releaseQty: amount.toString(),
              reserved: reservedAmount.toString()
            }
          }
        )
      );
    }

    // Проверка 3: releaseQty <= reserved (основная проверка)
    if (amount.greaterThan(reservedAmount)) {
      return Err(
        new InvalidTokenBalanceError(
          (ctx: Record<string, unknown>) =>
            `Cannot release ${ctx.requested}: only ${ctx.reserved} reserved`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              reason: TokenBalanceErrorReason.INSUFFICIENT_RESERVED,
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
