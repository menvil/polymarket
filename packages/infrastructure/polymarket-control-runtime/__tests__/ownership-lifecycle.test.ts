/**
 * Приёмочный сценарий MR: ACQUISITION ≠ RETENTION в терминах прохода
 * рантайма.
 *
 * @remarks
 * Тесты этого файла — главное доказательство новой архитектуры. Все
 * компоненты контура настоящие (universe, policy, планировщик, контроллер,
 * доменный `Market`); подделаны только каталог, транспорт и часы.
 *
 * Проверяются четыре утверждения, каждое из которых при неверной реализации
 * ломает контур ТИХО:
 *
 * ```text
 * 1. rollover:      X стартовал → покупаем Y, X остаётся claim-ом
 * 2. нет спроса:    владелец пропал из demands → claim НЕ снимается
 * 3. смена policy:  новая policy → новый рынок, старый НЕ отпускается
 * 4. общий рынок:   два владельца → ОДНА подписка, ДВА claim-а
 * ```
 */
import { describe, it, expect, jest } from '@jest/globals';
import type { MarketDiscoveryEntry } from '@polymarket/ports';
import {
  AT_1757_MS,
  AT_1758_MS,
  AT_1800_MS,
  AT_1800_01_MS,
  AT_1805_MS,
  makeEntry,
  policyOf,
} from './helpers/fakes.js';
import { makeHarness } from './helpers/harness.js';

/** X = BTC 18:00–18:05, Y = BTC 18:05–18:10. */
function series(): { readonly x: MarketDiscoveryEntry; readonly y: MarketDiscoveryEntry } {
  return {
    x: makeEntry({ id: 'btc-1800', startsAtMs: AT_1800_MS }),
    y: makeEntry({ id: 'btc-1805', startsAtMs: AT_1805_MS }),
  };
}

describe('rollover: приобретение будущего рынка ≠ удержание текущего', () => {
  it('X удерживается после старта, Y приобретается тем же владельцем с acquireLimit=1', async () => {
    const harness = makeHarness(AT_1757_MS);
    const { x, y } = series();
    harness.discovery.stage([x, y], AT_1757_MS);

    // Ни один тик не имеет права снимать claim — следим за ОБОИМИ способами.
    const releaseSpy = jest.spyOn(harness.controller, 'release');
    const releaseOwnerSpy = jest.spyOn(harness.controller, 'releaseOwner');

    const demand = { ownerKey: 'strategy:A', policy: policyOf('btc', '5m'), acquireLimit: 1 };

    // ── Тик 1: 17:57 — план [X, Y], берём первый ────────────────────────────
    const tick1 = await harness.runtime.runOnce([demand]);

    expect(tick1.owners[0]?.plan.candidateCount).toBe(2);
    expect(tick1.owners[0]?.selectedMarketIds.map(String)).toEqual(['btc-1800']);
    expect(tick1.owners[0]?.acquisitions[0]?.status).toBe('opened');
    expect(tick1.controller.activeMarkets).toBe(1);

    // ── Тик 2: 17:58 — X ещё будущий, физический ресурс НЕ дублируется ──────
    harness.clock.set(AT_1758_MS);
    const tick2 = await harness.runtime.runOnce([demand]);

    expect(tick2.owners[0]?.selectedMarketIds.map(String)).toEqual(['btc-1800']);
    expect(tick2.owners[0]?.acquisitions[0]?.status).toBe('already-held');
    expect(harness.source.subscribeMarketCalls).toHaveLength(1);
    expect(tick2.controller.activeMarkets).toBe(1);
    expect(tick2.controller.claims).toBe(1);

    // ── Тик 3: 18:00:01 — X стартовал и ушёл из плана, первый кандидат — Y ──
    harness.clock.set(AT_1800_01_MS);
    const tick3 = await harness.runtime.runOnce([demand]);

    expect(tick3.owners[0]?.plan.diagnostics.alreadyStarted).toBe(1);
    expect(tick3.owners[0]?.selectedMarketIds.map(String)).toEqual(['btc-1805']);
    expect(tick3.owners[0]?.acquisitions[0]?.status).toBe('opened');

    // ГЛАВНОЕ: владелец держит ОБА рынка — начавшийся X и предстоящий Y
    const owned = harness.controller
      .listSubscriptions()
      .filter((item) => item.ownerKeys.includes('strategy:A'))
      .map((item) => String(item.marketId));
    expect(owned).toEqual(['btc-1800', 'btc-1805']);
    expect(tick3.controller.activeMarkets).toBe(2);
    expect(tick3.controller.claims).toBe(2);

    // ... и ни одного снятия claim-а по инициативе рантайма
    expect(releaseSpy).not.toHaveBeenCalled();
    expect(releaseOwnerSpy).not.toHaveBeenCalled();
  });
});

describe('спрос не является desired-state', () => {
  it('исчезновение владельца из demands НЕ снимает его claim', async () => {
    const harness = makeHarness(AT_1757_MS);
    const { x, y } = series();
    harness.discovery.stage([x, y], AT_1757_MS);
    const releaseSpy = jest.spyOn(harness.controller, 'release');
    const releaseOwnerSpy = jest.spyOn(harness.controller, 'releaseOwner');

    await harness.runtime.runOnce([
      { ownerKey: 'strategy:A', policy: policyOf('btc', '5m'), acquireLimit: 1 },
    ]);
    expect(harness.controller.getStats().claims).toBe(1);

    // Владельца в спросе больше нет — но останавливал ли его кто-нибудь,
    // рантайм не знает и знать не может.
    harness.clock.set(AT_1758_MS);
    const result = await harness.runtime.runOnce([]);

    expect(result.owners).toEqual([]);
    expect(releaseSpy).not.toHaveBeenCalled();
    expect(releaseOwnerSpy).not.toHaveBeenCalled();
    expect(result.controller.claims).toBe(1);
    expect(result.controller.activeMarkets).toBe(1);
    expect(harness.controller.listSubscriptions()[0]?.ownerKeys).toEqual(['strategy:A']);
    // Физический ресурс жив: закрытий подписки не было
    expect(harness.source.issued.every((item) => item.closeCalls === 0)).toBe(true);
  });

  it('смена policy владельца НЕ отпускает уже приобретённый рынок', async () => {
    const harness = makeHarness(AT_1757_MS);
    harness.discovery.stage(
      [
        makeEntry({ id: 'btc-1800', asset: 'btc', startsAtMs: AT_1800_MS }),
        makeEntry({ id: 'xrp-1800', asset: 'xrp', startsAtMs: AT_1800_MS }),
      ],
      AT_1757_MS,
    );
    const releaseSpy = jest.spyOn(harness.controller, 'release');
    const releaseOwnerSpy = jest.spyOn(harness.controller, 'releaseOwner');

    const tick1 = await harness.runtime.runOnce([
      { ownerKey: 'strategy:A', policy: policyOf('btc', '5m'), acquireLimit: 1 },
    ]);
    expect(tick1.owners[0]?.selectedMarketIds.map(String)).toEqual(['btc-1800']);

    // Тот же владелец, ДРУГАЯ policy.
    harness.clock.set(AT_1758_MS);
    const tick2 = await harness.runtime.runOnce([
      { ownerKey: 'strategy:A', policy: policyOf('xrp', '5m'), acquireLimit: 1 },
    ]);

    expect(tick2.owners[0]?.selectedMarketIds.map(String)).toEqual(['xrp-1800']);
    expect(tick2.owners[0]?.acquisitions[0]?.status).toBe('opened');

    // Сознательное промежуточное поведение: старый claim остаётся. Когда
    // именно его снимать — вопрос владельца, а не смены его конфигурации.
    const owned = harness.controller
      .listSubscriptions()
      .filter((item) => item.ownerKeys.includes('strategy:A'))
      .map((item) => String(item.marketId));
    expect(owned).toEqual(['btc-1800', 'xrp-1800']);
    expect(releaseSpy).not.toHaveBeenCalled();
    expect(releaseOwnerSpy).not.toHaveBeenCalled();
  });
});

describe('несколько владельцев в одном проходе', () => {
  it('стратегия и коллектор делят ОДНУ физическую подписку', async () => {
    const harness = makeHarness(AT_1757_MS);
    const { x, y } = series();
    harness.discovery.stage([x, y], AT_1757_MS);
    const policy = policyOf('btc', '5m');

    const result = await harness.runtime.runOnce([
      { ownerKey: 'strategy:A', policy, acquireLimit: 1 },
      { ownerKey: 'collector:raw', policy, acquireLimit: 1 },
    ]);

    // Порядок обработки лексикографический, поэтому исход детерминирован
    expect(result.owners.map((owner) => owner.ownerKey)).toEqual(['collector:raw', 'strategy:A']);
    expect(result.owners[0]?.acquisitions[0]?.status).toBe('opened');
    expect(result.owners[1]?.acquisitions[0]?.status).toBe('joined');

    // Дедупликация рынков — обязанность контроллера, не рантайма
    expect(harness.source.subscribeMarketCalls).toHaveLength(1);
    expect(result.controller.activeMarkets).toBe(1);
    expect(result.controller.claims).toBe(2);
    expect(harness.controller.listSubscriptions()[0]?.ownerKeys).toEqual([
      'collector:raw',
      'strategy:A',
    ]);
  });

  it('два владельца с разными policy получают свои рынки в одном проходе', async () => {
    const harness = makeHarness(AT_1757_MS);
    harness.discovery.stage(
      [
        makeEntry({ id: 'btc-1800', asset: 'btc', startsAtMs: AT_1800_MS }),
        makeEntry({ id: 'xrp-1800', asset: 'xrp', startsAtMs: AT_1800_MS }),
      ],
      AT_1757_MS,
    );

    const result = await harness.runtime.runOnce([
      { ownerKey: 'strategy:btc-5m', policy: policyOf('btc', '5m'), acquireLimit: 1 },
      { ownerKey: 'strategy:xrp-5m', policy: policyOf('xrp', '5m'), acquireLimit: 1 },
    ]);

    expect(result.owners[0]?.selectedMarketIds.map(String)).toEqual(['btc-1800']);
    expect(result.owners[1]?.selectedMarketIds.map(String)).toEqual(['xrp-1800']);
    expect(result.owners.map((owner) => owner.acquisitions[0]?.status)).toEqual([
      'opened',
      'opened',
    ]);

    // Рантайм знает только ownerKey + Policy: две конфигурации одной будущей
    // реализации стратегии для него — два обычных владельца.
    expect(result.controller.activeMarkets).toBe(2);
    expect(result.controller.claims).toBe(2);
    expect(
      harness.controller.listSubscriptions().map((item) => [String(item.marketId), item.ownerKeys]),
    ).toEqual([
      ['btc-1800', ['strategy:btc-5m']],
      ['xrp-1800', ['strategy:xrp-5m']],
    ]);
  });
});
