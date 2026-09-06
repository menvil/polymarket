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
import type { CollectionHeaderFinalization } from '@polymarket/collector';
import {
  CID_A,
  CID_B,
  NOW_MS,
  armGamma,
  createFinalizerHarness,
  createFreshGammaEvent,
  createFreshGammaMarket,
  deferred,
  flushAsync,
  mid,
  openMarket,
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
    const harness = createFinalizerHarness();
    const { recorder, subscriptions, gamma, clock, lifecycle, finalizer } = harness;
    armGamma(gamma, createFreshGammaMarket(), createFreshGammaEvent());
    openMarket(harness);

    await finalizer.runOnce(); // clock < expiresAt
    expect(lifecycle.getStats()).toMatchObject({ activeSessions: 1, finalizingSessions: 0 });
    expect(recorder.seals).toEqual([]);
    expect(subscriptions.released).toEqual([]);

    clock.advance(EXPIRE_ADVANCE_MS);
    await finalizer.runOnce();

    expect(lifecycle.getStats()).toMatchObject({ activeSessions: 0 });
    expect(recorder.seals).toEqual([CID_A]);
    // Claim снимается ПОСЛЕ заморозки датасета, а не на истечении
    expect(subscriptions.released).toEqual([CID_A]);
    expect(harness.log.indexOf(`recorder.sealMarket:${CID_A}`)).toBeLessThan(
      harness.log.indexOf(`subscriptions.release:${CID_A}`),
    );
  });
});

describe('crypto enrichment (PART 27/30/53)', () => {
  it('partial → header pending без архива; full → complete header, EXPIRED, сессия снята', async () => {
    const harness = createFinalizerHarness();
const { recorder, gamma, clock, lifecycle, finalizer } = harness;
    // Попытка 1: только priceToBeat
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.995', noPrice: '0.005' }),
      createFreshGammaEvent({ priceToBeat: 78027.33965248794 }),
    );
    openMarket(harness);
    clock.advance(EXPIRE_ADVANCE_MS);

    await finalizer.runOnce();

    let finalization = lastFinalization(recorder);
    expect(finalization.status).toBe('pending');
    expect(finalization.crypto).toEqual({ priceToBeat: '78027.33965248794' });
    // До-резолюционные цены победителя НЕ дают
    expect(finalization.winning).toBeUndefined();
    expect(recorder.finalizations).toEqual([]);
    expect(lifecycle.getStats().finalizingSessions).toBe(1);

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
    expect(lifecycle.listSessions()).toEqual([]);
    expect(finalizer.getStats()).toMatchObject({
      pendingFinalizations: 0,
      archivedTotal: 1,
      archiveFailures: 0,
    });
  });

  it('cadence: повторный runOnce внутри enrichmentRetryMs НЕ делает второй Gamma-запрос', async () => {
    const harness = createFinalizerHarness();
const { gamma, clock, finalizer } = harness;
    armGamma(gamma, createFreshGammaMarket({ umaResolutionStatus: null }), createFreshGammaEvent());
    openMarket(harness);
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
    const harness = createFinalizerHarness();
const { recorder, gamma, clock, lifecycle, finalizer } = harness;
    gamma.failFetches = true;
    openMarket(harness);
    clock.advance(EXPIRE_ADVANCE_MS);

    await finalizer.runOnce();

    expect(recorder.metaUpdates).toEqual([]);
    expect(recorder.finalizations).toEqual([]);
    expect(lifecycle.getStats().finalizingSessions).toBe(1);
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
    const harness = createFinalizerHarness();
const { recorder, gamma, clock, lifecycle, finalizer } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.99', noPrice: '0.01' }),
      createFreshGammaEvent({ priceToBeat: 78027.33965248794 }), // finalPrice так и не появился
    );
    openMarket(harness);
    clock.advance(EXPIRE_ADVANCE_MS);
    await finalizer.runOnce(); // attempt 1 — pending

    clock.advance(15 * 60_000 + 1_000); // бюджет ожидания исчерпан
    await finalizer.runOnce();

    const finalization = lastFinalization(recorder);
    expect(finalization.status).toBe('timeout');
    expect(finalization.crypto).toEqual({ priceToBeat: '78027.33965248794' });
    expect(finalization.finalizedAtMs).toBeDefined();
    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
    expect(lifecycle.listSessions()).toEqual([]);
    expect(finalizer.getStats()).toMatchObject({ pendingFinalizations: 0, archivedTotal: 1 });
  });
});

describe('наблюдаемые отказы архива/header-а (PART 26/35/57/58)', () => {
  it('finalizeMarket(EXPIRED) бросает → отказ терминален, без success и без повторного gzip', async () => {
    const harness = createFinalizerHarness();
const { recorder, gamma, clock, lifecycle, finalizer, logger } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket(),
      createFreshGammaEvent({ priceToBeat: 1, finalPrice: 2 }),
    );
    openMarket(harness);
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
    expect(lifecycle.getStats().finalizingSessions).toBe(1);
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
    const harness = createFinalizerHarness();
const { recorder, gamma, clock, finalizer, logger } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket(),
      createFreshGammaEvent({ priceToBeat: 1, finalPrice: 2 }),
    );
    openMarket(harness);
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
    const harness = createFinalizerHarness();
const { recorder, gamma, clock, finalizer, logger } = harness;
    armGamma(gamma, createFreshGammaMarket({ umaResolutionStatus: null }), createFreshGammaEvent());
    openMarket(harness);
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
    const harness = createFinalizerHarness();
const { recorder, gamma, clock, finalizer } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket(),
      createFreshGammaEvent({ priceToBeat: 1, finalPrice: 2 }),
    );
    openMarket(harness);
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
    const harness = createFinalizerHarness();
const { recorder, gamma, clock, lifecycle, finalizer } = harness;
    // B истечёт и будет FINALIZING (incomplete); A останется ACTIVE
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.99', noPrice: '0.01' }),
      createFreshGammaEvent({ priceToBeat: 78027.1 }),
    );
    openMarket(harness, { conditionId: CID_B, expiresAtMs: Date.parse('2026-08-19T13:10:00.000Z') });
    openMarket(harness, { conditionId: CID_A, expiresAtMs: Date.parse('2026-08-19T20:00:00.000Z') });
    clock.advance(75 * 60_000); // B истёк, A ещё нет
    await finalizer.runOnce(); // B → FINALIZING, attempt 1 (pending)
    expect(lifecycle.getStats()).toMatchObject({ activeSessions: 1, finalizingSessions: 1 });
    const fetchesBeforeClose = gamma.fetchMarketCalls.length;

    await finalizer.close();

    // B заархивирован как timeout с best-known priceToBeat; НОВЫХ fetch-ей нет
    expect(gamma.fetchMarketCalls).toHaveLength(fetchesBeforeClose);
    expect(recorder.finalizations).toEqual([`${CID_B}:EXPIRED`]);
    const finalization = lastFinalization(recorder);
    expect(finalization.status).toBe('timeout');
    expect(finalization.crypto).toEqual({ priceToBeat: '78027.1' });
    // A НЕ архивирован finalizer-ом
    expect(lifecycle.getStats()).toMatchObject({ activeSessions: 1, finalizingSessions: 0 });

    // Дальше composition root: lifecycle.close() закрывает A как SHUTDOWN
    await lifecycle.close();
    expect(recorder.finalizations).toEqual([`${CID_B}:EXPIRED`, `${CID_A}:SHUTDOWN`]);

    // close идемпотентен; runOnce после close — no-op
    await finalizer.close();
    await finalizer.runOnce();
    expect(recorder.finalizations).toHaveLength(2);
  });
});

describe('non-crypto (PART 32/61)', () => {
  it('немедленный EXPIRED после best-effort снапшота — без 15-минутного ожидания', async () => {
    const harness = createFinalizerHarness();
const { recorder, gamma, clock, lifecycle, finalizer } = harness;
    armGamma(gamma, createFreshGammaMarket(), createFreshGammaEvent());
    openMarket(harness, { rtdsFeeds: [] }); // non-crypto
    clock.advance(EXPIRE_ADVANCE_MS);

    await finalizer.runOnce();

    const finalization = lastFinalization(recorder);
    expect(finalization.status).toBe('complete');
    expect(finalization.crypto).toBeUndefined(); // crypto-раздела нет
    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
    expect(lifecycle.listSessions()).toEqual([]);
  });

  it('отказ Gamma не держит non-crypto рынок: архив с initial-данными в тот же runOnce', async () => {
    const harness = createFinalizerHarness();
const { recorder, gamma, clock, finalizer } = harness;
    gamma.failFetches = true;
    openMarket(harness, { rtdsFeeds: [] });
    clock.advance(EXPIRE_ADVANCE_MS);

    await finalizer.runOnce();

    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
    expect(lastFinalization(recorder).status).toBe('complete');
  });
});

describe('header ОБОГАЩАЕТСЯ, а не пересобирается', () => {
  it('canonical V2 база сохранена, добавлены finalization и момент начала записи', async () => {
    const harness = createFinalizerHarness();
    const { recorder, gamma, clock, finalizer } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket(),
      createFreshGammaEvent({ priceToBeat: 78027.1, finalPrice: 78325.2 }),
    );
    const selected = openMarket(harness);
    const baseHeader = recorder.sessions.get(CID_A)!.marketMeta.rawMarket!;
    clock.advance(EXPIRE_ADVANCE_MS);

    await finalizer.runOnce();

    const header = recorder.lastHeader()!;
    // Дискриминатор версии остаётся V2 — legacy headerVersion 1 не возвращается
    expect(header['headerVersion']).toBe(2);
    expect(header['conditionId']).toBe(CID_A);
    expect(header['family']).toBe(baseHeader['family']);
    expect(header['outcomes']).toEqual(baseHeader['outcomes']);
    // Vendor-снапшоты Gamma в canonical header не протекают
    expect(header['gammaMarket']).toBeUndefined();
    expect(header['gammaEvent']).toBeUndefined();
    // timing дополнен моментом начала записи, границы рынка не переписаны
    expect(header['timing']).toEqual({
      startsAt: selected.eventStartsAt.toNumber(),
      expiresAt: selected.expiresAt.toNumber(),
      recordingStartsAt: NOW_MS,
    });
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
    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
  });
});

describe('изоляция отказов внутри прохода (review round 1)', () => {
  it('отказ seal одного рынка наблюдаем и НЕ оставляет его в вечном FINALIZING', async () => {
    // Раньше отказ seal пробрасывался из beginFinalization: рынок оставался
    // помеченным FINALIZING, но НЕ попадал в pending — и не архивировался
    // уже никогда. Заморозка датасета живёт в собственной cutoff-задаче,
    // поэтому отказ storage теперь виден в логе и не отменяет финализацию.
    const harness = createFinalizerHarness();
const { recorder, gamma, clock, lifecycle, finalizer, logger } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket(),
      createFreshGammaEvent({ priceToBeat: 1, finalPrice: 2 }),
    );
    // Оба рынка истекут одновременно; seal рынка A падает (storage-throw)
    openMarket(harness, { conditionId: CID_A });
    openMarket(harness, { conditionId: CID_B });
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
    expect(lifecycle.listSessions()).toEqual([]);
  });
});

describe('идентичность рынков (двойная защита)', () => {
  it('begin только для due-рынка: не истёкший сосед не затрагивается', async () => {
    const harness = createFinalizerHarness();
const { recorder, gamma, clock, lifecycle, finalizer } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket(),
      createFreshGammaEvent({ priceToBeat: 1, finalPrice: 2 }),
    );
    openMarket(harness, { conditionId: CID_A, expiresAtMs: Date.parse('2026-08-19T13:10:00.000Z') });
    openMarket(harness, { conditionId: CID_B, expiresAtMs: Date.parse('2026-08-19T20:00:00.000Z') });
    clock.advance(75 * 60_000);

    await finalizer.runOnce();

    expect(recorder.seals).toEqual([CID_A]);
    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
    expect(lifecycle.getStats()).toMatchObject({ activeSessions: 1, finalizingSessions: 0 });
    // ACTIVE-сосед не может быть снят как «финализированный» (identity-guard)
    expect(lifecycle.completeFinalization(mid(CID_B))).toBe(false);
  });
});

describe('winner-ladder: происхождение победителя (решение user 2026-08-25)', () => {
  it("complete без UMA-резолюции: победитель по официальным ценам, source='official-prices'", async () => {
    const harness = createFinalizerHarness();
const { recorder, gamma, clock, finalizer } = harness;
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
    openMarket(harness);
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
      const harness = createFinalizerHarness();
const { recorder, gamma, clock, finalizer } = harness;
      armGamma(
        gamma,
        createFreshGammaMarket({ closed: false, umaResolutionStatus: null }),
        createFreshGammaEvent({ priceToBeat: 78027.33965248794, finalPrice }),
      );
      openMarket(harness);
      clock.advance(EXPIRE_ADVANCE_MS);

      await finalizer.runOnce();

      const finalization = lastFinalization(recorder);
      expect(finalization.winning).toMatchObject({ label: expected, source: 'official-prices' });
    }
  });

  it("timeout без официальных данных: приблизительный победитель из записанного ряда, exact=false", async () => {
    const harness = createFinalizerHarness();
const { recorder, gamma, clock, finalizer } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.6', noPrice: '0.4' }),
      createFreshGammaEvent(), // ни priceToBeat, ни finalPrice
    );
    openMarket(harness);
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
    const harness = createFinalizerHarness();
const { recorder, gamma, clock, finalizer } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.6', noPrice: '0.4' }),
      createFreshGammaEvent(),
    );
    openMarket(harness);
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
    const harness = createFinalizerHarness({
      drainPollMs: 1,
    });
const { recorder, gamma, clock, finalizer } = harness;
    // До попытки №3 Gamma отдаёт незавершённые данные (нет finalPrice)
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null }),
      createFreshGammaEvent({ priceToBeat: 78027.33 }),
    );
    openMarket(harness);
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
    const harness = createFinalizerHarness({
      drainPollMs: 1,
      enrichmentMaxWaitMs: 90_000,
    });
const { recorder, gamma, clock, finalizer } = harness;
    // Официальная резолюция так и не приходит
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null }),
      createFreshGammaEvent(),
    );
    openMarket(harness);
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
    const harness = createFinalizerHarness({
      drainPollMs: 60_000, // без прерывания тест бы завис на реальном таймере
    });
const { recorder, gamma, clock, finalizer } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null }),
      createFreshGammaEvent({ priceToBeat: 78027.33 }),
    );
    openMarket(harness);
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
    const harness = createFinalizerHarness({ drainPollMs: 60_000 });
const { finalizer } = harness;
    await finalizer.drain(); // нет ни ACTIVE, ни pending — мгновенно

    await finalizer.close();
    await finalizer.drain(); // closed-guard — мгновенно
    expect(finalizer.isClosed).toBe(true);
  });
});

// ── Подхват FINALIZING независимо от инициатора перехода ────────────────────

describe('FINALIZING-сессия попадает в финализатор, кто бы ни совершил переход', () => {
  it('A. переход сделал lifecycle (точный таймер сессии) → финализатор подхватывает и архивирует', async () => {
    const harness = createFinalizerHarness();
    const { recorder, subscriptions, gamma, clock, lifecycle, finalizer } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket(),
      createFreshGammaEvent({ priceToBeat: 78027.1, finalPrice: 78325.2 }),
    );
    openMarket(harness);
    clock.advance(EXPIRE_ADVANCE_MS);

    // Ровно то, что делает таймер сессии: переход БЕЗ участия финализатора.
    const transitioned = await lifecycle.beginFinalization(mid(CID_A));
    expect(transitioned).toBeDefined();
    await lifecycle.awaitSettlementCapture(mid(CID_A));
    // Граница уже отработала: датасет заморожен, claim снят.
    expect(recorder.seals).toEqual([CID_A]);
    expect(subscriptions.released).toEqual([CID_A]);
    expect(finalizer.getStats().pendingFinalizations).toBe(0);

    await finalizer.runOnce();

    // Раньше здесь рынок молча оставался FINALIZING навсегда: Gamma-опрос не
    // начинался, header не финализировался, архив не создавался.
    expect(gamma.fetchMarketCalls).toHaveLength(1);
    expect(lastFinalization(recorder).status).toBe('complete');
    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
    expect(lifecycle.listSessions()).toEqual([]);
    expect(finalizer.getStats()).toMatchObject({
      pendingFinalizations: 0,
      archivedTotal: 1,
      officialFinalizations: 1,
    });
  });

  it('A2. переход сделан ДО истечения бюджета — startedAtMs остаётся моментом ГРАНИЦЫ', async () => {
    const harness = createFinalizerHarness();
    const { recorder, gamma, clock, lifecycle, finalizer } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket(),
      createFreshGammaEvent({ priceToBeat: 78027.1, finalPrice: 78325.2 }),
    );
    openMarket(harness);
    clock.advance(EXPIRE_ADVANCE_MS);
    const boundaryMs = clock.now().getTime();

    await lifecycle.beginFinalization(mid(CID_A));
    // Финализатор подхватывает НЕ сразу — через control-тик.
    clock.advance(7_000);
    await finalizer.runOnce();

    // Момент подхвата в header не попадает: иначе `startedAtMs` архива и
    // отсчёт бюджета ожидания сдвигались бы на задержку control-тика.
    expect(lastFinalization(recorder).startedAtMs).toBe(boundaryMs);
  });

  it('B. переход сделал lifecycle.runOnce() ДО прохода финализатора', async () => {
    const harness = createFinalizerHarness();
    const { recorder, gamma, clock, lifecycle, finalizer } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket(),
      createFreshGammaEvent({ priceToBeat: 78027.1, finalPrice: 78325.2 }),
    );
    openMarket(harness);
    clock.advance(EXPIRE_ADVANCE_MS);

    // Порядок production-тика: lifecycle.runOnce() → finalizer.runOnce().
    await lifecycle.runOnce();
    expect(lifecycle.listSessions()[0]?.state).toBe('FINALIZING');

    await finalizer.runOnce();

    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
    expect(lifecycle.listSessions()).toEqual([]);
  });

  it('C. повторный проход не создаёт второй pending и не дублирует begin/finalize', async () => {
    const harness = createFinalizerHarness();
    const { recorder, gamma, clock, lifecycle, finalizer } = harness;
    // Резолюции ещё нет — рынок остаётся pending между проходами.
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.5', noPrice: '0.5' }),
      createFreshGammaEvent(),
    );
    openMarket(harness);
    clock.advance(EXPIRE_ADVANCE_MS);
    await lifecycle.beginFinalization(mid(CID_A));

    await finalizer.runOnce();
    await finalizer.runOnce(); // тот же тик — cadence не наступил
    clock.advance(30_000);
    await finalizer.runOnce();

    expect(finalizer.getStats().pendingFinalizations).toBe(1);
    // Переход выполнен РОВНО один раз, архив не создавался.
    expect(recorder.narrowings).toHaveLength(1);
    expect(recorder.seals).toEqual([CID_A]);
    expect(recorder.finalizations).toEqual([]);
    // Ровно две Gamma-попытки: третий проход попал в cadence второго.
    expect(gamma.fetchMarketCalls).toHaveLength(2);
  });

  it('рынок, который ещё торгуется, не подхватывается и не переводится', async () => {
    const harness = createFinalizerHarness();
    const { recorder, gamma, lifecycle, finalizer } = harness;
    armGamma(gamma, createFreshGammaMarket(), createFreshGammaEvent());
    openMarket(harness); // истекает через 70 минут

    await finalizer.runOnce();

    expect(finalizer.getStats().pendingFinalizations).toBe(0);
    expect(recorder.seals).toEqual([]);
    expect(lifecycle.listSessions()[0]?.state).toBe('ACTIVE');
  });
});

// ── Граница датасета ПЕРЕД Gamma polling ────────────────────────────────────

describe('Gamma polling не начинается, пока датасет не заморожен', () => {
  it('пока settlement capture не завершён: ни одного Gamma-запроса и ни одного header update', async () => {
    const harness = createFinalizerHarness();
    const { recorder, subscriptions, gamma, clock, lifecycle, finalizer } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket(),
      createFreshGammaEvent({ priceToBeat: 78027.1, finalPrice: 78325.2 }),
    );
    openMarket(harness);
    clock.advance(EXPIRE_ADVANCE_MS);

    // Граница ИДЁТ: seal удерживается, значит grace/seal/release не завершены.
    const boundary = deferred();
    recorder.sealHold = boundary.promise;
    await lifecycle.beginFinalization(mid(CID_A));

    const pass = finalizer.runOnce();
    await flushAsync();

    // Инвариант: ни один Gamma-запрос не влияет на поток сырых наблюдений —
    // сеть не трогается, пока датасет ещё принимает граничный TWAP.
    expect(gamma.fetchMarketCalls).toEqual([]);
    expect(gamma.fetchEventCalls).toEqual([]);
    expect(recorder.metaUpdates).toEqual([]);
    expect(recorder.seals).toEqual([]);
    expect(subscriptions.released).toEqual([]);

    // Граница завершилась: датасет заморожен, claim снят.
    boundary.resolve();
    recorder.sealHold = undefined;
    await pass;

    expect(recorder.seals).toEqual([CID_A]);
    expect(subscriptions.released).toEqual([CID_A]);
    // Порядок доказан журналом: seal и release ПРЕДШЕСТВУЮТ header update.
    expect(harness.log.indexOf(`recorder.sealMarket:${CID_A}`)).toBeLessThan(
      harness.log.indexOf(`recorder.updateMarketMeta:${CID_A}`),
    );
    expect(harness.log.indexOf(`subscriptions.release:${CID_A}`)).toBeLessThan(
      harness.log.indexOf(`recorder.updateMarketMeta:${CID_A}`),
    );
    expect(gamma.fetchMarketCalls).toHaveLength(1);
    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
  });

  it('промежуточный pending-header тоже ждёт границы (частичные данные Gamma)', async () => {
    const harness = createFinalizerHarness();
    const { recorder, gamma, clock, lifecycle, finalizer } = harness;
    // Резолюции нет — проход закончится pending-header-ом, а не архивом.
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.5', noPrice: '0.5' }),
      createFreshGammaEvent({ priceToBeat: 78027.1 }),
    );
    openMarket(harness);
    clock.advance(EXPIRE_ADVANCE_MS);

    const boundary = deferred();
    recorder.sealHold = boundary.promise;
    await lifecycle.beginFinalization(mid(CID_A));

    const pass = finalizer.runOnce();
    await flushAsync();
    expect(recorder.metaUpdates).toEqual([]);

    boundary.resolve();
    recorder.sealHold = undefined;
    await pass;

    expect(lastFinalization(recorder).status).toBe('pending');
    expect(harness.log.indexOf(`recorder.sealMarket:${CID_A}`)).toBeLessThan(
      harness.log.indexOf(`recorder.updateMarketMeta:${CID_A}`),
    );
  });
});
