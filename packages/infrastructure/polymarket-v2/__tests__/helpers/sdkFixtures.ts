/**
 * Fixtures decoded-событий официального SDK для тестов Source.
 *
 * @remarks
 * Формы объектов 1:1 повторяют output zod-схем
 * `@polymarket/bindings/subscriptions` (проверено по `.d.ts` установленной
 * версии 0.6.0 и по live smoke `scripts/smoke.ts`, печатающему реальные
 * события):
 *
 * - market: wire `{event_type, asset_id, snake_case}` SDK трансформирует в
 *   `{topic:'market', type, payload:{tokenId, camelCase}}`;
 * - RTDS: wire topic `crypto_prices`/`crypto_prices_chainlink` SDK
 *   переименовывает в `prices.crypto.binance`/`prices.crypto.chainlink`,
 *   форма `{topic, type:'update', timestamp, payload:{symbol, timestamp,
 *   value}}` сохраняется.
 *
 * ### Почему `as` вместо запуска реальных схем
 *
 * Branded-типы SDK (`TokenId`, `DecimalString`, `EpochMilliseconds`)
 * конструируются только его zod-схемами, а `@polymarket/bindings` — чистый
 * ESM: под CJS-runtime jest его НЕЛЬЗЯ импортировать в runtime (type-импорты
 * стираются и безопасны). Поэтому fixtures построены wire-достоверными
 * литералами и приводятся ОДНИМ `as` к SDK-типу; runtime-парс реальных схем
 * выполняет characterization-скрипт `scripts/smoke.ts` (tsx, ESM).
 */
import type {
  CryptoPricesBinanceEvent,
  CryptoPricesChainlinkEvent,
  StandardMarketEvent,
} from '@polymarket/bindings/subscriptions';

/** Реалистичный CLOB tokenId (decimal-строка ERC-1155 token id). */
export const TOKEN_ID_UP =
  '65818619657568813474341868652308942079804919287380422192892211131408793125422';

/** Реалистичный conditionId рынка. */
export const MARKET_CONDITION_ID =
  '0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af';

/**
 * Создаёт SDK-событие `book` (полный снапшот стакана).
 *
 * @param overrides - Переопределения payload-полей (например, `hash` для
 *   различения событий в ordering-тестах)
 * @returns Событие в форме output SDK-схемы
 */
export function createBookEvent(
  overrides: Partial<{ hash: string; timestamp: number }> = {},
): StandardMarketEvent {
  return {
    topic: 'market',
    type: 'book',
    payload: {
      market: MARKET_CONDITION_ID,
      tokenId: TOKEN_ID_UP,
      bids: [
        { price: '0.48', size: '30' },
        { price: '0.47', size: '120' },
      ],
      asks: [
        { price: '0.52', size: '25' },
        { price: '0.53', size: '60' },
      ],
      hash: overrides.hash ?? '0x8a1c...book-hash',
      timestamp: overrides.timestamp ?? 1786668087123,
      minOrderSize: '5',
      tickSize: '0.01',
      negRisk: false,
      lastTradePrice: '0.49',
    },
  } as StandardMarketEvent;
}

/**
 * Создаёт SDK-событие `price_change` (batch-уведомление о ценах).
 *
 * @returns Событие в форме output SDK-схемы
 */
export function createPriceChangeEvent(): StandardMarketEvent {
  return {
    topic: 'market',
    type: 'price_change',
    payload: {
      market: MARKET_CONDITION_ID,
      priceChanges: [
        {
          tokenId: TOKEN_ID_UP,
          price: '0.49',
          size: '15',
          side: 'BUY',
          bestBid: '0.49',
          bestAsk: '0.52',
          hash: '0x8a1c...pc-hash',
        },
      ],
      timestamp: 1786668087500,
    },
  } as StandardMarketEvent;
}

/**
 * Создаёт SDK-событие RTDS Binance (`prices.crypto.binance`).
 *
 * @param overrides - Переопределения (value/timestamp для ordering-тестов)
 * @returns Событие в форме output SDK-схемы
 */
export function createBinanceEvent(
  overrides: Partial<{ value: string; timestamp: number }> = {},
): CryptoPricesBinanceEvent {
  const timestamp = overrides.timestamp ?? 1786668087200;
  return {
    topic: 'prices.crypto.binance',
    type: 'update',
    timestamp,
    payload: {
      symbol: 'btcusdt',
      timestamp,
      value: overrides.value ?? '64250.51',
    },
  } as CryptoPricesBinanceEvent;
}

/**
 * Создаёт SDK-событие RTDS Chainlink (`prices.crypto.chainlink`).
 *
 * @returns Событие в форме output SDK-схемы
 */
export function createChainlinkEvent(): CryptoPricesChainlinkEvent {
  return {
    topic: 'prices.crypto.chainlink',
    type: 'update',
    timestamp: 1786668087300,
    payload: {
      symbol: 'btc/usd',
      timestamp: 1786668087300,
      value: '64251.02',
    },
  } as CryptoPricesChainlinkEvent;
}
