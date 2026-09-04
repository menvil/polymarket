/**
 * Юнит-тесты допуска рынка к записи: universe-lookup + owner policy +
 * подтверждение claim-а + сборка recording-регистрации из canonical `Market`.
 */
import { describe, it, expect } from '@jest/globals';
import { COLLECTOR_RAW_OWNER_KEY, PolymarketCollectionGate } from '../src/index.js';
import { CapturingLogger } from './helpers/CapturingLogger.js';
import {
  BTC_FULL_FEEDS,
  acquireFor,
  makeEntry,
  makePolicy,
  makeSubscriptionHarness,
  makeUniverse,
} from './helpers/fixtures.js';
import type { SubscriptionHarness } from './helpers/fixtures.js';

interface GateFixture {
  readonly gate: PolymarketCollectionGate;
  readonly harness: SubscriptionHarness;
}

/**
 * Собирает gate поверх настоящего контроллера подписок.
 *
 * @param entries - Записи universe
 * @param assets - Активы owner policy
 * @param durations - Длительности owner policy
 * @returns Gate и его control-plane
 */
function gateFor(
  entries: ReturnType<typeof makeEntry>[],
  assets = ['btc'],
  durations = ['5m'],
): GateFixture {
  const universe = makeUniverse(entries);
  const policy = makePolicy(assets, durations);
  const harness = makeSubscriptionHarness();
  const gate = new PolymarketCollectionGate({
    universe,
    policy,
    subscriptions: harness.controller,
    logger: new CapturingLogger(),
  });
  return { gate, harness };
}

describe('PolymarketCollectionGate.admit', () => {
  it('интересный и приобретённый рынок → регистрация с canonical header, tokenIds и RTDS-фидами', async () => {
    const entry = makeEntry({ id: 'btc-5m-1', asset: 'btc', nominalMs: 5 * 60_000 });
    const { gate, harness } = gateFor([entry]);
    await acquireFor(harness, entry, COLLECTOR_RAW_OWNER_KEY);

    const registration = gate.admit('btc-5m-1');

    expect(registration).toBeDefined();
    expect(String(registration?.marketMeta.marketId)).toBe('btc-5m-1');
    expect(registration?.marketMeta.tokenIds).toEqual(['btc-5m-1-up', 'btc-5m-1-down']);
    // Фиды приходят из подготовки удерживаемого рынка, а не выводятся заново.
    expect(registration?.rtdsFeeds).toEqual(BTC_FULL_FEEDS);
    // startsAt НЕ задан → запись активируется немедленно (опорный снапшот).
    expect(registration?.marketMeta.startsAt).toBeUndefined();
    const header = registration?.marketMeta.rawMarket as Record<string, unknown>;
    expect(header['source']).toBe('polymarket');
    expect(header['conditionId']).toBe('btc-5m-1');
    expect(header['family']).toBe('CRYPTO_UP_DOWN');
    // Дискриминатор версии отличается от legacy vendor-header (headerVersion 1).
    expect(header['headerVersion']).toBe(2);
    expect(gate.getStats().admitted).toBe(1);

    await harness.controller.close();
  });

  it('неизвестный рынок (нет в universe) → undefined, счётчик ignoredUnknownMarket', () => {
    const { gate } = gateFor([makeEntry({ id: 'btc-5m-1' })]);

    expect(gate.admit('does-not-exist')).toBeUndefined();
    expect(gate.getStats().ignoredUnknownMarket).toBe(1);
    expect(gate.getStats().admitted).toBe(0);
  });

  it('рынок не подошёл под owner policy → undefined, счётчик ignoredByPolicy', async () => {
    // policy btc/5m; рынок eth/15m есть в universe, но policy его не хочет.
    const entry = makeEntry({ id: 'eth-15m-1', asset: 'eth', nominalMs: 15 * 60_000 });
    const { gate, harness } = gateFor([entry], ['btc'], ['5m']);
    await acquireFor(harness, entry, COLLECTOR_RAW_OWNER_KEY);

    expect(gate.admit('eth-15m-1')).toBeUndefined();
    expect(gate.getStats().ignoredByPolicy).toBe(1);
    expect(gate.getStats().admitted).toBe(0);

    await harness.controller.close();
  });

  it('рынок держит ДРУГОЙ владелец → undefined, счётчик ignoredNotHeldByCollector', async () => {
    const entry = makeEntry({ id: 'btc-5m-1' });
    const { gate, harness } = gateFor([entry]);
    // Physical поток открыт стратегией; коллектор рынок НЕ приобретал.
    await acquireFor(harness, entry, 'strategy:A');

    expect(gate.admit('btc-5m-1')).toBeUndefined();
    // Это НЕ «не подошёл под policy»: policy как раз подошла.
    expect(gate.getStats().ignoredByPolicy).toBe(0);
    expect(gate.getStats().ignoredNotHeldByCollector).toBe(1);
    expect(gate.getStats().admitted).toBe(0);

    await harness.controller.close();
  });

  it('claim снят (рынок финализирован) → повторный допуск невозможен', async () => {
    const entry = makeEntry({ id: 'btc-5m-1' });
    const { gate, harness } = gateFor([entry]);
    await acquireFor(harness, entry, COLLECTOR_RAW_OWNER_KEY);
    expect(gate.admit('btc-5m-1')).toBeDefined();

    await harness.controller.release(COLLECTOR_RAW_OWNER_KEY, entry.market.id);

    expect(gate.admit('btc-5m-1')).toBeUndefined();
    expect(gate.getStats().ignoredNotHeldByCollector).toBe(1);

    await harness.controller.close();
  });

  it('несколько допусков одного рынка независимы (сессиями владеет recorder)', async () => {
    const entry = makeEntry({ id: 'btc-5m-1' });
    const { gate, harness } = gateFor([entry]);
    await acquireFor(harness, entry, COLLECTOR_RAW_OWNER_KEY);

    const first = gate.admit('btc-5m-1');
    const second = gate.admit('btc-5m-1');

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    // Gate не хранит сессий: повторный допуск снова строит регистрацию.
    expect(gate.getStats().admitted).toBe(2);

    await harness.controller.close();
  });
});
