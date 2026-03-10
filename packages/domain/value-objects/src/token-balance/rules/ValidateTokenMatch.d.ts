import { Result } from '@polymarket/result';
import { OutcomeToken } from '../../outcome-token/core/OutcomeToken.js';
import { InvalidTokenBalanceError } from '../errors/InvalidTokenBalanceError.js';
/**
 * Правило: Токены должны совпадать
 *
 * @remarks
 * Policy для операций между балансами, требующих совпадения токенов.
 *
 * Проверяет:
 * - token1.equals(token2) (токены идентичны)
 *
 * Возвращает InvalidTokenBalanceError — стандарт домена Polymarket для валидации TokenBalance.
 *
 * @param token1 - Первый токен
 * @param token2 - Второй токен
 * @returns Result<void, InvalidTokenBalanceError>
 *
 * @example
 * ```typescript
 * import { ValidateTokenMatch } from '@polymarket/value-objects/token-balance';
 * import { OutcomeToken } from '@polymarket/value-objects/outcome-token';
 *
 * const token1 = OutcomeToken.of(conditionRef, 'UP');
 * const token2 = OutcomeToken.of(conditionRef, 'UP');
 * const token3 = OutcomeToken.of(conditionRef, 'DOWN');
 *
 * // ✅ Токены совпадают
 * const result1 = ValidateTokenMatch.check(token1, token2);
 * // result1.ok === true
 *
 * // ❌ Токены не совпадают
 * const result2 = ValidateTokenMatch.check(token1, token3);
 * if (!result2.ok) {
 *   console.error(result2.error.context?.reason);
 *   // TokenBalanceErrorReason.TOKEN_MISMATCH
 * }
 * ```
 */
export declare class ValidateTokenMatch {
    static check(token1: OutcomeToken, token2: OutcomeToken): Result<void, InvalidTokenBalanceError>;
}
//# sourceMappingURL=ValidateTokenMatch.d.ts.map