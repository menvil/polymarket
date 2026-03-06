/**
 * Дельта стакана ордеров
 *
 * @remarks
 * Представляет изменение стакана ордеров (order book delta).
 * Содержит изменённые уровни bid и ask.
 *
 * Семантика обновления:
 * - size > 0: установить новый объём на уровне
 * - size === 0: удалить уровень
 * - size < 0: игнорируется (защитная семантика)
 */

import type { PriceLevel } from './PriceLevel.js';

/**
 * Дельта стакана ордеров — набор изменённых уровней
 *
 * @example
 * ```typescript
 * const delta: OrderBookDelta = {
 *   bids: [{ price: 0.65, size: 500 }],  // обновить bid 0.65
 *   asks: [{ price: 0.66, size: 0 }],    // удалить ask 0.66
 * };
 * ```
 */
export interface OrderBookDelta {
  /** Изменённые уровни на стороне покупки */
  readonly bids: PriceLevel[];
  /** Изменённые уровни на стороне продажи */
  readonly asks: PriceLevel[];
}
