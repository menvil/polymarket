/**
 * Строгий разбор settlement-дескриптора и идентичность RTDS-фидов (MR-B).
 *
 * @remarks
 * Ключевой инвариант этих тестов: окно TWAP приходит ИЗ `resolution.source`
 * конкретного рынка и ниоткуда больше. Любая связь окна с длительностью
 * рынка («5 минут → 30 секунд») — ошибка, которая тихо резолвила бы рынок
 * не тем потоком; она закрыта отдельной regression-фикстурой.
 */
import { describe, expect, it } from '@jest/globals';
import type { Market } from '@polymarket/bindings/gamma';
import {
  CHAINLINK_TWAP_TOPIC,
  derivePolymarketCryptoMeta,
  isChainlinkTwapResolutionSource,
  isTwapRtdsFeed,
  parseChainlinkTwapSettlement,
  rtdsFeedKey,
} from '../src/index.js';
import type { PolymarketRtdsFeed } from '../src/index.js';

/** Минимальный вход `derivePolymarketCryptoMeta` (читается одно поле). */
function marketWithSource(source: string | null): Pick<Market, 'resolution'> {
  return { resolution: { source } } as unknown as Pick<Market, 'resolution'>;
}

describe('parseChainlinkTwapSettlement: символ + ТОЧНОЕ окно (PART 11/57)', () => {
  it.each([
    ['https://data.chain.link/streams/btc-usd-twap-60s-streams', 'btc/usd', 60],
    ['https://data.chain.link/streams/eth-usd-twap-30s-streams', 'eth/usd', 30],
    ['https://data.chain.link/streams/sol-usd-twap-60s-streams', 'sol/usd', 60],
    ['https://data.chain.link/streams/DOGE-USD-TWAP-30S-STREAMS', 'doge/usd', 30],
    ['https://data.chain.link/streams/xrp-usd-twap-60s', 'xrp/usd', 60],
  ])('%s → %s / %ss', (source, symbol, windowSeconds) => {
    expect(parseChainlinkTwapSettlement(source)).toEqual({
      kind: 'chainlink-twap',
      symbol,
      windowSeconds,
      resolutionSource: source,
    });
  });

  it.each([
    // Окно вне vendor-домена: подменять его ближайшим поддержанным ЗАПРЕЩЕНО
    ['https://data.chain.link/streams/btc-usd-twap-45s-streams'],
    ['https://data.chain.link/streams/btc-usd-twap-15s-streams'],
    ['https://data.chain.link/streams/btc-usd-twap-600s-streams'],
    // Не TWAP-форма вовсе
    ['https://data.chain.link/streams/btc-usd'],
    ['https://data.chain.link/streams/btc-usd-twap-streams'],
    ['https://data.chain.link/streams/btc-usd-twap-60-streams'], // нет 's' у окна
    // Другой источник резолюции
    ['https://www.binance.com/en/trade/BTC_USDT'],
    ['https://pfl.uz/'],
    [''],
  ])('%s → дескриптора нет (unsupported settlement)', (source) => {
    expect(parseChainlinkTwapSettlement(source)).toBeUndefined();
  });

  it('null/undefined источник не разбирается', () => {
    expect(parseChainlinkTwapSettlement(null)).toBeUndefined();
    expect(parseChainlinkTwapSettlement(undefined)).toBeUndefined();
  });
});

describe('окно НЕ выводится из длительности рынка (PART 9/58)', () => {
  it('5-минутный рынок с URL twap-60s даёт окно 60, а не 30', () => {
    // Regression: все живые 5m-серии Polymarket (замер 2026-08-26) резолвятся
    // 60-секундным TWAP. Эвристика «5m → 30s» дала бы рынок, чей архив
    // считается не тем потоком, которым рынок реально рассчитывается.
    const source = 'https://data.chain.link/streams/btc-usd-twap-60s-streams';
    const meta = derivePolymarketCryptoMeta(marketWithSource(source));

    expect(meta?.settlement?.windowSeconds).toBe(60);
    expect(meta?.feeds.find(isTwapRtdsFeed)?.windowSeconds).toBe(60);
  });

  it('15-минутный рынок с URL twap-30s даёт окно 30, а не 60', () => {
    const source = 'https://data.chain.link/streams/eth-usd-twap-30s-streams';
    const meta = derivePolymarketCryptoMeta(marketWithSource(source));

    expect(meta?.settlement?.windowSeconds).toBe(30);
    expect(meta?.feeds.find(isTwapRtdsFeed)?.windowSeconds).toBe(30);
  });
});

describe('derivePolymarketCryptoMeta: settlement ДОПОЛНЯЕТ spot-фиды (PART 15)', () => {
  it('TWAP-рынок получает Binance spot + Chainlink spot + Chainlink TWAP', () => {
    const meta = derivePolymarketCryptoMeta(
      marketWithSource('https://data.chain.link/streams/btc-usd-twap-60s-streams'),
    );

    expect(meta?.feeds).toEqual([
      { topic: 'prices.crypto.chainlink', symbol: 'btc/usd' },
      { topic: 'prices.crypto.binance', symbol: 'btcusdt' },
      { topic: CHAINLINK_TWAP_TOPIC, symbol: 'btc/usd', windowSeconds: 60 },
    ]);
  });

  it('spot-рынок Chainlink остаётся БЕЗ выдуманного settlement-потока (PART 90)', () => {
    const meta = derivePolymarketCryptoMeta(
      marketWithSource('https://data.chain.link/streams/btc-usd'),
    );

    expect(meta?.settlement).toBeUndefined();
    expect(meta?.feeds.some(isTwapRtdsFeed)).toBe(false);
  });

  it('неподдержанное окно: spot-фиды есть, settlement нет, правило ПОМЕЧЕНО', () => {
    // Рынок не выпадает из сбора целиком, но обязан нести признак «правило
    // расчёта — TWAP, локально не поддержано»: без него finalizer принял бы
    // его за обычный spot-рынок и вывел бы победителя по СПОТУ.
    const source = 'https://data.chain.link/streams/btc-usd-twap-45s-streams';
    const meta = derivePolymarketCryptoMeta(marketWithSource(source));

    expect(meta?.source).toBe('chainlink');
    expect(meta?.settlement).toBeUndefined();
    expect(meta?.feeds.some(isTwapRtdsFeed)).toBe(false);
    expect(meta?.unsupportedSettlementSource).toBe(source);
  });

  it('обычный spot-рынок НЕ помечается как неподдержанный TWAP', () => {
    const meta = derivePolymarketCryptoMeta(
      marketWithSource('https://data.chain.link/streams/btc-usd'),
    );

    expect(meta?.unsupportedSettlementSource).toBeUndefined();
  });

  it('поддержанное окно не помечается как неподдержанное', () => {
    const meta = derivePolymarketCryptoMeta(
      marketWithSource('https://data.chain.link/streams/btc-usd-twap-60s-streams'),
    );

    expect(meta?.settlement).toBeDefined();
    expect(meta?.unsupportedSettlementSource).toBeUndefined();
  });

  it.each([
    ['https://data.chain.link/streams/btc-usd-twap-45s-streams', true],
    ['https://data.chain.link/streams/btc-usd-twap-120s-streams', true],
    ['https://data.chain.link/streams/btc-usd-twap', true],
    ['https://data.chain.link/streams/btc-usd-twap-60s-streams', true],
    ['https://data.chain.link/streams/btc-usd', false],
    ['https://www.binance.com/en/trade/BTC_USDT', false],
    ['', false],
  ])('isChainlinkTwapResolutionSource(%s) → %s', (source, expected) => {
    expect(isChainlinkTwapResolutionSource(source)).toBe(expected);
  });

  it('Binance-источник не получает settlement-потока (PART 90)', () => {
    const meta = derivePolymarketCryptoMeta(
      marketWithSource('https://www.binance.com/en/trade/BTC_USDT'),
    );

    expect(meta?.source).toBe('binance');
    expect(meta?.settlement).toBeUndefined();
    expect(meta?.feeds.some(isTwapRtdsFeed)).toBe(false);
  });
});

describe('rtdsFeedKey: окно — часть ИДЕНТИЧНОСТИ фида (PART 14/20/59)', () => {
  const twap30: PolymarketRtdsFeed = {
    topic: CHAINLINK_TWAP_TOPIC,
    symbol: 'btc/usd',
    windowSeconds: 30,
  };
  const twap60: PolymarketRtdsFeed = {
    topic: CHAINLINK_TWAP_TOPIC,
    symbol: 'btc/usd',
    windowSeconds: 60,
  };

  it('btc/usd TWAP 30 и btc/usd TWAP 60 — РАЗНЫЕ ключи', () => {
    expect(rtdsFeedKey(twap30)).not.toBe(rtdsFeedKey(twap60));
  });

  it('одинаковые фиды дают одинаковый ключ (ref-count их склеит)', () => {
    expect(rtdsFeedKey(twap60)).toBe(
      rtdsFeedKey({ topic: CHAINLINK_TWAP_TOPIC, symbol: 'btc/usd', windowSeconds: 60 }),
    );
  });

  it('spot-фид и TWAP-фид одного символа различаются', () => {
    expect(rtdsFeedKey({ topic: 'prices.crypto.chainlink', symbol: 'btc/usd' })).not.toBe(
      rtdsFeedKey(twap60),
    );
  });

  it('разные символы одного окна различаются', () => {
    expect(rtdsFeedKey(twap60)).not.toBe(
      rtdsFeedKey({ topic: CHAINLINK_TWAP_TOPIC, symbol: 'eth/usd', windowSeconds: 60 }),
    );
  });

  it('склейка ключа не может стать неоднозначной (разделитель вне vendor-символов)', () => {
    // `prices.crypto.chainlink` + символ `btc/usd\n60` дал бы тот же ключ,
    // что TWAP-60, будь разделитель частью символьного алфавита источника.
    expect(rtdsFeedKey({ topic: 'prices.crypto.chainlink', symbol: 'btc/usd' })).not.toContain(
      '\n60',
    );
  });

  it('isTwapRtdsFeed сужает union до варианта с окном', () => {
    const feed: PolymarketRtdsFeed = twap30;
    expect(isTwapRtdsFeed(feed)).toBe(true);
    if (isTwapRtdsFeed(feed)) {
      expect(feed.windowSeconds).toBe(30); // компилятор видит поле только здесь
    }
    expect(isTwapRtdsFeed({ topic: 'prices.crypto.binance', symbol: 'btcusdt' })).toBe(false);
  });
});
