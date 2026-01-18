/**
 * Barrel-экспорт доменного слоя
 *
 * @remarks
 * Главная точка входа для всех доменных типов.
 * Экспортирует value objects, entities и aggregates.
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

// Errors (re-export from shared)
export * from '../shared/errors/index.js';
