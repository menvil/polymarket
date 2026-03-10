import { TradingError } from '../base/index.js';
import type { ErrorSeverity } from '../base/index.js';
/**
 * Ошибка превышения лимита вложенности субаккаунта
 *
 * @remarks
 * Выбрасывается при попытке создать AccountId с глубиной вложенности
 * превышающей максимально допустимую (MAX_SUBACCOUNT_DEPTH).
 *
 * Уровень серьёзности: medium — превышение лимита означает некорректное
 * использование API, а не критическую системную ошибку.
 *
 * Контекст ошибки содержит:
 * - `currentDepth` — текущая глубина вложенности
 * - `maxDepth` — максимально допустимая глубина
 * - `operation` — операция при которой возникла ошибка ('create' | 'serialize')
 *
 * @example
 * ```typescript
 * import { AccountIdDepthError } from '@polymarket/errors';
 *
 * return Err(new AccountIdDepthError(
 *   (ctx) => `Subaccount depth limit exceeded during ${ctx.operation}: current=${ctx.currentDepth}, max=${ctx.maxDepth}`,
 *   {
 *     context: { currentDepth: 6, maxDepth: 5, operation: 'create' }
 *   }
 * ));
 *
 * // Проверка типа
 * if (AccountIdDepthError.is(error)) {
 *   console.log('Depth exceeded:', error.context?.currentDepth);
 * }
 * ```
 */
export declare class AccountIdDepthError extends TradingError {
    readonly severity: ErrorSeverity;
    /**
     * Рекомендуемый код ошибки
     */
    static readonly code = "ACCOUNT_ID_DEPTH_EXCEEDED";
}
//# sourceMappingURL=AccountIdDepthError.d.ts.map