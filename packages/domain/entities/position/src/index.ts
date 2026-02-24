/**
 * Position Entity Package
 *
 * @remarks
 * Экспортирует Position entity, связанные типы и алгоритмы FIFO/LIFO.
 */

// Main Entity
export { Position } from './Position.js';
export type { PositionParams, PositionLot, PositionSide, PositionStatus } from './Position.js';

// FIFO/LIFO Algorithms
export {
  closeFIFO,
  closeLIFO,
  calculateWeightedAveragePrice,
  validateLotsConsistency,
} from './algorithms/index.js';
export type { CloseResult, ClosedLotInfo } from './algorithms/index.js';
