/**
 * Ошибки жизненного цикла рынка предсказаний (Market entity)
 *
 * @remarks
 * Иерархия ошибок для Market entity:
 *
 * ```
 * TradingError
 * ├── ValidationError
 * │   └── MarketValidationError   — невалидные данные при Market.create()
 * └── MarketLifecycleError        — базовый класс для нарушений FSM
 *     ├── MarketAlreadyClosedError    — close() на CLOSED рынке
 *     ├── MarketAlreadyResolvedError  — любой переход из RESOLVED
 *     └── MarketInvalidTransitionError — resolve() на ACTIVE (нужно сначала close())
 * ```
 *
 * ### Допустимые переходы Market FSM:
 * ```
 * ACTIVE → CLOSED → RESOLVED
 * ```
 *
 * @example
 * ```typescript
 * import {
 *   MarketValidationError,
 *   MarketLifecycleError,
 *   MarketAlreadyClosedError,
 *   MarketAlreadyResolvedError,
 *   MarketInvalidTransitionError,
 * } from '@polymarket/errors/market';
 *
 * const result = closedMarket.close(nowMs);
 * if (!result.ok) {
 *   if (result.error instanceof MarketAlreadyClosedError) {
 *     // Рынок уже закрыт — операция идемпотентна, можно продолжить
 *   } else if (result.error instanceof MarketAlreadyResolvedError) {
 *     // Рынок в терминальном состоянии — переход невозможен
 *   } else if (result.error instanceof MarketLifecycleError) {
 *     // Любое другое нарушение FSM
 *   }
 * }
 * ```
 *
 * @packageDocumentation
 */

import { TradingError, ValidationError } from '../base/index.js';

/**
 * MarketValidationError — ошибка валидации данных рынка
 *
 * @remarks
 * Возвращается как `Err` из `Market.create()` при невалидных входных данных, а также
 * из `Market.resolve()` при невалидном `outcomeIndex` (не целое число / вне диапазона).
 * Уровень серьёзности: low (данные можно исправить).
 *
 * ### Причины:
 * - Пустой question, outcomes[i].name
 * - Одинаковые названия или токены исходов
 * - Нефинитный expirationMs (NaN, Infinity)
 * - Невалидный state object
 *
 * @example
 * ```typescript
 * const result = Market.create({ question: '', ... });
 * if (!result.ok) {
 *   if (result.error instanceof MarketValidationError) {
 *     console.log('Field:', result.error.context?.field);
 *   }
 * }
 * ```
 */
export class MarketValidationError extends ValidationError {}

/**
 * MarketLifecycleError — базовый класс для нарушений FSM рынка
 *
 * @remarks
 * Возвращается как `Err` при попытке недопустимого перехода состояния
 * (`Market.close()`/`Market.resolve()` — `Result`-based, см. `@polymarket/market`).
 * Используй конкретные подклассы для точной обработки ошибок.
 *
 * Уровень серьёзности: medium (нарушение бизнес-логики в коде).
 *
 * @example
 * ```typescript
 * const result = market.close(nowMs);
 * if (!result.ok && result.error instanceof MarketLifecycleError) {
 *   console.log('FSM violation:', result.error.context?.currentStatus);
 * }
 * ```
 */
export class MarketLifecycleError extends TradingError {
  public static readonly code: string = 'MARKET_LIFECYCLE_ERROR';
}

/**
 * MarketAlreadyClosedError — попытка закрыть уже закрытый рынок
 *
 * @remarks
 * Возвращается как `Err` при вызове `close()` на рынке в состоянии CLOSED.
 *
 * @example
 * ```typescript
 * const result = closedMarket.close(nowMs);
 * if (!result.ok && result.error instanceof MarketAlreadyClosedError) {
 *   // Рынок уже закрыт — повторный вызов не нужен
 * }
 * ```
 */
export class MarketAlreadyClosedError extends MarketLifecycleError {
  public static readonly code: string = 'MARKET_ALREADY_CLOSED';
}

/**
 * MarketAlreadyResolvedError — попытка перехода из терминального состояния RESOLVED
 *
 * @remarks
 * Возвращается как `Err` при:
 * - `close()` на RESOLVED рынке
 * - `resolve()` на RESOLVED рынке
 *
 * RESOLVED — терминальное состояние, переходы из него запрещены.
 *
 * @example
 * ```typescript
 * const result = resolvedMarket.resolve(1, nowMs);
 * if (!result.ok && result.error instanceof MarketAlreadyResolvedError) {
 *   // Рынок уже разрешён — результат финален
 * }
 * ```
 */
export class MarketAlreadyResolvedError extends MarketLifecycleError {
  public static readonly code: string = 'MARKET_ALREADY_RESOLVED';
}

/**
 * MarketInvalidTransitionError — недопустимый переход состояния
 *
 * @remarks
 * Возвращается как `Err` при `resolve()` на ACTIVE рынке.
 * Правило: рынок нужно сначала закрыть (`close()`), затем разрешить (`resolve()`).
 *
 * @example
 * ```typescript
 * const result = activeMarket.resolve(0, nowMs);
 * if (!result.ok && result.error instanceof MarketInvalidTransitionError) {
 *   // Нужно сначала вызвать close()
 *   const closeResult = activeMarket.close(nowMs);
 *   if (closeResult.ok) {
 *     closeResult.value.resolve(0, nowMs);
 *   }
 * }
 * ```
 */
export class MarketInvalidTransitionError extends MarketLifecycleError {
  public static readonly code: string = 'MARKET_INVALID_TRANSITION';
}
