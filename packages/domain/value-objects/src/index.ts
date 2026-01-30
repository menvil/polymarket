/**
 * Barrel экспорт Value Objects
 *
 * @remarks
 * Экспортирует все value objects для удобного импорта.
 * Value objects являются иммутабельными и представляют концепции без идентичности.
 */
export { Money } from './Money.js';
export { Balance } from './Balance.js';
export { Price } from './Price.js';
export { Percentage } from './Percentage.js';
export { Quote } from './Quote.js';
export { Spread } from './Spread.js';

// Backward compatibility: новый Quantity модуль (только публичный API)
export { Quantity, QuantityService } from './quantity/index.js';
