import { describe, it, expect, beforeEach } from '@jest/globals';
import { InMemoryMarketCatalog } from '../../src/InMemoryMarketCatalog.js';
import { asMarketId, asInstrumentId } from '@polymarket/ids';
import type { InstrumentInfo } from '@polymarket/ports';
import type { Money, Price, Quantity } from '@polymarket/value-objects';
import type { Timestamp } from '@polymarket/timestamp';

const MARKET_ID = asMarketId('market-1')!;
const YES_TOKEN = asInstrumentId('yes-token')!;
const NO_TOKEN = asInstrumentId('no-token')!;
const OTHER_MARKET_ID = asMarketId('market-2')!;
const OTHER_TOKEN = asInstrumentId('other-token')!;

function makeInstrument(instrumentId: typeof YES_TOKEN, marketId: typeof MARKET_ID): InstrumentInfo {
  return {
    instrumentId,
    marketId,
    tickSize: {} as Price,
    minOrderSize: {} as Quantity,
    minOrderValue: {} as Money,
    active: true,
    expiresAt: {} as Timestamp,
  };
}

describe('InMemoryMarketCatalog', () => {
  let catalog: InMemoryMarketCatalog;

  beforeEach(() => {
    catalog = new InMemoryMarketCatalog();
  });

  it('getAllByMarketId возвращает ОБА outcome-токена бинарного рынка (YES + NO)', () => {
    catalog.register(makeInstrument(YES_TOKEN, MARKET_ID));
    catalog.register(makeInstrument(NO_TOKEN, MARKET_ID));

    const all = catalog.getAllByMarketId(MARKET_ID);
    expect(all).toHaveLength(2);
    expect(all.map((i) => i.instrumentId).sort()).toEqual([NO_TOKEN, YES_TOKEN].sort());
  });

  it('getByMarketId возвращает только ОДИН инструмент (не ошибка, задокументированное поведение)', () => {
    catalog.register(makeInstrument(YES_TOKEN, MARKET_ID));
    catalog.register(makeInstrument(NO_TOKEN, MARKET_ID));

    const found = catalog.getByMarketId(MARKET_ID);
    expect(found).toBeDefined();
    expect([YES_TOKEN, NO_TOKEN]).toContain(found?.instrumentId);
  });

  it('remove() одного outcome-токена НЕ удаляет сиблинга того же рынка', () => {
    catalog.register(makeInstrument(YES_TOKEN, MARKET_ID));
    catalog.register(makeInstrument(NO_TOKEN, MARKET_ID));

    catalog.remove(YES_TOKEN);

    expect(catalog.get(YES_TOKEN)).toBeUndefined();
    expect(catalog.get(NO_TOKEN)).toBeDefined();
    expect(catalog.getAllByMarketId(MARKET_ID)).toHaveLength(1);
    expect(catalog.getAllByMarketId(MARKET_ID)[0]?.instrumentId).toBe(NO_TOKEN);
  });

  it('remove() последнего инструмента рынка полностью очищает индекс marketId', () => {
    catalog.register(makeInstrument(YES_TOKEN, MARKET_ID));
    catalog.remove(YES_TOKEN);

    expect(catalog.getAllByMarketId(MARKET_ID)).toHaveLength(0);
    expect(catalog.getByMarketId(MARKET_ID)).toBeUndefined();
  });

  it('getAllByMarketId возвращает [] для неизвестного рынка', () => {
    expect(catalog.getAllByMarketId(MARKET_ID)).toEqual([]);
  });

  it('не путает инструменты разных рынков', () => {
    catalog.register(makeInstrument(YES_TOKEN, MARKET_ID));
    catalog.register(makeInstrument(OTHER_TOKEN, OTHER_MARKET_ID));

    expect(catalog.getAllByMarketId(MARKET_ID).map((i) => i.instrumentId)).toEqual([YES_TOKEN]);
    expect(catalog.getAllByMarketId(OTHER_MARKET_ID).map((i) => i.instrumentId)).toEqual([OTHER_TOKEN]);
  });

  it('register() с изменением marketId переносит instrumentId в новый Set, не трогая старых сиблингов', () => {
    catalog.register(makeInstrument(YES_TOKEN, MARKET_ID));
    catalog.register(makeInstrument(NO_TOKEN, MARKET_ID));

    // YES-токен "переезжает" на другой рынок (гипотетический re-register сценарий)
    catalog.register(makeInstrument(YES_TOKEN, OTHER_MARKET_ID));

    expect(catalog.getAllByMarketId(MARKET_ID).map((i) => i.instrumentId)).toEqual([NO_TOKEN]);
    expect(catalog.getAllByMarketId(OTHER_MARKET_ID).map((i) => i.instrumentId)).toEqual([YES_TOKEN]);
  });

  // ── getAnyInstrumentByMarketIdForMetadataOnly / deprecated alias ───────────

  describe('getAnyInstrumentByMarketIdForMetadataOnly', () => {
    it('возвращает один инструмент рынка (metadata-only)', () => {
      catalog.register(makeInstrument(YES_TOKEN, MARKET_ID));
      catalog.register(makeInstrument(NO_TOKEN, MARKET_ID));

      const found = catalog.getAnyInstrumentByMarketIdForMetadataOnly(MARKET_ID);
      expect(found).toBeDefined();
      expect([YES_TOKEN, NO_TOKEN]).toContain(found?.instrumentId);
    });

    it('возвращает undefined для неизвестного рынка', () => {
      expect(catalog.getAnyInstrumentByMarketIdForMetadataOnly(MARKET_ID)).toBeUndefined();
    });

    it('deprecated getByMarketId — alias с идентичным результатом', () => {
      catalog.register(makeInstrument(YES_TOKEN, MARKET_ID));

      expect(catalog.getByMarketId(MARKET_ID)).toEqual(
        catalog.getAnyInstrumentByMarketIdForMetadataOnly(MARKET_ID),
      );
    });
  });

  // ── registerMarket / removeMarket ──────────────────────────────────────────

  describe('registerMarket', () => {
    it('регистрирует несколько инструментов одного marketId атомарно', () => {
      catalog.registerMarket({
        marketId: MARKET_ID,
        instruments: [makeInstrument(YES_TOKEN, MARKET_ID), makeInstrument(NO_TOKEN, MARKET_ID)],
      });

      expect(catalog.getAllByMarketId(MARKET_ID)).toHaveLength(2);
      expect(catalog.get(YES_TOKEN)).toBeDefined();
      expect(catalog.get(NO_TOKEN)).toBeDefined();
    });

    it('не делает partial mutation, если один instrument с чужим marketId — бросает Error', () => {
      expect(() =>
        catalog.registerMarket({
          marketId: MARKET_ID,
          instruments: [
            makeInstrument(YES_TOKEN, MARKET_ID),
            makeInstrument(OTHER_TOKEN, OTHER_MARKET_ID), // чужой marketId
          ],
        }),
      ).toThrow(/belongs to market/);

      // Validate-first: НИЧЕГО не зарегистрировано, включая валидный YES_TOKEN.
      expect(catalog.getAll()).toHaveLength(0);
      expect(catalog.get(YES_TOKEN)).toBeUndefined();
    });

    it('registerMarket с пустым instruments бросает Error (пустая регистрация — bug вызывающего кода)', () => {
      expect(() => catalog.registerMarket({ marketId: MARKET_ID, instruments: [] })).toThrow(
        /empty instruments/,
      );
    });

    it('upsert, не replace: существующий инструмент рынка вне input.instruments не удаляется', () => {
      catalog.register(makeInstrument(NO_TOKEN, MARKET_ID));

      catalog.registerMarket({
        marketId: MARKET_ID,
        instruments: [makeInstrument(YES_TOKEN, MARKET_ID)],
      });

      expect(catalog.getAllByMarketId(MARKET_ID)).toHaveLength(2);
    });
  });

  describe('removeMarket', () => {
    it('удаляет ВСЕ инструменты рынка (оба outcome-токена)', () => {
      catalog.registerMarket({
        marketId: MARKET_ID,
        instruments: [makeInstrument(YES_TOKEN, MARKET_ID), makeInstrument(NO_TOKEN, MARKET_ID)],
      });
      catalog.register(makeInstrument(OTHER_TOKEN, OTHER_MARKET_ID));

      catalog.removeMarket(MARKET_ID);

      expect(catalog.getAllByMarketId(MARKET_ID)).toHaveLength(0);
      expect(catalog.get(YES_TOKEN)).toBeUndefined();
      expect(catalog.get(NO_TOKEN)).toBeUndefined();
      // Другой рынок не затронут.
      expect(catalog.get(OTHER_TOKEN)).toBeDefined();
    });

    it('unknown marketId — no-op, не бросает', () => {
      expect(() => catalog.removeMarket(MARKET_ID)).not.toThrow();
    });
  });
});
