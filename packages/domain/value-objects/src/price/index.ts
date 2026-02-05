// Core (публичный API)
export { Price, PriceInvariantViolation } from './core/index.js';

// Facade (главный публичный API)
export { PriceService } from './facade/index.js';

// Adapters (публичный API)
export { PriceSerializer, PriceFormatter, type PriceJSON } from './adapters/index.js';

// Errors (публичный API)
export { PriceErrorReason } from './errors/index.js';

// Rules (только типы для потребителей)
// ErrorContext и внутренние типы Rules НЕ экспортируются из верхнего index
// Для type-safe error handling используй PriceErrorReason (экспортирован выше)
