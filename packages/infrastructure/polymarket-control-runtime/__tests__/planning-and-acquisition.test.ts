/**
 * Планирование и приобретение внутри прохода: порядок, лимит, агрегация
 * исходов и неизменяемость отчёта.
 *
 * @remarks
 * Рантайм не имеет собственного отбора — он полностью переиспользует
 * планировщик. Поэтому тесты здесь проверяют не «правильно ли отобраны
 * рынки» (это предмет `@polymarket/subscription-planning`), а то, что
 * рантайм НЕ вмешивается: берёт первые N кандидатов в порядке плана,
 * обрабатывает их последовательно и складывает исходы как есть.
 */
import { describe, it, expect, jest } from '@jest/globals';
import type { PolymarketSubscriptionPlan } from '@polymarket/subscription-planning';
import type { MarketDiscoveryEntry } from '@polymarket/ports';
import type { PolymarketPolicy } from '@polymarket/policy';
import type { Timestamp } from '@polymarket/timestamp';
import {
  AT_1757_MS,
  AT_1800_MS,
  AT_1800_01_MS,
  AT_1805_MS,
  AT_1810_MS,
  makeEntry,
  policyOf,
} from './helpers/fakes.js';
import { makeHarness } from './helpers/harness.js';

/** Три последовательных 5-минутных рынка BTC. */
function threeBtcMarkets(): readonly MarketDiscoveryEntry[] {
  return [
    makeEntry({ id: 'btc-1800', startsAtMs: AT_1800_MS }),
    makeEntry({ id: 'btc-1805', startsAtMs: AT_1805_MS }),
    makeEntry({ id: 'btc-1810', startsAtMs: AT_1810_MS }),
  ];
}

describe('порядок кандидатов и лимит приобретения', () => {
  it('кандидаты берутся в порядке планировщика, лимит 1 — ближайший рынок', async () => {
    const harness = makeHarness(AT_1757_MS);
    // Технический порядок снимка ОБРАТЕН хронологии: планировщик обязан
    // упорядочить его сам, а рантайм — не трогать этот порядок.
    harness.discovery.stage([...threeBtcMarkets()].reverse(), AT_1757_MS);

    const result = await harness.runtime.runOnce([
      { ownerKey: 'strategy:A', policy: policyOf('btc', '5m'), acquireLimit: 1 },
    ]);

    expect(result.owners[0]?.selectedMarketIds.map(String)).toEqual(['btc-1800']);
    expect(result.owners[0]?.plan.candidateCount).toBe(3);
  });

  it('лимит 2 — первые два кандидата, третий не трогается', async () => {
    const harness = makeHarness(AT_1757_MS);
    harness.discovery.stage(threeBtcMarkets(), AT_1757_MS);

    const first = await harness.runtime.runOnce([
      { ownerKey: 'strategy:A', policy: policyOf('btc', '5m'), acquireLimit: 2 },
    ]);

    expect(first.owners[0]?.selectedMarketIds.map(String)).toEqual(['btc-1800', 'btc-1805']);
    expect(first.owners[0]?.acquisitions.map((item) => item.status)).toEqual(['opened', 'opened']);
    expect(harness.source.subscribeMarketCalls).toHaveLength(2);
    expect(first.controller.activeMarkets).toBe(2);

    // Следующий тик до старта: те же два рынка, новых ресурсов нет.
    const second = await harness.runtime.runOnce([
      { ownerKey: 'strategy:A', policy: policyOf('btc', '5m'), acquireLimit: 2 },
    ]);

    expect(second.owners[0]?.acquisitions.map((item) => item.status)).toEqual([
      'already-held',
      'already-held',
    ]);
    expect(harness.source.subscribeMarketCalls).toHaveLength(2);
    expect(second.controller.activeMarkets).toBe(2);
    expect(second.controller.claims).toBe(2);
  });

  it('повтор того же кандидата не создаёт второй физической подписки', async () => {
    const harness = makeHarness(AT_1757_MS);
    harness.discovery.stage([makeEntry({ id: 'btc-1800', startsAtMs: AT_1800_MS })], AT_1757_MS);
    const demand = { ownerKey: 'strategy:A', policy: policyOf('btc', '5m'), acquireLimit: 1 };

    await harness.runtime.runOnce([demand]);
    const repeated = await harness.runtime.runOnce([demand]);

    expect(repeated.owners[0]?.acquisitions[0]?.status).toBe('already-held');
    expect(harness.source.subscribeMarketCalls).toHaveLength(1);
    expect(harness.controller.getStats().claims).toBe(1);
  });
});

describe('детерминированный порядок владельцев', () => {
  it('владельцы обрабатываются по ownerKey ASC независимо от порядка входа', async () => {
    const harness = makeHarness(AT_1757_MS);
    harness.discovery.stage(threeBtcMarkets(), AT_1757_MS);
    const policy = policyOf('btc', '5m');

    const result = await harness.runtime.runOnce([
      { ownerKey: 'strategy:zzz', policy, acquireLimit: 1 },
      { ownerKey: 'collector:raw', policy, acquireLimit: 1 },
      { ownerKey: 'strategy:aaa', policy, acquireLimit: 1 },
    ]);

    expect(result.owners.map((owner) => owner.ownerKey)).toEqual([
      'collector:raw',
      'strategy:aaa',
      'strategy:zzz',
    ]);
    // Порядок определяет и диагностику: первым идёт тот, кто открыл рынок.
    expect(result.owners.map((owner) => owner.acquisitions[0]?.status)).toEqual([
      'opened',
      'joined',
      'joined',
    ]);
  });
});

describe('один момент решения на весь проход', () => {
  it('все вызовы планировщика тика получают ОДИН И ТОТ ЖЕ now', async () => {
    const harness = makeHarness(AT_1757_MS);
    harness.discovery.stage(threeBtcMarkets(), AT_1757_MS);
    const policy = policyOf('btc', '5m');

    const moments: Timestamp[] = [];
    const realPlan = harness.planner.plan.bind(harness.planner);
    jest
      .spyOn(harness.planner, 'plan')
      .mockImplementation(
        (
          entries: readonly MarketDiscoveryEntry[],
          ownerPolicy: PolymarketPolicy,
          now: Timestamp,
        ): PolymarketSubscriptionPlan => {
          moments.push(now);
          // Часы уезжают между владельцами: если бы рантайм читал их на
          // каждого, второй владелец увидел бы другой мир.
          harness.clock.set(AT_1800_01_MS);
          return realPlan(entries, ownerPolicy, now);
        },
      );

    const result = await harness.runtime.runOnce([
      { ownerKey: 'collector:raw', policy, acquireLimit: 1 },
      { ownerKey: 'strategy:A', policy, acquireLimit: 1 },
    ]);

    expect(moments).toHaveLength(2);
    expect(moments[0]).toBe(moments[1]);
    expect(moments[0]?.toNumber()).toBe(AT_1757_MS);
    expect(result.ranAt.toNumber()).toBe(AT_1757_MS);
  });
});

describe('агрегация исходов контроллера', () => {
  it('рынок, стартовавший между планом и приобретением, попадает в отчёт как rejected', async () => {
    const harness = makeHarness(AT_1757_MS);
    harness.discovery.stage([makeEntry({ id: 'btc-1800', startsAtMs: AT_1800_MS })], AT_1757_MS);

    const realPlan = harness.planner.plan.bind(harness.planner);
    jest
      .spyOn(harness.planner, 'plan')
      .mockImplementation(
        (
          entries: readonly MarketDiscoveryEntry[],
          policy: PolymarketPolicy,
          now: Timestamp,
        ): PolymarketSubscriptionPlan => {
          const plan = realPlan(entries, policy, now);
          // Рынок стартовал, пока строился план: контроллер обязан отказать
          // по СВОИМ часам, а не по возрасту плана.
          harness.clock.set(AT_1800_01_MS);
          return plan;
        },
      );

    const result = await harness.runtime.runOnce([
      { ownerKey: 'strategy:A', policy: policyOf('btc', '5m'), acquireLimit: 1 },
    ]);

    expect(result.owners[0]?.acquisitions[0]).toMatchObject({
      status: 'rejected',
      reason: 'already-started',
    });
    expect(harness.controller.getStats().claims).toBe(0);
  });

  it('пропавшая vendor-подготовка попадает в отчёт как rejected/not-prepared', async () => {
    const harness = makeHarness(AT_1757_MS);
    harness.discovery.stage([makeEntry({ id: 'btc-1800', startsAtMs: AT_1800_MS })], AT_1757_MS);
    await harness.runtime.runOnce([]); // universe наполнен

    harness.discovery.dropPreparation('btc-1800');
    harness.discovery.refreshOutcome = false; // universe остаётся last-good

    const result = await harness.runtime.runOnce([
      { ownerKey: 'strategy:A', policy: policyOf('btc', '5m'), acquireLimit: 1 },
    ]);

    expect(result.owners[0]?.acquisitions[0]?.status).toBe('rejected');
    expect(result.owners[0]?.acquisitions[0]).toMatchObject({ reason: 'not-prepared' });
  });

  it('отказ транспорта попадает в отчёт как failed, проход не бросает', async () => {
    const harness = makeHarness(AT_1757_MS);
    harness.discovery.stage([makeEntry({ id: 'btc-1800', startsAtMs: AT_1800_MS })], AT_1757_MS);
    harness.source.subscribeMarketError = new Error('transport is down');

    const result = await harness.runtime.runOnce([
      { ownerKey: 'strategy:A', policy: policyOf('btc', '5m'), acquireLimit: 1 },
    ]);

    expect(result.owners[0]?.acquisitions[0]).toMatchObject({
      status: 'failed',
      stage: 'market-subscription',
    });
    // Откат контроллера полный: висящего claim-а не остаётся
    expect(result.controller.claims).toBe(0);
    expect(result.controller.activeMarkets).toBe(0);
  });

  it('недоступный источник попадает в отчёт как rejected/source-unavailable', async () => {
    const harness = makeHarness(AT_1757_MS);
    harness.discovery.stage([makeEntry({ id: 'btc-1800', startsAtMs: AT_1800_MS })], AT_1757_MS);
    harness.source.hasFailed = true;

    const result = await harness.runtime.runOnce([
      { ownerKey: 'strategy:A', policy: policyOf('btc', '5m'), acquireLimit: 1 },
    ]);

    expect(result.owners[0]?.acquisitions[0]).toMatchObject({
      status: 'rejected',
      reason: 'source-unavailable',
    });
    // Замена отказавшего источника — работа composition root, не рантайма
    expect(result.controller.sourceFailed).toBe(true);
  });

  it('на кандидата приходится РОВНО одна попытка приобретения', async () => {
    const harness = makeHarness(AT_1757_MS);
    harness.discovery.stage([makeEntry({ id: 'btc-1800', startsAtMs: AT_1800_MS })], AT_1757_MS);
    harness.source.subscribeMarketError = new Error('transport is down');
    const acquireSpy = jest.spyOn(harness.controller, 'acquire');

    const result = await harness.runtime.runOnce([
      { ownerKey: 'strategy:A', policy: policyOf('btc', '5m'), acquireLimit: 1 },
    ]);

    expect(acquireSpy).toHaveBeenCalledTimes(1);
    expect(result.owners[0]?.acquisitions).toHaveLength(1);
  });
});

describe('неизменяемость отчёта', () => {
  it('отчёт заморожен на всех уровнях', async () => {
    const harness = makeHarness(AT_1757_MS);
    harness.discovery.stage(threeBtcMarkets(), AT_1757_MS);

    const result = await harness.runtime.runOnce([
      { ownerKey: 'strategy:A', policy: policyOf('btc', '5m'), acquireLimit: 2 },
    ]);
    const owner = result.owners[0];

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.owners)).toBe(true);
    expect(Object.isFrozen(result.controller)).toBe(true);
    expect(Object.isFrozen(owner)).toBe(true);
    expect(Object.isFrozen(owner?.plan)).toBe(true);
    expect(Object.isFrozen(owner?.plan.diagnostics)).toBe(true);
    expect(Object.isFrozen(owner?.selectedMarketIds)).toBe(true);
    expect(Object.isFrozen(owner?.acquisitions)).toBe(true);
  });

  it('позиции selectedMarketIds и acquisitions совпадают', async () => {
    const harness = makeHarness(AT_1757_MS);
    harness.discovery.stage(threeBtcMarkets(), AT_1757_MS);

    const result = await harness.runtime.runOnce([
      { ownerKey: 'strategy:A', policy: policyOf('btc', '5m'), acquireLimit: 3 },
    ]);
    const owner = result.owners[0];

    expect(owner?.selectedMarketIds).toHaveLength(3);
    expect(owner?.acquisitions).toHaveLength(3);
    owner?.selectedMarketIds.forEach((marketId, index) => {
      expect(owner.acquisitions[index]?.marketId).toBe(marketId);
    });
  });

  it('universe не мутируется проходом', async () => {
    const harness = makeHarness(AT_1757_MS);
    harness.discovery.stage(threeBtcMarkets(), AT_1757_MS);

    await harness.runtime.runOnce([
      { ownerKey: 'strategy:A', policy: policyOf('btc', '5m'), acquireLimit: 2 },
    ]);

    const entries = harness.universe.getAll();
    expect(entries).toHaveLength(3);
    expect(Object.isFrozen(entries)).toBe(true);
    expect(entries.map((entry) => String(entry.market.id))).toEqual([
      'btc-1800',
      'btc-1805',
      'btc-1810',
    ]);
  });
});
