/**
 * @polymarket/portfolio — Portfolio aggregate package
 *
 * @remarks
 * Предоставляет aggregate root Portfolio для системы предсказательных рынков.
 *
 * ### Архитектура:
 * - **Portfolio** — aggregate root: balance + positions
 * - **PortfolioId** — branded type для идентификатора
 * - **PortfolioErrors** — PortfolioValidationError, PortfolioOperationError
 * - **PortfolioValuationService** — аналитика стоимости (вынесена из aggregate)
 *
 * @example
 * ```typescript
 * import {
 *   Portfolio,
 *   asPortfolioId,
 *   PortfolioValidationError,
 *   PortfolioValuationService,
 * } from '@polymarket/portfolio';
 *
 * const result = Portfolio.create({
 *   id: asPortfolioId('portfolio-abc'),
 *   accountId,
 *   balance: Balance.withZeroReserved(Money.of(10000, 'USDC'), accountId, venueId),
 * });
 *
 * if (result.ok) {
 *   const portfolio = result.value;
 *   const reserveResult = portfolio.reserveForOrder(Money.of(3000, 'USDC'));
 * }
 * ```
 *
 * @packageDocumentation
 */

// Aggregate
export { Portfolio } from './Portfolio.js';
export type { PortfolioParams } from './Portfolio.js';

// Value Objects
export { type PortfolioId, parsePortfolioId, asPortfolioId } from './value-objects/index.js';

// Errors
export { PortfolioValidationError, PortfolioOperationError } from './errors/PortfolioErrors.js';

// Services
export { PortfolioValuationService } from './services/PortfolioValuationService.js';
