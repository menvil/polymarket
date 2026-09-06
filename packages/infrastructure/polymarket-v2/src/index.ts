/**
 * @polymarket/polymarket-v2 — Polymarket V2 ingress boundary.
 *
 * @remarks
 * Пакет превращает наблюдения Polymarket V2 client/bindings в canonical
 * `ExternalMessage` и публикует их в общий `ExternalMessageBus`:
 *
 * ```text
 * @polymarket/client → PolymarketSource → ExternalMessage → ExternalMessageBus
 * ```
 *
 * Никакой семантики здесь нет: payload — нетронутый vendor event; конверсия в
 * OrderBook/Trade/VO — работа PolymarketSemanticAdapter ПОСЛЕ bus.
 *
 * Vendor-типы payload re-экспортируются отсюда сознательно: это contract
 * surface source-native payload для подписчиков (Recorder/SemanticAdapter),
 * которым нельзя лезть в `@polymarket/bindings` напрямую.
 *
 * ### Control plane: Discovery
 *
 * `PolymarketMarketDiscovery` — второй, независимый контур пакета: он
 * превращает vendor-каталог в canonical `MarketDiscoverySnapshot`
 * (`@polymarket/ports`) с доменными `Market` внутри. Vendor-объекты
 * границу порта не пересекают.
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
  PolymarketSubscriptionHealth,
} from './PolymarketSource.js';
export { PolymarketMarketDiscovery } from './PolymarketMarketDiscovery.js';
export type {
  PolymarketDiscoveryClient,
  PolymarketMarketDiscoveryConfig,
  PolymarketMarketDiscoveryDependencies,
  SelectedPolymarketMarket,
  SelectedPolymarketOutcome,
} from './PolymarketMarketDiscovery.js';
export {
  classifyPolymarketMarket,
  isSupportedCryptoUpDown,
  parseCryptoUpDownSeriesDuration,
} from './PolymarketCryptoUpDownClassifier.js';
export type {
  PolymarketCryptoUpDownClassification,
  PolymarketInvalidClassification,
  PolymarketInvalidReason,
  PolymarketMarketClassification,
  PolymarketUnsupportedClassification,
  PolymarketUnsupportedReason,
  PolymarketUpDownSemantics,
} from './PolymarketCryptoUpDownClassifier.js';
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
// Typed normalized Gamma-модели Polymarket V2 bindings — contract surface
// Infrastructure-подготовки подписок/header (лезть в bindings напрямую запрещено).
export type { Event as PolymarketGammaEvent, Market as PolymarketGammaMarket } from '@polymarket/bindings/gamma';
