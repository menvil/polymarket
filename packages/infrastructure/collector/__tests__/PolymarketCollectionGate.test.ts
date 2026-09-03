/**
 * Юнит-тесты допуска рынка к записи: universe-lookup + owner policy + сборка
 * recording-регистрации из canonical `Market`.
 */
import { describe, it, expect } from '@jest/globals';
import { PolymarketCollectionGate } from '../src/index.js';
import { CapturingLogger } from './helpers/CapturingLogger.js';
import { makeEntry, makePolicy, makeUniverse } from './helpers/fixtures.js';

function gateFor(entries: Parameters<typeof makeUniverse>[0], assets = ['btc'], durations = ['5m']) {
  const universe = makeUniverse(entries);
  const policy = makePolicy(assets, durations);
  return new PolymarketCollectionGate({ universe, policy, logger: new CapturingLogger() });
}

describe('PolymarketCollectionGate.admit', () => {
  it('интересный рынок → регистрация с canonical header и tokenIds', () => {
    const gate = gateFor([makeEntry({ id: 'btc-5m-1', asset: 'btc', nominalMs: 5 * 60_000 })]);

    const registration = gate.admit('btc-5m-1');

    expect(registration).toBeDefined();
    expect(String(registration?.marketMeta.marketId)).toBe('btc-5m-1');
    expect(registration?.marketMeta.tokenIds).toEqual(['btc-5m-1-up', 'btc-5m-1-down']);
    // RTDS-фиды в этой фазе НЕ регистрируются (см. TSDoc gate).
    expect(registration?.rtdsFeeds).toBeUndefined();
    // startsAt НЕ задан → запись активируется немедленно (опорный снапшот).
    expect(registration?.marketMeta.startsAt).toBeUndefined();
    const header = registration?.marketMeta.rawMarket as Record<string, unknown>;
    expect(header['source']).toBe('polymarket');
    expect(header['conditionId']).toBe('btc-5m-1');
    expect(header['family']).toBe('CRYPTO_UP_DOWN');
    // Дискриминатор версии отличается от legacy vendor-header (headerVersion 1).
    expect(header['headerVersion']).toBe(2);
    expect(gate.getStats().admitted).toBe(1);
  });

  it('неизвестный рынок (нет в universe) → undefined, счётчик ignoredUnknownMarket', () => {
    const gate = gateFor([makeEntry({ id: 'btc-5m-1' })]);

    expect(gate.admit('does-not-exist')).toBeUndefined();
    expect(gate.getStats().ignoredUnknownMarket).toBe(1);
    expect(gate.getStats().admitted).toBe(0);
  });

  it('рынок не подошёл под owner policy → undefined, счётчик ignoredByPolicy', () => {
    // policy btc/5m; рынок eth/15m есть в universe, но policy его не хочет.
    const gate = gateFor(
      [makeEntry({ id: 'eth-15m-1', asset: 'eth', nominalMs: 15 * 60_000 })],
      ['btc'],
      ['5m'],
    );

    expect(gate.admit('eth-15m-1')).toBeUndefined();
    expect(gate.getStats().ignoredByPolicy).toBe(1);
    expect(gate.getStats().admitted).toBe(0);
  });

  it('несколько допусков одного рынка независимы (сессиями владеет recorder)', () => {
    const gate = gateFor([makeEntry({ id: 'btc-5m-1' })]);

    const first = gate.admit('btc-5m-1');
    const second = gate.admit('btc-5m-1');

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    // Gate не хранит сессий: повторный допуск снова строит регистрацию.
    expect(gate.getStats().admitted).toBe(2);
  });
});
