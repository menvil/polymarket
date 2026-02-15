import { OutcomeTokenFormatter } from '../../outcome-token/adapters/OutcomeTokenFormatter.js';
import { TokenBalance } from '../core/TokenBalance.js';

/**
 * Форматтер для TokenBalance
 *
 * @remarks
 * Предоставляет методы для форматирования TokenBalance в строки
 * для UI и логирования.
 *
 * Все методы безопасны и не бросают исключений.
 *
 * @example
 * ```typescript
 * import { TokenBalanceService, TokenBalanceFormatter } from '@polymarket/value-objects/token-balance';
 * import { OutcomeTokenService } from '@polymarket/value-objects/outcome-token';
 * import { QuantityService } from '@polymarket/value-objects/quantity';
 * import { BinaryOutcome, KnownVenues, accountIdFromWallet, parseWalletAddress } from '@polymarket/ids';
 *
 * const token = expectOk(OutcomeTokenService.create(onChainRef, BinaryOutcome.UP));
 * const qty = expectOk(QuantityService.create(100.5));
 * const walletAddress = parseWalletAddress('0x1234567890123456789012345678901234567890')!;
 * const accountId = accountIdFromWallet(walletAddress);
 * const balance = expectOk(TokenBalanceService.create(token, qty, accountId, KnownVenues.POLYMARKET));
 *
 * const display = TokenBalanceFormatter.toDisplayString(balance);
 * console.log(display);  // "100.5 UP (POLYMARKET_CTF:137:0xabc...)"
 *
 * const short = TokenBalanceFormatter.toShortString(balance);
 * console.log(short);    // "100.5 UP"
 * ```
 */
export class TokenBalanceFormatter {
  /**
   * Форматирует TokenBalance как полную строку с деталями
   *
   * @remarks
   * Включает amount, outcomeKey и детальную информацию о token.
   * Используется для логирования и диагностики.
   *
   * @param balance - TokenBalance для форматирования
   * @returns Отформатированная строка
   *
   * @example
   * ```typescript
   * const balance = expectOk(TokenBalanceService.create(token, qty, accountId, venueId));
   *
   * const str = TokenBalanceFormatter.toString(balance);
   * // → "TokenBalance[amount=100.5, token=OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0xabc...:UP]"
   * ```
   */
  public static toString(balance: TokenBalance): string {
    const amount = balance.amount().value().toString();
    const tokenStr = OutcomeTokenFormatter.toString(balance.token());

    return `TokenBalance[amount=${amount}, token=${tokenStr}]`;
  }

  /**
   * Форматирует TokenBalance для отображения в UI
   *
   * @remarks
   * Более читаемый формат с amount, outcomeKey и кратким описанием protocol/chain.
   * Используется для UI элементов.
   *
   * @param balance - TokenBalance для форматирования
   * @returns Human-readable строка
   *
   * @example
   * ```typescript
   * const balance = expectOk(TokenBalanceService.create(token, qty, accountId, venueId));
   *
   * const display = TokenBalanceFormatter.toDisplayString(balance);
   * // → "100.5 UP (POLYMARKET_CTF:137:0xabc...)"
   * ```
   */
  public static toDisplayString(balance: TokenBalance): string {
    const amount = balance.amount().value().toString();
    const tokenDisplay = OutcomeTokenFormatter.toDisplayString(balance.token());

    return `${amount} ${tokenDisplay}`;
  }

  /**
   * Форматирует TokenBalance в краткую строку (amount + outcome key)
   *
   * @remarks
   * Минимальное представление - amount и ключ outcome.
   * Используется для компактного отображения в таблицах и списках.
   *
   * @param balance - TokenBalance для форматирования
   * @returns Краткая строка (amount + outcome key)
   *
   * @example
   * ```typescript
   * const balance = expectOk(TokenBalanceService.create(token, qty, accountId, venueId));
   *
   * const short = TokenBalanceFormatter.toShortString(balance);
   * // → "100.5 UP"
   * ```
   */
  public static toShortString(balance: TokenBalance): string {
    const amount = balance.amount().value().toString();
    const outcomeKey = balance.outcomeKey() as string;

    return `${amount} ${outcomeKey}`;
  }

  /**
   * Форматирует TokenBalance с полной информацией
   *
   * @remarks
   * Включает все детали token и amount для debug/logging.
   * Используется для подробного логирования.
   *
   * @param balance - TokenBalance для форматирования
   * @returns Детальная строка с полной информацией
   *
   * @example
   * ```typescript
   * const balance = expectOk(TokenBalanceService.create(token, qty, accountId, venueId));
   *
   * const verbose = TokenBalanceFormatter.toVerboseString(balance);
   * // → "TokenBalance[amount=100.5, token=OutcomeToken[outcomeKey=UP, condition=ONCHAIN:POLYMARKET_CTF:137:0xabc...]]"
   * ```
   */
  public static toVerboseString(balance: TokenBalance): string {
    const amount = balance.amount().value().toString();
    const tokenVerbose = OutcomeTokenFormatter.toVerboseString(balance.token());

    return `TokenBalance[amount=${amount}, token=${tokenVerbose}]`;
  }

  /**
   * Форматирует amount с указанным числом десятичных знаков
   *
   * @remarks
   * Удобный метод для форматирования amount с округлением.
   * Используется для отображения в UI с фиксированной точностью.
   *
   * @param balance - TokenBalance для форматирования
   * @param decimalPlaces - Количество десятичных знаков (по умолчанию 2)
   * @returns Отформатированная строка с округленным amount
   *
   * @example
   * ```typescript
   * const balance = expectOk(TokenBalanceService.create(token, qty, accountId, venueId));
   *
   * const formatted = TokenBalanceFormatter.toFixedString(balance, 2);
   * // → "100.50 UP"
   *
   * const formatted4 = TokenBalanceFormatter.toFixedString(balance, 4);
   * // → "100.5000 UP"
   * ```
   */
  public static toFixedString(balance: TokenBalance, decimalPlaces: number = 2): string {
    const amount = balance.amount().value().toFixed(decimalPlaces);
    const outcomeKey = balance.outcomeKey() as string;

    return `${amount} ${outcomeKey}`;
  }
}
