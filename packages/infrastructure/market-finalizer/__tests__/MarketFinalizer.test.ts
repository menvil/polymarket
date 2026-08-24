/**
 * Поведенческие тесты MarketFinalizer поверх РЕАЛЬНОГО координатора:
 * expiry-переход, crypto enrichment, retry/timeout, наблюдаемые отказы,
 * конкурентность, shutdown, non-crypto (N-004 PART 49-61).
 *
 * @remarks
 * Часы инъецируются (детерминизм, PART 14); Gamma/recorder — узкие fakes;
 * session lifecycle — настоящий `MarketCollectionCoordinator`.
 */
import { describe, it, expect } from '@jest/globals';
import type { CollectionHeaderFinalization } from '@polymarket/collection-coordinator';
import {
  CID_A,
  CID_B,
  armGamma,
  createFinalizerHarness,
  createFreshGammaEvent,
  createFreshGammaMarket,
  mid,
} from './helpers/fakes.js';

/** Продвигает фикстурный рынок (истекает через 70 мин) за expiry. */
const EXPIRE_ADVANCE_MS = 70 * 60_000 + 1_000;

/** finalization-раздел последнего записанного header-а. */
function lastFinalization(
  recorder: { lastHeader(): Record<string, unknown> | undefined },
): CollectionHeaderFinalization {
  const header = recorder.lastHeader();
  expect(header).toBeDefined();
  return header!['finalization'] as CollectionHeaderFinalization;
}

describe('expiry-переход (PART 49)', () => {
  it('до expiry рынок остаётся ACTIVE; на expiry — FINALIZING с seal и teardown realtime', async () => {
    const { discovery, source, recorder, gamma, clock, coordinator, finalizer } =
      createFinalizerHarness();
    armGamma(gamma, createFreshGammaMarket(), createFreshGammaEvent());
    await coordinator.openMarket(discovery.addMarket());

    await finalizer.runOnce(); // clock < expiresAt
    expect(coordinator.getStats()).toMatchObject({ activeSessions: 1, finalizingSessions: 0 });
    expect(recorder.seals).toEqual([]);

    clock.advance(EXPIRE_ADVANCE_MS);
    await finalizer.runOnce();

    expect(coordinator.getStats()).toMatchObject({ activeSessions: 0 });
    expect(recorder.seals).toEqual([CID_A]);
    expect(source.marketSubscriptions[0]!.closeCalls).toBe(1);
    // Capacity освобождена, RTDS-refs сняты
    expect(coordinator.getStats().rtdsFeeds).toEqual([]);
  });
});

describe('crypto enrichment (PART 27/30/53)', () => {
  it('partial → header pending без архива; full → complete header, EXPIRED, сессия снята', async () => {
    const { discovery, recorder, gamma, clock, coordinator, finalizer } = createFinalizerHarness();
    // Попытка 1: только priceToBeat
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.995', noPrice: '0.005' }),
      createFreshGammaEvent({ priceToBeat: 78027.33965248794 }),
    );
    await coordinator.openMarket(discovery.addMarket());
    clock.advance(EXPIRE_ADVANCE_MS);

    await finalizer.runOnce();

    let finalization = lastFinalization(recorder);
    expect(finalization.status).toBe('pending');
    expect(finalization.crypto).toEqual({ priceToBeat: '78027.33965248794' });
    // До-резолюционные цены победителя НЕ дают
    expect(finalization.winning).toBeUndefined();
    expect(recorder.finalizations).toEqual([]);
    expect(coordinator.getStats().finalizingSessions).toBe(1);

    // Попытка 2 (через retry cadence): оба значения + resolved рынок
    armGamma(
      gamma,
      createFreshGammaMarket(),
      createFreshGammaEvent({ priceToBeat: 78027.33965248794, finalPrice: 78325.4503724296 }),
    );
    clock.advance(30_000);
    await finalizer.runOnce();

    finalization = lastFinalization(recorder);
    expect(finalization.status).toBe('complete');
    expect(finalization.attempts).toBe(2);
    expect(finalization.crypto).toEqual({
      priceToBeat: '78027.33965248794',
      finalPrice: '78325.4503724296',
    });
    expect(finalization.resolution).toMatchObject({ closed: true, umaResolutionStatus: 'resolved' });
    // Нейтральные финальные исходы + однозначный победитель
    expect(finalization.outcomes).toEqual([
      { label: 'Up', instrumentId: '111', price: '1' },
      { label: 'Down', instrumentId: '222', price: '0' },
    ]);
    expect(finalization.winning).toEqual({ label: 'Up', instrumentId: '111' });
    // Vendor yes/no не протекает в finalization-сводку
    expect(JSON.stringify(finalization)).not.toContain('"yes"');
    expect(JSON.stringify(finalization)).not.toContain('"no"');

    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
    expect(coordinator.listSessions()).toEqual([]);
    expect(finalizer.getStats()).toMatchObject({ pendingFinalizations: 0, archivedTotal: 1 });
  });

  it('cadence: повторный runOnce внутри enrichmentRetryMs НЕ делает второй Gamma-запрос', async () => {
    const { discovery, gamma, clock, coordinator, finalizer } = createFinalizerHarness();
    armGamma(gamma, createFreshGammaMarket({ umaResolutionStatus: null }), createFreshGammaEvent());
    await coordinator.openMarket(discovery.addMarket());
    clock.advance(EXPIRE_ADVANCE_MS);

    await finalizer.runOnce();
    expect(gamma.fetchMarketCalls).toHaveLength(1);

    await finalizer.runOnce(); // тот же тик — cadence не наступил
    expect(gamma.fetchMarketCalls).toHaveLength(1);

    clock.advance(30_000);
    await finalizer.runOnce();
    expect(gamma.fetchMarketCalls).toHaveLength(2);
  });
});

describe('отказ Gamma (PART 29/54)', () => {
  it('падение fetch сохраняет FINALIZING/файл без header-обновлений; следующий runOnce продолжает', async () => {
    const { discovery, recorder, gamma, clock, coordinator, finalizer } = createFinalizerHarness();
    gamma.failFetches = true;
    await coordinator.openMarket(discovery.addMarket());
    clock.advance(EXPIRE_ADVANCE_MS);

    await finalizer.runOnce();

    expect(recorder.metaUpdates).toEqual([]);
    expect(recorder.finalizations).toEqual([]);
    expect(coordinator.getStats().finalizingSessions).toBe(1);
    expect(finalizer.getStats().pendingFinalizations).toBe(1);

    // Gamma восстановился — enrichment продолжается штатно
    gamma.failFetches = false;
    armGamma(
      gamma,
      createFreshGammaMarket(),
      createFreshGammaEvent({ priceToBeat: 78027.1, finalPrice: 78325.2 }),
    );
    clock.advance(30_000);
    await finalizer.runOnce();

    expect(lastFinalization(recorder).status).toBe('complete');
    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
  });
});

describe('timeout (PART 31/55)', () => {
  it('без полного metadata архивирует best-known с явным status=timeout', async () => {
    const { discovery, recorder, gamma, clock, coordinator, finalizer } = createFinalizerHarness();
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.99', noPrice: '0.01' }),
      createFreshGammaEvent({ priceToBeat: 78027.33965248794 }), // finalPrice так и не появился
    );
    await coordinator.openMarket(discovery.addMarket());
    clock.advance(EXPIRE_ADVANCE_MS);
    await finalizer.runOnce(); // attempt 1 — pending

    clock.advance(15 * 60_000 + 1_000); // бюджет ожидания исчерпан
    await finalizer.runOnce();

    const finalization = lastFinalization(recorder);
    expect(finalization.status).toBe('timeout');
    expect(finalization.crypto).toEqual({ priceToBeat: '78027.33965248794' });
    expect(finalization.finalizedAtMs).toBeDefined();
    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
    expect(coordinator.listSessions()).toEqual([]);
    expect(finalizer.getStats()).toMatchObject({ pendingFinalizations: 0, archivedTotal: 1 });
  });
});

describe('наблюдаемые отказы архива/header-а (PART 26/35/57/58)', () => {
  it('finalizeMarket(EXPIRED) бросает → отказ терминален, без success и без повторного gzip', async () => {
    const { discovery, recorder, gamma, clock, coordinator, finalizer, logger } =
      createFinalizerHarness();
    armGamma(
      gamma,
      createFreshGammaMarket(),
      createFreshGammaEvent({ priceToBeat: 1, finalPrice: 2 }),
    );
    await coordinator.openMarket(discovery.addMarket());
    clock.advance(EXPIRE_ADVANCE_MS);
    recorder.finalizeError = new Error('gzip failed');

    await finalizer.runOnce();

    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]); // одна попытка
    expect(finalizer.getStats()).toMatchObject({ archivedTotal: 0, archiveFailures: 1 });
    // Сессия НЕ снята — identity рынка защищена
    expect(coordinator.getStats().finalizingSessions).toBe(1);
    expect(logger.byLevel('error').some((e) => e.message.includes('EXPIRED archive failed'))).toBe(
      true,
    );
    expect(
      logger.byLevel('info').some((e) => e.message.includes('Market finalized and archived')),
    ).toBe(false);

    // Повторный runOnce НЕ делает второй gzip-попытки (retry framework сознательно нет)
    clock.advance(30_000);
    await finalizer.runOnce();
    expect(recorder.finalizations).toHaveLength(1);
  });

  it('header update false при complete → архив отложен и наблюдаем; после успеха — архив', async () => {
    const { discovery, recorder, gamma, clock, coordinator, finalizer, logger } =
      createFinalizerHarness();
    armGamma(
      gamma,
      createFreshGammaMarket(),
      createFreshGammaEvent({ priceToBeat: 1, finalPrice: 2 }),
    );
    await coordinator.openMarket(discovery.addMarket());
    clock.advance(EXPIRE_ADVANCE_MS);
    recorder.metaUpdateResult = false;

    await finalizer.runOnce();

    expect(recorder.finalizations).toEqual([]); // «fully finalized» не объявлен
    expect(
      logger.byLevel('error').some((e) => e.message.includes('archive deferred')),
    ).toBe(true);
    expect(finalizer.getStats().pendingFinalizations).toBe(1);

    recorder.metaUpdateResult = true;
    clock.advance(30_000);
    await finalizer.runOnce();
    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
  });

  it('на timeout при неудачном header-е архивируется best-known предыдущий header (явная policy)', async () => {
    const { discovery, recorder, gamma, clock, coordinator, finalizer, logger } =
      createFinalizerHarness();
    armGamma(gamma, createFreshGammaMarket({ umaResolutionStatus: null }), createFreshGammaEvent());
    await coordinator.openMarket(discovery.addMarket());
    recorder.metaUpdateResult = false;
    clock.advance(EXPIRE_ADVANCE_MS);
    await finalizer.runOnce(); // begin + attempt 1 (pending, header не записался)

    clock.advance(15 * 60_000 + 1_000); // бюджет ожидания исчерпан
    await finalizer.runOnce();

    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
    expect(
      logger
        .byLevel('error')
        .some((e) => e.message.includes('archiving with best-known previous header')),
    ).toBe(true);
  });
});

describe('конкурентность (PART 38/59)', () => {
  it('два конкурентных runOnce для одного expired рынка → один begin/fetch/update/gzip', async () => {
    const { discovery, recorder, gamma, clock, coordinator, finalizer } = createFinalizerHarness();
    armGamma(
      gamma,
      createFreshGammaMarket(),
      createFreshGammaEvent({ priceToBeat: 1, finalPrice: 2 }),
    );
    await coordinator.openMarket(discovery.addMarket());
    clock.advance(EXPIRE_ADVANCE_MS);

    await Promise.all([finalizer.runOnce(), finalizer.runOnce()]);

    expect(recorder.seals).toEqual([CID_A]);
    expect(gamma.fetchMarketCalls).toHaveLength(1);
    expect(recorder.metaUpdates).toHaveLength(1);
    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
  });
});

describe('shutdown (PART 40/60)', () => {
  it('close(): FINALIZING → EXPIRED best-known без новых Gamma-запросов; ACTIVE остаётся координатору', async () => {
    const { discovery, recorder, gamma, clock, coordinator, finalizer } = createFinalizerHarness();
    // B истечёт и будет FINALIZING (incomplete); A останется ACTIVE
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.99', noPrice: '0.01' }),
      createFreshGammaEvent({ priceToBeat: 78027.1 }),
    );
    await coordinator.openMarket(discovery.addMarket({ conditionId: CID_B, expiresAtMs: Date.parse('2026-08-19T13:10:00.000Z') }));
    await coordinator.openMarket(
      discovery.addMarket({ conditionId: CID_A, expiresAtMs: Date.parse('2026-08-19T20:00:00.000Z') }),
    );
    clock.advance(75 * 60_000); // B истёк, A ещё нет
    await finalizer.runOnce(); // B → FINALIZING, attempt 1 (pending)
    expect(coordinator.getStats()).toMatchObject({ activeSessions: 1, finalizingSessions: 1 });
    const fetchesBeforeClose = gamma.fetchMarketCalls.length;

    await finalizer.close();

    // B заархивирован как timeout с best-known priceToBeat; НОВЫХ fetch-ей нет
    expect(gamma.fetchMarketCalls).toHaveLength(fetchesBeforeClose);
    expect(recorder.finalizations).toEqual([`${CID_B}:EXPIRED`]);
    const finalization = lastFinalization(recorder);
    expect(finalization.status).toBe('timeout');
    expect(finalization.crypto).toEqual({ priceToBeat: '78027.1' });
    // A НЕ архивирован finalizer-ом
    expect(coordinator.getStats()).toMatchObject({ activeSessions: 1, finalizingSessions: 0 });

    // Дальше composition root: coordinator.close() закрывает A как SHUTDOWN
    await coordinator.close();
    expect(recorder.finalizations).toEqual([`${CID_B}:EXPIRED`, `${CID_A}:SHUTDOWN`]);

    // close идемпотентен; runOnce после close — no-op
    await finalizer.close();
    await finalizer.runOnce();
    expect(recorder.finalizations).toHaveLength(2);
  });
});

describe('non-crypto (PART 32/61)', () => {
  it('немедленный EXPIRED после best-effort снапшота — без 15-минутного ожидания', async () => {
    const { discovery, recorder, gamma, clock, coordinator, finalizer } = createFinalizerHarness();
    armGamma(gamma, createFreshGammaMarket(), createFreshGammaEvent());
    await coordinator.openMarket(discovery.addMarket({ rtdsFeeds: [] })); // non-crypto
    clock.advance(EXPIRE_ADVANCE_MS);

    await finalizer.runOnce();

    const finalization = lastFinalization(recorder);
    expect(finalization.status).toBe('complete');
    expect(finalization.crypto).toBeUndefined(); // crypto-раздела нет
    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
    expect(coordinator.listSessions()).toEqual([]);
  });

  it('отказ Gamma не держит non-crypto рынок: архив с initial-данными в тот же runOnce', async () => {
    const { discovery, recorder, gamma, clock, coordinator, finalizer } = createFinalizerHarness();
    gamma.failFetches = true;
    await coordinator.openMarket(discovery.addMarket({ rtdsFeeds: [] }));
    clock.advance(EXPIRE_ADVANCE_MS);

    await finalizer.runOnce();

    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
    expect(lastFinalization(recorder).status).toBe('complete');
  });
});

describe('усечение header-а не теряет критические данные (PART 24/56)', () => {
  it('огромные fresh Gamma-снапшоты выброшены, finalization-ядро сохранено', async () => {
    const { discovery, recorder, gamma, clock, coordinator, finalizer } = createFinalizerHarness();
    armGamma(
      gamma,
      createFreshGammaMarket({ padding: 16 * 1024 }),
      createFreshGammaEvent({ priceToBeat: 78027.1, finalPrice: 78325.2, padding: 16 * 1024 }),
    );
    await coordinator.openMarket(discovery.addMarket());
    clock.advance(EXPIRE_ADVANCE_MS);

    await finalizer.runOnce();

    const header = recorder.lastHeader()!;
    expect(header['truncated']).toEqual(['gammaEvent', 'gammaMarket']);
    expect(header['gammaMarket']).toBeUndefined();
    expect(header['gammaEvent']).toBeUndefined();
    // Критические данные финализации пережили усечение vendor-снапшотов
    const finalization = header['finalization'] as CollectionHeaderFinalization;
    expect(finalization.status).toBe('complete');
    expect(finalization.crypto).toEqual({ priceToBeat: '78027.1', finalPrice: '78325.2' });
    expect(finalization.outcomes).toHaveLength(2);
    expect(finalization.winning).toEqual({ label: 'Up', instrumentId: '111' });
    expect(header['conditionId']).toBe(CID_A);
    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
  });
});

describe('идентичность рынков (двойная защита)', () => {
  it('begin только для due-рынка: не истёкший сосед не затрагивается', async () => {
    const { discovery, recorder, gamma, clock, coordinator, finalizer } = createFinalizerHarness();
    armGamma(
      gamma,
      createFreshGammaMarket(),
      createFreshGammaEvent({ priceToBeat: 1, finalPrice: 2 }),
    );
    await coordinator.openMarket(
      discovery.addMarket({ conditionId: CID_A, expiresAtMs: Date.parse('2026-08-19T13:10:00.000Z') }),
    );
    await coordinator.openMarket(
      discovery.addMarket({ conditionId: CID_B, expiresAtMs: Date.parse('2026-08-19T20:00:00.000Z') }),
    );
    clock.advance(75 * 60_000);

    await finalizer.runOnce();

    expect(recorder.seals).toEqual([CID_A]);
    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
    expect(coordinator.getStats()).toMatchObject({ activeSessions: 1, finalizingSessions: 0 });
    // ACTIVE-сосед не может быть снят как «финализированный» (identity-guard)
    expect(coordinator.completeFinalization(mid(CID_B))).toBe(false);
  });
});
