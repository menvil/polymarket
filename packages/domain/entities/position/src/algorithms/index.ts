/**
 * FIFO/LIFO Algorithms
 *
 * @remarks
 * Экспортирует алгоритмы для управления лотами позиций.
 */

export {
  closeFIFO,
  closeLIFO,
  calculateWeightedAveragePrice,
  validateLotsConsistency,
} from './fifo-lifo.js';

export type { CloseResult, ClosedLotInfo } from './fifo-lifo.js';
