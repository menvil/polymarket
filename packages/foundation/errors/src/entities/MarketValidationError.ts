/**
 * MarketValidationError - ошибка валидации рынка
 *
 * @remarks
 * Выбрасывается когда данные рынка (Market entity) не проходят валидацию.
 * Может возникать при создании или модификации рынка.
 *
 * Типичные случаи:
 * - Невалидный ID рынка
 * - Отсутствующий или пустой slug
 * - Некорректное количество outcome tokens (должно быть ровно 2)
 * - Невалидные названия outcome tokens
 * - Некорректный статус рынка
 *
 * Уровень серьезности: low (проблемы валидации данных не критичны).
 *
 * @example
 * ```typescript
 * import { MarketValidationError } from '@polymarket/errors';
 *
 * // Статическое сообщение
 * throw new MarketValidationError('Invalid market: missing slug');
 *
 * // С кодом и контекстом для отладки (рекомендуется)
 * throw new MarketValidationError('Invalid market slug', {
 *   code: MarketValidationError.code,
 *   context: { marketId: 'market-123', slug: '' }
 * });
 *
 * // Динамическое сообщение из контекста
 * throw new MarketValidationError(
 *   (ctx) => `Market ${ctx.marketId} validation failed: ${ctx.reason}`,
 *   {
 *     code: MarketValidationError.code,
 *     context: { marketId: 'market-123', reason: 'slug cannot be empty' }
 *   }
 * );
 * // "Market market-123 validation failed: slug cannot be empty"
 *
 * // Проверка типа ошибки
 * try {
 *   Market.create({ id: '', slug: '', question: '', outcomes: [] });
 * } catch (error) {
 *   if (MarketValidationError.is(error)) {
 *     console.log('Error code:', error.code); // 'MARKET_VALIDATION_ERROR'
 *     console.log('Market ID:', error.context?.marketId);
 *     console.log('Reason:', error.context?.reason);
 *   }
 * }
 * ```
 */

import { TradingError, ErrorSeverity } from '../base/index.js';

/**
 * MarketValidationError - ошибка валидации рынка
 *
 * @remarks
 * Уровень серьезности: low (незначительная)
 * Рекомендуемый код ошибки: MARKET_VALIDATION_ERROR
 */
export class MarketValidationError extends TradingError {
  public readonly severity: ErrorSeverity = 'low';

  /**
   * Рекомендуемый код ошибки
   *
   * @remarks
   * Используйте этот код при создании ошибки:
   * ```typescript
   * throw new MarketValidationError('message', {
   *   code: MarketValidationError.code,
   *   context: { ... }
   * });
   * ```
   */
  public static readonly code = 'MARKET_VALIDATION_ERROR';
}
