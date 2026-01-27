/**
 * PortfolioValidationError - ошибка валидации портфеля
 *
 * @remarks
 * Выбрасывается когда данные портфеля (Portfolio entity) не проходят валидацию.
 * Может возникать при создании или модификации портфеля.
 *
 * Типичные случаи:
 * - Невалидный ID портфеля (пустая строка)
 * - Отрицательный initial cash
 * - Отрицательный итоговый cash после операции
 * - Попытка освободить больше reserved cash, чем доступно
 * - Некорректные операции с cash (updateCash приводит к negative balance)
 *
 * Уровень серьезности: low (проблемы валидации данных не критичны).
 *
 * @example
 * ```typescript
 * import { PortfolioValidationError } from '@polymarket/errors';
 *
 * // Статическое сообщение
 * throw new PortfolioValidationError('Invalid portfolio: missing ID');
 *
 * // С кодом и контекстом для отладки (рекомендуется)
 * throw new PortfolioValidationError('Portfolio id must be a non-empty string', {
 *   code: PortfolioValidationError.code,
 *   context: { field: 'id', value: '' }
 * });
 *
 * // Динамическое сообщение из контекста
 * throw new PortfolioValidationError(
 *   (ctx) => `Portfolio ${ctx.portfolioId} validation failed: ${ctx.reason}`,
 *   {
 *     code: PortfolioValidationError.code,
 *     context: { portfolioId: 'p-123', reason: 'negative cash' }
 *   }
 * );
 * // "Portfolio p-123 validation failed: negative cash"
 *
 * // Проверка типа ошибки
 * try {
 *   Portfolio.create('', Money.fromUSDC(-100));
 * } catch (error) {
 *   if (PortfolioValidationError.is(error)) {
 *     console.log('Error code:', error.code); // 'PORTFOLIO_VALIDATION_ERROR'
 *     console.log('Portfolio ID:', error.context?.portfolioId);
 *     console.log('Field:', error.context?.field);
 *   }
 * }
 * ```
 */

import { TradingError, ErrorSeverity } from '../base/index.js';

/**
 * PortfolioValidationError - ошибка валидации портфеля
 *
 * @remarks
 * Уровень серьезности: low (незначительная)
 * Рекомендуемый код ошибки: PORTFOLIO_VALIDATION_ERROR
 */
export class PortfolioValidationError extends TradingError {
  public readonly severity: ErrorSeverity = 'low';

  /**
   * Рекомендуемый код ошибки
   *
   * @remarks
   * Используйте этот код при создании ошибки:
   * ```typescript
   * throw new PortfolioValidationError('message', {
   *   code: PortfolioValidationError.code,
   *   context: { ... }
   * });
   * ```
   */
  public static readonly code = 'PORTFOLIO_VALIDATION_ERROR';
}
