/**
 * Barrel экспорт Value Objects
 *
 * @remarks
 * Экспортирует все value objects для удобного импорта.
 * Value objects являются иммутабельными и представляют концепции без идентичности.
 */

// Money модуль (только публичный API)
export { Money, MoneyService, MoneySerializer, MoneyFormatter, SupportedCurrency } from './money/index.js';

// Price модуль (только публичный API)
export { Price, PriceService, PriceSerializer, PriceFormatter } from './price/index.js';

// Quantity модуль (только публичный API)
export { Quantity, QuantityService } from './quantity/index.js';

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
  OutcomeTokenErrorReason,
  type OutcomeTokenJSON
} from './outcome-token/index.js';

// TODO: Implement these value objects
// export { Quote } from './Quote.js';
