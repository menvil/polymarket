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
 * └── MarketLifecycleError        — базовый класс для конфликтов наблюдений
 *     └── MarketAlreadyResolvedError — регрессия или конфликт после RESOLVED
 * ```
 *
 * ### Допустимые переходы Market FSM:
 * ```
 * ACTIVE → CLOSED        ACTIVE → RESOLVED        CLOSED → RESOLVED
 * CLOSED → CLOSED        RESOLVED(i) → RESOLVED(i)   — идемпотентно
 * ```
 *
 * Переходы отражают подтверждённое площадкой внешнее состояние — мы фиксируем
 * наблюдение, а не командуем внешнему рынку. Поэтому повторное наблюдение того
 * же состояния ошибкой не считается (внешние снапшоты повторяются), а из ACTIVE
 * допустим прямой переход в RESOLVED: промежуточный CLOSED мог не попасть между
 * двумя опросами источника.
 *
 * Ошибкой остаётся только противоречие уже зафиксированному факту:
 * `RESOLVED → CLOSED` (регрессия) и `RESOLVED(i) → RESOLVED(j≠i)` (конфликт исхода).
 *
 * @example
 * ```typescript
 * import {
 *   MarketValidationError,
 *   MarketLifecycleError,
 *   MarketAlreadyResolvedError,
 * } from '@polymarket/errors/market';
 *
 * const result = resolvedMarket.markClosed();
 * if (!result.ok && result.error instanceof MarketAlreadyResolvedError) {
 *   // Источник противоречит уже зафиксированной резолюции
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
 * Возвращается как `Err`, когда наблюдение противоречит уже зафиксированному
 * состоянию (`Market.markClosed()`/`Market.markResolved()` — `Result`-based,
 * см. `@polymarket/market`). Используй конкретные подклассы для точной обработки.
 *
 * Уровень серьёзности: medium (рассинхрон с внешним источником).
 *
 * @example
 * ```typescript
 * const result = market.markClosed();
 * if (!result.ok && result.error instanceof MarketLifecycleError) {
 *   console.log('Observation conflict:', result.error.context?.currentStatus);
 * }
 * ```
 */
export class MarketLifecycleError extends TradingError {
  public static readonly code: string = 'MARKET_LIFECYCLE_ERROR';
}

/**
 * MarketAlreadyResolvedError — наблюдение противоречит уже зафиксированной резолюции
 *
 * @remarks
 * RESOLVED — терминальное состояние. Возвращается как `Err` при:
 * - `markClosed()` на RESOLVED рынке — регрессия состояния;
 * - `markResolved()` на RESOLVED рынке **другим** исходом — конфликт данных источника.
 *
 * Повторная резолюция тем же исходом ошибкой НЕ является: внешние снапшоты
 * повторяются, и `markResolved()` в этом случае идемпотентен.
 *
 * @example
 * ```typescript
 * const result = resolvedMarket.markResolved(1);
 * if (!result.ok && result.error instanceof MarketAlreadyResolvedError) {
 *   logger.error('Source contradicts recorded resolution', {
 *     recorded: result.error.context?.resolvedOutcomeIndex,
 *     observed: result.error.context?.observedOutcomeIndex,
 *   });
 * }
 * ```
 */
export class MarketAlreadyResolvedError extends MarketLifecycleError {
  public static readonly code: string = 'MARKET_ALREADY_RESOLVED';
}
