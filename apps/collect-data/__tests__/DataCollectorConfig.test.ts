/**
 * Граница «внешняя конфигурация → canonical owner policy» коллектора.
 *
 * @remarks
 * Отдельный акцент — на СОХРАНЕНИИ контракта `cex-config.json`: формат файла
 * унаследован от прежнего коллектора, поэтому per-exchange транспортные
 * параметры обязаны доходить до источника, а неверные значения — ронять старт,
 * а не превращаться в валидные молча.
 */
import { describe, it, expect } from '@jest/globals';
import { parseCexExchangeConfigs, toDataCollectorConfig } from '../src/runtime/DataCollectorConfig.js';
import type { CollectorConfig } from '../src/config.js';

/** Базовая внешняя конфигурация приложения (валидная). */
function baseConfig(overrides: Partial<CollectorConfig> = {}): CollectorConfig {
  return {
    dnsOverrideEnabled: false,
    gammaApiBaseUrl: 'https://gamma-api.polymarket.com',
    wsUrl: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
    wsReconnectDelayMs: 3000,
    minTimeToExpiryHours: 0,
    minSpread: 0,
    minLiquidity: 0,
    maxMarkets: 50,
    requiredKeywords: [],
    anyOfKeywords: [],
    excludedKeywords: [],
    marketScanPauseMs: 30_000,
    outputDir: './data/snapshots',
    sourceSubDir: 'polymarket',
    compression: 'gzip',
    bufferSize: 100,
    flushIntervalMs: 10_000,
    cexConfig: null,
    cexWindowMinutes: undefined,
    cexBufferSize: 200,
    cexFlushIntervalMs: 5_000,
    policyAssets: [],
    policyDurations: [],
    discoveryWindowHours: undefined,
    controlTickMs: 5_000,
    ...overrides,
  };
}

describe('parseCexExchangeConfigs — policy + per-exchange транспорт', () => {
  it('несколько бирж → по описанию на биржу, у каждой точный список символов', () => {
    const exchanges = parseCexExchangeConfigs(
      JSON.stringify({
        binance: { type: 'spot', symbols: ['BTC/USDT', 'ETH/USDT'], orderbook: true, trades: true, obDepth: 10 },
        bybit: { type: 'spot', symbols: ['BTC/USDT'], orderbook: true, trades: false, obDepth: 50 },
      }),
    );

    expect(exchanges).toHaveLength(2);
    const binance = exchanges.find((exchange) => exchange.exchangeId === 'binance');
    expect(binance?.policy.symbols).toEqual(['BTC/USDT', 'ETH/USDT']);
    expect(binance?.policy.orderbookDepth).toBe(10);
    expect(binance?.policy.trades).toBe(true);
    const bybit = exchanges.find((exchange) => exchange.exchangeId === 'bybit');
    // Точный список символов биржи сохранён — без объединения в декартово произведение.
    expect(bybit?.policy.symbols).toEqual(['BTC/USDT']);
    expect(bybit?.policy.orderbookDepth).toBe(50);
    expect(bybit?.policy.trades).toBe(false);
  });

  it('РАЗНЫЕ obMethod/restartIntervalMs у бирж сохраняются по-биржево', () => {
    const exchanges = parseCexExchangeConfigs(
      JSON.stringify({
        binance: {
          type: 'spot', symbols: ['BTC/USDT'], orderbook: true, trades: true,
          obMethod: 'watch', restartIntervalMs: 1_800_000,
        },
        'some-exchange': {
          type: 'spot', symbols: ['BTC/USDT'], orderbook: true, trades: true,
          obMethod: 'fetch', restartIntervalMs: 600_000,
        },
      }),
    );

    const binance = exchanges.find((exchange) => exchange.exchangeId === 'binance');
    const other = exchanges.find((exchange) => exchange.exchangeId === 'some-exchange');
    // Профиль просит оба потока: транспорт объявляется по каждому, а obMethod
    // относится только к стакану.
    expect(binance?.streamTransports).toEqual([
      { stream: 'ORDERBOOK', transport: { orderbookMethod: 'watch', restartIntervalMs: 1_800_000 } },
      { stream: 'TRADES', transport: { restartIntervalMs: 1_800_000 } },
    ]);
    expect(other?.streamTransports).toEqual([
      { stream: 'ORDERBOOK', transport: { orderbookMethod: 'fetch', restartIntervalMs: 600_000 } },
      { stream: 'TRADES', transport: { restartIntervalMs: 600_000 } },
    ]);
  });

  it('не заданный транспорт остаётся пустым (дефолты принадлежат CexSource)', () => {
    const exchanges = parseCexExchangeConfigs(
      JSON.stringify({ binance: { type: 'spot', symbols: ['BTC/USDT'], orderbook: true, trades: true } }),
    );
    expect(exchanges[0]?.streamTransports).toEqual([
      { stream: 'ORDERBOOK', transport: {} },
      { stream: 'TRADES', transport: {} },
    ]);
  });

  it('явный exchangeId записи побеждает ключ словаря', () => {
    const exchanges = parseCexExchangeConfigs(
      JSON.stringify({
        'binance-profile': { exchangeId: 'binance', type: 'spot', symbols: ['BTC/USDT'], orderbook: true, trades: true },
      }),
    );
    expect(exchanges[0]?.exchangeId).toBe('binance');
    expect(exchanges[0]?.policy.exchangeIds).toEqual(['binance']);
  });

  it('legacy-алиас type "futures" даёт то же описание, что и "future"', () => {
    const entry = (type: string): string =>
      JSON.stringify({ binance: { type, symbols: ['BTC/USDT'], orderbook: true, trades: true, obDepth: 10 } });

    const legacy = parseCexExchangeConfigs(entry('futures'));
    const canonical = parseCexExchangeConfigs(entry('future'));

    // Прежний парсер нормализовал этот алиас; рабочий конфиг с "futures"
    // обязан продолжать стартовать после переезда на owner policy.
    expect(legacy[0]?.policy.marketTypes).toEqual(['future']);
    expect(legacy).toEqual(canonical);
  });

  it('невалидный JSON → ошибка', () => {
    expect(() => parseCexExchangeConfigs('{ not json')).toThrow('Invalid CEX config JSON');
  });

  it('неизвестный тип рынка → ошибка (валидирует parseCexPolicyConfig)', () => {
    expect(() =>
      parseCexExchangeConfigs(JSON.stringify({ binance: { type: 'perp', symbols: ['BTC/USDT'], orderbook: true, trades: true } })),
    ).toThrow();
  });

  it('биржа без потоков (orderbook=false, trades=false) → ошибка', () => {
    expect(() =>
      parseCexExchangeConfigs(JSON.stringify({ binance: { type: 'spot', symbols: ['BTC/USDT'], orderbook: false, trades: false } })),
    ).toThrow();
  });
});

describe('parseCexExchangeConfigs — неверный ввод роняет старт, а не становится валидным', () => {
  it('строковый orderbook НЕ превращается молча в false', () => {
    expect(() =>
      parseCexExchangeConfigs(
        JSON.stringify({ binance: { type: 'spot', symbols: ['BTC/USDT'], orderbook: 'true', trades: true } }),
      ),
    ).toThrow('orderbook and trades must be booleans');
  });

  it('строковый obDepth НЕ отбрасывается молча в дефолт', () => {
    expect(() =>
      parseCexExchangeConfigs(
        JSON.stringify({ binance: { type: 'spot', symbols: ['BTC/USDT'], orderbook: true, trades: true, obDepth: '10' } }),
      ),
    ).toThrow('obDepth must be a finite number > 0');
  });

  it('нулевой/отрицательный restartIntervalMs отвергается', () => {
    expect(() =>
      parseCexExchangeConfigs(
        JSON.stringify({ binance: { type: 'spot', symbols: ['BTC/USDT'], orderbook: true, trades: true, restartIntervalMs: 0 } }),
      ),
    ).toThrow('restartIntervalMs must be a finite number > 0');
  });

  it('неизвестный obMethod отвергается', () => {
    expect(() =>
      parseCexExchangeConfigs(
        JSON.stringify({ binance: { type: 'spot', symbols: ['BTC/USDT'], orderbook: true, trades: true, obMethod: 'poll' } }),
      ),
    ).toThrow("obMethod must be 'watch' | 'fetch'");
  });

  it('symbols не массивом отвергается, а не превращается в пустой список', () => {
    expect(() =>
      parseCexExchangeConfigs(
        JSON.stringify({ binance: { type: 'spot', symbols: 'BTC/USDT', orderbook: true, trades: true } }),
      ),
    ).toThrow('symbols must be an array');
  });
});

describe('toDataCollectorConfig — env → runtime config', () => {
  it('строит PolymarketPolicy семейства CRYPTO_UP_DOWN с активами/номиналами', () => {
    const config = toDataCollectorConfig(baseConfig({ policyAssets: ['btc'], policyDurations: ['5m'] }));

    expect(config.polymarketPolicy.kind).toBe('POLYMARKET');
    expect(config.polymarketPolicy.family).toBe('CRYPTO_UP_DOWN');
    expect(config.polymarketPolicy.assets?.map(String)).toEqual(['btc']);
    expect(config.control.acquireLimit).toBe(50);
  });

  it('keyword-фильтры discovery переносятся в title-селекторы policy', () => {
    const config = toDataCollectorConfig(
      baseConfig({ excludedKeywords: ['testnet'], anyOfKeywords: ['bitcoin'] }),
    );
    expect(config.polymarketPolicy.title?.excluded).toEqual(['testnet']);
    expect(config.polymarketPolicy.title?.anyOf).toEqual(['bitcoin']);
  });

  it('окно discovery НЕ задаётся, если переменная не выставлена (действует canonical дефолт 6ч)', () => {
    const config = toDataCollectorConfig(baseConfig({ discoveryWindowHours: undefined }));
    // Своего дубля дефолта конфигурация не заводит: поле отсутствует, и
    // PolymarketMarketDiscovery применяет собственные 6 часов.
    expect(config.discoveryWindowMs).toBeUndefined();
    expect('discoveryWindowMs' in config).toBe(false);
  });

  it('окно discovery передаётся как явный override, если переменная задана', () => {
    const config = toDataCollectorConfig(baseConfig({ discoveryWindowHours: 3 }));
    expect(config.discoveryWindowMs).toBe(3 * 60 * 60_000);
  });

  it('CEX выключен, если cexConfig не задан (пустой набор бирж)', () => {
    const config = toDataCollectorConfig(baseConfig({ cexConfig: null }));
    expect(config.cex.exchanges).toHaveLength(0);
  });

  it('CEX-конфиг разбирается в описания бирж с их транспортом', () => {
    const config = toDataCollectorConfig(
      baseConfig({
        cexConfig: JSON.stringify({
          binance: {
            type: 'spot', symbols: ['BTC/USDT'], orderbook: true, trades: true,
            obDepth: 10, obMethod: 'watch', restartIntervalMs: 900_000,
          },
        }),
      }),
    );
    expect(config.cex.exchanges).toHaveLength(1);
    expect(config.cex.exchanges[0]?.exchangeId).toBe('binance');
    expect(config.cex.exchanges[0]?.streamTransports).toEqual([
      { stream: 'ORDERBOOK', transport: { orderbookMethod: 'watch', restartIntervalMs: 900_000 } },
      { stream: 'TRADES', transport: { restartIntervalMs: 900_000 } },
    ]);
  });

  it('невалидная CEX-конфигурация не даёт собрать рантайм (fail-fast)', () => {
    expect(() =>
      toDataCollectorConfig(
        baseConfig({ cexConfig: JSON.stringify({ binance: { type: 'spot', symbols: [], orderbook: true, trades: true } }) }),
      ),
    ).toThrow();
  });
});
