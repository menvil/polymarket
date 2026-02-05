// Core (публичный API)
export { Quantity, QuantityInvariantViolation } from './core/index.js';

// Facade (единственная точка входа для операций)
export { QuantityService } from './facade/index.js';

// Adapters (сериализация и форматирование)
export { QuantitySerializer, QuantityFormatter, type QuantityJSON } from './adapters/index.js';

// Errors (публичный API)
export { QuantityErrorReason } from './errors/index.js';

// Rules НЕ экспортируются — это internal implementation details.
// Все операции должны идти через QuantityService.
