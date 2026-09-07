/**
 * Тесты vendor-границы CCXT: маппинг конфигурации в аргументы конструктора
 * инстанса (regression на unified-терминологию типов рынка).
 *
 * @remarks
 * Детерминированная проверка БЕЗ сети и без загрузки vendor-модуля:
 * `buildCcxtInstanceOptions` — ровно те аргументы, которые
 * `createCcxtProExchange` передаёт в `new ccxt.pro[exchangeId](...)`.
 */
import { describe, it, expect } from '@jest/globals';
import type { CexMarketType } from '../src/index.js';
import {
  buildCcxtInstanceOptions,
  normalizeOrderbookDepth,
  releaseVendorCaches,
} from '../src/index.js';

describe('buildCcxtInstanceOptions: CCXT unified market types', () => {
  it.each<CexMarketType>(['spot', 'future', 'swap'])(
    'marketType=%s уходит в options.defaultType КАК ЕСТЬ',
    (marketType) => {
      const args = buildCcxtInstanceOptions({ exchangeId: 'binance', marketType, depth: 10 });
      expect(args.options['defaultType']).toBe(marketType);
    },
  );

  it("expiring futures = 'future' (native CCXT), никакого legacy 'futures'", () => {
    const args = buildCcxtInstanceOptions({
      exchangeId: 'binance',
      marketType: 'future',
      depth: 10,
    });
    expect(args.options['defaultType']).toBe('future');
    expect(args.options['defaultType']).not.toBe('futures');
    // Скрытой конверсии нет нигде в аргументах конструктора
    expect(JSON.stringify(args)).not.toContain('futures');
  });

  it('закрепляет контракт инстанса: newUpdates, rate limit, depth, timeout', () => {
    const args = buildCcxtInstanceOptions({ exchangeId: 'binance', marketType: 'spot', depth: 25 });
    expect(args.enableRateLimit).toBe(true);
    // Официальный механизм «только новые trades» пиним явно
    expect(args.options['newUpdates']).toBe(true);
    expect(args.options['watchOrderBook']).toEqual({ checksum: false, limit: 25 });
    // timeout — TOP-LEVEL свойство конструктора CCXT; в options он инертен
    expect(typeof args.timeout).toBe('number');
    expect(args.timeout).toBeGreaterThan(0);
    expect(args.options['timeout']).toBeUndefined();
    // Без keep-alive override-а ws-опции не добавляются
    expect(args.options['ws']).toBeUndefined();
  });

  it('keep-alive override применяется только к биржам из таблицы', () => {
    const bybit = buildCcxtInstanceOptions({ exchangeId: 'bybit', marketType: 'spot', depth: 50 });
    expect(bybit.options['ws']).toEqual({ keepAlive: 20_000, maxPingPongMisses: 3 });
    const okx = buildCcxtInstanceOptions({ exchangeId: 'okx', marketType: 'spot', depth: 10 });
    expect(okx.options['ws']).toEqual({ keepAlive: 20_000, maxPingPongMisses: 3 });
    const binance = buildCcxtInstanceOptions({
      exchangeId: 'binance',
      marketType: 'spot',
      depth: 10,
    });
    expect(binance.options['ws']).toBeUndefined();
  });
});

describe('normalizeOrderbookDepth: vendor whitelist', () => {
  it('whitelist применяется только к spot; future/swap не трогаются', () => {
    expect(normalizeOrderbookDepth('bybit', 'spot', 10)).toBe(50);
    expect(normalizeOrderbookDepth('bybit', 'swap', 10)).toBe(10);
    expect(normalizeOrderbookDepth('bybit', 'future', 10)).toBe(10);
    expect(normalizeOrderbookDepth('coinbase', 'spot', 10)).toBe(50);
    expect(normalizeOrderbookDepth('binance', 'spot', 10)).toBe(10);
    // Запрошено больше максимума — максимум whitelist-а
    expect(normalizeOrderbookDepth('bybit', 'spot', 5_000)).toBe(1_000);
  });
});

describe('releaseVendorCaches', () => {
  it('опустошает ArrayCache НА МЕСТЕ, а не отвязывает ссылку', () => {
    // Ловушка, найденная legacy откатом («ArrayCache not a plain array»):
    // vendor держит ссылку на сам массив, а не только запись в карте. Если
    // просто удалить ключ, память останется занятой ровно там, где её держит
    // ccxt.pro, и очистка окажется бесполезной.
    const cache: unknown[] = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const vendorHeldReference = cache; // ← так её держит ccxt.pro
    const instance = { trades: { 'BTC/USDT': cache } };

    releaseVendorCaches(instance as never);

    expect(vendorHeldReference).toHaveLength(0);
  });

  it('снимает и сами ключи карты, не только содержимое', () => {
    const instance = { orderbooks: { 'BTC/USDT': [{ level: 1 }], 'ETH/USDT': [{ level: 2 }] } };

    const released = releaseVendorCaches(instance as never);

    expect(released).toBe(2);
    expect(Object.keys(instance.orderbooks)).toEqual([]);
  });

  it('идемпотентна и безразлична к отсутствующим кэшам', () => {
    const instance = { trades: { 'BTC/USDT': [{ id: 1 }] } };

    expect(releaseVendorCaches(instance as never)).toBe(1);
    expect(releaseVendorCaches(instance as never)).toBe(0);
    expect(releaseVendorCaches({} as never)).toBe(0);
  });
});

describe('releaseVendorCaches: hashmap ArrayCache', () => {
  /** Форма, эквивалентная `ArrayCacheBySymbolById` ccxt.pro. */
  function makeArrayCacheBySymbolById(): unknown[] & { hashmap: Record<string, unknown> } {
    const cache = [] as unknown as unknown[] & { hashmap: Record<string, unknown> };
    cache.hashmap = {};
    return cache;
  }

  it('освобождает hashmap, а не только массив', () => {
    // `length = 0` обходит `append`, который единственный чистит hashmap при
    // вытеснении. Без явной очистки индекс удерживает до maxSize объектов на
    // символ — у сделок это tradesLimit, тысяча.
    const cache = makeArrayCacheBySymbolById();
    const trade = { id: '1', symbol: 'BTC/USDT' };
    cache.push(trade);
    cache.hashmap['BTC/USDT'] = { '1': trade };
    const instance = { trades: { 'BTC/USDT': cache } };

    releaseVendorCaches(instance as never);

    expect(cache).toHaveLength(0);
    expect(Object.keys(cache.hashmap)).toEqual([]);
  });

  it('считает освобождённым кэш, где пуст массив, но НЕ пуст hashmap', () => {
    // Ровно состояние после чужого `clear()` из самого ccxt: тот делает
    // только `length = 0`, поэтому «пустой» кэш всё ещё держит ссылки.
    const cache = makeArrayCacheBySymbolById();
    cache.hashmap['BTC/USDT'] = { '1': { id: '1' } };
    const instance = { trades: { 'BTC/USDT': cache } };

    expect(releaseVendorCaches(instance as never)).toBe(1);
    expect(Object.keys(cache.hashmap)).toEqual([]);
  });

  it('обычный массив без hashmap обрабатывается как прежде', () => {
    const cache: unknown[] = [{ id: 1 }, { id: 2 }];
    const instance = { orderbooks: { 'BTC/USDT': cache } };

    expect(releaseVendorCaches(instance as never)).toBe(1);
    expect(cache).toHaveLength(0);
  });
});
