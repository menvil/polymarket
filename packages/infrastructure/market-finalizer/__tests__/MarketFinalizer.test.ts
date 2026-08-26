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
  NOW_MS,
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
    expect(finalization.winning).toEqual({
      label: 'Up',
      instrumentId: '111',
      outcomeIndex: 0,
      source: 'resolution',
      exact: true,
    });
    // Vendor yes/no не протекает в finalization-сводку
    expect(JSON.stringify(finalization)).not.toContain('"yes"');
    expect(JSON.stringify(finalization)).not.toContain('"no"');

    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
    expect(coordinator.listSessions()).toEqual([]);
    expect(finalizer.getStats()).toMatchObject({
      pendingFinalizations: 0,
      archivedTotal: 1,
      archiveFailures: 0,
    });
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
    // Pending entry НЕ исчез как successful completion
    expect(finalizer.getStats()).toMatchObject({
      pendingFinalizations: 1,
      archivedTotal: 0,
      archiveFailures: 1,
    });
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

  it('на терминальном пути неудачный header НЕ даёт архива (MR-B PART 51)', async () => {
    // Прежняя policy архивировала best-known предыдущий header. Это создавало
    // ровно тот артефакт, который MR-B запрещает: `.gz`, содержимое которого
    // не соответствует принятому решению о резолюции.
    const { discovery, recorder, gamma, clock, coordinator, finalizer, logger } =
      createFinalizerHarness();
    armGamma(gamma, createFreshGammaMarket({ umaResolutionStatus: null }), createFreshGammaEvent());
    await coordinator.openMarket(discovery.addMarket());
    recorder.metaUpdateResult = false;
    clock.advance(EXPIRE_ADVANCE_MS);
    await finalizer.runOnce(); // begin + attempt 1 (pending, header не записался)

    clock.advance(15 * 60_000 + 1_000); // бюджет ожидания исчерпан
    await finalizer.runOnce();

    expect(recorder.finalizations).toEqual([]); // завершённого архива НЕТ
    expect(
      logger
        .byLevel('error')
        .some((e) => e.message.includes('no archive created')),
    ).toBe(true);
    expect(finalizer.getStats()).toMatchObject({ archiveFailures: 1 });
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
    expect(finalization.winning).toEqual({
      label: 'Up',
      instrumentId: '111',
      outcomeIndex: 0,
      source: 'resolution',
      exact: true,
    });
    expect(header['conditionId']).toBe(CID_A);
    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
  });
});

describe('изоляция отказов внутри прохода (review round 1)', () => {
  it('отказ seal одного рынка наблюдаем и НЕ оставляет его в вечном FINALIZING', async () => {
    // Раньше отказ seal пробрасывался из beginFinalization: рынок оставался
    // помеченным FINALIZING, но НЕ попадал в pending — и не архивировался
    // уже никогда. Заморозка датасета живёт в собственной cutoff-задаче,
    // поэтому отказ storage теперь виден в логе и не отменяет финализацию.
    const { discovery, recorder, gamma, clock, coordinator, finalizer, logger } =
      createFinalizerHarness();
    armGamma(
      gamma,
      createFreshGammaMarket(),
      createFreshGammaEvent({ priceToBeat: 1, finalPrice: 2 }),
    );
    // Оба рынка истекут одновременно; seal рынка A падает (storage-throw)
    await coordinator.openMarket(discovery.addMarket({ conditionId: CID_A }));
    await coordinator.openMarket(discovery.addMarket({ conditionId: CID_B }));
    recorder.sealErrorForMarketId = CID_A;
    clock.advance(EXPIRE_ADVANCE_MS);

    await expect(finalizer.runOnce()).resolves.toBeUndefined(); // проход не reject-ится

    expect(
      logger.byLevel('error').some((e) => e.message.includes('Settlement cutoff failed')),
    ).toBe(true);
    // ОБА рынка дошли до архива: сосед не пострадал, а отказавший не завис
    expect(recorder.finalizations.sort()).toEqual(
      [`${CID_A}:EXPIRED`, `${CID_B}:EXPIRED`].sort(),
    );
    expect(finalizer.getStats()).toMatchObject({ archivedTotal: 2 });
    expect(coordinator.listSessions()).toEqual([]);
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

describe('winner-ladder: происхождение победителя (решение user 2026-08-25)', () => {
  it("complete без UMA-резолюции: победитель по официальным ценам, source='official-prices'", async () => {
    const { discovery, recorder, gamma, clock, coordinator, finalizer } = createFinalizerHarness();
    // Обе официальные цены есть, UMA ещё НЕ resolved (live-кейс 10:30-рынков)
    armGamma(
      gamma,
      createFreshGammaMarket({
        closed: false,
        umaResolutionStatus: null,
        yesPrice: '0.995',
        noPrice: '0.005',
      }),
      createFreshGammaEvent({ priceToBeat: 79233.50451521577, finalPrice: 79237.63456493833 }),
    );
    await coordinator.openMarket(discovery.addMarket());
    clock.advance(EXPIRE_ADVANCE_MS);

    await finalizer.runOnce();

    const finalization = lastFinalization(recorder);
    expect(finalization.status).toBe('complete');
    expect(finalization.winning).toEqual({
      label: 'Up',
      instrumentId: '111',
      outcomeIndex: 0,
      source: 'official-prices',
      exact: true,
    });
    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
    // Файл датасета НЕ читался: официальных цен достаточно
    expect(recorder.sealedReads).toEqual([]);
  });

  it('official-prices: finalPrice < priceToBeat → Down; равенство (tie) → Up', async () => {
    for (const [finalPrice, expected] of [
      [78026.99, 'Down'],
      [78027.33965248794, 'Up'], // правило description: greater than OR EQUAL → Up
    ] as const) {
      const { discovery, recorder, gamma, clock, coordinator, finalizer } =
        createFinalizerHarness();
      armGamma(
        gamma,
        createFreshGammaMarket({ closed: false, umaResolutionStatus: null }),
        createFreshGammaEvent({ priceToBeat: 78027.33965248794, finalPrice }),
      );
      await coordinator.openMarket(discovery.addMarket());
      clock.advance(EXPIRE_ADVANCE_MS);

      await finalizer.runOnce();

      const finalization = lastFinalization(recorder);
      expect(finalization.winning).toMatchObject({ label: expected, source: 'official-prices' });
    }
  });

  it("timeout без официальных данных: приблизительный победитель из записанного ряда, exact=false", async () => {
    const { discovery, recorder, gamma, clock, coordinator, finalizer } = createFinalizerHarness();
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.6', noPrice: '0.4' }),
      createFreshGammaEvent(), // ни priceToBeat, ни finalPrice
    );
    await coordinator.openMarket(discovery.addMarket());
    // Тайминг окна фикстуры: eventStartsAt = NOW+10м, expiresAt = NOW+70м
    const startMs = NOW_MS + 10 * 60_000;
    const expiryMs = NOW_MS + 70 * 60_000;
    const chainlinkLine = (tsMs: number, value: string): string =>
      JSON.stringify({
        topic: 'prices.crypto.chainlink',
        type: 'update',
        timestamp: tsMs + 700,
        payload: { symbol: 'btc/usd', timestamp: tsMs, value },
      });
    clock.advance(EXPIRE_ADVANCE_MS);
    await finalizer.runOnce(); // attempt 1 → pending (данных нет)

    // Записанный ряд: старт 79000.5 → последние 60s среднее выше старта → Up
    recorder.sealedPayloadLines = [
      chainlinkLine(startMs + 500, '79000.5'),
      chainlinkLine(expiryMs - 45_000, '79020.1'),
      chainlinkLine(expiryMs - 30_000, '79030.3'),
      chainlinkLine(expiryMs - 15_000, '79040.5'),
      JSON.stringify({ topic: 'market', type: 'book', payload: { market: CID_A } }), // чужая строка — отфильтруется
    ];

    clock.advance(15 * 60_000 + 1_000); // бюджет исчерпан → timeout-архив
    await finalizer.runOnce();

    const finalization = lastFinalization(recorder);
    expect(finalization.status).toBe('timeout');
    expect(finalization.winning).toMatchObject({
      label: 'Up',
      instrumentId: '111',
      source: 'recorded-rtds',
      exact: false,
    });
    expect(finalization.winning?.basis?.startValue).toBe('79000.5');
    expect(finalization.winning?.basis?.endValue).toBe('79030.3'); // среднее трёх последних
    expect(recorder.sealedReads).toEqual([CID_A]);
    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
  });

  it('timeout: датасет не читается → архив без победителя (best-effort, не ошибка)', async () => {
    const { discovery, recorder, gamma, clock, coordinator, finalizer } = createFinalizerHarness();
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.6', noPrice: '0.4' }),
      createFreshGammaEvent(),
    );
    await coordinator.openMarket(discovery.addMarket());
    recorder.sealedPayloadLines = undefined; // read-путь отказал
    clock.advance(EXPIRE_ADVANCE_MS);
    await finalizer.runOnce();
    clock.advance(15 * 60_000 + 1_000);
    await finalizer.runOnce();

    const finalization = lastFinalization(recorder);
    expect(finalization.status).toBe('timeout');
    expect(finalization.winning).toBeUndefined();
    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
  });
});

describe('drain — graceful wind-down (решение user 2026-08-25)', () => {
  /**
   * Оборачивает fetchMarket fake-Gamma: каждый вызов продвигает часы на
   * enrichmentRetryMs (следующий drain-проход снова due), опционально
   * «доносит» полные данные на заданной попытке.
   */
  function advanceClockPerFetch(
    gamma: { fetchMarket: unknown; markets: Map<string, unknown>; events: Map<string, unknown> },
    clock: { advance(ms: number): void },
    options: { completeOnCall?: number } = {},
  ): void {
    const base = gamma.fetchMarket as (request: { id?: string }) => Promise<unknown>;
    let calls = 0;
    gamma.fetchMarket = (async (request: { id?: string }) => {
      calls++;
      clock.advance(30_000);
      if (options.completeOnCall !== undefined && calls === options.completeOnCall) {
        armGamma(
          gamma as never,
          createFreshGammaMarket(),
          createFreshGammaEvent({ priceToBeat: 78027.33, finalPrice: 78325.45 }),
        );
      }
      return base(request);
    }) as never;
  }

  it('drain дожидается официальной резолюции и архивирует complete', async () => {
    const { discovery, recorder, gamma, clock, coordinator, finalizer } = createFinalizerHarness({
      drainPollMs: 1,
    });
    // До попытки №3 Gamma отдаёт незавершённые данные (нет finalPrice)
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null }),
      createFreshGammaEvent({ priceToBeat: 78027.33 }),
    );
    await coordinator.openMarket(discovery.addMarket());
    clock.advance(EXPIRE_ADVANCE_MS);
    advanceClockPerFetch(gamma, clock, { completeOnCall: 3 });

    // Конкурентные drain разделяют одно ожидание (двойных попыток нет)
    await Promise.all([finalizer.drain(), finalizer.drain()]);

    expect(gamma.fetchMarketCalls).toHaveLength(3);
    const finalization = lastFinalization(recorder);
    expect(finalization.status).toBe('complete');
    expect(finalization.attempts).toBe(3);
    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
    expect(finalizer.getStats()).toMatchObject({
      pendingFinalizations: 0,
      archivedTotal: 1,
      archiveFailures: 0,
    });
    expect(finalizer.isClosed).toBe(false); // drain НЕ закрывает finalizer
  });

  it('drain доводит рынок до timeout-архива по ПОЛНОМУ бюджету, а не бросает раньше', async () => {
    const { discovery, recorder, gamma, clock, coordinator, finalizer } = createFinalizerHarness({
      drainPollMs: 1,
      enrichmentMaxWaitMs: 90_000,
    });
    // Официальная резолюция так и не приходит
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null }),
      createFreshGammaEvent(),
    );
    await coordinator.openMarket(discovery.addMarket());
    clock.advance(EXPIRE_ADVANCE_MS);
    advanceClockPerFetch(gamma, clock);

    await finalizer.drain();

    // Попытки шли cadence-ом 30s до исчерпания 90s-бюджета, затем timeout
    const finalization = lastFinalization(recorder);
    expect(finalization.status).toBe('timeout');
    expect(finalization.attempts).toBe(4);
    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
    expect(finalizer.getStats()).toMatchObject({ pendingFinalizations: 0, archivedTotal: 1 });
  });

  it('close() прерывает спящий drain немедленно (аварийный best-known путь)', async () => {
    const { discovery, recorder, gamma, clock, coordinator, finalizer } = createFinalizerHarness({
      drainPollMs: 60_000, // без прерывания тест бы завис на реальном таймере
    });
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null }),
      createFreshGammaEvent({ priceToBeat: 78027.33 }),
    );
    await coordinator.openMarket(discovery.addMarket());
    clock.advance(EXPIRE_ADVANCE_MS);
    await finalizer.runOnce(); // попытка 1 → pending, часы заморожены

    const drainPromise = finalizer.drain(); // проход без due-попытки → сон 60s
    await new Promise((resolve) => setTimeout(resolve, 20));
    await finalizer.close();
    await drainPromise; // разрешается пробуждением, НЕ по таймеру

    expect(finalizer.isClosed).toBe(true);
    const finalization = lastFinalization(recorder);
    expect(finalization.status).toBe('timeout'); // best-known аварийного close()
    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
  });

  it('drain без pending возвращается сразу; после close() — no-op', async () => {
    const { finalizer } = createFinalizerHarness({ drainPollMs: 60_000 });
    await finalizer.drain(); // нет ни ACTIVE, ни pending — мгновенно

    await finalizer.close();
    await finalizer.drain(); // closed-guard — мгновенно
    expect(finalizer.isClosed).toBe(true);
  });
});
