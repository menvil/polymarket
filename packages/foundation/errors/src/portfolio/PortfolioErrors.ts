/**
 * Ошибки Portfolio entity
 *
 * @remarks
 * Иерархия ошибок:
 *
 * ```
 * TradingError
 * ├── ValidationError
 * │   └── PortfolioValidationError  — невалидные данные при Portfolio.create()
 * └── TradingError
 *     └── PortfolioOperationError   — нарушение бизнес-правила при операции
 * ```
 *
 * @example
 * ```typescript
 * import { PortfolioValidationError, PortfolioOperationError } from '@polymarket/errors/portfolio';
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
 *
 * @packageDocumentation
 */

import { TradingError, ValidationError } from '../base/index.js';
import type { ErrorSeverity } from '../base/index.js';

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
  public override readonly severity: ErrorSeverity = 'medium';

  /** @internal */
  public static readonly code = 'PORTFOLIO_OPERATION_ERROR';
}
