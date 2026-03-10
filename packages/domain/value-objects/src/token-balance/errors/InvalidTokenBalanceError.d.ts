import { TradingError, ErrorSeverity, ErrorSource } from '@polymarket/errors';
import { TokenBalanceErrorReason } from './TokenBalanceErrorReason.js';
/**
 * InvalidTokenBalanceError - ошибка валидации token balance
 *
 * @remarks
 * Выбрасывается когда token balance имеет некорректное значение:
 * - Невалидный token
 * - Невалидное количество (отрицательное, NaN, Infinity)
 * - Невалидный accountId
 * - Невалидный venueId
 *
 * Используется в TokenBalanceService для валидации операций с балансом токенов.
 * Уровень серьезности: low (проблемы валидации данных не критичны).
 *
 * @example
 * ```typescript
 * import { InvalidTokenBalanceError } from '@polymarket/value-objects';
 *
 * // Статическое сообщение
 * throw new InvalidTokenBalanceError('Token cannot be null');
 *
 * // С кодом и контекстом (рекомендуется)
 * throw new InvalidTokenBalanceError('Invalid token balance', {
 *   code: InvalidTokenBalanceError.code,
 *   context: { token: 'OUTCOME_TOKEN', amount: -100 }
 * });
 *
 * // Динамическое сообщение из контекста
 * throw new InvalidTokenBalanceError(
 *   (ctx) => `Amount cannot be negative: ${ctx.amount}`,
 *   {
 *     code: InvalidTokenBalanceError.code,
 *     context: { amount: -100, reason: 'INVALID_AMOUNT' }
 *   }
 * );
 * ```
 */
export declare class InvalidTokenBalanceError extends TradingError {
    readonly severity: ErrorSeverity;
    /**
     * Рекомендуемый код ошибки
     */
    static readonly code = "INVALID_TOKEN_BALANCE";
    /**
     * Создать InvalidTokenBalanceError из legacy формата (для обратной совместимости)
     *
     * @param message - Сообщение об ошибке
     * @param context - Контекст с reason и details
     * @param source - Источник ошибки
     * @returns InvalidTokenBalanceError в новом формате
     */
    static fromLegacy(message: string, context?: {
        reason?: TokenBalanceErrorReason;
        details?: unknown;
    }, source?: ErrorSource): InvalidTokenBalanceError;
}
//# sourceMappingURL=InvalidTokenBalanceError.d.ts.map