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
export { Ratio, RatioInvariantViolation } from './core/index.js';
export { RatioService, type RatioCreateOptions } from './facade/index.js';
export { RatioFormatter, RatioSerializer, type RatioJSON } from './adapters/index.js';
export { RatioErrorReason } from './errors/index.js';
export { ValidateRatioGteMinusOne, ValidateRatioLteOne } from './rules/index.js';
//# sourceMappingURL=index.d.ts.map