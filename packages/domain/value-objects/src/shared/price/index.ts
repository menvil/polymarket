/**
 * Общее МЕЖДУ ЦЕНОВЫМИ доменами: контракт «это цена», описание домена,
 * арифметика, тик и ценовые правила.
 *
 * @remarks
 * Граница этой папки — «нужен ли коду тип цены». Всё здесь типизировано
 * через {@link DecimalPrice} либо оперирует ценовой сеткой, поэтому в
 * `quantity`, `money` или `side` оно неприменимо. То, что общее для ВСЕХ
 * value objects (разбор JSON, безопасная диагностика), лежит рядом в
 * `shared/json` — это другая широта разделения, и смешивать их в одной
 * папке значит потерять её.
 *
 * Домены (`outcome-price`, `asset-price`) держат только свои инварианты,
 * константы и специфичные методы вроде `complement`.
 */
export type { DecimalPrice } from './DecimalPrice.js';
export type { PriceDomain } from './priceDomain.js';
export type { TickRoundingMode } from './priceOperations.js';
export type { PriceJSON } from './priceCodec.js';
export { formatPriceFixed, priceFromJSON, priceToJSON } from './priceCodec.js';
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
export { ValidateAligned } from './ValidateAligned.js';
