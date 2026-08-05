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
/** Реэкспорт типов Position entity (см. `Position.ts`). */
export type { PositionParams, PositionSide, PositionStatus, CloseResult } from './Position.js';

// Value Objects
export { PositionLot } from './core/PositionLot.js';
/** Реэкспорт параметров создания лота (см. `core/PositionLot.ts`). */
export type { PositionLotParams } from './core/PositionLot.js';

// FIFO/LIFO Algorithms
export {
  closeFIFO,
  closeLIFO,
  calculateWeightedAveragePrice,
} from './algorithms/index.js';
/** Реэкспорт вспомогательных типов FIFO/LIFO-вычислений (см. `algorithms/`). */
export type { ClosedLotInfo, LotCloseComputation } from './algorithms/index.js';
