/**
 * Execution services barrel export
 *
 * @remarks
 * Exports all execution-related domain services.
 */
export { SlippageCalculator } from './SlippageCalculator.js';
export type { SlippageResult } from './SlippageCalculator.js';

export { OrderValidator } from './OrderValidator.js';
export type { ValidationResult, ValidationConfig } from './OrderValidator.js';
