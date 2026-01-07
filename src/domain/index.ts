/**
 * Domain layer barrel export
 * 
 * @remarks
 * Main entry point for all domain types.
 * Exports value objects, entities, and aggregates.
 * 
 * @example
 * ```typescript
 * import { Price, Order, Portfolio } from '@domain';
 * 
 * const price = Price.fromNumber(0.5);
 * const order = Order.create({...});
 * const portfolio = Portfolio.create(Money.fromUSDC(10000));
 * ```
 */

// Value Objects
export * from './value-objects/index.js';

// Entities
export * from './entities/index.js';

// Aggregates
export * from './aggregates/index.js';

// Errors (re-export from shared)
export * from '../shared/errors/index.js';
