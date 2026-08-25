/**
 * Boundary-конверсия внешней конфигурации в конфигурацию V2-рантайма
 * (MR-A PART 24/25).
 *
 * @remarks
 * Формат `cex-config.json` сохранён от legacy-коллектора, поэтому
 * production-конфигурация не переписывается вместе с рантаймом — но legacy
 * ТИПЫ внутрь V2 не проходят: конверсия имён полей выполняется на границе.
 */
import { describe, expect, it } from '@jest/globals';
import { parseCexSourceConfigs, toDataCollectorConfig } from '../src/runtime/DataCollectorConfig.js';
import type { CollectorConfig } from '../src/config.js';

/** Базовая внешняя конфигурация приложения. */
function baseConfig(overrides: Partial<CollectorConfig> = {}): CollectorConfig {
  return {
    dnsOverrideEnabled: false,
    gammaApiBaseUrl: 'https://gamma-api.polymarket.com',
    wsUrl: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
    wsReconnectDelayMs: 3_000,
    minTimeToExpiryHours: 0,
    minSpread: 0,
    minLiquidity: 50,
    maxMarkets: 12,
    requiredKeywords: ['up', 'down'],
    anyOfKeywords: ['bitcoin', 'ethereum'],
    excludedKeywords: [],
    marketScanPauseMs: 30_000,
    outputDir: './snapshots',
    sourceSubDir: 'polymarket',
    compression: 'gzip',
    bufferSize: 100,
    flushIntervalMs: 10_000,
    cexConfig: null,
    cexWindowMinutes: undefined,
    cexBufferSize: 200,
    cexFlushIntervalMs: 5_000,
    ...overrides,
  };
}

describe('parseCexSourceConfigs — legacy JSON → CexSourceConfig', () => {
  it('переводит имена полей на словарь V2', () => {
    const sources = parseCexSourceConfigs(
      JSON.stringify({
        binance: {
          type: 'spot',
          symbols: ['BTC/USDT', 'ETH/USDT'],
          orderbook: true,
          trades: true,
          obDepth: 10,
          obMethod: 'watch',
          restartIntervalMs: 900_000,
        },
      }),
    );

    expect(sources).toEqual([
      {
        exchangeId: 'binance',
        marketType: 'spot',
        symbols: ['BTC/USDT', 'ETH/USDT'],
        watchOrderbook: true,
        watchTrades: true,
        orderbookDepth: 10,
        orderbookMethod: 'watch',
        restartIntervalMs: 900_000,
      },
    ]);
  });

  it('ключ словаря служит биржей, явный exchangeId побеждает', () => {
    const sources = parseCexSourceConfigs(
      JSON.stringify({
        alias: { exchangeId: 'bybit', type: 'spot', symbols: ['BTC/USDT'], orderbook: true, trades: false },
        okx: { type: 'spot', symbols: ['ETH/USDT'], orderbook: false, trades: true },
      }),
    );

    expect(sources.map((source) => source.exchangeId)).toEqual(['bybit', 'okx']);
    expect(sources[1]?.watchOrderbook).toBe(false);
    expect(sources[1]?.watchTrades).toBe(true);
  });

  it('legacy futures отображается в canonical future', () => {
    const sources = parseCexSourceConfigs(
      JSON.stringify({ binance: { type: 'futures', symbols: ['BTC/USDT'], orderbook: true, trades: true } }),
    );

    expect(sources[0]?.marketType).toBe('future');
  });

  it('опущенные поля не подставляются — дефолты остаются за пакетом source', () => {
    const sources = parseCexSourceConfigs(
      JSON.stringify({ kraken: { type: 'spot', symbols: ['BTC/USD'], orderbook: true, trades: true } }),
    );

    expect(sources[0]).not.toHaveProperty('orderbookDepth');
    expect(sources[0]).not.toHaveProperty('restartIntervalMs');
    expect(sources[0]).not.toHaveProperty('orderbookMethod');
  });

  it('отвергает невалидную конфигурацию вместо тихой потери биржи', () => {
    expect(() => parseCexSourceConfigs('{ not json')).toThrow('Invalid CEX config JSON');
    expect(() => parseCexSourceConfigs('[]')).toThrow('keyed by exchange id');
    expect(() =>
      parseCexSourceConfigs(JSON.stringify({ binance: { type: 'perp', symbols: ['BTC/USDT'] } })),
    ).toThrow("type must be 'spot' | 'future' | 'swap'");
    expect(() => parseCexSourceConfigs(JSON.stringify({ binance: { type: 'spot', symbols: [] } }))).toThrow(
      'non-empty array of strings',
    );
    expect(() =>
      parseCexSourceConfigs(
        JSON.stringify({ binance: { type: 'spot', symbols: ['BTC/USDT'], obDepth: -1 } }),
      ),
    ).toThrow('obDepth must be a finite number > 0');
    expect(() =>
      parseCexSourceConfigs(
        JSON.stringify({ binance: { type: 'spot', symbols: ['BTC/USDT'], obMethod: 'poll' } }),
      ),
    ).toThrow("obMethod must be 'watch' | 'fetch'");
  });
});

describe('toDataCollectorConfig — внешняя конфигурация → рантайм', () => {
  it('переносит фильтр discovery целиком', () => {
    const config = toDataCollectorConfig(baseConfig());

    expect(config.discovery.filter).toEqual({
      minTimeToExpiryHours: 0,
      minSpread: 0,
      minLiquidity: 50,
      maxMarketsToReturn: 12,
      requiredKeywords: ['up', 'down'],
      anyOfKeywords: ['bitcoin', 'ethereum'],
      excludedKeywords: [],
    });
  });

  it('обе storage-политики получают ОДИН корень датасетов', () => {
    const config = toDataCollectorConfig(baseConfig({ outputDir: '/data/snapshots' }));

    expect(config.outputDir).toBe('/data/snapshots');
    expect(config.polymarket.sourceSubDir).toBe('polymarket');
    expect(config.cex.compression).toBe('gzip');
  });

  it('без CEX-конфигурации source-ов нет (CEX выключен)', () => {
    const config = toDataCollectorConfig(baseConfig({ cexConfig: null }));

    expect(config.cex.sources).toEqual([]);
  });

  it('невалидная CEX-конфигурация — отказ старта, а не тихая работа без CEX', () => {
    expect(() => toDataCollectorConfig(baseConfig({ cexConfig: '{ broken' }))).toThrow(
      'Invalid CEX config JSON',
    );
  });

  it('дефолты финализации остаются за пакетом финализатора', () => {
    const config = toDataCollectorConfig(baseConfig());

    expect(config.finalization).toEqual({});
  });

  it('размер окна не задан — дефолт принадлежит CexWindowRecorder', () => {
    const config = toDataCollectorConfig(baseConfig());

    expect(config.cex).not.toHaveProperty('windowMinutes');
  });

  it('заданный размер окна пробрасывается', () => {
    const config = toDataCollectorConfig(baseConfig({ cexWindowMinutes: 15 }));

    expect(config.cex.windowMinutes).toBe(15);
  });

  it('период обновления кандидатов берётся из конфигурации приложения', () => {
    const config = toDataCollectorConfig(baseConfig({ marketScanPauseMs: 45_000 }));

    expect(config.collection.discoveryRefreshMs).toBe(45_000);
    expect(config.collection.maxMarkets).toBe(12);
  });
});
