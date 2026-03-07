/**
 * Position Entity Package — публичное API
 *
 * @remarks
 * Экспортирует Position entity, связанные типы и алгоритмы FIFO/LIFO.
 *
 * ### Архитектурные изменения:
 * - `quantity` и `averageEntryPrice` теперь derived getters (из lots)
 * - `CloseResult.position` вместо `CloseResult.newPosition`
 * - `LotCloseComputation` — новый экспорт для pure computation
 * - `validateLotsConsistency` удалена (lots = единственный источник истины)
 */

// Main Entity
export { Position } from './Position.js';
export type { PositionParams, PositionSide, PositionStatus, CloseResult } from './Position.js';

// Value Objects
export { PositionLot } from './core/PositionLot.js';
export type { PositionLotParams } from './core/PositionLot.js';

// FIFO/LIFO Algorithms
export {
  closeFIFO,
  closeLIFO,
  calculateWeightedAveragePrice,
} from './algorithms/index.js';
export type { ClosedLotInfo, LotCloseComputation } from './algorithms/index.js';
