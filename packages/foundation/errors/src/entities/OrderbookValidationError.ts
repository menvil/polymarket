/**
 * OrderbookValidationError - ошибка валидации стакана ордеров
 *
 * @remarks
 * Выбрасывается когда данные стакана (Orderbook entity) не проходят валидацию.
 * Может возникать при создании или обновлении orderbook.
 *
 * Типичные случаи:
 * - Невалидный или пустой marketId
 * - Некорректный формат bids (не массив)
 * - Некорректный формат asks (не массив)
 * - Невалидные цены в уровнях стакана
 * - Невалидные количества в уровнях стакана
 * - Некорректный timestamp
 *
 * Уровень серьезности: low (проблемы валидации данных не критичны).
 *
 * @example
 * ```typescript
 * import { OrderbookValidationError } from '@polymarket/errors';
 *
 * // Статическое сообщение
 * throw new OrderbookValidationError('Invalid orderbook: missing marketId');
 *
 * // С кодом и контекстом для отладки (рекомендуется)
 * throw new OrderbookValidationError('Market ID must be a non-empty string', {
 *   code: OrderbookValidationError.code,
 *   context: { field: 'marketId', value: '' }
 * });
 *
 * // Динамическое сообщение из контекста
 * throw new OrderbookValidationError(
 *   (ctx) => `Orderbook validation failed for market ${ctx.marketId}: ${ctx.reason}`,
 *   {
 *     code: OrderbookValidationError.code,
 *     context: { marketId: 'market-123', reason: 'bids must be an array' }
 *   }
 * );
 * // "Orderbook validation failed for market market-123: bids must be an array"
 *
 * // Проверка типа ошибки
 * try {
 *   Orderbook.create('', { bids: [], asks: [] });
 * } catch (error) {
 *   if (OrderbookValidationError.is(error)) {
 *     console.log('Error code:', error.code); // 'ORDERBOOK_VALIDATION_ERROR'
 *     console.log('Market ID:', error.context?.marketId);
 *     console.log('Field:', error.context?.field);
 *   }
 * }
 * ```
 */

import { TradingError, ErrorSeverity } from '../base/index.js';

/**
 * OrderbookValidationError - ошибка валидации стакана ордеров
 *
 * @remarks
 * Уровень серьезности: low (незначительная)
 * Рекомендуемый код ошибки: ORDERBOOK_VALIDATION_ERROR
 */
export class OrderbookValidationError extends TradingError {
  public readonly severity: ErrorSeverity = 'low';

  /**
   * Рекомендуемый код ошибки
   *
   * @remarks
   * Используйте этот код при создании ошибки:
   * ```typescript
   * throw new OrderbookValidationError('message', {
   *   code: OrderbookValidationError.code,
   *   context: { ... }
   * });
   * ```
   */
  public static readonly code = 'ORDERBOOK_VALIDATION_ERROR';
}
