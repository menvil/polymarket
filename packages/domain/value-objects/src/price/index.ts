// Core (публичный API)
export { Price, PriceInvariantViolation } from './core/index.js';

// Facade (главный публичный API)
export { PriceService } from './facade/index.js';

// Adapters (публичный API)
export { PriceSerializer, PriceFormatter, type PriceJSON } from './adapters/index.js';

// Errors (публичный API)
export { PriceErrorReason } from './errors/index.js';

// Rules (публичный API для внешней валидации)
export {
  ValidateTickSize,
  ValidateTickSizeMultipleOfBaseTick,
  ValidateAligned,
  ValidateFactorForPriceMultiplication,
  ValidateDivisorForPriceDivision,
  type TickSizeField,
  type AlignedField,
  type ErrorContext,
  type TickSizeErrorReason,
  type TickSizeMultipleReason,
  type AlignedErrorReason
} from './rules/index.js';
