/**
 * @polymarket/market — Market entity package
 *
 * @remarks
 * Предоставляет доменную сущность Market для системы предсказательных рынков.
 *
 * ### Архитектура:
 * - **Market** — основная entity с lifecycle management
 * - **Value Objects** — MarketId (@polymarket/ids), OutcomeToken (@polymarket/value-objects),
 *   MarketSlug, MarketStatus, MarketState
 * - **Errors** — переехали в `@polymarket/errors/market` (re-exported отсюда для удобства)
 * - **View** — MarketViewModel (URL, toJSON, fromJSON)
 *
 * ### Импорт ошибок:
 * ```typescript
 * // Предпочтительный вариант — прямой импорт из sub-path:
 * import { MarketLifecycleError, MarketAlreadyClosedError } from '@polymarket/errors/market';
 *
 * // Или через этот пакет (re-export):
 * import { MarketLifecycleError } from '@polymarket/market';
 * ```
 *
 * @example
 * ```typescript
 * import {
 *   Market,
 *   MarketState,
 *   unsafeMarketId,
 *   parseMarketSlug,
 *   MarketViewModel,
 * } from '@polymarket/market';
 * import { OutcomeToken, BinaryOutcome } from '@polymarket/value-objects/outcome-token';
 *
 * const result = Market.create({
 *   id: unsafeMarketId('market-abc'),
 *   slug: parseMarketSlug('will-trump-win')!,
 *   question: 'Will Trump win?',
 *   outcomes: [
 *     { token: OutcomeToken.of(conditionRef, BinaryOutcome.UP), index: 0, name: 'Yes' },
 *     { token: OutcomeToken.of(conditionRef, BinaryOutcome.DOWN), index: 1, name: 'No' },
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
} from './value-objects/index.js';

// Errors — живут в @polymarket/errors/market, re-export для удобства
export {
  MarketValidationError,
  MarketLifecycleError,
  MarketAlreadyClosedError,
  MarketAlreadyResolvedError,
  MarketInvalidTransitionError,
} from '@polymarket/errors/market';

// View
export {
  MarketViewModel,
  type MarketJSON,
} from './view/MarketViewModel.js';
