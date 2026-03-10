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
 * - **getTotalValue / getTotalUnrealizedPnL** — оценка стоимости (требуют внешних цен)
 *
 * @example
 * ```typescript
 * import {
 *   Portfolio,
 *   asPortfolioId,
 *   PortfolioValidationError,
 *   getTotalValue,
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
// Value Objects
export { parsePortfolioId, asPortfolioId } from './value-objects/index.js';
// Errors (re-export из @polymarket/errors/portfolio)
export { PortfolioValidationError, PortfolioOperationError } from '@polymarket/errors/portfolio';
// Valuation
export { getTotalValue, getTotalUnrealizedPnL, } from './services/PortfolioValuationService.js';
//# sourceMappingURL=index.js.map