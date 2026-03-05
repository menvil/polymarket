/**
 * @polymarket/market — Market entity package
 *
 * @remarks
 * Предоставляет доменную сущность Market для системы предсказательных рынков.
 *
 * ### Архитектура:
 * - **Market** — основная entity с lifecycle management
 * - **Value Objects** — MarketId (@polymarket/ids), OutcomeToken (@polymarket/value-objects), MarketSlug, MarketStatus, MarketState
 * - **Errors** — MarketValidationError, MarketLifecycleError
 * - **View** — MarketViewModel (URL, toJSON, fromJSON)
 *
 * @example
 * ```typescript
 * import {
 *   Market,
 *   MarketState,
 *   asMarketId,
 *   parseMarketSlug,
 *   parseOutcomeTokenId,
 *   MarketViewModel,
 * } from '@polymarket/market';
 *
 * const result = Market.create({
 *   id: asMarketId('market-abc'),
 *   slug: parseMarketSlug('will-trump-win')!,
 *   question: 'Will Trump win?',
 *   outcomeNames: ['Yes', 'No'],
 *   outcomeTokenIds: [
 *     parseOutcomeTokenId('token-yes')!,
 *     parseOutcomeTokenId('token-no')!,
 *   ],
 *   expirationMs: Date.now() + 86400000,
 *   state: MarketState.active(),
 * });
 *
 * if (result.ok) {
 *   const url = MarketViewModel.getMarketUrl(result.value);
 * }
 * ```
 *
 * @packageDocumentation
 */

// Entity
export { Market, type Outcome, type MarketProps } from './Market.js';

// Value Objects
export {
  type MarketId,
  asMarketId,
  unsafeMarketId,
  OutcomeToken,
  OutcomeTokenSerializer,
  type OutcomeTokenJSON,
  type MarketSlug,
  parseMarketSlug,
  type MarketStatus,
  MARKET_STATUS_VALUES,
  isValidMarketStatus,
  type OutcomeIndex,
  MarketState,
  isActive,
  isClosed,
  isResolved,
  canTransition,
} from './value-objects/index.js';

// Errors
export {
  MarketValidationError,
  MarketLifecycleError,
} from './errors/MarketErrors.js';

// View
export {
  MarketViewModel,
  type MarketJSON,
} from './view/MarketViewModel.js';
