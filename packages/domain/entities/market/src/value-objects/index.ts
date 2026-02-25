/**
 * Value Objects для Market entity
 */

export { type MarketId, parseMarketId, asMarketId } from './MarketId.js';
export { type OutcomeTokenId, parseOutcomeTokenId } from './OutcomeTokenId.js';
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
  canTransition,
} from './MarketState.js';
