/**
 * `@polymarket/polymarket-semantic-adapter` — граница
 * «raw-наблюдение Polymarket → canonical Domain/Application».
 *
 * @remarks
 * Пакет ЧИТАЕТ общий `ExternalMessageBus` и ПУБЛИКУЕТ canonical
 * `ApplicationEvent` в Application `IEventBus`. Он не владеет ни одной из
 * этих шин и ничего не знает про `DataCollector`/recorder — recorder и
 * адаптер являются независимыми потребителями одной raw-шины.
 *
 * @example
 * ```typescript
 * import { PolymarketSemanticAdapter } from '@polymarket/polymarket-semantic-adapter';
 *
 * const adapter = new PolymarketSemanticAdapter({ bus, eventBus, metadataGenerator, logger });
 * adapter.start();
 * ```
 *
 * @packageDocumentation
 */
export { PolymarketSemanticAdapter } from './PolymarketSemanticAdapter.js';
export type {
  PolymarketSemanticAdapterDependencies,
  PolymarketSemanticAdapterStats,
  PolymarketSemanticBusSubscription,
} from './PolymarketSemanticAdapter.js';
export {
  POLYMARKET_RTDS_BINANCE_SOURCE,
  POLYMARKET_RTDS_CHAINLINK_SOURCE,
  POLYMARKET_RTDS_CHAINLINK_TWAP_SOURCE,
} from './PolymarketSemanticAdapter.js';

export { parseAssetPair } from './symbols.js';
export type { AssetPairSymbols } from './symbols.js';

export { OrderbookReconstructionState } from './OrderbookReconstructionState.js';
export type {
  ApplyFailureReason,
  ApplyOutcome,
  BookSide,
  LevelDeltaInput,
  RawLevelInput,
  ReconstructionStats,
  VendorBestPrices,
} from './OrderbookReconstructionState.js';
