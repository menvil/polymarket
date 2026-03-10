/**
 * InvalidSpreadError - ошибка валидации спреда
 *
 * @remarks
 * Выбрасывается когда спред невалиден (bid > ask).
 * Уровень серьезности: low (проблемы валидации данных не критичны).
 *
 * @example
 * ```typescript
 * import { InvalidSpreadError } from '@polymarket/errors';
 *
 * // Динамическое сообщение из контекста
 * throw new InvalidSpreadError(
 *   (ctx) => `Invalid spread: bid (${ctx.bid}) must be <= ask (${ctx.ask})`,
 *   {
 *     code: InvalidSpreadError.code,
 *     context: { bid: 0.6, ask: 0.5 }
 *   }
 * );
 * ```
 */
import { TradingError } from '../base/index.js';
export class InvalidSpreadError extends TradingError {
    severity = 'low';
    static code = 'INVALID_SPREAD';
}
//# sourceMappingURL=InvalidSpreadError.js.map