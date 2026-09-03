/**
 * Граница «внешняя конфигурация → canonical owner policy» коллектора.
 */
import { describe, it, expect } from '@jest/globals';
import { parseCexPolicies, toDataCollectorConfig } from '../src/runtime/DataCollectorConfig.js';
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
    cexOrderbookMethod: undefined,
    cexRestartIntervalMs: undefined,
    ...overrides,
  };
}

describe('parseCexPolicies — одна CexPolicy на биржу', () => {
  it('несколько бирж → несколько policy, у каждой точный список символов', () => {
    const policies = parseCexPolicies(
      JSON.stringify({
        binance: { type: 'spot', symbols: ['BTC/USDT', 'ETH/USDT'], orderbook: true, trades: true, obDepth: 10 },
        bybit: { type: 'spot', symbols: ['BTC/USDT'], orderbook: true, trades: false, obDepth: 50 },
      }),
    );

    expect(policies).toHaveLength(2);
    const binance = policies.find((policy) => policy.exchangeIds[0] === 'binance');
    expect(binance?.symbols).toEqual(['BTC/USDT', 'ETH/USDT']);
    expect(binance?.orderbookDepth).toBe(10);
    expect(binance?.trades).toBe(true);
    const bybit = policies.find((policy) => policy.exchangeIds[0] === 'bybit');
    // Точный список символов биржи сохранён — без объединения в декартово произведение.
    expect(bybit?.symbols).toEqual(['BTC/USDT']);
    expect(bybit?.orderbookDepth).toBe(50);
    expect(bybit?.trades).toBe(false);
  });

  it('невалидный JSON → ошибка', () => {
    expect(() => parseCexPolicies('{ not json')).toThrow('Invalid CEX config JSON');
  });

  it('неизвестный тип рынка → ошибка (валидирует parseCexPolicyConfig)', () => {
    expect(() =>
      parseCexPolicies(JSON.stringify({ binance: { type: 'perp', symbols: ['BTC/USDT'], orderbook: true, trades: true } })),
    ).toThrow();
  });

  it('биржа без потоков (orderbook=false, trades=false) → ошибка', () => {
    expect(() =>
      parseCexPolicies(JSON.stringify({ binance: { type: 'spot', symbols: ['BTC/USDT'], orderbook: false, trades: false } })),
    ).toThrow();
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

  it('CEX выключен, если cexConfig не задан (пустой набор policy)', () => {
    const config = toDataCollectorConfig(baseConfig({ cexConfig: null }));
    expect(config.cex.policies).toHaveLength(0);
  });

  it('CEX-конфиг разбирается в policy + транспортные параметры отделены', () => {
    const config = toDataCollectorConfig(
      baseConfig({
        cexConfig: JSON.stringify({
          binance: { type: 'spot', symbols: ['BTC/USDT'], orderbook: true, trades: true, obDepth: 10 },
        }),
        cexOrderbookMethod: 'watch',
        cexRestartIntervalMs: 900_000,
      }),
    );
    expect(config.cex.policies).toHaveLength(1);
    expect(config.cex.transport.orderbookMethod).toBe('watch');
    expect(config.cex.transport.restartIntervalMs).toBe(900_000);
  });

  it('невалидная CEX-конфигурация не даёт собрать рантайм (fail-fast)', () => {
    expect(() =>
      toDataCollectorConfig(
        baseConfig({ cexConfig: JSON.stringify({ binance: { type: 'spot', symbols: [], orderbook: true, trades: true } }) }),
      ),
    ).toThrow();
  });
});
