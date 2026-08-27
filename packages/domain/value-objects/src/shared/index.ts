/**
 * Код, разделяемый между value objects.
 *
 * @remarks
 * Разложен НЕ по виду вещи (правила / операции / адаптеры), а по ШИРОТЕ
 * разделения — потому что именно она определяет, кому позволено это
 * импортировать:
 *
 * - `json/` — общее для ВСЕХ value objects: разбор внешнего JSON и
 *   безопасная диагностика. Ни о каком домене не знает.
 * - `price/` — общее только для ЦЕНОВЫХ доменов: контракт {@link DecimalPrice},
 *   арифметика, ценовая сетка, правила. В `quantity` или `side` неприменимо.
 *
 * Плоская папка склеила бы эти две области: `quantity` начал бы тянуть
 * ценовые правила просто потому, что они «в shared».
 */
export type { DecimalPrice, PriceDomain, TickRoundingMode, PriceJSON } from './price/index.js';
export {
  applyRelativeChangeToPrice,
  averagePrices,
  dividePrice,
  ensurePriceAlignedToTick,
  formatPriceFixed,
  multiplyPrice,
  priceDifference,
  priceFromJSON,
  priceToJSON,
  roundPriceToTick,
  ValidateAligned,
  ValidateDivisorForPriceDivision,
  ValidateFactorForPriceMultiplication,
  ValidateTickSize,
  ValidateTickSizeMultipleOfBaseTick,
} from './price/index.js';
export { safeStringify } from './json/index.js';
