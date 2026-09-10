import { Result, Ok, Err } from '@polymarket/result';
import { ErrorSource } from '@polymarket/errors';
import type { InstrumentId } from '@polymarket/ids';
import { InvalidTokenBalanceError } from '../errors/InvalidTokenBalanceError.js';
import { TokenBalanceErrorReason } from '../errors/TokenBalanceErrorReason.js';

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
export class ValidateTokenMatch {
  public static check(
    token1: InstrumentId,
    token2: InstrumentId
  ): Result<void, InvalidTokenBalanceError> {
    // Проверка: инструменты должны совпадать
    if (token1 !== token2) {
      return Err(
        new InvalidTokenBalanceError(
          (ctx: Record<string, unknown>) =>
            `Token mismatch: ${ctx.token1} vs ${ctx.token2}`,
          {
            context: {
              source: ErrorSource.RULE_VALIDATION,
              reason: TokenBalanceErrorReason.TOKEN_MISMATCH,
              token1: String(token1),
              token2: String(token2),
              token1AssetId: String(token1),
              token2AssetId: String(token2)
            }
          }
        )
      );
    }

    return Ok(undefined);
  }
}
