/**
 * FIFO/LIFO алгоритмы для управления лотами позиций
 *
 * @remarks
 * Тонкие обёртки над `Position.close()`.
 * Вся логика закрытия лотов находится в `lot-closing.ts` (pure computation)
 * и `Position.applyClose()` (entity mutation).
 *
 * ### FIFO (First-In-First-Out)
 * - Закрывает самые старые лоты первыми
 * - Соответствует бухгалтерским стандартам
 *
 * ### LIFO (Last-In-First-Out)
 * - Закрывает самые новые лоты первыми
 * - Может влиять на налогообложение
 *
 * @example
 * ```typescript
 * import { closeFIFO, closeLIFO } from './algorithms/fifo-lifo';
 *
 * const result = closeFIFO(position, closeQuantity, closePrice, Timestamp.now());
 * if (result.ok) {
 *   const { position: newPosition, realizedPnL } = result.value;
 *   console.log('Realized P&L:', realizedPnL.value().toString());
 * }
 * ```
 */

import { Result } from '@polymarket/result';
import { ValidationError } from '@polymarket/errors';
import { Quantity, Price, Timestamp } from '@polymarket/value-objects';
import { Position, type CloseResult } from '../Position.js';

// Re-export вспомогательных типов из lot-closing.ts
export type { ClosedLotInfo, LotCloseComputation } from './lot-closing.js';
export { calculateWeightedAveragePrice } from './lot-closing.js';

// Re-export CloseResult из Position.ts (содержит ссылку на Position)
export type { CloseResult };

/**
 * Закрывает позицию используя FIFO алгоритм (First-In-First-Out)
 *
 * @param position - Позиция для закрытия
 * @param closeQuantity - Количество для закрытия
 * @param closePrice - Цена закрытия
 * @param closedAt - Timestamp операции (записывается в updatedAt нового Position)
 * @returns Result<CloseResult, ValidationError>
 *
 * @remarks
 * Тонкая обёртка над `position.close(qty, price, 'FIFO', closedAt)`.
 * FIFO закрывает самые старые лоты первыми (лоты уже отсортированы ASC в Position).
 *
 * ### Валидации (в lot-closing.ts):
 * - closeQuantity > 0
 * - position.lots.length > 0
 * - closeQuantity <= position.quantity
 *
 * @example
 * ```typescript
 * // Позиция с 3 лотами:
 * // Lot 1: 50 @ 0.60 (timestamp: 100)
 * // Lot 2: 30 @ 0.65 (timestamp: 200)
 * // Lot 3: 20 @ 0.70 (timestamp: 300)
 *
 * const result = closeFIFO(
 *   position,
 *   Quantity.of(new Decimal(60)),
 *   Price.of(new Decimal(0.75)),
 *   Timestamp.now(),
 * );
 * if (result.ok) {
 *   const { position: newPos, realizedPnL } = result.value;
 *   // Закроются: Lot 1 полностью (50) + 10 из Lot 2
 *   // P&L: (0.75 - 0.60) * 50 + (0.75 - 0.65) * 10 = 8.5
 * }
 * ```
 */
export function closeFIFO(
  position: Position,
  closeQuantity: Quantity,
  closePrice: Price,
  closedAt: Timestamp,
): Result<CloseResult, ValidationError> {
  return position.close(closeQuantity, closePrice, 'FIFO', closedAt);
}

/**
 * Закрывает позицию используя LIFO алгоритм (Last-In-First-Out)
 *
 * @param position - Позиция для закрытия
 * @param closeQuantity - Количество для закрытия
 * @param closePrice - Цена закрытия
 * @param closedAt - Timestamp операции (записывается в updatedAt нового Position)
 * @returns Result<CloseResult, ValidationError>
 *
 * @remarks
 * Тонкая обёртка над `position.close(qty, price, 'LIFO', closedAt)`.
 * LIFO закрывает самые новые лоты первыми (лоты переворачиваются внутри Position.close()).
 *
 * ### Валидации (в lot-closing.ts):
 * - closeQuantity > 0
 * - position.lots.length > 0
 * - closeQuantity <= position.quantity
 *
 * @example
 * ```typescript
 * // Позиция с 3 лотами:
 * // Lot 1: 50 @ 0.60 (timestamp: 100)
 * // Lot 2: 30 @ 0.65 (timestamp: 200)
 * // Lot 3: 20 @ 0.70 (timestamp: 300)
 *
 * const result = closeLIFO(
 *   position,
 *   Quantity.of(new Decimal(60)),
 *   Price.of(new Decimal(0.75)),
 *   Timestamp.now(),
 * );
 * if (result.ok) {
 *   const { position: newPos, realizedPnL } = result.value;
 *   // Закроются: Lot 3 (20) + Lot 2 (30) + 10 из Lot 1
 *   // P&L: (0.75 - 0.70) * 20 + (0.75 - 0.65) * 30 + (0.75 - 0.60) * 10 = 5.5
 * }
 * ```
 */
export function closeLIFO(
  position: Position,
  closeQuantity: Quantity,
  closePrice: Price,
  closedAt: Timestamp,
): Result<CloseResult, ValidationError> {
  return position.close(closeQuantity, closePrice, 'LIFO', closedAt);
}
