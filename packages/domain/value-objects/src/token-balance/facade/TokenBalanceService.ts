import { Result, Ok, Err } from '@polymarket/result';
import { ErrorSource } from '@polymarket/errors';
import type { AccountId, VenueId } from '@polymarket/ids';
import { OutcomeToken } from '../../outcome-token/core/index.js';
import { Quantity } from '../../quantity/core/index.js';
import { TokenBalance, TokenBalanceInvariantViolation } from '../core/index.js';
import { InvalidTokenBalanceError, TokenBalanceErrorReason } from '../errors/index.js';

/**
 * Фасад для работы с TokenBalance - публичный API
 *
 * @remarks
 * Единая точка входа для всех операций с token balances.
 * Оркестрирует Core + error handling.
 *
 * **Контракт "Never Throw":**
 * ВСЕ методы TokenBalanceService ГАРАНТИРОВАННО возвращают Result и НИКОГДА не бросают исключения.
 *
 * **Facade Error Contract:**
 * Любой Err из Facade содержит:
 * - message - человекочитаемое описание
 * - context.reason - типизированная причина (TokenBalanceErrorReason)
 * - context.details - дополнительная информация для диагностики
 * - context.source - источник ошибки (ErrorSource)
 *
 * @example
 * ```typescript
 * import { TokenBalanceService } from '@polymarket/value-objects/token-balance';
 * import { OutcomeTokenService } from '@polymarket/value-objects/outcome-token';
 * import { BinaryOutcome, KnownOnChainProtocols } from '@polymarket/ids';
 *
 * const tokenResult = OutcomeTokenService.create(conditionRef, BinaryOutcome.UP);
 * if (!tokenResult.ok) {
 *   console.error(tokenResult.error);
 *   return;
 * }
 *
 * const qtyResult = QuantityService.create(100);
 * if (!qtyResult.ok) {
 *   console.error(qtyResult.error);
 *   return;
 * }
 *
 * const balanceResult = TokenBalanceService.create(tokenResult.value, qtyResult.value);
 * if (balanceResult.ok) {
 *   const balance = balanceResult.value;
 *   console.log(balance.amount().toNumber()); // 100
 *   console.log(balance.outcomeKey()); // 'UP'
 * } else {
 *   console.error(balanceResult.error.message);
 *   console.error(balanceResult.error.context?.reason);
 * }
 * ```
 */
export class TokenBalanceService {
  /**
   * Создать TokenBalance из OutcomeToken, Quantity, AccountId и VenueId
   *
   * @param token - Outcome token
   * @param amount - Количество токенов (должно быть non-negative, уже проверено в Quantity)
   * @param accountId - ID аккаунта владельца баланса
   * @param venueId - ID площадки (venue) где находится баланс
   * @param source - Источник ошибки (опционально)
   * @returns Result с TokenBalance или InvalidTokenBalanceError
   *
   * @remarks
   * Никогда не бросает исключения - всегда возвращает Result.
   *
   * Возможные ошибки:
   * - INVALID_TOKEN: если token некорректен
   * - INVALID_AMOUNT: если amount некорректен
   *
   * @example
   * ```typescript
   * import { accountIdFromWallet, KnownVenues } from '@polymarket/ids';
   *
   * const token = expectOk(OutcomeTokenService.create(conditionRef, BinaryOutcome.UP));
   * const qty = expectOk(QuantityService.create(100));
   * const accountId = accountIdFromWallet('0x1234...').unwrap();
   *
   * const result = TokenBalanceService.create(token, qty, accountId, KnownVenues.POLYMARKET);
   * if (!result.ok) {
   *   if (result.error.context?.reason === TokenBalanceErrorReason.INVALID_AMOUNT) {
   *     console.error('Invalid amount');
   *   }
   * }
   * ```
   */
  public static create(
    token: OutcomeToken,
    amount: Quantity,
    accountId: AccountId,
    venueId: VenueId,
    source: ErrorSource = ErrorSource.SERVICE_CALL
  ): Result<TokenBalance, InvalidTokenBalanceError> {
    try {
      // Create TokenBalance (may throw TokenBalanceInvariantViolation, but unlikely)
      const balance = TokenBalance.of(token, amount, accountId, venueId);

      return Ok(balance);
    } catch (error) {
      // Catch TokenBalanceInvariantViolation and other unexpected errors
      if (error instanceof TokenBalanceInvariantViolation) {
        return Err(
          new InvalidTokenBalanceError(
            `Failed to create TokenBalance: ${error.message}`,
            {
              reason: error.reason || TokenBalanceErrorReason.INVALID_INPUT,
              details: { token, amount },
            },
            source
          )
        );
      }

      // Unexpected error
      return Err(
        new InvalidTokenBalanceError(
          `Unexpected error creating TokenBalance: ${error instanceof Error ? error.message : String(error)}`,
          {
            details: { token, amount, error: String(error) },
          },
          source
        )
      );
    }
  }

  /**
   * Сравнить два TokenBalance на равенство
   *
   * @param a - Первый TokenBalance
   * @param b - Второй TokenBalance
   * @returns true если балансы представляют одинаковый токен и количество
   *
   * @remarks
   * Never throws - безопасная утилита для сравнения.
   * Использует метод equals() из TokenBalance core.
   *
   * @example
   * ```typescript
   * const balance1 = expectOk(TokenBalanceService.create(token, qty1));
   * const balance2 = expectOk(TokenBalanceService.create(token, qty2));
   *
   * const same = TokenBalanceService.equals(balance1, balance2);
   * console.log(same); // → true if amounts equal
   * ```
   */
  public static equals(a: TokenBalance, b: TokenBalance): boolean {
    return a.equals(b);
  }

  /**
   * Проверяет что баланс нулевой
   *
   * @param balance - TokenBalance для проверки
   * @returns true если amount равно 0
   *
   * @remarks
   * Never throws - безопасная утилита для проверки.
   * Делегирует к balance.isZero().
   *
   * @example
   * ```typescript
   * const balance = expectOk(TokenBalanceService.create(token, Quantity.ZERO));
   * const isZero = TokenBalanceService.isZero(balance); // true
   * ```
   */
  public static isZero(balance: TokenBalance): boolean {
    return balance.isZero();
  }

  /**
   * Проверяет что баланс положительный
   *
   * @param balance - TokenBalance для проверки
   * @returns true если amount > 0
   *
   * @remarks
   * Never throws - безопасная утилита для проверки.
   * Делегирует к balance.isPositive().
   *
   * @example
   * ```typescript
   * const balance = expectOk(TokenBalanceService.create(token, qty));
   * const isPositive = TokenBalanceService.isPositive(balance); // true if qty > 0
   * ```
   */
  public static isPositive(balance: TokenBalance): boolean {
    return balance.isPositive();
  }
}
