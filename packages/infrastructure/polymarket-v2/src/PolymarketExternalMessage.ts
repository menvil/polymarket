/**
 * Canonical ExternalMessage-контракты Polymarket V2 ingress.
 *
 * @remarks
 * ### Source-native payload = decoded event официального SDK
 *
 * Payload каждого сообщения — это БУКВАЛЬНО объект, который вернул официальный
 * `@polymarket/client` (декодированный и валидированный SDK), без нашего
 * DTO-remapping, без VO-конверсии и без выбрасывания полей:
 *
 * ```text
 * SDK AsyncIterable event ──→ ExternalMessage.payload   (тот же объект)
 * ```
 *
 * SDK сохраняет собственные discriminators (`topic`, `type`) внутри payload —
 * они понадобятся будущим Recorder/Reader/SemanticAdapter. Наш внешний
 * `ExternalMessage.type` — это ТОЛЬКО routing discriminator нашего контура
 * и он не заменяет vendor-поля.
 *
 * ### Granularity union
 *
 * Один ExternalMessage-тип на source/channel/topic; SDK-specific event
 * discriminator (`book`/`price_change`/... или `update`) остаётся ВНУТРИ
 * payload. Подключены только каналы, которые реально использует текущая
 * система сбора данных: CLOB market channel и два RTDS crypto-price topics
 * (Binance + Chainlink). TWAP/equity/comments/sports/perps каналы SDK
 * сознательно НЕ подключены — приложение их не использует.
 *
 * ### Почему `@polymarket/bindings/subscriptions`
 *
 * `@polymarket/client@0.6.0` НЕ re-экспортирует realtime event-типы
 * (`StandardMarketEvent`, `CryptoPricesBinanceEvent`, ...) со своего root.
 * Они живут в public subpath export `@polymarket/bindings/subscriptions`
 * (объявлен в `exports` пакета bindings — это НЕ internal path). Версия
 * bindings зафиксирована точно той же, которую pin-ит сам client (0.6.0).
 */
import type {
  CryptoPricesBinanceEvent,
  CryptoPricesChainlinkEvent,
  StandardMarketEvent,
} from '@polymarket/bindings/subscriptions';
import type { ExternalMessage } from '@polymarket/external-messages';

/**
 * Наблюдение CLOB market channel Polymarket.
 *
 * @remarks
 * Payload — {@link StandardMarketEvent} официального SDK: discriminated union
 * `type: 'book' | 'price_change' | 'last_trade_price' | 'tick_size_change'`
 * с `topic: 'market'`. Это ровно те event-типы, которые текущая система
 * получает из старого market channel (`event_type` в старом wire-формате).
 *
 * Подписка выполняется БЕЗ `customFeatureEnabled`, поэтому расширенные
 * custom-события (`best_bid_ask`/`new_market`/`market_resolved`) в этот
 * контракт не входят — старый pipeline их тоже не использует.
 *
 * @example
 * ```typescript
 * bus.subscribe('POLYMARKET_MARKET', (message) => {
 *   // message.payload — StandardMarketEvent; narrowing по payload.type:
 *   if (message.payload.type === 'book') {
 *     recorder.write(message.payload); // bids/asks/hash/timestamp — как отдал SDK
 *   }
 * });
 * ```
 */
export type PolymarketMarketExternalMessage = ExternalMessage<
  'POLYMARKET_MARKET',
  StandardMarketEvent
>;

/**
 * Наблюдение RTDS topic `prices.crypto.binance` (крипто-цены Binance).
 *
 * @remarks
 * Payload — {@link CryptoPricesBinanceEvent} официального SDK:
 * `{ topic: 'prices.crypto.binance', type: 'update', timestamp,
 * payload: { symbol, timestamp, value } }` — SDK сохраняет нативную форму
 * RTDS-сообщения (старый `RtdsWebSocketClient` получал тот же shape).
 *
 * @example
 * ```typescript
 * bus.subscribe('POLYMARKET_CRYPTO_BINANCE', (message) => {
 *   const { symbol, value, timestamp } = message.payload.payload;
 * });
 * ```
 */
export type PolymarketCryptoBinanceExternalMessage = ExternalMessage<
  'POLYMARKET_CRYPTO_BINANCE',
  CryptoPricesBinanceEvent
>;

/**
 * Наблюдение RTDS topic `prices.crypto.chainlink` (крипто-цены Chainlink oracle).
 *
 * @remarks
 * Payload — {@link CryptoPricesChainlinkEvent} официального SDK; структура
 * идентична Binance-событию, отличается только `topic`-discriminator.
 * Символы Chainlink имеют slash-формат (`btc/usd`), Binance — слитный
 * (`btcusdt`) — как и в старом RTDS-клиенте.
 *
 * @example
 * ```typescript
 * bus.subscribe('POLYMARKET_CRYPTO_CHAINLINK', (message) => {
 *   const { symbol, value } = message.payload.payload; // 'btc/usd', DecimalString
 * });
 * ```
 */
export type PolymarketCryptoChainlinkExternalMessage = ExternalMessage<
  'POLYMARKET_CRYPTO_CHAINLINK',
  CryptoPricesChainlinkEvent
>;

/**
 * Полный discriminated union внешних сообщений Polymarket V2 source.
 *
 * @remarks
 * Именно этим union параметризуется общий
 * `ExternalMessageBus<PolymarketExternalMessage>` контура (при появлении
 * других sources union контура расширяется на composition root:
 * `PolymarketExternalMessage | CexExternalMessage | ...`).
 *
 * Payload каждого члена — конкретный typed SDK event; `unknown`/widening до
 * `AnyExternalMessage` в production-контуре запрещены (уничтожают narrowing).
 *
 * @example
 * ```typescript
 * const bus = new ExternalMessageBus<PolymarketExternalMessage>();
 * bus.subscribe('POLYMARKET_MARKET', (m) => {
 *   // m.payload: StandardMarketEvent — компилятор сузил по типу подписки
 * });
 * ```
 */
export type PolymarketExternalMessage =
  | PolymarketMarketExternalMessage
  | PolymarketCryptoBinanceExternalMessage
  | PolymarketCryptoChainlinkExternalMessage;
