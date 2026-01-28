/**
 * @polymarket/math - Decimal.js utilities
 *
 * @remarks
 * Утилиты для работы с высокоточными десятичными числами на базе Decimal.js.
 *
 * Архитектура:
 * - decimal/ - арифметические операции (add, subtract, multiply, divide, average, compare, round)
 * - rounding/ - округление к tick size (roundToTick, floorToTick, ceilToTick, roundToPrecision)
 * - validation/ - валидация чисел (isFinite, isPositive, isNonNegative)
 *
 * Принципы:
 * - Чистые функции без побочных эффектов
 * - Throw на математические невозможности (NaN, Infinity, деление на ноль)
 * - Explicit лучше implicit (обязательные параметры для rounding modes)
 *
 * @example
 * ```typescript
 * import Decimal from 'decimal.js';
 * import { divideDecimal, roundToTick } from '@polymarket/math';
 *
 * const result = divideDecimal(new Decimal('100'), new Decimal('3'));
 * const rounded = roundToTick(
 *   new Decimal('10.567'),
 *   new Decimal('0.01'),
 *   Decimal.ROUND_HALF_UP
 * );
 * ```
 *
 * @packageDocumentation
 */

// Decimal operations
export * from './decimal/index.js';

// Rounding operations
export * from './rounding/index.js';

// Validation utilities
export * from './validation/index.js';

// Constants
export { MATH_CONSTANTS } from './constants.js';

// Re-export Decimal type for convenience
export type { Decimal } from 'decimal.js';
