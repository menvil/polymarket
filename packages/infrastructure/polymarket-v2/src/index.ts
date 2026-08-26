/**
 * @polymarket/polymarket-v2 — Polymarket V2 ingress boundary.
 *
 * @remarks
 * Пакет превращает наблюдения официального `@polymarket/client` в canonical
 * `ExternalMessage` и публикует их в общий `ExternalMessageBus`:
 *
 * ```text
 * @polymarket/client → PolymarketSource → ExternalMessage → ExternalMessageBus
 * ```
 *
 * Никакой семантики здесь нет: payload — нетронутый SDK event; конверсия в
 * OrderBook/Trade/VO — работа будущего PolymarketSemanticAdapter ПОСЛЕ bus.
 *
 * SDK-типы payload re-экспортируются отсюда сознательно: это contract surface
 * source-native payload для будущих подписчиков (Recorder/SemanticAdapter),
 * которым нельзя лезть в `@polymarket/bindings` напрямую.
 */
export type {
  PolymarketExternalMessage,
  PolymarketMarketExternalMessage,
  PolymarketCryptoBinanceExternalMessage,
  PolymarketCryptoChainlinkExternalMessage,
  PolymarketCryptoChainlinkTwapExternalMessage,
} from './PolymarketExternalMessage.js';
export { PolymarketSource } from './PolymarketSource.js';
export type {
  PolymarketExternalMessagePublisher,
  PolymarketOpenSubscription,
  PolymarketSourceDependencies,
  PolymarketSubscribeClient,
  PolymarketSubscriptionHandle,
} from './PolymarketSource.js';
export { PolymarketMarketDiscovery } from './PolymarketMarketDiscovery.js';
export type {
  PolymarketDiscoveryClient,
  PolymarketDiscoveredMarket,
  PolymarketMarketDiscoveryConfig,
  PolymarketMarketDiscoveryDependencies,
  SelectedPolymarketMarket,
  SelectedPolymarketOutcome,
} from './PolymarketMarketDiscovery.js';
export {
  CHAINLINK_TWAP_TOPIC,
  derivePolymarketCryptoMeta,
  isChainlinkTwapResolutionSource,
  isTwapRtdsFeed,
  parseChainlinkTwapSettlement,
  rtdsFeedKey,
} from './PolymarketRtdsFeeds.js';
export type {
  PolymarketChainlinkTwapSettlement,
  PolymarketCryptoMeta,
  PolymarketRtdsFeed,
  PolymarketSpotRtdsFeed,
  PolymarketTwapRtdsFeed,
} from './PolymarketRtdsFeeds.js';
export { PolymarketTwapObservations } from './PolymarketTwapObservations.js';
export type {
  PolymarketTwapBusSubscription,
  PolymarketTwapObservation,
  PolymarketTwapObservationsConfig,
  PolymarketTwapObservationsDependencies,
  PolymarketTwapObservationsStats,
} from './PolymarketTwapObservations.js';
export {
  compareDecimalStrings,
  deriveWinnerFromCryptoPrices,
  deriveWinningOutcome,
  extractCryptoFinalization,
  isFiniteDecimalString,
  mapFinalOutcomes,
  meanOfDecimalStrings,
} from './PolymarketFinalization.js';
export type {
  PolymarketCryptoFinalization,
  PolymarketFinalOutcome,
} from './PolymarketFinalization.js';
export type {
  CryptoPricesBinanceEvent,
  CryptoPricesChainlinkEvent,
  CryptoPricesChainlinkTwapEvent,
  CryptoPricesChainlinkTwapTopic,
  CryptoPricesChainlinkTwapWindowSeconds,
  CryptoPricesTopic,
  StandardMarketEvent,
} from '@polymarket/bindings/subscriptions';
// Typed normalized Gamma-модели официального SDK — contract surface discovery
// boundary для координатора/header (лезть в bindings напрямую запрещено).
export type { Event as PolymarketGammaEvent, Market as PolymarketGammaMarket } from '@polymarket/bindings/gamma';
