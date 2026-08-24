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
import { buildCcxtInstanceOptions, normalizeOrderbookDepth } from '../src/index.js';

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
    expect(typeof args.options['timeout']).toBe('number');
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
