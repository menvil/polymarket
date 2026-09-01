/**
 * Тесты фабрик policy: нормализация селекторов и отказ на противоречивой
 * конфигурации.
 *
 * @remarks
 * Проверяется главным образом то, ЧТО НЕ должно тихо проходить: policy,
 * которая не действует никогда, и селектор, который совпадает со всем.
 * Оба дефекта без проверки выглядят как «фильтр почему-то не работает».
 */
import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { TimestampService } from '@polymarket/timestamp';
import type { Timestamp } from '@polymarket/timestamp';
import { unsafeCryptoAssetId } from '@polymarket/ids';
import { asMarketDuration } from '@polymarket/market';
import { Money } from '@polymarket/value-objects';
import {
  PolicyValidationError,
  createCexPolicy,
  createPolymarketPolicy,
} from '../src/createPolicy.js';

function at(iso: string): Timestamp {
  const result = TimestampService.fromISO(iso);
  if (!result.ok) throw new Error(`bad fixture timestamp: ${iso}`);
  return result.value;
}

const BTC = unsafeCryptoAssetId('btc');
const ETH = unsafeCryptoAssetId('eth');
const FIVE_MIN = asMarketDuration(5 * 60_000)!;
const FIFTEEN_MIN = asMarketDuration(15 * 60_000)!;
const T18 = at('2026-09-01T18:00:00.000Z');
const T19 = at('2026-09-01T19:00:00.000Z');

describe('createPolymarketPolicy: нормализация', () => {
  it('дедуплицирует активы и длительности, сохраняя порядок первого появления', () => {
    const policy = createPolymarketPolicy({
      kind: 'POLYMARKET',
      family: 'CRYPTO_UP_DOWN',
      assets: [BTC, ETH, BTC],
      durations: [FIVE_MIN, FIVE_MIN, FIFTEEN_MIN],
    });

    expect(policy.assets).toEqual([BTC, ETH]);
    expect(policy.durations).toEqual([FIVE_MIN, FIFTEEN_MIN]);
  });

  it('пустой список схлопывается в отсутствие селектора: это одно утверждение', () => {
    const policy = createPolymarketPolicy({
      kind: 'POLYMARKET',
      family: 'CRYPTO_UP_DOWN',
      assets: [],
      durations: [],
    });

    expect(policy.assets).toBeUndefined();
    expect(policy.durations).toBeUndefined();
    expect('assets' in policy).toBe(false);
  });

  it('обрезает ключевые слова и убирает дубликаты', () => {
    const policy = createPolymarketPolicy({
      kind: 'POLYMARKET',
      family: 'CRYPTO_UP_DOWN',
      title: { excluded: ['  testnet ', 'testnet', 'demo'] },
    });

    expect(policy.title?.excluded).toEqual(['testnet', 'demo']);
  });

  it('title без единого непустого селектора схлопывается целиком', () => {
    const policy = createPolymarketPolicy({
      kind: 'POLYMARKET',
      family: 'CRYPTO_UP_DOWN',
      title: { required: [], anyOf: [], excluded: [] },
    });

    expect(policy.title).toBeUndefined();
  });

  it('не мутирует входные массивы', () => {
    const assets = [BTC, BTC];
    const excluded = ['  testnet  '];
    createPolymarketPolicy({
      kind: 'POLYMARKET',
      family: 'CRYPTO_UP_DOWN',
      assets,
      title: { excluded },
    });

    expect(assets).toEqual([BTC, BTC]);
    expect(excluded).toEqual(['  testnet  ']);
  });

  it('результат заморожен', () => {
    const policy = createPolymarketPolicy({ kind: 'POLYMARKET', family: 'CRYPTO_UP_DOWN' });

    expect(Object.isFrozen(policy)).toBe(true);
  });

  it('сохраняет canonical-пороги как есть', () => {
    const minLiquidity = Money.of(new Decimal(1000), 'USDC');
    const policy = createPolymarketPolicy({
      kind: 'POLYMARKET',
      family: 'CRYPTO_UP_DOWN',
      minLiquidity,
      effectiveFrom: T18,
      effectiveUntil: T19,
    });

    expect(policy.minLiquidity).toBe(minLiquidity);
    expect(policy.effectiveFrom).toBe(T18);
  });
});

describe('createPolymarketPolicy: отказы', () => {
  it('окно, которое не действует никогда, отвергается', () => {
    expect(() =>
      createPolymarketPolicy({
        kind: 'POLYMARKET',
        family: 'CRYPTO_UP_DOWN',
        effectiveFrom: T19,
        effectiveUntil: T18,
      }),
    ).toThrow(PolicyValidationError);
  });

  it('совпадающие границы тоже отвергаются: интервал полуоткрыт, множество пусто', () => {
    expect(() =>
      createPolymarketPolicy({
        kind: 'POLYMARKET',
        family: 'CRYPTO_UP_DOWN',
        effectiveFrom: T18,
        effectiveUntil: T18,
      }),
    ).toThrow(PolicyValidationError);
  });

  it('селектор из одних пробелов — дефект конфигурации, а не выключенный фильтр', () => {
    expect(() =>
      createPolymarketPolicy({
        kind: 'POLYMARKET',
        family: 'CRYPTO_UP_DOWN',
        title: { excluded: ['   ', ''] },
      }),
    ).toThrow(PolicyValidationError);
  });
});

describe('createCexPolicy', () => {
  const VALID = {
    kind: 'CEX' as const,
    exchangeIds: ['binance'],
    marketTypes: ['swap' as const],
    symbols: ['BTC/USDT:USDT'],
    orderbook: true,
    trades: true,
  };

  it('собирает валидную policy и замораживает её', () => {
    const policy = createCexPolicy({ ...VALID, orderbookDepth: 10 });

    expect(policy.exchangeIds).toEqual(['binance']);
    expect(policy.orderbookDepth).toBe(10);
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it('дедуплицирует и обрезает списки', () => {
    const policy = createCexPolicy({
      ...VALID,
      exchangeIds: [' binance ', 'binance'],
      symbols: ['BTC/USDT:USDT', 'BTC/USDT:USDT', 'ETH/USDT:USDT'],
    });

    expect(policy.exchangeIds).toEqual(['binance']);
    expect(policy.symbols).toEqual(['BTC/USDT:USDT', 'ETH/USDT:USDT']);
  });

  it.each([
    ['exchangeIds', { ...VALID, exchangeIds: [] }],
    ['marketTypes', { ...VALID, marketTypes: [] }],
    ['symbols', { ...VALID, symbols: [] }],
    ['symbols из пробелов', { ...VALID, symbols: ['  '] }],
  ])('пустой обязательный список (%s) отвергается', (_name, input) => {
    expect(() => createCexPolicy(input)).toThrow(PolicyValidationError);
  });

  it('policy без единого запрошенного потока отвергается', () => {
    // Подписка, не просящая ни стакана, ни сделок, описывает подписку без данных
    expect(() => createCexPolicy({ ...VALID, orderbook: false, trades: false })).toThrow(
      PolicyValidationError,
    );
  });

  it.each([0, -1, 1.5, Number.NaN])('некорректная глубина стакана (%p) отвергается', (depth) => {
    expect(() => createCexPolicy({ ...VALID, orderbookDepth: depth })).toThrow(
      PolicyValidationError,
    );
  });

  it('окно проверяется теми же правилами, что у Polymarket-policy', () => {
    expect(() => createCexPolicy({ ...VALID, effectiveFrom: T19, effectiveUntil: T18 })).toThrow(
      PolicyValidationError,
    );
  });
});
