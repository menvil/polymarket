/**
 * Aggregates barrel export
 *
 * @remarks
 * Exports all domain aggregates for convenient importing.
 * Aggregates are consistency boundaries with a root entity.
 */
export { Portfolio } from './Portfolio.js';
export { RiskExposure } from './RiskExposure.js';
export type { RiskStatus, TradingMode } from './RiskExposure.js';
export { TradingSession } from './TradingSession.js';
export { MarketDataSubscriptionAggregate, InvariantViolationError } from './MarketDataSubscriptionAggregate.js';
