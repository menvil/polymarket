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
} from './PolymarketExternalMessage.js';
export { PolymarketSource } from './PolymarketSource.js';
export type {
  PolymarketExternalMessagePublisher,
  PolymarketOpenSubscription,
  PolymarketSourceDependencies,
  PolymarketSubscribeClient,
  PolymarketSubscriptionHandle,
} from './PolymarketSource.js';
export type {
  CryptoPricesBinanceEvent,
  CryptoPricesChainlinkEvent,
  CryptoPricesTopic,
  StandardMarketEvent,
} from '@polymarket/bindings/subscriptions';
