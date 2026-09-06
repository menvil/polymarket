/**
 * Обогащение canonical V2 header-а итогом финализации и его бюджет.
 *
 * @remarks
 * Проверяется ровно то, что отличает V2-обогащение от legacy-пересборки:
 * база не подменяется, `timing` дополняется, а при нехватке места
 * выбрасывается ТОЛЬКО некритическая часть раздела.
 */
import { describe, expect, it } from '@jest/globals';
import { unsafeInstrumentId, unsafeMarketId } from '@polymarket/ids';
import type { MarketMeta } from '@polymarket/ports';
import { buildFinalizedMarketHeader } from '../src/index.js';
import type { CollectionHeaderFinalization } from '../src/index.js';
import { BASE_START_MS, ts } from './helpers/fixtures.js';

/** Фиксированное истечение фикстурного рынка. */
const EXPIRES_AT_MS = BASE_START_MS + 5 * 60_000;
/** Момент первой записанной строки датасета. */
const RECORDING_STARTED_AT_MS = BASE_START_MS - 30_000;

/** Canonical header допуска (то, что пишет gate в LINE 1). */
function baseHeader(question = 'Bitcoin Up or Down?'): Record<string, unknown> {
  return {
    headerVersion: 2,
    source: 'polymarket',
    conditionId: 'btc-5m-1',
    question,
    outcomes: [
      { index: 0, label: 'Up', instrumentId: 'btc-5m-1-up' },
      { index: 1, label: 'Down', instrumentId: 'btc-5m-1-down' },
    ],
    family: 'CRYPTO_UP_DOWN',
    timing: { startsAt: BASE_START_MS, expiresAt: EXPIRES_AT_MS },
    crypto: { asset: 'btc', duration: 5 * 60_000 },
  };
}

/** Регистрация рынка (внешние поля meta-строки storage). */
function marketMeta(question = 'Bitcoin Up or Down?'): MarketMeta {
  return {
    marketId: unsafeMarketId('btc-5m-1'),
    question,
    tokenIds: [String(unsafeInstrumentId('btc-5m-1-up')), String(unsafeInstrumentId('btc-5m-1-down'))],
    expiresAt: ts(EXPIRES_AT_MS),
    rawMarket: baseHeader(question),
  };
}

/** Полный finalization-раздел с победителем и числами. */
function finalization(outcomeLabelPadding = 0): CollectionHeaderFinalization {
  return {
    status: 'complete',
    startedAtMs: EXPIRES_AT_MS,
    finalizedAtMs: EXPIRES_AT_MS + 60_000,
    attempts: 2,
    settlement: {
      kind: 'chainlink-twap',
      topic: 'prices.crypto.chainlink.twap',
      symbol: 'btc/usd',
      windowSeconds: 60,
      resolutionSource: 'https://data.chain.link/streams/btc-usd-twap-60s-streams',
    },
    resolution: { closed: true, umaResolutionStatus: 'resolved' },
    outcomes: [
      {
        label: `Up${'x'.repeat(outcomeLabelPadding)}`,
        instrumentId: unsafeInstrumentId('btc-5m-1-up'),
        price: '1',
      },
      {
        label: `Down${'x'.repeat(outcomeLabelPadding)}`,
        instrumentId: unsafeInstrumentId('btc-5m-1-down'),
        price: '0',
      },
    ],
    winning: {
      label: 'Up',
      instrumentId: unsafeInstrumentId('btc-5m-1-up'),
      outcomeIndex: 0,
      source: 'resolution',
      exact: true,
    },
    provenance: { resolution: 'official', priceToBeat: 'official', finalPrice: 'official' },
    crypto: { priceToBeat: '78027.1', finalPrice: '78325.2' },
  };
}

describe('buildFinalizedMarketHeader', () => {
  it('база V2 сохранена как есть, timing дополнен, раздел finalization добавлен', () => {
    const header = buildFinalizedMarketHeader({
      baseHeader: baseHeader(),
      marketMeta: marketMeta(),
      recordingStartsAtMs: RECORDING_STARTED_AT_MS,
      finalization: finalization(),
    });

    expect(header).toBeDefined();
    // Дискриминатор версии не откатывается к legacy `headerVersion: 1`.
    expect(header?.['headerVersion']).toBe(2);
    expect(header?.['conditionId']).toBe('btc-5m-1');
    expect(header?.['outcomes']).toEqual(baseHeader()['outcomes']);
    expect(header?.['family']).toBe('CRYPTO_UP_DOWN');
    // timing ДОПОЛНЕН, а не переписан.
    expect(header?.['timing']).toEqual({
      startsAt: BASE_START_MS,
      expiresAt: EXPIRES_AT_MS,
      recordingStartsAt: RECORDING_STARTED_AT_MS,
    });
    expect(header?.['truncated']).toBeUndefined();
    const section = header?.['finalization'] as CollectionHeaderFinalization;
    expect(section.status).toBe('complete');
    expect(section.winning?.label).toBe('Up');
    expect(section.outcomes).toHaveLength(2);
  });

  it('не влезает целиком → выброшены ТОЛЬКО outcomes, итог рынка сохранён', () => {
    // Раздутые метки исходов: полный раздел за бюджетом, ядро — в бюджете.
    const header = buildFinalizedMarketHeader({
      baseHeader: baseHeader(),
      marketMeta: marketMeta(),
      recordingStartsAtMs: RECORDING_STARTED_AT_MS,
      finalization: finalization(8 * 1024),
    });

    expect(header).toBeDefined();
    expect(header?.['truncated']).toEqual(['finalization.outcomes']);
    const section = header?.['finalization'] as CollectionHeaderFinalization;
    expect(section.outcomes).toBeUndefined();
    // Критические данные переживают бюджет: архив без итога хуже отсутствия архива.
    expect(section.status).toBe('complete');
    expect(section.winning).toMatchObject({ label: 'Up', source: 'resolution', exact: true });
    expect(section.provenance).toMatchObject({ resolution: 'official' });
    expect(section.crypto).toEqual({ priceToBeat: '78027.1', finalPrice: '78325.2' });
    expect(section.settlement).toMatchObject({ kind: 'chainlink-twap', windowSeconds: 60 });
  });

  it('не влезает даже ядро → header не собирается (вызывающий обязан отказать)', () => {
    // question дублируется во ВНЕШНЕЙ meta-строке storage: бюджет считается
    // по полному конверту, а не по одному payload `m`.
    const question = `Bitcoin Up or Down? ${'q'.repeat(12 * 1024)}`;
    const header = buildFinalizedMarketHeader({
      baseHeader: baseHeader(question),
      marketMeta: marketMeta(question),
      recordingStartsAtMs: RECORDING_STARTED_AT_MS,
      finalization: finalization(),
    });

    expect(header).toBeUndefined();
  });
});
