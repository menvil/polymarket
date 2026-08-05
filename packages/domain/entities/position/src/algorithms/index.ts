/**
 * FIFO/LIFO Algorithms — публичное API
 *
 * @remarks
 * Экспортирует алгоритмы закрытия лотов и вспомогательные типы.
 * `validateLotsConsistency` удалена — lots теперь единственный источник истины,
 * несогласованность невозможна по архитектуре.
 */

export {
  closeFIFO,
  closeLIFO,
  calculateWeightedAveragePrice,
} from './fifo-lifo.js';

/** Реэкспорт типов результата close (см. `fifo-lifo.ts`/`lot-closing.ts`). */
export type { CloseResult, ClosedLotInfo, LotCloseComputation } from './fifo-lifo.js';
