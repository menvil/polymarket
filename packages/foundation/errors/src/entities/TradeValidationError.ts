/**
 * TradeValidationError - ошибка валидации сделки
 *
 * @remarks
 * Выбрасывается когда данные сделки (Trade entity) не проходят валидацию.
 * Может возникать при создании сделки или обработке событий из Polymarket API.
 *
 * Типичные случаи:
 * - Невалидный ID сделки
 * - Отсутствующий marketId
 * - Отсутствующий tokenId
 * - Невалидная цена (вне диапазона [0.0001, 0.9999])
 * - Невалидное количество (отрицательное или ноль)
 * - Некорректная сторона сделки (должно быть 'BUY' или 'SELL')
 * - Невалидный timestamp
 *
 * Уровень серьезности: low (проблемы валидации данных не критичны).
 *
 * @example
 * ```typescript
 * import { TradeValidationError } from '@polymarket/errors';
 *
 * // Статическое сообщение
 * throw new TradeValidationError('Invalid trade: missing marketId');
 *
 * // С кодом и контекстом для отладки (рекомендуется)
 * throw new TradeValidationError('Invalid trade side', {
 *   code: TradeValidationError.code,
 *   context: { tradeId: 'trade-123', side: 'INVALID' }
 * });
 *
 * // Динамическое сообщение из контекста
 * throw new TradeValidationError(
 *   (ctx) => `Trade ${ctx.tradeId} validation failed: ${ctx.reason}`,
 *   {
 *     code: TradeValidationError.code,
 *     context: { tradeId: 'trade-123', reason: 'price must be in range [0.0001, 0.9999]' }
 *   }
 * );
 * // "Trade trade-123 validation failed: price must be in range [0.0001, 0.9999]"
 *
 * // Проверка типа ошибки
 * try {
 *   Trade.create({ id: '', marketId: '', tokenId: '', price: -1, size: 0, side: 'BUY' });
 * } catch (error) {
 *   if (TradeValidationError.is(error)) {
 *     console.log('Error code:', error.code); // 'TRADE_VALIDATION_ERROR'
 *     console.log('Trade ID:', error.context?.tradeId);
 *     console.log('Reason:', error.context?.reason);
 *   }
 * }
 * ```
 */

import { TradingError, ErrorSeverity } from '../base/index.js';

/**
 * TradeValidationError - ошибка валидации сделки
 *
 * @remarks
 * Уровень серьезности: low (незначительная)
 * Рекомендуемый код ошибки: TRADE_VALIDATION_ERROR
 */
export class TradeValidationError extends TradingError {
  public readonly severity: ErrorSeverity = 'low';

  /**
   * Рекомендуемый код ошибки
   *
   * @remarks
   * Используйте этот код при создании ошибки:
   * ```typescript
   * throw new TradeValidationError('message', {
   *   code: TradeValidationError.code,
   *   context: { ... }
   * });
   * ```
   */
  public static readonly code = 'TRADE_VALIDATION_ERROR';
}
