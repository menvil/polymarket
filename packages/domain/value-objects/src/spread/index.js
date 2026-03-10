// Core (публичный API)
export { Spread, SpreadInvariantViolation } from './core/index.js';
// Facade (главный публичный API)
export { SpreadService } from './facade/index.js';
// Adapters (публичный API)
export { SpreadSerializer, SpreadFormatter } from './adapters/index.js';
// Errors (публичный API)
export { SpreadErrorReason } from './errors/index.js';
// Rules (публичный API для внешней валидации)
export { ValidateBidAsk, ValidateMinWidth, ValidateMaxWidth } from './rules/index.js';
//# sourceMappingURL=index.js.map