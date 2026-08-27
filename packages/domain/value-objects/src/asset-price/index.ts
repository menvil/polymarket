/**
 * Модуль AssetPrice — цена внешнего актива (BTC/USD, ETH/USD, ...).
 *
 * @remarks
 * Source-agnostic canonical VO: не знает ни про Polymarket RTDS, ни про
 * биржи. Провенанс наблюдения (кто и каким потоком его прислал) живёт в
 * semantic-событии, а не в самой цене — поэтому этот VO переиспользуется
 * любым source adapter, включая будущий CEX.
 *
 * Почему не `OutcomePrice` — см. докблок `core/AssetPrice.ts`.
 */

// Core (публичный API)
export { AssetPrice, AssetPriceInvariantViolation } from './core/index.js';

// Facade (главный публичный API)
export { AssetPriceService } from './facade/index.js';

// Adapters (публичный API)
export { AssetPriceFormatter, AssetPriceSerializer, type AssetPriceJSON } from './adapters/index.js';

// Errors (публичный API)
export { AssetPriceErrorReason } from './errors/index.js';
