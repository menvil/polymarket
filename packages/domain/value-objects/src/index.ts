/**
 * Barrel экспорт Value Objects
 *
 * @remarks
 * Экспортирует все value objects для удобного импорта.
 * Value objects являются иммутабельными и представляют концепции без идентичности.
 */

// Money модуль (только публичный API)
export { Money, MoneyService, SupportedCurrency } from './money/index.js';

// Price модуль (только публичный API)
export { Price, PriceService, PriceSerializer, PriceFormatter } from './price/index.js';

// Quantity модуль (только публичный API)
export { Quantity, QuantityService } from './quantity/index.js';

// TODO: Implement these value objects
// export { Balance } from './Balance.js';
// export { Percentage } from './Percentage.js';
// export { Quote } from './Quote.js';
// export { Spread } from './Spread.js';
