import { Result, Ok } from '@polymarket/result';
import { wrapOp } from '@polymarket/errors';
import type { AccountId, VenueId } from '@polymarket/ids';
import { OutcomeToken } from '../../outcome-token/core/index.js';
import { Quantity } from '../../quantity/core/index.js';
import { TokenBalance } from '../core/index.js';
import { InvalidTokenBalanceError } from '../errors/index.js';

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
 * import { BinaryOutcome, KnownOnChainProtocols, KnownVenues, accountIdFromWallet, parseWalletAddress } from '@polymarket/ids';
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
 * const walletAddress = parseWalletAddress('0x1234567890123456789012345678901234567890')!;
 * const accountId = accountIdFromWallet(walletAddress);
 *
 * const balanceResult = TokenBalanceService.create(tokenResult.value, qtyResult.value, accountId, KnownVenues.POLYMARKET);
 * if (balanceResult.ok) {
 *   const balance = balanceResult.value;
 *   console.log(balance.amount().toNumber()); // 100
 *   console.log(balance.outcomeKey()); // 'UP'
 *   console.log(balance.accountId()); // accountId
 *   console.log(balance.venueId()); // 'POLYMARKET'
 * } else {
 *   console.error(balanceResult.error.message);
 *   console.error(balanceResult.error.context?.reason);
 * }
 * ```
 */
export class TokenBalanceService {
  private static readonly SERVICE_NAME = 'TokenBalanceService';

  /**
   * Создать TokenBalance из OutcomeToken, Quantity, AccountId и VenueId
   *
   * @param token - Outcome token
   * @param amount - Количество токенов (должно быть non-negative, уже проверено в Quantity)
   * @param accountId - ID аккаунта владельца баланса
   * @param venueId - ID площадки (venue) где находится баланс
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
   * import { accountIdFromWallet, parseWalletAddress, KnownVenues } from '@polymarket/ids';
   *
   * const token = expectOk(OutcomeTokenService.create(conditionRef, BinaryOutcome.UP));
   * const qty = expectOk(QuantityService.create(100));
   * const walletAddress = parseWalletAddress('0x1234567890123456789012345678901234567890')!;
   * const accountId = accountIdFromWallet(walletAddress);
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
    venueId: VenueId
  ): Result<TokenBalance, InvalidTokenBalanceError> {
    return wrapOp(
      TokenBalanceService.SERVICE_NAME,
      'create',
      {
        token: token?.assetId?.() ?? 'null',
        amount: amount?.value?.()?.toString() ?? 'null',
        accountId: accountId ?? 'null',
        venueId: venueId ?? 'null'
      },
      () => {
        // Create TokenBalance (may throw TokenBalanceInvariantViolation)
        const balance = TokenBalance.of(token, amount, accountId, venueId);
        return Ok(balance);
      },
      InvalidTokenBalanceError
    );
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
   * const balance1 = expectOk(TokenBalanceService.create(token, qty1, accountId, venueId));
   * const balance2 = expectOk(TokenBalanceService.create(token, qty2, accountId, venueId));
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
   * const balance = expectOk(TokenBalanceService.create(token, Quantity.ZERO, accountId, venueId));
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
   * const balance = expectOk(TokenBalanceService.create(token, qty, accountId, venueId));
   * const isPositive = TokenBalanceService.isPositive(balance); // true if qty > 0
   * ```
   */
  public static isPositive(balance: TokenBalance): boolean {
    return balance.isPositive();
  }
}
