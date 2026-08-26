/**
 * Fixtures decoded-событий официального SDK для тестов Recorder.
 *
 * @remarks
 * Формы объектов 1:1 повторяют output zod-схем
 * `@polymarket/bindings/subscriptions` (проверено по `.d.ts` установленной
 * версии 0.6.0 и по live smoke N-001) — та же основа, что и fixtures
 * `@polymarket/polymarket-v2`, расширенная параметрами routing
 * (`market`/`symbol`) и multi-token `price_change` для тестов маршрутизации.
 *
 * SDK-типы импортируются через публичный API `@polymarket/polymarket-v2`
 * (contract surface source-native payload) — в `@polymarket/bindings`
 * напрямую тесты recorder-а не ходят. Branded-типы SDK конструируются только
 * его zod-схемами, поэтому fixtures построены wire-достоверными литералами и
 * приводятся ОДНИМ `as` к SDK-типу (runtime-парс реальных схем выполняет
 * live smoke `scripts/smoke.ts`).
 */
import type {
  CryptoPricesBinanceEvent,
  CryptoPricesChainlinkEvent,
  CryptoPricesChainlinkTwapEvent,
  StandardMarketEvent,
} from '@polymarket/polymarket-v2';

/** Реалистичный CLOB tokenId (decimal-строка ERC-1155 token id). */
export const TOKEN_ID_UP =
  '65818619657568813474341868652308942079804919287380422192892211131408793125422';

/** Второй tokenId (DOWN-сторона) для multi-token price_change. */
export const TOKEN_ID_DOWN =
  '71321045679252212594626385532706912750332728571942532289631379312455583992563';

/** Реалистичный conditionId рынка A. */
export const MARKET_CONDITION_ID =
  '0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af';

/** Реалистичный conditionId рынка B (для fan-out/duplication тестов). */
export const MARKET_CONDITION_ID_B =
  '0x5f0827a4c0cfd1b3ec814b46b45107486e6c7ef8ee5b4e714b46921663bbb1f2';

/**
 * Создаёт SDK-событие `book` (полный снапшот стакана).
 *
 * @param overrides - Переопределения routing/ordering-полей
 * @returns Событие в форме output SDK-схемы
 */
export function createBookEvent(
  overrides: Partial<{ market: string; hash: string; timestamp: number }> = {},
): StandardMarketEvent {
  return {
    topic: 'market',
    type: 'book',
    payload: {
      market: overrides.market ?? MARKET_CONDITION_ID,
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
 * Создаёт SDK-событие `price_change` с изменениями по ДВУМ tokenIds.
 *
 * @param overrides - Переопределения routing-полей
 * @returns Событие в форме output SDK-схемы
 *
 * @remarks
 * Multi-token нагрузка — регрессия PART 23: у события нет одного внешнего
 * tokenId, маршрутизация обязана идти по `payload.market`, а payload
 * записываться ОДНОЙ строкой (без разбиения по priceChanges).
 */
export function createPriceChangeEvent(
  overrides: Partial<{ market: string }> = {},
): StandardMarketEvent {
  return {
    topic: 'market',
    type: 'price_change',
    payload: {
      market: overrides.market ?? MARKET_CONDITION_ID,
      priceChanges: [
        {
          tokenId: TOKEN_ID_UP,
          price: '0.49',
          size: '15',
          side: 'BUY',
          bestBid: '0.49',
          bestAsk: '0.52',
          hash: '0x8a1c...pc-hash-up',
        },
        {
          tokenId: TOKEN_ID_DOWN,
          price: '0.51',
          size: '40',
          side: 'SELL',
          bestBid: '0.48',
          bestAsk: '0.51',
          hash: '0x8a1c...pc-hash-down',
        },
      ],
      timestamp: 1786668087500,
    },
  } as StandardMarketEvent;
}

/**
 * Создаёт SDK-событие `last_trade_price`.
 *
 * @param overrides - Переопределения routing-полей
 * @returns Событие в форме output SDK-схемы
 */
export function createLastTradePriceEvent(
  overrides: Partial<{ market: string }> = {},
): StandardMarketEvent {
  return {
    topic: 'market',
    type: 'last_trade_price',
    payload: {
      market: overrides.market ?? MARKET_CONDITION_ID,
      tokenId: TOKEN_ID_UP,
      price: '0.49',
      side: 'BUY',
      size: '12',
      feeRateBps: '0',
      timestamp: 1786668087700,
      transactionHash: '0xabc...trade',
    },
  } as StandardMarketEvent;
}

/**
 * Создаёт SDK-событие `tick_size_change`.
 *
 * @param overrides - Переопределения routing-полей
 * @returns Событие в форме output SDK-схемы
 */
export function createTickSizeChangeEvent(
  overrides: Partial<{ market: string }> = {},
): StandardMarketEvent {
  return {
    topic: 'market',
    type: 'tick_size_change',
    payload: {
      market: overrides.market ?? MARKET_CONDITION_ID,
      tokenId: TOKEN_ID_UP,
      oldTickSize: '0.01',
      newTickSize: '0.001',
      timestamp: 1786668087900,
    },
  } as StandardMarketEvent;
}

/**
 * Создаёт SDK-событие RTDS Binance (`prices.crypto.binance`).
 *
 * @param overrides - Переопределения routing/ordering-полей
 * @returns Событие в форме output SDK-схемы
 */
export function createBinanceEvent(
  overrides: Partial<{ symbol: string; value: string; timestamp: number }> = {},
): CryptoPricesBinanceEvent {
  const timestamp = overrides.timestamp ?? 1786668087200;
  return {
    topic: 'prices.crypto.binance',
    type: 'update',
    timestamp,
    payload: {
      symbol: overrides.symbol ?? 'btcusdt',
      timestamp,
      value: overrides.value ?? '64250.51',
    },
  } as CryptoPricesBinanceEvent;
}

/**
 * Создаёт SDK-событие RTDS Chainlink (`prices.crypto.chainlink`).
 *
 * @param overrides - Переопределения routing-полей
 * @returns Событие в форме output SDK-схемы
 */
export function createChainlinkEvent(
  overrides: Partial<{ symbol: string; value: string }> = {},
): CryptoPricesChainlinkEvent {
  return {
    topic: 'prices.crypto.chainlink',
    type: 'update',
    timestamp: 1786668087300,
    payload: {
      symbol: overrides.symbol ?? 'btc/usd',
      timestamp: 1786668087300,
      value: overrides.value ?? '64251.02',
    },
  } as CryptoPricesChainlinkEvent;
}

/**
 * Событие официального settlement-потока Chainlink TWAP.
 *
 * @param overrides - Символ/значение/окно/vendor-timestamp наблюдения
 * @returns SDK-событие в форме, характеризованной live 2026-08-26
 *
 * @remarks
 * Отличие от spot-события — `payload.windowSeconds`: окно приходит В САМОМ
 * событии, поэтому и routing записи, и последующий replay различают
 * `btc/usd` TWAP 30 и `btc/usd` TWAP 60 без внешнего контекста.
 *
 * @example
 * ```typescript
 * createChainlinkTwapEvent({ windowSeconds: 30 });
 * ```
 */
export function createChainlinkTwapEvent(
  overrides: Partial<{
    symbol: string;
    value: string;
    windowSeconds: 30 | 60;
    timestamp: number;
  }> = {},
): CryptoPricesChainlinkTwapEvent {
  const timestamp = overrides.timestamp ?? 1786668087000;
  return {
    topic: 'prices.crypto.chainlink.twap',
    type: 'update',
    timestamp: timestamp + 1_895,
    payload: {
      symbol: overrides.symbol ?? 'btc/usd',
      timestamp,
      value: overrides.value ?? '78400.701754893592952832',
      windowSeconds: overrides.windowSeconds ?? 60,
    },
  } as CryptoPricesChainlinkTwapEvent;
}
