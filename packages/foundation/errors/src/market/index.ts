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
 *   MarketAlreadyResolvedError,
 * } from '@polymarket/errors/market';
 * ```
 *
 * ### Иерархия:
 * ```
 * TradingError
 * ├── ValidationError
 * │   └── MarketValidationError
 * └── MarketLifecycleError
 *     └── MarketAlreadyResolvedError
 * ```
 *
 * @packageDocumentation
 */

export {
  MarketValidationError,
  MarketLifecycleError,
  MarketAlreadyResolvedError,
} from './MarketErrors.js';
