import { Result } from '@polymarket/result';
import { InvalidBalanceError } from '@polymarket/errors';
import type { SupportedCurrency } from '@polymarket/ids';
import { Money } from '../../money/core/Money.js';
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
export declare class ValidateCurrencyMatch {
    static check(amount: Money, balanceCurrency: SupportedCurrency): Result<void, InvalidBalanceError>;
}
//# sourceMappingURL=ValidateCurrencyMatch.d.ts.map