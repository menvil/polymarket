/**
 * Ratio module - value object для представления относительных величин
 *
 * @remarks
 * Экспортирует публичный API модуля:
 * - Core: Ratio class, RatioInvariantViolation
 * - Facade: RatioService (primary API)
 * - Adapters: RatioFormatter, RatioSerializer
 * - Errors: RatioErrorReason
 */

// Core (public API)
export { Ratio, RatioInvariantViolation } from './core/index.js';

// Facade (primary API)
export { RatioService, RatioCreateOptions } from './facade/index.js';

// Adapters (public API)
export { RatioFormatter, RatioSerializer, type RatioJSON } from './adapters/index.js';

// Errors (public API)
export { RatioErrorReason } from './errors/index.js';

// Rules (публичный API для внешней валидации)
export { ValidateRatioGteMinusOne } from './rules/index.js';
