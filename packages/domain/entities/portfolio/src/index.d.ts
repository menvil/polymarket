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
export { Portfolio } from './Portfolio.js';
export type { PortfolioParams, IPosition } from './Portfolio.js';
export { type PortfolioId, parsePortfolioId, asPortfolioId } from './value-objects/index.js';
export { PortfolioValidationError, PortfolioOperationError } from '@polymarket/errors/portfolio';
export { getTotalValue, getTotalUnrealizedPnL, type PriceProvider, } from './services/PortfolioValuationService.js';
//# sourceMappingURL=index.d.ts.map