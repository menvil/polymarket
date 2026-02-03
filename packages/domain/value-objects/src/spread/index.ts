// Core (публичный API)
export { Spread, SpreadInvariantViolation } from './core/index.js';

// Facade (главный публичный API)
export { SpreadService } from './facade/index.js';

// Adapters (публичный API)
export { SpreadSerializer, SpreadFormatter } from './adapters/index.js';

// Errors (публичный API)
export { SpreadErrorReason } from './core/SpreadErrorReason.js';

// Rules (только типы для потребителей)
// ErrorContext и внутренние типы Rules НЕ экспортируются из верхнего index
// Для type-safe error handling используй SpreadErrorReason (экспортирован выше)
