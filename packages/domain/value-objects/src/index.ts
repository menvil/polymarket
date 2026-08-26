/**
 * Barrel экспорт Value Objects
 *
 * @remarks
 * Экспортирует все value objects для удобного импорта.
 * Value objects являются иммутабельными и представляют концепции без идентичности.
 */

// Money модуль (только публичный API)
export {
  Money,
  MoneyService,
  MoneySerializer,
  MoneyFormatter,
  MoneyErrorReason,
  // Rules Layer (публичный API для внешней валидации)
  ValidateDeltaForIncreaseBy,
  ValidateDivisorForMoneyDivision,
  ValidateFactorForMoneyMultiplication
} from './money/index.js';
export type { SupportedCurrency } from './money/index.js';

// Price модуль (только публичный API)
export { Price, PriceService, PriceSerializer, PriceFormatter, PriceErrorReason } from './price/index.js';

// ReferencePrice модуль — цена ВНЕШНЕГО актива (BTC/USD), без ограничения [0..1]
export {
  ReferencePrice,
  ReferencePriceInvariantViolation,
  ReferencePriceService,
  ReferencePriceErrorReason
} from './reference-price/index.js';

// Quantity модуль (только публичный API)
export { Quantity, QuantityService, QuantityFormatter, QuantitySerializer, QuantityErrorReason } from './quantity/index.js';

// Balance модуль (только публичный API)
export {
  Balance,
  BalanceService,
  BalanceSerializer,
  BalanceFormatter,
  BalanceErrorReason
} from './balance/index.js';

// Spread модуль (только публичный API)
export {
  Spread,
  SpreadService,
  SpreadSerializer,
  SpreadFormatter,
  SpreadErrorReason
} from './spread/index.js';

// Ratio модуль (только публичный API)
export {
  Ratio,
  RatioService,
  RatioSerializer,
  RatioFormatter,
  RatioErrorReason
} from './ratio/index.js';

// OutcomeToken модуль (только публичный API)
export {
  OutcomeToken,
  OutcomeTokenService,
  OutcomeTokenSerializer,
  OutcomeTokenFormatter,
  type OutcomeTokenJSON
} from './outcome-token/index.js';

// TokenBalance модуль (только публичный API)
export {
  TokenBalance,
  TokenBalanceService,
  TokenBalanceSerializer,
  TokenBalanceFormatter,
  TokenBalanceErrorReason,
  type TokenBalanceJSON
} from './token-balance/index.js';

// AssetQuantity модуль (только публичный API)
export {
  AssetQuantity,
  AssetQuantityService,
  AssetQuantitySerializer,
  AssetQuantityFormatter,
  AssetQuantityErrorReason,
  type AssetQuantityJSON
} from './asset-quantity/index.js';

// Quote модуль (только публичный API)
export {
  Quote,
  QuoteInvariantViolation,
  QuoteService,
  QuoteSerializer,
  QuoteFormatter,
  QuoteErrorReason,
  ValidateQuoteSizes,
  ValidateMinSpread,
  ValidateMaxSpread,
  ValidateMarketCrossing,
  type QuoteJSON,
  type QuoteFormatOptions
} from './quote/index.js';

// Side модуль (направление торговой операции)
export {
  type Side,
  SideService,
  SideSerializer,
  SideFormatter,
  SideErrorReason
} from './side/index.js';

// Fee модуль (комиссии)
export {
  Fee,
  FeeService,
  FeeSerializer,
  FeeFormatter,
  FeeErrorReason,
  FeeOperationError,
  FeeOperationErrorReason,
  type FeeJSON
} from './fee/index.js';
