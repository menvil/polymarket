/**
 * Resolution policy MR-B: official → fallback → discard.
 *
 * @remarks
 * Проверяется главный инвариант MR-B: завершённый архив поддержанного
 * крипто-рынка ВСЕГДА несёт известного победителя с machine-usable
 * identity и происхождением. Датасет, итог которого вывести нельзя,
 * удаляется — `.gz` без победителя не создаётся ни на одном пути.
 *
 * Часы инъецированы, бюджет ожидания в тестах маленький: 60-минутная ветка
 * проверяется управляемым временем, а не реальным часом.
 */
import { describe, it, expect } from '@jest/globals';
import type { CollectionHeaderFinalization } from '@polymarket/collection-coordinator';
import {
  BTC_TWAP_FEEDS,
  BTC_TWAP_SETTLEMENT,
  CID_A,
  TOKEN_DOWN,
  TOKEN_UP,
  armGamma,
  createFinalizerHarness,
  createFreshGammaEvent,
  createFreshGammaMarket,
  mid,
} from './helpers/fakes.js';

/** Продвигает фикстурный рынок (истекает через 70 мин) за expiry. */
const EXPIRE_ADVANCE_MS = 70 * 60_000 + 1_000;
/** Бюджет ожидания официальной резолюции в тестах. */
const MAX_WAIT_MS = 15 * 60_000;

/** Окно фикстурного рынка: старт через 10 мин, истечение через 70 мин. */
const MARKET_START_MS = Date.parse('2026-08-19T12:10:00.000Z');
const MARKET_END_MS = Date.parse('2026-08-19T13:10:00.000Z');

function lastFinalization(recorder: {
  lastHeader(): Record<string, unknown> | undefined;
}): CollectionHeaderFinalization {
  const header = recorder.lastHeader();
  expect(header).toBeDefined();
  return header!['finalization'] as CollectionHeaderFinalization;
}

/** Строка записанного settlement-наблюдения (payload-only, как на диске). */
function twapLine(
  timestampMs: number,
  value: string,
  windowSeconds: 30 | 60 = 60,
): string {
  return JSON.stringify({
    topic: 'prices.crypto.chainlink.twap',
    type: 'update',
    timestamp: timestampMs + 1_895,
    payload: { symbol: 'btc/usd', timestamp: timestampMs, value, windowSeconds },
  });
}

/** Ряд, покрывающий обе границы рынка: закрытие ВЫШЕ открытия → Up. */
function upSeries(): string[] {
  return [
    twapLine(MARKET_START_MS - 1_000, '78440.0'),
    twapLine(MARKET_START_MS, '78449.05813530705395712'),
    twapLine(MARKET_END_MS - 1_000, '78500.0'),
    twapLine(MARKET_END_MS, '78501.123456789012345678'),
    twapLine(MARKET_END_MS + 1_000, '78501.123456789012345678'),
  ];
}

/** Ряд, где закрытие НИЖЕ открытия → Down. */
function downSeries(): string[] {
  return [
    twapLine(MARKET_START_MS, '78449.05813530705395712'),
    twapLine(MARKET_END_MS, '78400.701754893592952832'),
  ];
}

/** Открывает TWAP-рынок и доводит его до FINALIZING. */
async function openExpiredTwapMarket(
  harness: ReturnType<typeof createFinalizerHarness>,
  overrides: { tokenIds?: readonly string[] } = {},
): Promise<void> {
  const { discovery, clock, coordinator, finalizer } = harness;
  await coordinator.openMarket(
    discovery.addMarket({
      rtdsFeeds: BTC_TWAP_FEEDS,
      settlement: BTC_TWAP_SETTLEMENT,
      ...(overrides.tokenIds !== undefined ? { tokenIds: overrides.tokenIds } : {}),
    }),
  );
  clock.advance(EXPIRE_ADVANCE_MS);
  await finalizer.runOnce(); // begin + первая попытка
}

describe('OFFICIAL COMPLETE имеет приоритет (PART 7/44/64)', () => {
  it('официальная резолюция архивирует НЕМЕДЛЕННО, не дожидаясь finalPrice', async () => {
    // Live-наблюдение 2026-08-26: uma=resolved и цены 1/0 приходят раньше
    // finalPrice. Прежнее условие «оба числа» держало бы рынок весь бюджет.
    const harness = createFinalizerHarness({ enrichmentMaxWaitMs: MAX_WAIT_MS });
    const { recorder, gamma, coordinator, finalizer } = harness;
    armGamma(gamma, createFreshGammaMarket(), createFreshGammaEvent({ priceToBeat: 78449.05 }));

    await openExpiredTwapMarket(harness);

    const finalization = lastFinalization(recorder);
    expect(finalization.status).toBe('complete');
    expect(finalization.winning).toMatchObject({ label: 'Up', source: 'resolution', exact: true });
    expect(finalization.provenance?.resolution).toBe('official');
    expect(finalization.provenance?.fallbackTrigger).toBeUndefined();
    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
    expect(coordinator.listSessions()).toEqual([]);
    expect(finalizer.getStats()).toMatchObject({
      officialFinalizations: 1,
      fallbackFinalizations: 0,
      discardedUnresolvable: 0,
    });
  });

  it('официальный итог НЕ перезаписывается fallback-ом, даже когда ряд записан', async () => {
    const harness = createFinalizerHarness({ enrichmentMaxWaitMs: MAX_WAIT_MS });
    const { recorder, gamma } = harness;
    // Gamma говорит Up (resolved 1/0), а записанный ряд дал бы Down
    armGamma(gamma, createFreshGammaMarket(), createFreshGammaEvent());
    recorder.sealedPayloadLines = downSeries();

    await openExpiredTwapMarket(harness);

    const finalization = lastFinalization(recorder);
    expect(finalization.winning).toMatchObject({ label: 'Up', source: 'resolution' });
    expect(finalization.provenance?.resolution).toBe('official');
    expect(recorder.sealedReads).toEqual([]); // датасет даже не читался
  });

  it('официальные priceToBeat/finalPrice дают победителя без UMA-резолюции', async () => {
    const harness = createFinalizerHarness({ enrichmentMaxWaitMs: MAX_WAIT_MS });
    const { recorder, gamma } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.6', noPrice: '0.4' }),
      createFreshGammaEvent({ priceToBeat: 78027.3, finalPrice: 78325.4 }),
    );

    await openExpiredTwapMarket(harness);

    const finalization = lastFinalization(recorder);
    expect(finalization.winning).toMatchObject({ label: 'Up', source: 'official-prices' });
    expect(finalization.provenance).toMatchObject({
      resolution: 'official',
      priceToBeat: 'official',
      finalPrice: 'official',
    });
  });

  it('официальный архив без finalPrice помечает происхождение чисел честно', async () => {
    const harness = createFinalizerHarness({ enrichmentMaxWaitMs: MAX_WAIT_MS });
    const { recorder, gamma } = harness;
    armGamma(gamma, createFreshGammaMarket(), createFreshGammaEvent({ priceToBeat: 78449.05 }));

    await openExpiredTwapMarket(harness);

    const finalization = lastFinalization(recorder);
    expect(finalization.provenance?.priceToBeat).toBe('official');
    expect(finalization.provenance?.finalPrice).toBeUndefined(); // числа нет — и вида нет
    expect(finalization.crypto).toEqual({ priceToBeat: '78449.05' });
  });
});

describe('FALLBACK по исчерпанию бюджета (PART 46/65)', () => {
  it('таймаут + пригодный ряд → complete с provenance fallback/official-timeout', async () => {
    const harness = createFinalizerHarness({ enrichmentMaxWaitMs: MAX_WAIT_MS });
    const { recorder, gamma, clock, coordinator, finalizer } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.5', noPrice: '0.5' }),
      createFreshGammaEvent(), // Gamma так и не дал ничего
    );
    recorder.sealedPayloadLines = upSeries();

    await openExpiredTwapMarket(harness);
    expect(recorder.finalizations).toEqual([]); // ещё ждём официальную резолюцию

    clock.advance(MAX_WAIT_MS + 1_000);
    await finalizer.runOnce();

    const finalization = lastFinalization(recorder);
    expect(finalization.status).toBe('complete'); // таймаут — ТРИГГЕР, не итог
    expect(finalization.winning).toMatchObject({
      label: 'Up',
      instrumentId: TOKEN_UP,
      outcomeIndex: 0,
      source: 'recorded-twap',
      exact: true,
    });
    expect(finalization.provenance).toMatchObject({
      resolution: 'fallback-chainlink-twap',
      fallbackTrigger: 'official-timeout',
      priceToBeat: 'derived',
      finalPrice: 'derived',
    });
    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
    expect(coordinator.listSessions()).toEqual([]);
    expect(finalizer.getStats()).toMatchObject({
      fallbackFinalizations: 1,
      fallbackByTimeout: 1,
      fallbackByShutdown: 0,
      officialFinalizations: 0,
    });
  });

  it('evidence позволяет ВОСПРОИЗВЕСТИ решение по архиву (PART 43)', async () => {
    const harness = createFinalizerHarness({ enrichmentMaxWaitMs: MAX_WAIT_MS });
    const { recorder, gamma, clock, finalizer } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.5', noPrice: '0.5' }),
      createFreshGammaEvent(),
    );
    recorder.sealedPayloadLines = upSeries();

    await openExpiredTwapMarket(harness);
    clock.advance(MAX_WAIT_MS + 1_000);
    await finalizer.runOnce();

    expect(lastFinalization(recorder).provenance?.evidence).toEqual({
      symbol: 'btc/usd',
      windowSeconds: 60,
      priceToBeatValue: '78449.05813530705395712',
      priceToBeatTimestampMs: MARKET_START_MS,
      finalPriceValue: '78501.123456789012345678',
      finalPriceTimestampMs: MARKET_END_MS,
      marketStartMs: MARKET_START_MS,
      marketEndMs: MARKET_END_MS,
      observations: 5,
    });
  });

  it('официальный priceToBeat остаётся официальным, finalPrice — derived (PART 31/41)', async () => {
    const harness = createFinalizerHarness({ enrichmentMaxWaitMs: MAX_WAIT_MS });
    const { recorder, gamma, clock, finalizer } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.5', noPrice: '0.5' }),
      createFreshGammaEvent({ priceToBeat: 78449.05813530706 }),
    );
    recorder.sealedPayloadLines = upSeries();

    await openExpiredTwapMarket(harness);
    clock.advance(MAX_WAIT_MS + 1_000);
    await finalizer.runOnce();

    const finalization = lastFinalization(recorder);
    expect(finalization.provenance).toMatchObject({
      priceToBeat: 'official',
      finalPrice: 'derived',
    });
    expect(finalization.crypto?.priceToBeat).toBe('78449.05813530706'); // не подменён
    expect(finalization.provenance?.evidence?.priceToBeatValue).toBe('78449.05813530706');
  });

  it('fallback не использует spot-цены: одних spot-строк недостаточно (PART 8/17)', async () => {
    const harness = createFinalizerHarness({ enrichmentMaxWaitMs: MAX_WAIT_MS });
    const { recorder, gamma, clock, finalizer } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.5', noPrice: '0.5' }),
      createFreshGammaEvent(),
    );
    // Ряд полон spot-наблюдений того же символа и обеих границ — и всё же
    // непригоден: рынок резолвится TWAP, а не спотом
    recorder.sealedPayloadLines = [
      JSON.stringify({
        topic: 'prices.crypto.chainlink',
        type: 'update',
        timestamp: MARKET_START_MS,
        payload: { symbol: 'btc/usd', timestamp: MARKET_START_MS, value: '78449.0' },
      }),
      JSON.stringify({
        topic: 'prices.crypto.chainlink',
        type: 'update',
        timestamp: MARKET_END_MS,
        payload: { symbol: 'btc/usd', timestamp: MARKET_END_MS, value: '78500.0' },
      }),
    ];

    await openExpiredTwapMarket(harness);
    clock.advance(MAX_WAIT_MS + 1_000);
    await finalizer.runOnce();

    expect(recorder.finalizations).toEqual([`${CID_A}:SHUTDOWN`]); // датасет удалён
  });

  it('наблюдения ЧУЖОГО окна не годятся как основание (PART 20)', async () => {
    const harness = createFinalizerHarness({ enrichmentMaxWaitMs: MAX_WAIT_MS });
    const { recorder, gamma, clock, finalizer } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.5', noPrice: '0.5' }),
      createFreshGammaEvent(),
    );
    recorder.sealedPayloadLines = [
      twapLine(MARKET_START_MS, '78449.0', 30),
      twapLine(MARKET_END_MS, '78500.0', 30),
    ];

    await openExpiredTwapMarket(harness);
    clock.advance(MAX_WAIT_MS + 1_000);
    await finalizer.runOnce();

    expect(recorder.finalizations).toEqual([`${CID_A}:SHUTDOWN`]);
  });
});

describe('DISCARD неразрешимого датасета (PART 4/28/74)', () => {
  it('таймаут без официальных данных и без ряда → НЕТ `.gz`, датасет удалён', async () => {
    const harness = createFinalizerHarness({ enrichmentMaxWaitMs: MAX_WAIT_MS });
    const { recorder, gamma, clock, coordinator, finalizer } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.5', noPrice: '0.5' }),
      createFreshGammaEvent(),
    );
    recorder.sealedPayloadLines = undefined; // датасет не читается

    await openExpiredTwapMarket(harness);
    clock.advance(MAX_WAIT_MS + 1_000);
    await finalizer.runOnce();

    // Завершённого архива НЕТ: SHUTDOWN удаляет `.jsonl` без создания `.gz`
    expect(recorder.finalizations).toEqual([`${CID_A}:SHUTDOWN`]);
    expect(recorder.finalizations).not.toContain(`${CID_A}:EXPIRED`);
    // Вечного FINALIZING не осталось
    expect(coordinator.listSessions()).toEqual([]);
    expect(finalizer.getStats()).toMatchObject({
      discardedUnresolvable: 1,
      archivedTotal: 0,
      fallbackFinalizations: 0,
    });
  });

  it('ряд без ГРАНИЧНОГО наблюдения не спасает датасет (PART 34/71)', async () => {
    const harness = createFinalizerHarness({ enrichmentMaxWaitMs: MAX_WAIT_MS });
    const { recorder, gamma, clock, finalizer } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.5', noPrice: '0.5' }),
      createFreshGammaEvent(),
    );
    // Есть открытие и почти-закрытие, но не сама граница
    recorder.sealedPayloadLines = [
      twapLine(MARKET_START_MS, '78449.0'),
      twapLine(MARKET_END_MS - 1_000, '78500.0'),
    ];

    await openExpiredTwapMarket(harness);
    clock.advance(MAX_WAIT_MS + 1_000);
    await finalizer.runOnce();

    expect(recorder.finalizations).toEqual([`${CID_A}:SHUTDOWN`]);
  });

  it('рынок без официального времени старта не резолвится по ряду (PART 32)', async () => {
    const harness = createFinalizerHarness({ enrichmentMaxWaitMs: MAX_WAIT_MS });
    const { discovery, recorder, gamma, clock, coordinator, finalizer } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.5', noPrice: '0.5' }),
      createFreshGammaEvent(),
    );
    recorder.sealedPayloadLines = upSeries();
    await coordinator.openMarket(
      discovery.addMarket({
        rtdsFeeds: BTC_TWAP_FEEDS,
        settlement: BTC_TWAP_SETTLEMENT,
        eventStartsAtMs: null, // точного открытия окна нет
      }),
    );
    clock.advance(EXPIRE_ADVANCE_MS);
    await finalizer.runOnce();
    clock.advance(MAX_WAIT_MS + 1_000);
    await finalizer.runOnce();

    expect(recorder.finalizations).toEqual([`${CID_A}:SHUTDOWN`]);
  });
});

describe('SHUTDOWN ускоряет fallback (PART 5/47/66/67)', () => {
  it('close(): истёкший рынок с пригодным рядом → fallback/shutdown БЕЗ Gamma-запросов', async () => {
    const harness = createFinalizerHarness({ enrichmentMaxWaitMs: MAX_WAIT_MS });
    const { recorder, gamma, coordinator, finalizer } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.5', noPrice: '0.5' }),
      createFreshGammaEvent(),
    );
    recorder.sealedPayloadLines = downSeries();

    await openExpiredTwapMarket(harness);
    const fetchesBeforeClose = gamma.fetchMarketCalls.length;

    await finalizer.close();

    expect(gamma.fetchMarketCalls).toHaveLength(fetchesBeforeClose); // сеть не трогали
    const finalization = lastFinalization(recorder);
    expect(finalization.status).toBe('complete');
    expect(finalization.winning).toMatchObject({
      label: 'Down',
      instrumentId: TOKEN_DOWN,
      outcomeIndex: 1,
      source: 'recorded-twap',
    });
    expect(finalization.provenance).toMatchObject({
      resolution: 'fallback-chainlink-twap',
      fallbackTrigger: 'shutdown',
    });
    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
    expect(coordinator.listSessions()).toEqual([]);
    expect(finalizer.getStats()).toMatchObject({
      fallbackFinalizations: 1,
      fallbackByShutdown: 1,
      fallbackByTimeout: 0,
    });
  });

  it('close(): истёкший рынок БЕЗ пригодного ряда → датасет удаляется, архива нет', async () => {
    const harness = createFinalizerHarness({ enrichmentMaxWaitMs: MAX_WAIT_MS });
    const { recorder, gamma, coordinator, finalizer } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.5', noPrice: '0.5' }),
      createFreshGammaEvent(),
    );
    recorder.sealedPayloadLines = [twapLine(MARKET_START_MS, '78449.0')]; // границы закрытия нет

    await openExpiredTwapMarket(harness);
    await finalizer.close();

    expect(recorder.finalizations).toEqual([`${CID_A}:SHUTDOWN`]);
    expect(coordinator.listSessions()).toEqual([]);
    expect(finalizer.getStats()).toMatchObject({ discardedUnresolvable: 1, archivedTotal: 0 });
  });

  it('официальная резолюция, пришедшая до shutdown, побеждает записанный ряд', async () => {
    const harness = createFinalizerHarness({
      enrichmentRetryMs: 30_000,
      enrichmentMaxWaitMs: MAX_WAIT_MS,
    });
    const { recorder, gamma, clock, finalizer } = harness;
    // Сначала Gamma молчит: рынок остаётся pending, ряд уже записан и дал бы Down
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.5', noPrice: '0.5' }),
      createFreshGammaEvent(),
    );
    recorder.sealedPayloadLines = downSeries();
    await openExpiredTwapMarket(harness);
    expect(recorder.finalizations).toEqual([]);

    // Официальная резолюция приходит вовремя (Up) — она и должна победить
    armGamma(gamma, createFreshGammaMarket(), createFreshGammaEvent());
    clock.advance(30_000); // следующая попытка due
    await finalizer.runOnce();

    const finalization = lastFinalization(recorder);
    expect(finalization.winning).toMatchObject({ label: 'Up', source: 'resolution' });
    expect(finalization.provenance?.resolution).toBe('official');
    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);

    await finalizer.close(); // pending пуст — shutdown ничего не меняет
    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
    expect(finalizer.getStats()).toMatchObject({
      officialFinalizations: 1,
      fallbackFinalizations: 0,
    });
  });

  it('НЕ истёкший рынок при shutdown остаётся координатору (PART 68)', async () => {
    const harness = createFinalizerHarness({ enrichmentMaxWaitMs: MAX_WAIT_MS });
    const { discovery, recorder, gamma, coordinator, finalizer } = harness;
    armGamma(gamma, createFreshGammaMarket(), createFreshGammaEvent());
    await coordinator.openMarket(
      discovery.addMarket({ rtdsFeeds: BTC_TWAP_FEEDS, settlement: BTC_TWAP_SETTLEMENT }),
    );

    await finalizer.close(); // рынок ещё ACTIVE

    expect(recorder.finalizations).toEqual([]);
    expect(coordinator.getStats()).toMatchObject({ activeSessions: 1 });

    await coordinator.close();
    expect(recorder.finalizations).toEqual([`${CID_A}:SHUTDOWN`]); // partial удалён
  });
});

describe('identity победителя (PART 36/37/38/39/69/70)', () => {
  it('outcomeIndex ищется СОПОСТАВЛЕНИЕМ: перевёрнутый порядок исходов', async () => {
    // Фикстура с порядком [Down, Up]: константа `tokenIds[0]` присудила бы
    // победу не тому инструменту
    const harness = createFinalizerHarness({ enrichmentMaxWaitMs: MAX_WAIT_MS });
    const { recorder, gamma, clock, finalizer } = harness;
    armGamma(
      gamma,
      {
        ...createFreshGammaMarket({
          closed: false,
          umaResolutionStatus: null,
          yesPrice: '0.5',
          noPrice: '0.5',
        }),
        outcomes: {
          yes: { label: 'Down', tokenId: TOKEN_DOWN, positionId: null, price: '0.5' },
          no: { label: 'Up', tokenId: TOKEN_UP, positionId: null, price: '0.5' },
        },
      } as ReturnType<typeof createFreshGammaMarket>,
      createFreshGammaEvent(),
    );
    recorder.sealedPayloadLines = upSeries(); // деривация даёт Up

    await openExpiredTwapMarket(harness);
    clock.advance(MAX_WAIT_MS + 1_000);
    await finalizer.runOnce();

    const finalization = lastFinalization(recorder);
    expect(finalization.outcomes?.map((outcome) => outcome.label)).toEqual(['Down', 'Up']);
    // Up лежит ВТОРЫМ — индекс и инструмент обязаны это отражать
    expect(finalization.winning).toMatchObject({
      label: 'Up',
      instrumentId: TOKEN_UP,
      outcomeIndex: 1,
    });
  });

  it('tie (finalPrice == priceToBeat) → Up, как написано в правиле серии', async () => {
    const harness = createFinalizerHarness({ enrichmentMaxWaitMs: MAX_WAIT_MS });
    const { recorder, gamma, clock, finalizer } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.5', noPrice: '0.5' }),
      createFreshGammaEvent(),
    );
    recorder.sealedPayloadLines = [
      twapLine(MARKET_START_MS, '78449.05813530705395712'),
      twapLine(MARKET_END_MS, '78449.05813530705395712'),
    ];

    await openExpiredTwapMarket(harness);
    clock.advance(MAX_WAIT_MS + 1_000);
    await finalizer.runOnce();

    expect(lastFinalization(recorder).winning).toMatchObject({
      label: 'Up',
      outcomeIndex: 0,
      source: 'recorded-twap',
    });
  });

  it('завершённый архив всегда несёт полную machine-usable identity (PART 49)', async () => {
    const harness = createFinalizerHarness({ enrichmentMaxWaitMs: MAX_WAIT_MS });
    const { recorder, gamma, clock, finalizer } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.5', noPrice: '0.5' }),
      createFreshGammaEvent(),
    );
    recorder.sealedPayloadLines = downSeries();

    await openExpiredTwapMarket(harness);
    clock.advance(MAX_WAIT_MS + 1_000);
    await finalizer.runOnce();

    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
    const finalization = lastFinalization(recorder);
    expect(finalization.status).toBe('complete');
    expect(finalization.winning?.instrumentId).toBeDefined();
    expect(finalization.winning?.outcomeIndex).toBeDefined();
    expect(finalization.winning?.label).toBeDefined();
    expect(finalization.provenance?.resolution).toBeDefined();
  });
});

describe('отказы на терминальном пути не создают вводящих в заблуждение архивов', () => {
  it('header не записался → `.gz` НЕ создаётся (PART 51/72)', async () => {
    const harness = createFinalizerHarness({ enrichmentMaxWaitMs: MAX_WAIT_MS });
    const { recorder, gamma, clock, finalizer } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.5', noPrice: '0.5' }),
      createFreshGammaEvent(),
    );
    recorder.sealedPayloadLines = upSeries();

    await openExpiredTwapMarket(harness);
    recorder.metaUpdateResult = false; // storage молча не переписал header
    clock.advance(MAX_WAIT_MS + 1_000);
    await finalizer.runOnce();

    expect(recorder.finalizations).toEqual([]);
    expect(finalizer.getStats()).toMatchObject({ archivedTotal: 0, archiveFailures: 1 });
  });

  it('gzip упал → архив не объявляется успешным (PART 52/73)', async () => {
    const harness = createFinalizerHarness({ enrichmentMaxWaitMs: MAX_WAIT_MS });
    const { recorder, gamma, clock, coordinator, finalizer } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.5', noPrice: '0.5' }),
      createFreshGammaEvent(),
    );
    recorder.sealedPayloadLines = upSeries();

    await openExpiredTwapMarket(harness);
    recorder.finalizeError = new Error('gzip failed');
    clock.advance(MAX_WAIT_MS + 1_000);
    await finalizer.runOnce();

    expect(finalizer.getStats()).toMatchObject({ archivedTotal: 0, archiveFailures: 1 });
    // Сессия НЕ снята: успех не объявлен
    expect(coordinator.listSessions()).toEqual([
      expect.objectContaining({ marketId: mid(CID_A), state: 'FINALIZING' }),
    ]);
  });
});
