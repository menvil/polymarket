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
import type { CollectionHeaderFinalization } from '@polymarket/collector';
import {
  BTC_FEEDS,
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
  openMarket,
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

/** Строка записанного СПОТ-наблюдения Chainlink (не settlement-поток). */
function chainlinkSpotLine(timestampMs: number, value: string): string {
  return JSON.stringify({
    topic: 'prices.crypto.chainlink',
    type: 'update',
    timestamp: timestampMs,
    payload: { symbol: 'btc/usd', timestamp: timestampMs, value },
  });
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
  const { clock, finalizer } = harness;
  openMarket(harness, {
      rtdsFeeds: BTC_TWAP_FEEDS,
      settlement: BTC_TWAP_SETTLEMENT,
      ...(overrides.tokenIds !== undefined ? { tokenIds: overrides.tokenIds } : {}),
    });
  clock.advance(EXPIRE_ADVANCE_MS);
  await finalizer.runOnce(); // begin + первая попытка
}

describe('OFFICIAL COMPLETE имеет приоритет (PART 7/44/64)', () => {
  it('ПОЛНЫЙ комплект (резолюция + обе цены) архивирует досрочно', async () => {
    const harness = createFinalizerHarness({ enrichmentMaxWaitMs: MAX_WAIT_MS });
    const { recorder, gamma, lifecycle, finalizer } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket(),
      createFreshGammaEvent({ priceToBeat: 78449.05, finalPrice: 78500.1 }),
    );

    await openExpiredTwapMarket(harness);

    const finalization = lastFinalization(recorder);
    expect(finalization.status).toBe('complete');
    expect(finalization.winning).toMatchObject({ label: 'Up', source: 'resolution', exact: true });
    expect(finalization.provenance).toMatchObject({
      resolution: 'official',
      priceToBeat: 'official',
      finalPrice: 'official',
    });
    expect(finalization.provenance?.fallbackTrigger).toBeUndefined();
    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
    expect(lifecycle.listSessions()).toEqual([]);
    expect(finalizer.getStats()).toMatchObject({
      officialFinalizations: 1,
      fallbackFinalizations: 0,
      discardedUnresolvable: 0,
    });
  });

  it('резолюция БЕЗ finalPrice держит рынок: ждём максимума информации', async () => {
    // Решение user: частичный комплект рынок не закрывает — бюджет всё равно
    // есть, а официальное число ценнее выведенного. Раньше такой рынок
    // архивировался немедленно и терял шанс получить официальный finalPrice.
    const harness = createFinalizerHarness({
      enrichmentRetryMs: 30_000,
      enrichmentMaxWaitMs: MAX_WAIT_MS,
    });
    const { recorder, gamma, clock, lifecycle, finalizer } = harness;
    armGamma(gamma, createFreshGammaMarket(), createFreshGammaEvent({ priceToBeat: 78449.05 }));

    await openExpiredTwapMarket(harness);

    expect(recorder.finalizations).toEqual([]); // архива НЕТ
    expect(lastFinalization(recorder).status).toBe('pending');
    expect(lifecycle.listSessions()).toHaveLength(1);

    // finalPrice приходит позже — вот теперь комплект полон
    armGamma(
      gamma,
      createFreshGammaMarket(),
      createFreshGammaEvent({ priceToBeat: 78449.05, finalPrice: 78500.1 }),
    );
    clock.advance(30_000);
    await finalizer.runOnce();

    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
    expect(lastFinalization(recorder).provenance).toMatchObject({
      resolution: 'official',
      priceToBeat: 'official',
      finalPrice: 'official',
    });
  });

  it('официальный итог НЕ перезаписывается fallback-ом, даже когда ряд записан', async () => {
    const harness = createFinalizerHarness({ enrichmentMaxWaitMs: MAX_WAIT_MS });
    const { recorder, gamma } = harness;
    // Gamma говорит Up (resolved 1/0), а записанный ряд дал бы Down
    armGamma(
      gamma,
      createFreshGammaMarket(),
      createFreshGammaEvent({ priceToBeat: 78449.05, finalPrice: 78500.1 }),
    );
    recorder.sealedPayloadLines = downSeries();

    await openExpiredTwapMarket(harness);

    const finalization = lastFinalization(recorder);
    expect(finalization.winning).toMatchObject({ label: 'Up', source: 'resolution' });
    expect(finalization.provenance?.resolution).toBe('official');
    // Комплект официальных чисел полон — записанный ряд даже не читался
    expect(recorder.sealedReads).toEqual([]);
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

  it('по таймауту недостающий finalPrice восполняется из ряда и помечается derived', async () => {
    // Gamma так и не дал finalPrice за весь бюджет. Победитель официальный,
    // но число — выведенное, и архив обязан это различать.
    const harness = createFinalizerHarness({ enrichmentMaxWaitMs: MAX_WAIT_MS });
    const { recorder, gamma, clock, finalizer } = harness;
    armGamma(gamma, createFreshGammaMarket(), createFreshGammaEvent({ priceToBeat: 78449.05 }));
    recorder.sealedPayloadLines = upSeries();

    await openExpiredTwapMarket(harness);
    expect(recorder.finalizations).toEqual([]); // ждём весь бюджет

    clock.advance(MAX_WAIT_MS + 1_000);
    await finalizer.runOnce();

    const finalization = lastFinalization(recorder);
    expect(finalization.status).toBe('complete');
    expect(finalization.winning).toMatchObject({ label: 'Up', source: 'resolution' });
    expect(finalization.provenance).toMatchObject({
      resolution: 'official',
      priceToBeat: 'official',
      finalPrice: 'derived',
    });
    expect(finalization.crypto).toEqual({
      priceToBeat: '78449.05',
      finalPrice: '78501.123456789012345678', // граничное наблюдение ряда
    });
    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
  });
});

describe('FALLBACK по исчерпанию бюджета (PART 46/65)', () => {
  it('таймаут + пригодный ряд → complete с provenance fallback/official-timeout', async () => {
    const harness = createFinalizerHarness({ enrichmentMaxWaitMs: MAX_WAIT_MS });
    const { recorder, gamma, clock, lifecycle, finalizer } = harness;
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
    expect(lifecycle.listSessions()).toEqual([]);
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

  it('НЕПРИГОДНЫЙ официальный priceToBeat не выдаётся за официальный (PART 41)', async () => {
    // Gamma отдаёт metadata как есть; строковое значение вроде "NaN" проходит
    // извлечение, но резолвер его отбрасывает. Если бы provenance считался по
    // НАЛИЧИЮ значения, архив утверждал бы «цена официальная», держа при этом
    // выведенное число — ровно та ложь, ради запрета которой поле и введено.
    const harness = createFinalizerHarness({ enrichmentMaxWaitMs: MAX_WAIT_MS });
    const { recorder, gamma, clock, finalizer } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.5', noPrice: '0.5' }),
      createFreshGammaEvent({ priceToBeatRaw: 'NaN' }),
    );
    recorder.sealedPayloadLines = upSeries();

    await openExpiredTwapMarket(harness);
    clock.advance(MAX_WAIT_MS + 1_000);
    await finalizer.runOnce();

    const finalization = lastFinalization(recorder);
    expect(finalization.provenance?.priceToBeat).toBe('derived');
    expect(finalization.crypto?.priceToBeat).toBe('78449.05813530705395712'); // записанное
    expect(finalization.provenance?.evidence?.priceToBeatValue).toBe(
      '78449.05813530705395712',
    );
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
    const { recorder, gamma, clock, lifecycle, finalizer } = harness;
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
    expect(lifecycle.listSessions()).toEqual([]);
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

  it('BLOCKER-регрессия: НЕподдержанное окно TWAP не резолвится по СПОТУ', async () => {
    // Правило расчёта — TWAP (URL это объявляет), но окно вне vendor-домена.
    // Источник расчёта ИЗВЕСТЕН и это не спот, поэтому приблизительная
    // ступень recorded-rtds для такого рынка запрещена: иначе расширение
    // vendor-домена раньше нашего кода молча дало бы архив с победителем,
    // посчитанным по чужому потоку.
    const harness = createFinalizerHarness({ enrichmentMaxWaitMs: MAX_WAIT_MS });
    const { recorder, gamma, clock, lifecycle, finalizer } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.5', noPrice: '0.5' }),
      createFreshGammaEvent(),
    );
    // Спот-ряд ПОЛОН и по нему recorded-rtds выдал бы победителя
    recorder.sealedPayloadLines = [
      chainlinkSpotLine(MARKET_START_MS, '78000.0'),
      chainlinkSpotLine(MARKET_END_MS - 30_000, '78500.0'),
      chainlinkSpotLine(MARKET_END_MS - 1_000, '78600.0'),
    ];
    openMarket(harness, {
        rtdsFeeds: BTC_FEEDS, // только spot: settlement-фида нет
        unsupportedSettlementSource:
          'https://data.chain.link/streams/btc-usd-twap-45s-streams',
      });
    clock.advance(EXPIRE_ADVANCE_MS);
    await finalizer.runOnce();
    clock.advance(MAX_WAIT_MS + 1_000);
    await finalizer.runOnce();

    // Никакого архива и никакого победителя по споту
    expect(recorder.finalizations).toEqual([`${CID_A}:SHUTDOWN`]);
    expect(recorder.finalizations).not.toContain(`${CID_A}:EXPIRED`);
    expect(finalizer.getStats()).toMatchObject({
      discardedUnresolvable: 1,
      archivedTotal: 0,
    });
    expect(lifecycle.listSessions()).toEqual([]);
  });

  it('обычный spot-рынок Chainlink сохраняет прежнюю ступень recorded-rtds', async () => {
    // Контраст к предыдущему тесту: у рынка БЕЗ TWAP-правила источник
    // расчёта нам не объявлен, и verified-поведение до MR-B сохраняется.
    const harness = createFinalizerHarness({ enrichmentMaxWaitMs: MAX_WAIT_MS });
    const { recorder, gamma, clock, finalizer } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.5', noPrice: '0.5' }),
      createFreshGammaEvent(),
    );
    recorder.sealedPayloadLines = [
      chainlinkSpotLine(MARKET_START_MS, '78000.0'),
      chainlinkSpotLine(MARKET_END_MS - 30_000, '78500.0'),
      chainlinkSpotLine(MARKET_END_MS - 1_000, '78600.0'),
    ];
    openMarket(harness, { rtdsFeeds: BTC_FEEDS });
    clock.advance(EXPIRE_ADVANCE_MS);
    await finalizer.runOnce();
    clock.advance(MAX_WAIT_MS + 1_000);
    await finalizer.runOnce();

    expect(recorder.finalizations).toEqual([`${CID_A}:EXPIRED`]);
    expect(lastFinalization(recorder).winning).toMatchObject({
      source: 'recorded-rtds',
      exact: false,
    });
  });

  it('рынок без официального времени старта не резолвится по ряду (PART 32)', async () => {
    const harness = createFinalizerHarness({ enrichmentMaxWaitMs: MAX_WAIT_MS });
    const { recorder, gamma, clock, finalizer } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.5', noPrice: '0.5' }),
      createFreshGammaEvent(),
    );
    recorder.sealedPayloadLines = upSeries();
    openMarket(harness, {
        rtdsFeeds: BTC_TWAP_FEEDS,
        settlement: BTC_TWAP_SETTLEMENT,
        eventStartsAtMs: null, // точного открытия окна нет
      });
    clock.advance(EXPIRE_ADVANCE_MS);
    await finalizer.runOnce();
    clock.advance(MAX_WAIT_MS + 1_000);
    await finalizer.runOnce();

    expect(recorder.finalizations).toEqual([`${CID_A}:SHUTDOWN`]);
  });
});

describe('отказ УДАЛЕНИЯ не выдаётся за успешное удаление', () => {
  it('finalizeMarket(SHUTDOWN) бросил → НЕ discarded, счётчик не растёт', async () => {
    // Файл, скорее всего, остался на диске. Снять сессию, увеличить счётчик
    // удалённых и написать «dataset discarded» значило бы приписать системе
    // действие, которого не было.
    const harness = createFinalizerHarness({ enrichmentMaxWaitMs: MAX_WAIT_MS });
    const { recorder, gamma, clock, lifecycle, finalizer, logger } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.5', noPrice: '0.5' }),
      createFreshGammaEvent(),
    );
    recorder.sealedPayloadLines = undefined; // деривация недоступна → discard

    await openExpiredTwapMarket(harness);
    recorder.finalizeError = new Error('unlink failed');
    clock.advance(MAX_WAIT_MS + 1_000);
    await finalizer.runOnce();

    expect(finalizer.getStats()).toMatchObject({
      discardedUnresolvable: 0, // удаление НЕ состоялось
      archivedTotal: 0,
    });
    expect(
      logger.byLevel('error').some((e) => e.message.includes('file may remain on disk')),
    ).toBe(true);
    // Успешного «discarded» в логе быть не должно
    expect(
      logger.byLevel('warn').some((e) => e.message.includes('incomplete dataset discarded')),
    ).toBe(false);
    // Сессия НЕ снята: система не считает рынок завершённым
    expect(lifecycle.listSessions()).toHaveLength(1);
  });

  it('успешное удаление снимает сессию и растит счётчик', async () => {
    const harness = createFinalizerHarness({ enrichmentMaxWaitMs: MAX_WAIT_MS });
    const { recorder, gamma, clock, lifecycle, finalizer } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.5', noPrice: '0.5' }),
      createFreshGammaEvent(),
    );
    recorder.sealedPayloadLines = undefined;

    await openExpiredTwapMarket(harness);
    clock.advance(MAX_WAIT_MS + 1_000);
    await finalizer.runOnce();

    expect(recorder.finalizations).toEqual([`${CID_A}:SHUTDOWN`]);
    expect(finalizer.getStats()).toMatchObject({ discardedUnresolvable: 1 });
    expect(lifecycle.listSessions()).toEqual([]);
  });
});

describe('SHUTDOWN ускоряет fallback (PART 5/47/66/67)', () => {
  it('close(): истёкший рынок с пригодным рядом → fallback/shutdown БЕЗ Gamma-запросов', async () => {
    const harness = createFinalizerHarness({ enrichmentMaxWaitMs: MAX_WAIT_MS });
    const { recorder, gamma, lifecycle, finalizer } = harness;
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
    expect(lifecycle.listSessions()).toEqual([]);
    expect(finalizer.getStats()).toMatchObject({
      fallbackFinalizations: 1,
      fallbackByShutdown: 1,
      fallbackByTimeout: 0,
    });
  });

  it('close(): истёкший рынок БЕЗ пригодного ряда → датасет удаляется, архива нет', async () => {
    const harness = createFinalizerHarness({ enrichmentMaxWaitMs: MAX_WAIT_MS });
    const { recorder, gamma, lifecycle, finalizer } = harness;
    armGamma(
      gamma,
      createFreshGammaMarket({ closed: false, umaResolutionStatus: null, yesPrice: '0.5', noPrice: '0.5' }),
      createFreshGammaEvent(),
    );
    recorder.sealedPayloadLines = [twapLine(MARKET_START_MS, '78449.0')]; // границы закрытия нет

    await openExpiredTwapMarket(harness);
    await finalizer.close();

    expect(recorder.finalizations).toEqual([`${CID_A}:SHUTDOWN`]);
    expect(lifecycle.listSessions()).toEqual([]);
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
    armGamma(
      gamma,
      createFreshGammaMarket(),
      createFreshGammaEvent({ priceToBeat: 78449.05, finalPrice: 78500.1 }),
    );
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
    const { recorder, gamma, lifecycle, finalizer } = harness;
    armGamma(gamma, createFreshGammaMarket(), createFreshGammaEvent());
    openMarket(harness, { rtdsFeeds: BTC_TWAP_FEEDS, settlement: BTC_TWAP_SETTLEMENT });

    await finalizer.close(); // рынок ещё ACTIVE

    expect(recorder.finalizations).toEqual([]);
    expect(lifecycle.getStats()).toMatchObject({ activeSessions: 1 });

    await lifecycle.close();
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
    const { recorder, gamma, clock, lifecycle, finalizer } = harness;
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
    expect(lifecycle.listSessions()).toEqual([
      expect.objectContaining({ marketId: mid(CID_A), state: 'FINALIZING' }),
    ]);
  });
});
