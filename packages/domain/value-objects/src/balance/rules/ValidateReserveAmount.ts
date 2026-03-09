import { Result, Ok, Err } from '@polymarket/result';
import { InvalidBalanceError, ErrorSource } from '@polymarket/errors';
import { Money } from '../../money/core/Money.js';
import { BalanceErrorReason } from '../errors/BalanceErrorReason.js';

/**
 * Правило: Резервируемая сумма должна быть <= доступным средствам
 *
 * @remarks
 * Policy для операции reserve() баланса.
 *
 * Проверяет:
 * - reserveAmount <= available (достаточно средств для резервирования)
 * - reserveAmount > 0 (нельзя резервировать нулевую или отрицательную сумму)
 * - reserveAmount isFinite (защита от Infinity/NaN)
 *
 * Возвращает InvalidBalanceError — стандарт домена Polymarket для валидации Balance.
 *
 * **ВАЖНО:** Не проверяет валюту — это делает отдельное правило ValidateCurrencyMatch.
 *
 * @param reserveAmount - Сумма для резервирования
 * @param available - Доступные средства
 * @returns Result<void, InvalidBalanceError>
 *
 * @example
 * ```typescript
 * import { ValidateReserveAmount } from '@polymarket/value-objects/balance';
 * import { Money } from '@polymarket/value-objects/money';
 *
 * const available = Money.fromUSDC(10000);
 * const reserveAmount = Money.fromUSDC(5000);
 *
 * // ✅ Достаточно средств
 * const result1 = ValidateReserveAmount.check(reserveAmount, available);
 * // result1.ok === true
 *
 * // ❌ Недостаточно средств
 * const result2 = ValidateReserveAmount.check(
 *   Money.fromUSDC(15000),
 *   available
 * );
 * if (!result2.ok) {
 *   console.error(result2.error.context?.reason);
 *   // BalanceErrorReason.INSUFFICIENT_FUNDS
 * }
 *
 * // ❌ Попытка резервировать 0 или отрицательную сумму
 * const result3 = ValidateReserveAmount.check(
 *   Money.fromUSDC(0),
 *   available
 * );
 * if (!result3.ok) {
 *   console.error(result3.error.context?.reason);
 *   // BalanceErrorReason.INVALID_FORMAT
 * }
 * ```
 */
export class ValidateReserveAmount {
  public static check(
    reserveAmount: Money,
    available: Money
  ): Result<void, InvalidBalanceError> {
    const amount = reserveAmount.value();
    const availableAmount = available.value();

    // Проверка 1: reserveAmount должен быть finite
    if (!amount.isFinite()) {
      return Err(
        new InvalidBalanceError('Reserve amount must be finite', {
          context: {
            source: ErrorSource.RULE_VALIDATION,
            reason: BalanceErrorReason.INVALID_FORMAT,
            reserveAmount: amount.toString(),
            available: availableAmount.toString()
          }
        })
      );
    }

    // Проверка 2: reserveAmount должен быть > 0
    if (amount.lessThanOrEqualTo(0)) {
      return Err(
        new InvalidBalanceError(
          (ctx) => `Reserve amount must be positive, got ${ctx.reserveAmount}`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              reason: BalanceErrorReason.INVALID_FORMAT,
              reserveAmount: amount.toString(),
              available: availableAmount.toString()
            }
          }
        )
      );
    }

    // Проверка 3: reserveAmount <= available (основная проверка)
    if (amount.greaterThan(availableAmount)) {
      return Err(
        new InvalidBalanceError(
          (ctx) =>
            `Cannot reserve ${ctx.requested}: only ${ctx.available} available`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              reason: BalanceErrorReason.INSUFFICIENT_FUNDS,
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
