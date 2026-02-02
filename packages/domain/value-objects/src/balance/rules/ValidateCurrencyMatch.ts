import { Result, Ok, Err } from '@polymarket/result';
import { InvalidBalanceError } from '@polymarket/errors';
import { Money } from '../../money/core/Money.js';
import type { SupportedCurrency } from '../../money/core/Money.js';
import { BalanceErrorReason } from '../errors/BalanceErrorReason.js';

/**
 * Правило: Валюта amount должна совпадать с валютой баланса
 *
 * @remarks
 * Policy для операций reserve(), release(), updateAvailable() баланса.
 *
 * Проверяет:
 * - amount.currency() === balanceCurrency (нельзя резервировать/освобождать средства в другой валюте)
 *
 * Возвращает InvalidBalanceError — стандарт домена Polymarket для валидации Balance.
 *
 * **Когда применяется:**
 * - reserve(amount) - проверяем что amount в той же валюте что и баланс
 * - release(amount) - проверяем что amount в той же валюте что и баланс
 * - updateAvailable(amount) - проверяем что amount в той же валюте что и баланс
 *
 * **Когда НЕ применяется:**
 * - Balance.of() constructor - там валюты проверяются через инвариант
 * - Query методы (available(), reserved(), total()) - не меняют состояние
 *
 * @param amount - Money для проверки валюты
 * @param balanceCurrency - Валюта баланса
 * @returns Result<void, InvalidBalanceError>
 *
 * @example
 * ```typescript
 * import { ValidateCurrencyMatch } from '@polymarket/value-objects/balance';
 * import { Money } from '@polymarket/value-objects/money';
 *
 * const balanceCurrency = 'USDC';
 * const amount = Money.fromUSDC(1000);
 *
 * // ✅ Валюты совпадают
 * const result1 = ValidateCurrencyMatch.check(amount, balanceCurrency);
 * // result1.ok === true
 *
 * // ❌ Валюты не совпадают
 * const amountBTC = Money.of(1, 'BTC');
 * const result2 = ValidateCurrencyMatch.check(amountBTC, balanceCurrency);
 * if (!result2.ok) {
 *   console.error(result2.error.context?.reason);
 *   // BalanceErrorReason.CURRENCY_MISMATCH
 *   console.error(result2.error.context?.expected); // 'USDC'
 *   console.error(result2.error.context?.actual);   // 'BTC'
 * }
 * ```
 */
export class ValidateCurrencyMatch {
  public static check(
    amount: Money,
    balanceCurrency: SupportedCurrency
  ): Result<void, InvalidBalanceError> {
    const amountCurrency = amount.currency();

    // Проверка: валюты должны совпадать
    if (amountCurrency !== balanceCurrency) {
      return Err(
        new InvalidBalanceError(
          (ctx) =>
            `Currency mismatch: expected ${ctx.expected}, got ${ctx.actual}`,
          {
            context: {
              reason: BalanceErrorReason.CURRENCY_MISMATCH,
              expected: balanceCurrency,
              actual: amountCurrency
            }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
