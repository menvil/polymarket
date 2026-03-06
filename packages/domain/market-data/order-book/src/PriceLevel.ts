/**
 * Ценовой уровень стакана
 *
 * @remarks
 * Представляет один уровень в стакане ордеров (order book).
 * Содержит цену и суммарный объём на этом уровне.
 * Использует Value Objects для type safety и точной арифметики.
 */

import type { Price, Quantity } from '@polymarket/value-objects';

/**
 * Ценовой уровень стакана ордеров
 *
 * @example
 * ```typescript
 * import { PriceService, QuantityService } from '@polymarket/value-objects';
 *
 * const priceResult = PriceService.create('0.65');
 * const sizeResult = QuantityService.create('1000');
 * if (priceResult.ok && sizeResult.ok) {
 *   const level: PriceLevel = { price: priceResult.value, size: sizeResult.value };
 * }
 * ```
 */
export interface PriceLevel {
  /** Цена уровня (Price VO) */
  readonly price: Price;
  /** Суммарный объём на уровне (Quantity VO) */
  readonly size: Quantity;
}
