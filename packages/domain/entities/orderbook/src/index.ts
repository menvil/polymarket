/**
 * Orderbook Entity Package
 *
 * @remarks
 * Экспортирует Orderbook entity, OrderbookLevel VO, нормализатор,
 * адаптеры и типы.
 *
 * Архитектура:
 * - Core: Orderbook entity, OrderbookLevel VO
 * - Normalizer: OrderbookNormalizer, NormalizationPolicy, Raw types
 * - Adapters: OrderbookSerializer (JSON)
 * - Errors: OrderbookInvalidError
 *
 * @example
 * ```typescript
 * import {
 *   Orderbook,
 *   OrderbookSerializer,
 *   OrderbookNormalizer,
 *   DEFAULT_NORMALIZATION_POLICY,
 *   type RawOrderbook,
 * } from '@polymarket/orderbook';
 *
 * // Из raw данных
 * const rawData: RawOrderbook = { / * ... * / };
 * const normalized = OrderbookNormalizer.normalize(rawData);
 * if (normalized.ok) {
 *   const orderbook = Orderbook.fromNormalized(normalized.value);
 * }
 *
 * // Из JSON
 * const result = OrderbookSerializer.fromJSON(json);
 * if (result.ok) {
 *   const orderbook = result.value;
 *   const spread = orderbook.getSpread();
 * }
 * ```
 */

// Core
export { Orderbook, type OrderbookParams } from './core/Orderbook.js';
export { OrderbookLevel } from './core/OrderbookLevel.js';

// Normalizer
export {
  OrderbookNormalizer,
  type NormalizedOrderbook,
} from './normalizer/OrderbookNormalizer.js';
export {
  type NormalizationPolicy,
  DEFAULT_NORMALIZATION_POLICY,
  PERMISSIVE_NORMALIZATION_POLICY,
  TOP_OF_BOOK_POLICY,
} from './normalizer/NormalizationPolicy.js';
export { type RawOrderbook, type RawLevel } from './normalizer/types.js';

// Adapters
export {
  OrderbookSerializer,
  type OrderbookJSON,
} from './adapters/OrderbookSerializer.js';
export {
  PolymarketBookEventParser,
  type PolymarketBookEvent,
  type PolymarketLevel,
} from './adapters/PolymarketBookEventParser.js';

// Errors
export {
  OrderbookInvalidError,
  OrderbookInvalidReason,
  type OrderbookInvalidContext,
  ORDERBOOK_INVALID_ERROR_CODE,
} from './errors/OrderbookInvalidError.js';
