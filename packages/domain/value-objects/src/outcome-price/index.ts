// Core (публичный API)
export { OutcomePrice, OutcomePriceInvariantViolation } from './core/index.js';

// Facade (главный публичный API)
export { OutcomePriceService } from './facade/index.js';

// Adapters (публичный API)
export { OutcomePriceSerializer, OutcomePriceFormatter, type OutcomePriceJSON } from './adapters/index.js';

// Errors (публичный API)
export { OutcomePriceErrorReason } from './errors/index.js';

// Rules (публичный API для внешней валидации)
export {
  ValidateAligned,
  type TickSizeField,
  type AlignedField,
  type ErrorContext,
  type TickSizeErrorReason,
  type TickSizeMultipleReason,
  type AlignedErrorReason
} from './rules/index.js';
