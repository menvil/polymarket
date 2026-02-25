/**
 * Position Entity Package
 *
 * @remarks
 * Экспортирует Position entity, связанные типы и алгоритмы FIFO/LIFO.
 */

// Main Entity
export { Position } from './Position.js';
export type { PositionParams, PositionSide, PositionStatus } from './Position.js';

// Value Objects
export { PositionLot } from './core/PositionLot.js';
export type { PositionLotParams } from './core/PositionLot.js';

// FIFO/LIFO Algorithms
export {
  closeFIFO,
  closeLIFO,
  calculateWeightedAveragePrice,
  validateLotsConsistency,
} from './algorithms/index.js';
export type { CloseResult, ClosedLotInfo } from './algorithms/index.js';
