/**
 * Обход каталога внутри прохода: свежий снимок заменяет universe, неудачный
 * обход его НЕ трогает.
 *
 * @remarks
 * Контракт `refresh(): boolean` существует ровно ради этого различия:
 * при отказе внутренний снимок discovery остаётся last-good. Наивное
 *
 * ```typescript
 * await discovery.refresh();
 * universe.replace(discovery.getSnapshot()); // без проверки результата
 * ```
 *
 * на первом же неудачном обходе (до первого успешного) обнулило бы universe,
 * а дальше — переписывало бы его тем же самым снимком впустую. Хуже другое:
 * временная недоступность Gamma читалась бы как «рынков больше нет», то есть
 * как повод перестать приобретать вообще.
 */
import { describe, it, expect } from '@jest/globals';
import {
  AT_1750_MS,
  AT_1757_MS,
  AT_1758_MS,
  AT_1800_MS,
  AT_1805_MS,
  makeEntry,
  policyOf,
} from './helpers/fakes.js';
import { makeHarness } from './helpers/harness.js';

describe('оркестрация обхода каталога', () => {
  it('успешный обход заменяет universe снимком discovery', async () => {
    const harness = makeHarness(AT_1757_MS);
    const x = makeEntry({ id: 'btc-1800', startsAtMs: AT_1800_MS });
    const y = makeEntry({ id: 'btc-1805', startsAtMs: AT_1805_MS });
    harness.discovery.stage([x, y], AT_1757_MS);

    const result = await harness.runtime.runOnce([]);

    expect(result.discoveryRefreshed).toBe(true);
    expect(result.universeEntries).toBe(2);
    expect(harness.universe.getAll().map((entry) => String(entry.market.id))).toEqual([
      'btc-1800',
      'btc-1805',
    ]);
    // План строится по ТОМУ ЖЕ universe, который отчёт называет размером
    expect(harness.universe.getSnapshot().observedAt.toNumber()).toBe(AT_1757_MS);
  });

  it('неудачный обход сохраняет last-good universe', async () => {
    const harness = makeHarness(AT_1757_MS);
    const x = makeEntry({ id: 'btc-1800', startsAtMs: AT_1800_MS });
    const y = makeEntry({ id: 'btc-1805', startsAtMs: AT_1805_MS });
    harness.discovery.stage([x, y], AT_1757_MS);

    const first = await harness.runtime.runOnce([]);
    expect(first.universeEntries).toBe(2);

    harness.discovery.refreshOutcome = false;
    const second = await harness.runtime.runOnce([]);

    expect(second.discoveryRefreshed).toBe(false);
    expect(second.universeEntries).toBe(2);
    expect(harness.universe.getAll()).toHaveLength(2);
  });

  it('первый обход неудачен: пустой отчёт, но не исключение', async () => {
    const harness = makeHarness(AT_1757_MS);
    harness.discovery.refreshOutcome = false;

    const result = await harness.runtime.runOnce([
      { ownerKey: 'strategy:A', policy: policyOf('btc', '5m'), acquireLimit: 1 },
    ]);

    expect(result.discoveryRefreshed).toBe(false);
    expect(result.universeEntries).toBe(0);
    expect(result.owners[0]?.plan.candidateCount).toBe(0);
    expect(result.owners[0]?.selectedMarketIds).toEqual([]);
    expect(result.owners[0]?.acquisitions).toEqual([]);
    expect(result.controller.claims).toBe(0);
  });

  it('спрос, появившийся при недоступном каталоге, обслуживается last-good universe', async () => {
    // Тик 1: каталог доступен, спроса ещё нет — universe наполнен.
    const harness = makeHarness(AT_1750_MS);
    harness.discovery.stage(
      [
        makeEntry({ id: 'btc-1800', startsAtMs: AT_1800_MS }),
        makeEntry({ id: 'btc-1805', startsAtMs: AT_1805_MS }),
      ],
      AT_1750_MS,
    );
    const warmUp = await harness.runtime.runOnce([]);
    expect(warmUp.universeEntries).toBe(2);
    expect(warmUp.controller.claims).toBe(0);

    // Тик 2: Gamma недоступна, зато появился владелец.
    harness.discovery.refreshOutcome = false;
    harness.clock.set(AT_1757_MS);

    const result = await harness.runtime.runOnce([
      { ownerKey: 'strategy:A', policy: policyOf('btc', '5m'), acquireLimit: 1 },
    ]);

    // Временная недоступность каталога ≠ мёртвый control plane
    expect(result.discoveryRefreshed).toBe(false);
    expect(result.universeEntries).toBe(2);
    expect(result.owners[0]?.acquisitions[0]?.status).toBe('opened');
    expect(String(result.owners[0]?.selectedMarketIds[0])).toBe('btc-1800');
    expect(result.controller.activeMarkets).toBe(1);
  });

  it('universe заменяется ТОЛЬКО при успешном обходе', async () => {
    const harness = makeHarness(AT_1757_MS);
    harness.discovery.stage([makeEntry({ id: 'btc-1800', startsAtMs: AT_1800_MS })], AT_1757_MS);
    await harness.runtime.runOnce([]);

    // Готовим ДРУГОЙ снимок и одновременно ломаем обход: раз обход не
    // удался, подготовленный снимок не должен попасть в universe.
    harness.discovery.stage([makeEntry({ id: 'btc-1805', startsAtMs: AT_1805_MS })], AT_1758_MS);
    harness.discovery.refreshOutcome = false;

    const result = await harness.runtime.runOnce([]);

    expect(result.discoveryRefreshed).toBe(false);
    expect(harness.universe.getAll().map((entry) => String(entry.market.id))).toEqual(['btc-1800']);
  });
});
