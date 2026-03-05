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
 * try {
 *   closedMarket.close();
 * } catch (e) {
 *   if (e instanceof MarketAlreadyClosedError) {
 *     // Рынок уже закрыт — операция идемпотентна, можно продолжить
 *   } else if (e instanceof MarketAlreadyResolvedError) {
 *     // Рынок в терминальном состоянии — переход невозможен
 *   } else if (e instanceof MarketLifecycleError) {
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
 * Выбрасывается в Market.create() при невалидных входных данных.
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
 * Выбрасывается при попытке недопустимого перехода состояния.
 * Используй конкретные подклассы для точной обработки ошибок.
 *
 * Уровень серьёзности: medium (нарушение бизнес-логики в коде).
 *
 * @example
 * ```typescript
 * try {
 *   market.close();
 * } catch (e) {
 *   if (e instanceof MarketLifecycleError) {
 *     console.log('FSM violation:', e.context?.currentStatus);
 *   }
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
 * Выбрасывается при вызове `close()` на рынке в состоянии CLOSED.
 *
 * @example
 * ```typescript
 * try {
 *   closedMarket.close();
 * } catch (e) {
 *   if (e instanceof MarketAlreadyClosedError) {
 *     // Рынок уже закрыт — повторный вызов не нужен
 *   }
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
 * Выбрасывается при:
 * - `close()` на RESOLVED рынке
 * - `resolve()` на RESOLVED рынке
 *
 * RESOLVED — терминальное состояние, переходы из него запрещены.
 *
 * @example
 * ```typescript
 * try {
 *   resolvedMarket.resolve(1);
 * } catch (e) {
 *   if (e instanceof MarketAlreadyResolvedError) {
 *     // Рынок уже разрешён — результат финален
 *   }
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
 * Выбрасывается при `resolve()` на ACTIVE рынке.
 * Правило: рынок нужно сначала закрыть (`close()`), затем разрешить (`resolve()`).
 *
 * @example
 * ```typescript
 * try {
 *   activeMarket.resolve(0);
 * } catch (e) {
 *   if (e instanceof MarketInvalidTransitionError) {
 *     // Нужно сначала вызвать close()
 *     const closed = activeMarket.close();
 *     closed.resolve(0);
 *   }
 * }
 * ```
 */
export class MarketInvalidTransitionError extends MarketLifecycleError {
  public static readonly code: string = 'MARKET_INVALID_TRANSITION';
}
