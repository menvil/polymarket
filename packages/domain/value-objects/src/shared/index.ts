/**
 * Общие контракты и операции, разделяемые ценовыми доменами.
 *
 * @remarks
 * Здесь живёт всё, что от домена НЕ зависит: контракт «это цена», описание
 * домена для операций и сами операции (арифметика, тик, разность). Домены
 * (`outcome-price`, `asset-price`) держат только свои инварианты, константы
 * и специфичные методы.
 */
export type { DecimalPrice } from './DecimalPrice.js';
export type { PriceDomain } from './priceDomain.js';
export type { TickRoundingMode } from './priceOperations.js';
export {
  applyRelativeChangeToPrice,
  averagePrices,
  dividePrice,
  ensurePriceAlignedToTick,
  multiplyPrice,
  priceDifference,
  roundPriceToTick,
} from './priceOperations.js';
export { ValidateFactorForPriceMultiplication } from './ValidateFactorForPriceMultiplication.js';
export { ValidateDivisorForPriceDivision } from './ValidateDivisorForPriceDivision.js';
export { ValidateTickSize } from './ValidateTickSize.js';
export { ValidateTickSizeMultipleOfBaseTick } from './ValidateTickSizeMultipleOfBaseTick.js';
