/**
 * Модуль ReferencePrice — цена внешнего актива (BTC/USD, ETH/USD, ...).
 *
 * @remarks
 * Source-agnostic canonical VO: не знает ни про Polymarket RTDS, ни про
 * биржи. Провенанс наблюдения (кто и каким потоком его прислал) живёт в
 * semantic-событии, а не в самой цене — поэтому этот VO переиспользуется
 * любым source adapter, включая будущий CEX.
 *
 * Почему не `Price` — см. докблок `core/ReferencePrice.ts`.
 */

// Core (публичный API)
export { ReferencePrice, ReferencePriceInvariantViolation } from './core/index.js';

// Facade (главный публичный API)
export { ReferencePriceService } from './facade/index.js';

// Errors (публичный API)
export { ReferencePriceErrorReason } from './errors/index.js';
