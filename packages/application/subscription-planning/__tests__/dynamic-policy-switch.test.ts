/**
 * Приёмочный сценарий контура: universe → policy → planner при СМЕНЕ policy
 * по расписанию.
 *
 * @remarks
 * Отдельные ворота проверены в `PolymarketSubscriptionPlanner.test.ts`.
 * Здесь проверяется то, чего не видно ни в одном из них по отдельности:
 * что цепочка СОБИРАЕТСЯ на настоящем `MarketUniverse` и что переход
 * BTC → XRP в 18:00 оформляется ЗАРАНЕЕ — в 17:57, когда XRP-policy ещё не
 * действует, а BTC-policy действует.
 *
 * ```text
 * 17:57  ← момент планирования
 *
 * BTC-policy: … 18:00)     XRP-policy: [18:00 …
 *
 * universe:
 *   BTC 17:55–18:00  ← торги уже идут
 *   BTC 18:00–18:05  ← BTC-policy в 18:00 уже НЕ действует
 *   XRP 18:00–18:05  ← XRP-policy в 18:00 уже действует
 *   XRP 18:05–18:10
 * ```
 */
import { describe, it, expect } from '@jest/globals';
import type { IClock } from '@polymarket/time';
import { MarketUniverse } from '@polymarket/market-discovery';
import { createPolymarketPolicy } from '@polymarket/policy';
import type { PolymarketPolicy } from '@polymarket/policy';
import { unsafeCryptoAssetId } from '@polymarket/ids';
import { PolymarketSubscriptionPlanner } from '../src/index.js';
import {
  AT_1755_MS,
  AT_1757_MS,
  AT_1800_MS,
  AT_1805_MS,
  FIVE_MIN_MS,
  makeEntry,
  makeSnapshot,
  nominal,
  ts,
} from './helpers/fixtures.js';

/** Часы, остановленные на фиксированном моменте (нужны только universe). */
class FixedClock implements IClock {
  public constructor(private readonly _ms: number) {}
  public now(): Date {
    return new Date(this._ms);
  }
}

/** Policy 5-минутной серии одного актива с заданным окном действия. */
function policyFor(asset: string, window: Partial<PolymarketPolicy>): PolymarketPolicy {
  return createPolymarketPolicy({
    kind: 'POLYMARKET',
    family: 'CRYPTO_UP_DOWN',
    assets: [unsafeCryptoAssetId(asset)],
    durations: [nominal(FIVE_MIN_MS)],
    ...window,
  });
}

/** Universe сценария: две серии BTC и две серии XRP вокруг стыка 18:00. */
function switchUniverse(): MarketUniverse {
  const universe = new MarketUniverse(new FixedClock(AT_1757_MS));
  universe.replace(
    makeSnapshot(
      [
        makeEntry({ id: 'btc-1755', asset: 'btc', startsAtMs: AT_1755_MS }),
        makeEntry({ id: 'btc-1800', asset: 'btc', startsAtMs: AT_1800_MS }),
        makeEntry({ id: 'xrp-1800', asset: 'xrp', startsAtMs: AT_1800_MS }),
        makeEntry({ id: 'xrp-1805', asset: 'xrp', startsAtMs: AT_1805_MS }),
      ],
      AT_1757_MS,
    ),
  );
  return universe;
}

describe('смена policy BTC → XRP в 18:00, планирование в 17:57', () => {
  const planner = new PolymarketSubscriptionPlanner();
  const now = ts(AT_1757_MS);

  const btcPolicy = policyFor('btc', { effectiveUntil: ts(AT_1800_MS) });
  const xrpPolicy = policyFor('xrp', { effectiveFrom: ts(AT_1800_MS) });

  it('BTC-policy не получает НИ ОДНОГО рынка: один уже идёт, второй — за её границей', () => {
    const plan = planner.plan(switchUniverse().getAll(), btcPolicy, now);

    expect(plan.candidates).toHaveLength(0);
    // btc-1755 потерян по расписанию, btc-1800 — по окну policy В МОМЕНТ
    // СТАРТА; xrp-рынки не подходят активом.
    expect(plan.diagnostics.alreadyStarted).toBe(1);
    expect(plan.diagnostics.policyMismatch).toBe(3);
  });

  it('XRP-policy строит план ДО собственного effectiveFrom', () => {
    const plan = planner.plan(switchUniverse().getAll(), xrpPolicy, now);

    expect(plan.candidates.map((entry) => String(entry.market.id))).toEqual([
      'xrp-1800',
      'xrp-1805',
    ]);
    expect(plan.diagnostics.eligible).toBe(2);
  });

  it('в плане нет ни начавшихся рынков, ни рынков чужой policy', () => {
    const plan = planner.plan(switchUniverse().getAll(), xrpPolicy, now);

    for (const entry of plan.candidates) {
      expect(entry.market.isStartedAt(now)).toBe(false);
      expect(String(entry.market.crypto?.asset)).toBe('xrp');
      expect(entry.market.isActive()).toBe(true);
    }
  });

  it('через контур проходят ТОЛЬКО canonical-записи universe', () => {
    const universe = switchUniverse();

    const plan = planner.plan(universe.getAll(), xrpPolicy, now);

    for (const entry of plan.candidates) {
      expect(Object.keys(entry).sort()).toEqual(['market', 'metrics']);
      // Ни численного score, ни vendor-полей планировщик не добавляет
      for (const leaked of ['score', 'sdkMarket', 'gammaMarket', 'rawMarket']) {
        expect(entry).not.toHaveProperty(leaked);
        expect(entry.market).not.toHaveProperty(leaked);
      }
    }
  });

  it('universe после планирования не изменился', () => {
    const universe = switchUniverse();
    const before = universe.getAll().map((entry) => String(entry.market.id));

    planner.plan(universe.getAll(), xrpPolicy, now);
    planner.plan(universe.getAll(), btcPolicy, now);

    expect(universe.getAll().map((entry) => String(entry.market.id))).toEqual(before);
  });
});
