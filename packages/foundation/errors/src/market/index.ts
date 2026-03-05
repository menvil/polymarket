/**
 * @polymarket/errors/market — ошибки жизненного цикла Market entity
 *
 * @remarks
 * Sub-path экспорт для ошибок доменной сущности Market.
 * Импортируй через sub-path, чтобы не тянуть весь errors barrel:
 *
 * ```typescript
 * import {
 *   MarketValidationError,
 *   MarketLifecycleError,
 *   MarketAlreadyClosedError,
 *   MarketAlreadyResolvedError,
 *   MarketInvalidTransitionError,
 * } from '@polymarket/errors/market';
 * ```
 *
 * ### Иерархия:
 * ```
 * TradingError
 * ├── ValidationError
 * │   └── MarketValidationError
 * └── MarketLifecycleError
 *     ├── MarketAlreadyClosedError
 *     ├── MarketAlreadyResolvedError
 *     └── MarketInvalidTransitionError
 * ```
 *
 * @packageDocumentation
 */

export {
  MarketValidationError,
  MarketLifecycleError,
  MarketAlreadyClosedError,
  MarketAlreadyResolvedError,
  MarketInvalidTransitionError,
} from './MarketErrors.js';
