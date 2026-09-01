/**
 * Canonical ExternalMessage-контракты Polymarket V2 ingress.
 *
 * @remarks
 * ### Source-native payload = decoded event Polymarket V2 client/bindings
 *
 * Payload каждого сообщения — это БУКВАЛЬНО объект, который вернул
 * `@polymarket/client` (декодированный и валидированный им), без нашего
 * DTO-remapping, без VO-конверсии и без выбрасывания полей:
 *
 * ```text
 * client AsyncIterable event ──→ ExternalMessage.payload   (тот же объект)
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
 * система сбора данных: CLOB market channel, два RTDS spot crypto-price
 * topics (Binance + Chainlink) и settlement-поток Chainlink TWAP.
 * Equity/comments/sports/perps каналы SDK сознательно НЕ подключены —
 * приложение их не использует.
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
  CryptoPricesChainlinkTwapEvent,
  StandardMarketEvent,
} from '@polymarket/bindings/subscriptions';
import type { ExternalMessage } from '@polymarket/external-messages';

/**
 * Наблюдение CLOB market channel Polymarket.
 *
 * @remarks
 * Payload — {@link StandardMarketEvent} Polymarket V2 client/bindings: discriminated union
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
 * Payload — {@link CryptoPricesBinanceEvent} Polymarket V2 client/bindings:
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
 * Payload — {@link CryptoPricesChainlinkEvent} Polymarket V2 client/bindings; структура
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
 * Наблюдение RTDS topic `prices.crypto.chainlink.twap` — ОФИЦИАЛЬНЫЙ
 * settlement-поток Up/Down-серий.
 *
 * @remarks
 * Отдельный routing discriminator, а не вариант
 * {@link PolymarketCryptoChainlinkExternalMessage} (MR-B PART 17): TWAP —
 * не «ещё одна spot-цена», а источник РАСЧЁТА рынка, и подмешивать его в
 * spot-поток означало бы потерю различия там, где оно определяет итог.
 *
 * Payload — {@link CryptoPricesChainlinkTwapEvent} Polymarket V2 client/bindings
 * (характеризовано live 2026-08-26):
 *
 * ```json
 * {"topic":"prices.crypto.chainlink.twap","type":"update","timestamp":1787751722763,
 *  "payload":{"symbol":"btc/usd","timestamp":1787751721000,
 *             "value":"78376.356031481042173952","windowSeconds":60}}
 * ```
 *
 * Ключевое отличие от spot-события: `payload.windowSeconds` (30 | 60) —
 * окно усреднения приходит В САМОМ событии, поэтому и routing записи, и
 * последующий replay различают окна БЕЗ внешнего контекста. Vendor-топики
 * провода (`crypto_prices_twap_thirty`/`_sixty`) SDK нормализует в один
 * `topic` ещё до нас — мы видим уже нормализованную форму.
 *
 * @example
 * ```typescript
 * bus.subscribe('POLYMARKET_CRYPTO_CHAINLINK_TWAP', (message) => {
 *   const { symbol, value, windowSeconds, timestamp } = message.payload.payload;
 * });
 * ```
 */
export type PolymarketCryptoChainlinkTwapExternalMessage = ExternalMessage<
  'POLYMARKET_CRYPTO_CHAINLINK_TWAP',
  CryptoPricesChainlinkTwapEvent
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
  | PolymarketCryptoChainlinkExternalMessage
  | PolymarketCryptoChainlinkTwapExternalMessage;
