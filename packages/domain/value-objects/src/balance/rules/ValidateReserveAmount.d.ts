import { Result } from '@polymarket/result';
import { InvalidBalanceError } from '@polymarket/errors';
import { Money } from '../../money/core/Money.js';
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
export declare class ValidateReserveAmount {
    static check(reserveAmount: Money, available: Money): Result<void, InvalidBalanceError>;
}
//# sourceMappingURL=ValidateReserveAmount.d.ts.map