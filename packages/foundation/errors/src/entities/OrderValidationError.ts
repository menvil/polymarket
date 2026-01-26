/**
 * OrderValidationError - ошибка валидации ордера
 *
 * @remarks
 * Выбрасывается когда данные ордера (Order entity) не проходят валидацию.
 * Может возникать при создании или модификации ордера.
 *
 * Типичные случаи:
 * - Невалидный ID ордера
 * - Отсутствующий или пустой marketId/tokenId
 * - Некорректная сторона (side должна быть BUY или SELL)
 * - Невалидная цена (Price value object)
 * - Невалидный размер (Quantity value object)
 * - Некорректный статус ордера
 * - Filled size превышает order size
 * - Average fill price отсутствует при filled size > 0
 *
 * Уровень серьезности: low (проблемы валидации данных не критичны).
 *
 * @example
 * ```typescript
 * import { OrderValidationError } from '@polymarket/errors';
 *
 * // Статическое сообщение
 * throw new OrderValidationError('Invalid order: missing ID');
 *
 * // С кодом и контекстом для отладки (рекомендуется)
 * throw new OrderValidationError('Order ID must be a non-empty string', {
 *   code: OrderValidationError.code,
 *   context: { field: 'id', value: '' }
 * });
 *
 * // Динамическое сообщение из контекста
 * throw new OrderValidationError(
 *   (ctx) => `Order ${ctx.orderId} validation failed: ${ctx.reason}`,
 *   {
 *     code: OrderValidationError.code,
 *     context: { orderId: 'order-123', reason: 'invalid side' }
 *   }
 * );
 * // "Order order-123 validation failed: invalid side"
 *
 * // Проверка типа ошибки
 * try {
 *   Order.create({ id: '', marketId: '', tokenId: '', ... });
 * } catch (error) {
 *   if (OrderValidationError.is(error)) {
 *     console.log('Error code:', error.code); // 'ORDER_VALIDATION_ERROR'
 *     console.log('Order ID:', error.context?.orderId);
 *     console.log('Field:', error.context?.field);
 *   }
 * }
 * ```
 */

import { TradingError, ErrorSeverity } from '../base/index.js';

/**
 * OrderValidationError - ошибка валидации ордера
 *
 * @remarks
 * Уровень серьезности: low (незначительная)
 * Рекомендуемый код ошибки: ORDER_VALIDATION_ERROR
 */
export class OrderValidationError extends TradingError {
  public readonly severity: ErrorSeverity = 'low';

  /**
   * Рекомендуемый код ошибки
   *
   * @remarks
   * Используйте этот код при создании ошибки:
   * ```typescript
   * throw new OrderValidationError('message', {
   *   code: OrderValidationError.code,
   *   context: { ... }
   * });
   * ```
   */
  public static readonly code = 'ORDER_VALIDATION_ERROR';
}
