/**
 * SignedQuantity Value Object - знаковое количество
 *
 * @remarks
 * Представляет знаковое количество, которое может быть положительным, отрицательным или нулем.
 *
 * Используется для:
 * - Изменения позиций (position deltas)
 * - Profit & Loss (P&L)
 * - Нетто-позиции (net positions)
 * - Любые знаковые количества
 *
 * Отличия от Quantity:
 * - Quantity: >= 0 (только неотрицательные)
 * - SignedQuantity: любое конечное число (может быть отрицательным)
 *
 * @packageDocumentation
 *
 * @example
 * ```typescript
 * import { SignedQuantityService } from '@polymarket/value-objects/signed-quantity';
 *
 * // Создание
 * const positive = SignedQuantityService.create(10);
 * const negative = SignedQuantityService.create(-10);
 * const zero = SignedQuantityService.create(0);
 *
 * // Операции
 * const sum = SignedQuantityService.add(positive.value, negative.value);
 * const abs = SignedQuantityService.abs(negative.value);
 * const negated = SignedQuantityService.negate(positive.value);
 * ```
 */

// Core
export { SignedQuantity } from './core/SignedQuantity.js';
export { SignedQuantityInvariantViolation } from './core/SignedQuantityInvariantViolation.js';

// Errors
export { SignedQuantityErrorReason } from './errors/SignedQuantityErrorReason.js';

// Facade
export { SignedQuantityService } from './facade/SignedQuantityService.js';

// Adapters
export { SignedQuantityFormatter } from './adapters/SignedQuantityFormatter.js';
export { SignedQuantitySerializer, SignedQuantityJSON } from './adapters/SignedQuantitySerializer.js';
