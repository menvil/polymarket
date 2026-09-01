/**
 * Value Objects канонического Market
 *
 * @remarks
 * Здесь собраны только те типы, которые описывают **структуру и подтверждённое
 * состояние** внешнего рынка. Быстро меняющиеся наблюдения (ликвидность, спред,
 * стакан, последняя сделка, цены) в этот контур не входят — см. TSDoc `Market`.
 *
 * Идентификаторы (`MarketId`, `VenueId`, `InstrumentId`, `CryptoAssetId`) живут
 * в foundation-пакете `@polymarket/ids` и реэкспортируются отсюда для удобства
 * потребителей Market.
 */

// Идентификаторы — из foundation-пакета @polymarket/ids
export {
  type MarketId,
  asMarketId,
  unsafeMarketId,
  type VenueId,
  asVenueId,
  isKnownVenue,
  KnownVenues,
  type InstrumentId,
  asInstrumentId,
  unsafeInstrumentId,
  type CryptoAssetId,
  asCryptoAssetId,
  unsafeCryptoAssetId,
} from '@polymarket/ids';

export { type MarketSlug, parseMarketSlug } from './MarketSlug.js';
export {
  type MarketStatus,
  MARKET_STATUS_VALUES,
  isValidMarketStatus,
} from './MarketStatus.js';
export {
  type MarketFamily,
  MARKET_FAMILY_VALUES,
  isValidMarketFamily,
} from './MarketFamily.js';
export { type MarketDuration, asMarketDuration } from './MarketDuration.js';
export { type CryptoUpDownSpec } from './MarketSpec.js';
export { type MarketOutcome } from './MarketOutcome.js';
export {
  type OutcomeIndex,
  MarketState,
  isActive,
  isClosed,
  isResolved,
} from './MarketState.js';
