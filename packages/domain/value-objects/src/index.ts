/**
 * Barrel экспорт Value Objects
 *
 * @remarks
 * Экспортирует все value objects для удобного импорта.
 * Value objects являются иммутабельными и представляют концепции без идентичности.
 */
// TODO: Implement these value objects
// export { Money } from './Money.js';
// export { Balance } from './Balance.js';
// export { Percentage } from './Percentage.js';
// export { Quote } from './Quote.js';
// export { Spread } from './Spread.js';

// Price модуль (только публичный API)
export { Price, PriceService, PriceSerializer, PriceFormatter } from './price/index.js';

// Quantity модуль (только публичный API)
export { Quantity, QuantityService } from './quantity/index.js';
