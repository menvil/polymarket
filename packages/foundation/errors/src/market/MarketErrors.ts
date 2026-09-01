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
 *     ├── MarketAlreadyClosedError    — markClosed() на CLOSED рынке
 *     ├── MarketAlreadyResolvedError  — любой переход из RESOLVED
 *     └── MarketInvalidTransitionError — markResolved() на ACTIVE (нужно сначала markClosed())
 * ```
 *
 * ### Допустимые переходы Market FSM:
 * ```
 * ACTIVE → CLOSED → RESOLVED
 * ```
 *
 * Переходы отражают подтверждённое площадкой внешнее состояние — мы фиксируем
 * наблюдение, а не командуем внешнему рынку.
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
 * const result = closedMarket.markClosed();
 * if (!result.ok) {
 *   if (result.error instanceof MarketAlreadyClosedError) {
 *     // Рынок уже был закрыт — наблюдение повторное, источник рассинхронизирован
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
 * из `Market.markResolved()` при невалидном `outcomeIndex` (не целое число / вне диапазона).
 * Уровень серьёзности: low (данные можно исправить).
 *
 * ### Причины:
 * - Пустой question, id, venueId, outcomes[i].label
 * - Одинаковые метки или instrument identity исходов
 * - Невалидное расписание (`startsAt >= expiresAt`, не-`Timestamp`)
 * - Невалидный state object
 * - Неизвестное семейство рынка или отсутствующая спецификация семейства
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
 * Возвращается как `Err` при попытке зафиксировать недопустимый переход состояния
 * (`Market.markClosed()`/`Market.markResolved()` — `Result`-based, см. `@polymarket/market`).
 * Используй конкретные подклассы для точной обработки ошибок.
 *
 * Уровень серьёзности: medium (нарушение бизнес-логики в коде).
 *
 * @example
 * ```typescript
 * const result = market.markClosed();
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
 * Возвращается как `Err` при вызове `markClosed()` на рынке в состоянии CLOSED.
 *
 * @example
 * ```typescript
 * const result = closedMarket.markClosed();
 * if (!result.ok && result.error instanceof MarketAlreadyClosedError) {
 *   // Закрытие уже зафиксировано — повторное наблюдение того же факта
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
 * - `markClosed()` на RESOLVED рынке
 * - `markResolved()` на RESOLVED рынке
 *
 * RESOLVED — терминальное состояние, переходы из него запрещены.
 *
 * @example
 * ```typescript
 * const result = resolvedMarket.markResolved(1);
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
 * Возвращается как `Err` при `markResolved()` на ACTIVE рынке.
 * Правило: сначала фиксируется наблюдённое закрытие (`markClosed()`),
 * затем объявленный исход (`markResolved()`).
 *
 * @example
 * ```typescript
 * const result = activeMarket.markResolved(0);
 * if (!result.ok && result.error instanceof MarketInvalidTransitionError) {
 *   // Сначала нужно зафиксировать закрытие
 *   const closeResult = activeMarket.markClosed();
 *   if (closeResult.ok) {
 *     closeResult.value.markResolved(0);
 *   }
 * }
 * ```
 */
export class MarketInvalidTransitionError extends MarketLifecycleError {
  public static readonly code: string = 'MARKET_INVALID_TRANSITION';
}
