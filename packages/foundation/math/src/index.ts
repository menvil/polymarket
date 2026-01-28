/**
 * @polymarket/math - Pure mathematical operations
 *
 * @remarks
 * Этот пакет предоставляет чистые математические функции для работы с Decimal.js.
 *
 * Архитектура:
 * - decimal/ - базовые арифметические операции (add, subtract, multiply, divide, average)
 * - rounding/ - операции округления (roundToTickSize, roundToDecimalPlaces)
 * - validation/ - валидация чисел (isFinite, isPositive, isNonNegative)
 *
 * Философия:
 * - Чистые функции без побочных эффектов
 * - Throw на математические невозможности (NaN, Infinity, деление на ноль)
 * - Используется на Core Layer (до бизнес-логики)
 *
 * @example
 * ```typescript
 * import Decimal from 'decimal.js';
 * import { divideDecimal, roundToTickSize } from '@polymarket/math';
 *
 * const result = divideDecimal(new Decimal('100'), new Decimal('3'));
 * const rounded = roundToTickSize(new Decimal('10.567'), new Decimal('0.01'));
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
