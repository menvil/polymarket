import { Result, Ok, Err } from '@polymarket/result';
import { ErrorSource } from '@polymarket/errors';
import { Quantity } from '../../quantity/core/Quantity.js';
import { InvalidTokenBalanceError } from '../errors/InvalidTokenBalanceError.js';
import { TokenBalanceErrorReason } from '../errors/TokenBalanceErrorReason.js';

/**
 * Правило: Резервируемое количество должно быть <= доступным токенам
 *
 * @remarks
 * Policy для операции reserve() баланса токенов.
 *
 * Проверяет:
 * - reserveQty <= available (достаточно токенов для резервирования)
 * - reserveQty > 0 (нельзя резервировать нулевое или отрицательное количество)
 * - reserveQty isFinite (защита от Infinity/NaN)
 *
 * Возвращает InvalidTokenBalanceError — стандарт домена Polymarket для валидации TokenBalance.
 *
 * @param reserveQty - Количество для резервирования
 * @param available - Доступные токены
 * @returns Result<void, InvalidTokenBalanceError>
 *
 * @example
 * ```typescript
 * import { ValidateReserveAmount } from '@polymarket/value-objects/token-balance';
 * import { Quantity } from '@polymarket/value-objects/quantity';
 * import Decimal from 'decimal.js';
 *
 * const available = Quantity.of(new Decimal(100));
 * const reserveQty = Quantity.of(new Decimal(50));
 *
 * // ✅ Достаточно токенов
 * const result1 = ValidateReserveAmount.check(reserveQty, available);
 * // result1.ok === true
 *
 * // ❌ Недостаточно токенов
 * const result2 = ValidateReserveAmount.check(
 *   Quantity.of(new Decimal(150)),
 *   available
 * );
 * if (!result2.ok) {
 *   console.error(result2.error.context?.reason);
 *   // TokenBalanceErrorReason.INSUFFICIENT_AVAILABLE
 * }
 *
 * // ❌ Попытка резервировать 0 или отрицательное количество
 * const result3 = ValidateReserveAmount.check(
 *   Quantity.ZERO,
 *   available
 * );
 * if (!result3.ok) {
 *   console.error(result3.error.context?.reason);
 *   // TokenBalanceErrorReason.INVALID_FORMAT
 * }
 * ```
 */
export class ValidateReserveAmount {
  public static check(
    reserveQty: Quantity,
    available: Quantity
  ): Result<void, InvalidTokenBalanceError> {
    const amount = reserveQty.value();
    const availableAmount = available.value();

    // Проверка 1: reserveQty должен быть finite
    if (!amount.isFinite()) {
      return Err(
        new InvalidTokenBalanceError('Reserve quantity must be finite', {
          context: {
            source: ErrorSource.RULE_VALIDATION,
            reason: TokenBalanceErrorReason.INVALID_FORMAT,
            reserveQty: amount.toString(),
            available: availableAmount.toString()
          }
        })
      );
    }

    // Проверка 2: reserveQty должен быть > 0
    if (amount.lessThanOrEqualTo(0)) {
      return Err(
        new InvalidTokenBalanceError(
          (ctx: Record<string, unknown>) => `Reserve quantity must be positive, got ${ctx.reserveQty}`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              reason: TokenBalanceErrorReason.INVALID_FORMAT,
              reserveQty: amount.toString(),
              available: availableAmount.toString()
            }
          }
        )
      );
    }

    // Проверка 3: reserveQty <= available (основная проверка)
    if (amount.greaterThan(availableAmount)) {
      return Err(
        new InvalidTokenBalanceError(
          (ctx: Record<string, unknown>) =>
            `Cannot reserve ${ctx.requested}: only ${ctx.available} available`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              reason: TokenBalanceErrorReason.INSUFFICIENT_AVAILABLE,
              requested: amount.toString(),
              available: availableAmount.toString()
            }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
