/**
 * Domain services barrel export
 *
 * @remarks
 * Exports all domain services organized by category:
 * - Pricing services (fair value, microprice, arbitrage)
 * - Risk services (assessment, payoff, margin)
 * - Inventory services (position tracking, lot accounting, hedge ratio)
 * - Execution services (slippage, validation)
 * - Signals services (trade flow analysis, fragility, market state)
 */

// Pricing services
export * from './pricing/index.js';

// Risk services
export * from './risk/index.js';

// Inventory services
export * from './inventory/index.js';

// Execution services
export * from './execution/index.js';

// Signals services (trade flow analysis, fragility)
export * from './signals/index.js';
