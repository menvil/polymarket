import { Result, Ok, Err } from '@polymarket/result';
import { InvalidBalanceError, ErrorSource } from '@polymarket/errors';
import { Money } from '../../money/core/Money';
import { BalanceErrorReason } from '../errors/BalanceErrorReason';

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
 * import Decimal from 'decimal.js';
 *
 * const available = Money.of(new Decimal(10000), 'USDC');
 * const reserveAmount = Money.of(new Decimal(5000), 'USDC');
 *
 * // ✅ Достаточно средств
 * const result1 = ValidateReserveAmount.check(reserveAmount, available);
 * // result1.ok === true
 *
 * // ❌ Недостаточно средств
 * const result2 = ValidateReserveAmount.check(
 *   Money.of(new Decimal(15000), 'USDC'),
 *   available
 * );
 * if (!result2.ok) {
 *   console.error(result2.error.context?.reason);
 *   // BalanceErrorReason.INSUFFICIENT_FUNDS
 * }
 *
 * // ❌ Попытка резервировать 0 или отрицательную сумму
 * const result3 = ValidateReserveAmount.check(
 *   Money.of(new Decimal(0), 'USDC'),
 *   available
 * );
 * if (!result3.ok) {
 *   console.error(result3.error.context?.reason);
 *   // BalanceErrorReason.INVALID_FORMAT
 * }
 * ```
 */
export class ValidateReserveAmount {
  private constructor() {
    // Static-only class — нельзя создавать экземпляры
  }

  public static check(
    reserveAmount: Money,
    available: Money
  ): Result<void, InvalidBalanceError> {
    const amount = reserveAmount.value();
    const availableAmount = available.value();

    // Проверка 1: reserveAmount должен быть > 0
    // Примечание: проверка isFinite не нужна - Money.of() гарантирует finite значения через инварианты
    if (amount.lessThanOrEqualTo(0)) {
      return Err(
        new InvalidBalanceError(
          (ctx) => `Reserve amount must be positive, got ${ctx.requested}`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              reason: BalanceErrorReason.INVALID_FORMAT,
              requested: amount.toNumber(),
              available: availableAmount.toNumber()
            }
          }
        )
      );
    }

    // Проверка 2: reserveAmount <= available (основная проверка)
    if (amount.greaterThan(availableAmount)) {
      return Err(
        new InvalidBalanceError(
          (ctx) =>
            `Cannot reserve ${ctx.requested}: only ${ctx.available} available`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              reason: BalanceErrorReason.INSUFFICIENT_FUNDS,
              requested: amount.toNumber(),
              available: availableAmount.toNumber()
            }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
