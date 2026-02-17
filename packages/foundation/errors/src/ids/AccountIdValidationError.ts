import { TradingError } from '../base/index.js';
import type { ErrorSeverity } from '../base/index.js';

/**
 * Ошибка валидации поля AccountId (userId или name субаккаунта)
 *
 * @remarks
 * Выбрасывается при попытке создать AccountId с невалидным строковым полем.
 * Валидация обеспечивает корректность round-trip сериализации:
 * create → serialize → parse.
 *
 * Уровень серьёзности: low — ошибка входных данных, не системная проблема.
 *
 * Контекст ошибки содержит:
 * - `field` — имя поля ('userId' | 'name')
 * - `value` — невалидное значение
 * - `reason` — причина невалидности (например, 'contains separator character')
 *
 * @example
 * ```typescript
 * import { AccountIdValidationError } from '@polymarket/errors';
 *
 * return Err(new AccountIdValidationError(
 *   (ctx) => `Invalid ${ctx.field}: ${ctx.reason} (value: "${ctx.value}")`,
 *   {
 *     code: AccountIdValidationError.code,
 *     context: { field: 'userId', value: 'user:invalid', reason: 'contains separator character' }
 *   }
 * ));
 *
 * // Проверка типа
 * if (AccountIdValidationError.is(error)) {
 *   console.log('Invalid field:', error.context?.field);
 * }
 * ```
 */
export class AccountIdValidationError extends TradingError {
  public readonly severity: ErrorSeverity = 'low';

  /**
   * Рекомендуемый код ошибки
   */
  public static readonly code = 'INVALID_ACCOUNT_ID';
}
