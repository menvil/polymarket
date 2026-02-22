import { Result, Ok, Err } from '@polymarket/result';
import { InvalidBalanceError, ErrorSource } from '@polymarket/errors';
import type { SupportedCurrency } from '@polymarket/ids';
import { Money } from '../../money/core/Money';
import { BalanceErrorReason } from '../errors/BalanceErrorReason';

/**
 * Правило: Валюта amount должна совпадать с валютой баланса
 *
 * @remarks
 * Policy для операций reserve(), unfreezeReserved(), consumeReserved(), updateAvailable() баланса.
 *
 * Проверяет:
 * - amount.currency() === balanceCurrency (нельзя резервировать/размораживать/списывать средства в другой валюте)
 *
 * Возвращает InvalidBalanceError — стандарт домена Polymarket для валидации Balance.
 *
 * **Когда применяется:**
 * - reserve(amount) - проверяем что amount в той же валюте что и баланс
 * - unfreezeReserved(amount) - проверяем что amount в той же валюте что и баланс
 * - consumeReserved(amount) - проверяем что amount в той же валюте что и баланс
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
 * import Decimal from 'decimal.js';
 *
 * const balanceCurrency = 'USDC';
 * const amount = Money.of(new Decimal(1000), 'USDC');
 *
 * // ✅ Валюты совпадают
 * const result1 = ValidateCurrencyMatch.check(amount, balanceCurrency);
 * // result1.ok === true
 *
 * // ❌ Валюты не совпадают (пример с другой поддерживаемой валютой, если добавлена)
 * // Если USDC - единственная валюта, этот кейс невозможен в runtime
 * // Но правило все равно проверяет совпадение для будущих валют
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
              source: ErrorSource.RULE_VALIDATION,
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
