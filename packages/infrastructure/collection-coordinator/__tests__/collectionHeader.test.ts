/**
 * Тесты бюджета header LINE 1: деградация по ПОЛНОМУ meta-конверту storage.
 *
 * @remarks
 * Storage проверяет размер всей meta-строки
 * (`{t, formatVersion, ts, marketId, question, tokenIds, m}`), а не только
 * payload `m` — лестница усечения обязана считать конверт целиком и давать
 * `undefined`, когда безопасного header не существует.
 */
import { describe, it, expect } from '@jest/globals';
import { buildCollectionHeader } from '../src/index.js';
import { NOW_MS, createSelected, ts } from './helpers/fakes.js';

const START = ts(NOW_MS);

/** Probe-конверт той же формы, что metaRecord DataRecorder. */
function envelopeBytes(header: Record<string, unknown>, question: string): number {
  const selected = createSelected({ question });
  return Buffer.byteLength(
    JSON.stringify({
      t: 'meta',
      formatVersion: 2,
      ts: NOW_MS,
      marketId: String(selected.marketId),
      question: selected.question,
      tokenIds: selected.outcomes.map((outcome) => outcome.instrumentId),
      m: header,
    }),
    'utf8',
  );
}

describe('buildCollectionHeader: лестница усечения по бюджету meta-блока', () => {
  it('компактный рынок: полный header с gammaMarket и gammaEvent, без truncated', () => {
    const selected = createSelected({ gammaEventPadding: 64 });

    const header = buildCollectionHeader({ selected: selected, recordingStartsAt: START });

    expect(header).toBeDefined();
    expect(header!['truncated']).toBeUndefined();
    expect(header!['gammaMarket']).toBeDefined();
    expect(header!['gammaEvent']).toBeDefined();
    // Вложенные markets события выброшены безусловно (дублируют gammaMarket)
    expect((header!['gammaEvent'] as Record<string, unknown>)['markets']).toEqual([]);
  });

  it('крупный gammaEvent → truncated [gammaEvent], gammaMarket сохранён', () => {
    const selected = createSelected({ gammaEventPadding: 16 * 1024 });

    const header = buildCollectionHeader({ selected: selected, recordingStartsAt: START });

    expect(header).toBeDefined();
    expect(header!['truncated']).toEqual(['gammaEvent']);
    expect(header!['gammaMarket']).toBeDefined();
    expect(header!['gammaEvent']).toBeUndefined();
  });

  it('крупные gammaEvent и gammaMarket → truncated оба, ядро сохранено', () => {
    const selected = createSelected({
      gammaEventPadding: 16 * 1024,
      gammaMarketPadding: 16 * 1024,
    });

    const header = buildCollectionHeader({ selected: selected, recordingStartsAt: START });

    expect(header).toBeDefined();
    expect(header!['truncated']).toEqual(['gammaEvent', 'gammaMarket']);
    expect(header!['gammaMarket']).toBeUndefined();
    expect(header!['conditionId']).toBe(String(selected.marketId));
    expect(header!['timing']).toBeDefined();
    expect(header!['rtdsFeeds']).toEqual(selected.rtdsFeeds);
  });

  it('бюджет считается по ПОЛНОМУ конверту: m в пределах блока, но конверт сверх — усечение', () => {
    const BLOCK_LIMIT = 16 * 1024 - 1; // лимит storage на JSON всей meta-строки
    const BUDGET = BLOCK_LIMIT - 256; // бюджет билдера (с защитным запасом)

    // Подбираем паддинг адаптивно: payload `m` — чуть НИЖЕ лимита блока,
    // но полный конверт (внешние ts/marketId/question/tokenIds) — ВЫШЕ
    // бюджета. Проверка только по `m` этот случай пропустила бы.
    const unpadded = createSelected({});
    const unpaddedHeader = buildCollectionHeader({ selected: unpadded, recordingStartsAt: START })!;
    const unpaddedBytes = Buffer.byteLength(JSON.stringify(unpaddedHeader), 'utf8');
    const padding = BLOCK_LIMIT - 64 - unpaddedBytes;
    const selected = createSelected({ gammaMarketPadding: padding });

    const header = buildCollectionHeader({ selected: selected, recordingStartsAt: START });

    expect(header).toBeDefined();
    expect(header!['truncated']).toEqual(['gammaEvent', 'gammaMarket']);

    // Предпосылка: неусечённый вариант влезал бы в блок по `m`,
    // но его полный конверт превышает бюджет
    const rejected = { ...header!, gammaMarket: selected.gammaMarket } as Record<string, unknown>;
    delete rejected['truncated'];
    const rejectedBytes = Buffer.byteLength(JSON.stringify(rejected), 'utf8');
    expect(rejectedBytes).toBeLessThanOrEqual(BLOCK_LIMIT);
    expect(envelopeBytes(rejected, selected.question)).toBeGreaterThan(BUDGET);
  });

  it('даже усечённое ядро не помещается (аномальный question) → undefined', () => {
    const selected = createSelected({ question: `Bitcoin ${'q'.repeat(17_000)}` });

    expect(buildCollectionHeader({ selected: selected, recordingStartsAt: START })).toBeUndefined();
  });

  it('итоговый header всегда проходит проверку размера конверта', () => {
    for (const options of [
      {},
      { gammaEventPadding: 16 * 1024 },
      { gammaEventPadding: 16 * 1024, gammaMarketPadding: 16 * 1024 },
      { gammaMarketPadding: 15 * 1024 },
    ]) {
      const selected = createSelected(options);
      const header = buildCollectionHeader({ selected: selected, recordingStartsAt: START });
      expect(header).toBeDefined();
      expect(envelopeBytes(header!, selected.question)).toBeLessThanOrEqual(16 * 1024 - 1 - 256);
    }
  });
});
