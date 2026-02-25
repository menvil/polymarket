/**
 * Ошибки Portfolio entity
 *
 * @remarks
 * - `PortfolioValidationError` — данные портфеля не прошли валидацию при создании.
 * - `PortfolioOperationError` — нарушение бизнес-правила при выполнении операции.
 *
 * **Архитектура:**
 * Оба класса расширяют `TradingError` из `@polymarket/errors`.
 * `PortfolioValidationError` имеет severity 'low' (пользовательская ошибка).
 * `PortfolioOperationError` имеет severity 'medium' (программная ошибка).
 *
 * @example
 * ```typescript
 * import { PortfolioValidationError, PortfolioOperationError } from './PortfolioErrors';
 *
 * // Ошибка валидации (например, пустой portfolioId)
 * throw new PortfolioValidationError('Portfolio ID is required', {
 *   context: { field: 'portfolioId' }
 * });
 *
 * // Операционная ошибка (нарушение бизнес-правила)
 * throw new PortfolioOperationError('Cannot reserve more than available balance', {
 *   context: { portfolioId: 'portfolio-abc', op: 'reserveForOrder' }
 * });
 * ```
 */

import { TradingError, ValidationError } from '@polymarket/errors';
import type { ErrorSeverity } from '@polymarket/errors';

/**
 * PortfolioValidationError — ошибка валидации данных портфеля
 *
 * @remarks
 * Используется в Portfolio.create() при невалидных входных данных.
 * severity: 'low' — пользовательская ошибка, исправляемая изменением данных.
 *
 * @example
 * ```typescript
 * throw new PortfolioValidationError('Portfolio ID is required', {
 *   context: { field: 'portfolioId' }
 * });
 * ```
 */
export class PortfolioValidationError extends ValidationError {
  /** @internal */
  public static readonly code = 'PORTFOLIO_VALIDATION_ERROR';
}

/**
 * PortfolioOperationError — ошибка бизнес-операции портфеля
 *
 * @remarks
 * Выбрасывается при нарушении бизнес-правил в методах портфеля:
 * - reserveForOrder: недостаточно средств
 * - releaseReservation: недостаточно зарезервировано
 * - applyDebit: недостаточно средств
 * - и других операциях с балансом
 *
 * В отличие от PortfolioValidationError — это программная ошибка логики,
 * которую нужно обрабатывать на уровне приложения (например, отклонить ордер).
 * severity: 'medium'.
 *
 * @example
 * ```typescript
 * throw new PortfolioOperationError('Cannot reserve more than available', {
 *   context: { portfolioId: 'p-123', op: 'reserveForOrder', available: 500, requested: 1000 }
 * });
 * ```
 */
export class PortfolioOperationError extends TradingError {
  public readonly severity: ErrorSeverity = 'medium';

  /** @internal */
  public static readonly code = 'PORTFOLIO_OPERATION_ERROR';
}
