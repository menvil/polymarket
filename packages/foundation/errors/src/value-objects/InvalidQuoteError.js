/**
 * InvalidQuoteError - ошибка валидации котировки
 *
 * @remarks
 * Выбрасывается когда котировка маркет-мейкера невалидна.
 * Уровень серьезности: low (проблемы валидации данных не критичны).
 *
 * Причины невалидности:
 * - Отсутствуют и bid, и ask
 * - bid >= ask (для двухсторонних котировок)
 * - Отрицательные размеры
 * - Несоответствие размеров и цен (null bid с ненулевым bidSize)
 *
 * @example
 * ```typescript
 * import { InvalidQuoteError } from '@polymarket/errors';
 *
 * // Статическое сообщение
 * throw new InvalidQuoteError('Quote must have at least bid or ask', {
 *   code: InvalidQuoteError.code
 * });
 *
 * // С контекстом для отладки
 * throw new InvalidQuoteError(
 *   `Bid ${bid} must be less than ask ${ask}`,
 *   {
 *     code: InvalidQuoteError.code,
 *     context: { bid, ask }
 *   }
 * );
 * ```
 */
import { TradingError } from '../base/index.js';
export class InvalidQuoteError extends TradingError {
    severity = 'low';
    static code = 'INVALID_QUOTE';
}
//# sourceMappingURL=InvalidQuoteError.js.map