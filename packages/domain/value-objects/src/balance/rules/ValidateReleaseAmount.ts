import { Result, Ok, Err } from '@polymarket/result';
import { InvalidBalanceError, ErrorSource } from '@polymarket/errors';
import { Money } from '../../money/core/Money';
import { BalanceErrorReason } from '../errors/BalanceErrorReason';

/**
 * Правило: Освобождаемая/списываемая сумма должна быть <= зарезервированным средствам
 *
 * @remarks
 * Policy для операций unfreezeReserved() и consumeReserved() баланса.
 *
 * Проверяет:
 * - releaseAmount <= reserved (достаточно зарезервированных средств для освобождения)
 * - releaseAmount > 0 (нельзя освобождать нулевую или отрицательную сумму)
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
 * import Decimal from 'decimal.js';
 *
 * const reserved = Money.of(new Decimal(5000), 'USDC');
 * const releaseAmount = Money.of(new Decimal(2000), 'USDC');
 *
 * // ✅ Достаточно зарезервированных средств
 * const result1 = ValidateReleaseAmount.check(releaseAmount, reserved);
 * // result1.ok === true
 *
 * // ❌ Недостаточно зарезервированных средств
 * const result2 = ValidateReleaseAmount.check(
 *   Money.of(new Decimal(10000), 'USDC'),
 *   reserved
 * );
 * if (!result2.ok) {
 *   console.error(result2.error.context?.reason);
 *   // BalanceErrorReason.INSUFFICIENT_RESERVED
 * }
 *
 * // ❌ Попытка освободить 0 или отрицательную сумму
 * const result3 = ValidateReleaseAmount.check(
 *   Money.of(new Decimal(0), 'USDC'),
 *   reserved
 * );
 * if (!result3.ok) {
 *   console.error(result3.error.context?.reason);
 *   // BalanceErrorReason.INVALID_FORMAT
 * }
 * ```
 */
export class ValidateReleaseAmount {
  private constructor() {
    // Static-only class — нельзя создавать экземпляры
  }

  public static check(
    releaseAmount: Money,
    reserved: Money
  ): Result<void, InvalidBalanceError> {
    const amount = releaseAmount.value();
    const reservedAmount = reserved.value();

    // Проверка 1: releaseAmount должен быть > 0
    // Примечание: проверка isFinite не нужна - Money.of() гарантирует finite значения через инварианты
    if (amount.lessThanOrEqualTo(0)) {
      return Err(
        new InvalidBalanceError(
          (ctx) => `Amount to unfreeze/consume must be positive, got ${ctx.requested}`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              reason: BalanceErrorReason.INVALID_FORMAT,
              requested: amount.toNumber(),
              reserved: reservedAmount.toNumber()
            }
          }
        )
      );
    }

    // Проверка 2: releaseAmount <= reserved (основная проверка)
    if (amount.greaterThan(reservedAmount)) {
      return Err(
        new InvalidBalanceError(
          (ctx) =>
            `Cannot unfreeze/consume ${ctx.requested}: only ${ctx.reserved} reserved`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
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
