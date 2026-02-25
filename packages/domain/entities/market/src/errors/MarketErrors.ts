/**
 * Ошибки Market entity
 *
 * @remarks
 * Содержит ошибки специфичные для жизненного цикла рынка:
 * - MarketValidationError — ошибки валидации данных рынка
 * - MarketLifecycleError — нарушения допустимых переходов состояния
 */

import { TradingError, ValidationError } from '@polymarket/errors';

/**
 * MarketValidationError — ошибка валидации данных рынка
 *
 * @remarks
 * Выбрасывается в Market.create() при невалидных входных данных.
 * Уровень серьезности: low (пользователь может исправить данные).
 *
 * @example
 * ```typescript
 * const result = Market.create({ id: '', ... });
 * if (!result.ok) {
 *   if (MarketValidationError.is(result.error)) {
 *     console.log('Validation failed:', result.error.context?.field);
 *   }
 * }
 * ```
 */
export class MarketValidationError extends ValidationError {}

/**
 * MarketLifecycleError — нарушение жизненного цикла рынка
 *
 * @remarks
 * Выбрасывается при попытке выполнить недопустимый переход состояния:
 * - close() на CLOSED или RESOLVED рынке
 * - resolve() на ACTIVE или RESOLVED рынке
 *
 * Допустимые переходы: ACTIVE → CLOSED → RESOLVED
 *
 * Уровень серьезности: medium (нарушение бизнес-логики).
 *
 * @example
 * ```typescript
 * const market = Market.create({ ..., state: MarketState.closed() });
 * try {
 *   market.close(); // выбросит MarketLifecycleError
 * } catch (e) {
 *   if (MarketLifecycleError.is(e)) {
 *     console.log('Lifecycle error:', e.message);
 *     // "Cannot close market in CLOSED state. Market is already closed."
 *   }
 * }
 * ```
 */
export class MarketLifecycleError extends TradingError {
  /**
   * Код ошибки для классификации
   */
  public static readonly code = 'MARKET_LIFECYCLE_ERROR';
}

// Re-export для удобства
export { TradingError };
