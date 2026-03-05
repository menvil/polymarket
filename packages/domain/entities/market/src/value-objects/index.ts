/**
 * Value Objects для Market entity
 */

// MarketId — из foundation ids пакета
export { type MarketId, asMarketId, unsafeMarketId } from '@polymarket/ids';

// OutcomeToken — из domain value-objects пакета
export { OutcomeToken, OutcomeTokenSerializer, type OutcomeTokenJSON } from '@polymarket/value-objects/outcome-token';

export { type MarketSlug, parseMarketSlug } from './MarketSlug.js';
export {
  type MarketStatus,
  MARKET_STATUS_VALUES,
  isValidMarketStatus,
} from './MarketStatus.js';
export {
  type OutcomeIndex,
  MarketState,
  isActive,
  isClosed,
  isResolved,
} from './MarketState.js';
