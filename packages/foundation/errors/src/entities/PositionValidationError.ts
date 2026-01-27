/**
 * PositionValidationError - ошибка валидации позиции
 *
 * @remarks
 * Выбрасывается когда данные позиции (Position или PositionLot entity) не проходят валидацию.
 * Может возникать при создании или модификации позиции или лота.
 *
 * Типичные случаи:
 * - Невалидный ID лота (пустая строка)
 * - Невалидный tokenId (пустая строка)
 * - Отрицательное или нулевое quantity в лоте
 * - Несоответствие tokenId при добавлении лота в позицию
 * - Несоответствие side при добавлении лота в позицию
 * - Ошибка вычисления средней цены (Price.fromValue failed)
 *
 * Уровень серьезности: low (проблемы валидации данных не критичны).
 *
 * @example
 * ```typescript
 * import { PositionValidationError } from '@polymarket/errors';
 *
 * // Статическое сообщение
 * throw new PositionValidationError('Invalid position lot: missing ID');
 *
 * // С кодом и контекстом для отладки (рекомендуется)
 * throw new PositionValidationError('Lot ID must be a non-empty string', {
 *   code: PositionValidationError.code,
 *   context: { field: 'lotId', value: '' }
 * });
 *
 * // Динамическое сообщение из контекста
 * throw new PositionValidationError(
 *   (ctx) => `Token mismatch: lot ${ctx.lotTokenId} vs position ${ctx.positionTokenId}`,
 *   {
 *     code: PositionValidationError.code,
 *     context: { lotTokenId: 'token-1', positionTokenId: 'token-2', lotId: 'lot-123' }
 *   }
 * );
 * // "Token mismatch: lot token-1 vs position token-2"
 *
 * // Проверка типа ошибки
 * try {
 *   PositionLot.create('', 'token-1', 'YES', quantity, price, Date.now());
 * } catch (error) {
 *   if (PositionValidationError.is(error)) {
 *     console.log('Error code:', error.code); // 'POSITION_VALIDATION_ERROR'
 *     console.log('Lot ID:', error.context?.lotId);
 *     console.log('Field:', error.context?.field);
 *   }
 * }
 * ```
 */

import { TradingError, ErrorSeverity } from '../base/index.js';

/**
 * PositionValidationError - ошибка валидации позиции/лота
 *
 * @remarks
 * Уровень серьезности: low (незначительная)
 * Рекомендуемый код ошибки: POSITION_VALIDATION_ERROR
 */
export class PositionValidationError extends TradingError {
  public readonly severity: ErrorSeverity = 'low';

  /**
   * Рекомендуемый код ошибки
   *
   * @remarks
   * Используйте этот код при создании ошибки:
   * ```typescript
   * throw new PositionValidationError('message', {
   *   code: PositionValidationError.code,
   *   context: { ... }
   * });
   * ```
   */
  public static readonly code = 'POSITION_VALIDATION_ERROR';
}
