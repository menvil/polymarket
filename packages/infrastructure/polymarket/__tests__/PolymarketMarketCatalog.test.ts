/**
 * Тесты PolymarketMarketCatalog.
 *
 * @remarks
 * Проверяет контракт `IMarketCatalog` в части multi-outcome рынков:
 * - metadata-only lookup (`getAnyInstrumentByMarketIdForMetadataOnly`)
 *   и deprecated alias `getByMarketId`;
 * - market-wide lookup (`getAllByMarketId`);
 * - атомарную регистрацию рынка (`registerMarket`: validate-first,
 *   partial mutation исключена) и удаление рынка целиком (`removeMarket`).
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { PolymarketMarketCatalog } from '../catalog/PolymarketMarketCatalog.js';
import type { ILogger } from '@polymarket/logger';
import { asMarketId, asInstrumentId } from '@polymarket/ids';
import type { InstrumentId, MarketId } from '@polymarket/ids';
import type { InstrumentInfo } from '@polymarket/ports';
import type { Money, OutcomePrice, Quantity } from '@polymarket/value-objects';
import type { Timestamp } from '@polymarket/timestamp';

function makeLogger(): ILogger {
  return {
    trace: jest.fn() as ILogger['trace'],
    debug: jest.fn() as ILogger['debug'],
    info: jest.fn() as ILogger['info'],
    warn: jest.fn() as ILogger['warn'],
    error: jest.fn() as ILogger['error'],
    fatal: jest.fn() as ILogger['fatal'],
    child: jest.fn<ILogger['child']>().mockReturnThis() as ILogger['child'],
  };
}

const MARKET_ID = asMarketId('market-1')!;
const OTHER_MARKET_ID = asMarketId('market-2')!;
const YES_TOKEN = asInstrumentId('yes-token')!;
const NO_TOKEN = asInstrumentId('no-token')!;
const OTHER_TOKEN = asInstrumentId('other-token')!;

function makeInstrument(instrumentId: InstrumentId, marketId: MarketId): InstrumentInfo {
  return {
    instrumentId,
    marketId,
    tickSize: {} as OutcomePrice,
    minOrderSize: {} as Quantity,
    minOrderValue: {} as Money,
    active: true,
    expiresAt: {} as Timestamp,
  };
}

describe('PolymarketMarketCatalog', () => {
  let catalog: PolymarketMarketCatalog;

  beforeEach(() => {
    catalog = new PolymarketMarketCatalog(makeLogger());
  });

  describe('register (старый API) + lookups', () => {
    it('register(instrument) продолжает работать: get/getAll видят инструмент', () => {
      catalog.register(makeInstrument(YES_TOKEN, MARKET_ID));

      expect(catalog.get(YES_TOKEN)?.instrumentId).toBe(YES_TOKEN);
      expect(catalog.getAll()).toHaveLength(1);
    });

    it('getAllByMarketId возвращает ВСЕ outcome-токены рынка', () => {
      catalog.register(makeInstrument(YES_TOKEN, MARKET_ID));
      catalog.register(makeInstrument(NO_TOKEN, MARKET_ID));
      catalog.register(makeInstrument(OTHER_TOKEN, OTHER_MARKET_ID));

      const all = catalog.getAllByMarketId(MARKET_ID);
      expect(all).toHaveLength(2);
      expect(all.map((i) => i.instrumentId).sort()).toEqual([NO_TOKEN, YES_TOKEN].sort());
    });

    it('getAnyInstrumentByMarketIdForMetadataOnly возвращает один инструмент рынка', () => {
      catalog.register(makeInstrument(YES_TOKEN, MARKET_ID));
      catalog.register(makeInstrument(NO_TOKEN, MARKET_ID));

      const found = catalog.getAnyInstrumentByMarketIdForMetadataOnly(MARKET_ID);
      expect(found).toBeDefined();
      expect([YES_TOKEN, NO_TOKEN]).toContain(found?.instrumentId);
    });

    it('getAnyInstrumentByMarketIdForMetadataOnly возвращает undefined для неизвестного рынка', () => {
      expect(catalog.getAnyInstrumentByMarketIdForMetadataOnly(MARKET_ID)).toBeUndefined();
    });

    it('deprecated getByMarketId работает как alias', () => {
      catalog.register(makeInstrument(YES_TOKEN, MARKET_ID));

      expect(catalog.getByMarketId(MARKET_ID)).toEqual(
        catalog.getAnyInstrumentByMarketIdForMetadataOnly(MARKET_ID),
      );
      expect(catalog.getByMarketId(OTHER_MARKET_ID)).toBeUndefined();
    });
  });

  describe('registerMarket', () => {
    it('регистрирует несколько инструментов одного marketId', () => {
      catalog.registerMarket({
        marketId: MARKET_ID,
        instruments: [makeInstrument(YES_TOKEN, MARKET_ID), makeInstrument(NO_TOKEN, MARKET_ID)],
      });

      expect(catalog.getAllByMarketId(MARKET_ID)).toHaveLength(2);
    });

    it('не делает partial mutation при instrument с чужим marketId — бросает, каталог не изменён', () => {
      expect(() =>
        catalog.registerMarket({
          marketId: MARKET_ID,
          instruments: [
            makeInstrument(YES_TOKEN, MARKET_ID),
            makeInstrument(OTHER_TOKEN, OTHER_MARKET_ID),
          ],
        }),
      ).toThrow(/belongs to market/);

      expect(catalog.getAll()).toHaveLength(0);
    });

    it('пустой instruments — бросает Error', () => {
      expect(() => catalog.registerMarket({ marketId: MARKET_ID, instruments: [] })).toThrow(
        /empty instruments/,
      );
    });

    it('upsert: повторный registerMarket обновляет существующие инструменты без дублей', () => {
      catalog.registerMarket({
        marketId: MARKET_ID,
        instruments: [makeInstrument(YES_TOKEN, MARKET_ID), makeInstrument(NO_TOKEN, MARKET_ID)],
      });
      catalog.registerMarket({
        marketId: MARKET_ID,
        instruments: [{ ...makeInstrument(YES_TOKEN, MARKET_ID), active: false }],
      });

      expect(catalog.getAllByMarketId(MARKET_ID)).toHaveLength(2);
      expect(catalog.get(YES_TOKEN)?.active).toBe(false);
      expect(catalog.get(NO_TOKEN)?.active).toBe(true);
    });
  });

  describe('removeMarket', () => {
    it('удаляет все инструменты рынка, не трогая другие рынки', () => {
      catalog.registerMarket({
        marketId: MARKET_ID,
        instruments: [makeInstrument(YES_TOKEN, MARKET_ID), makeInstrument(NO_TOKEN, MARKET_ID)],
      });
      catalog.register(makeInstrument(OTHER_TOKEN, OTHER_MARKET_ID));

      catalog.removeMarket(MARKET_ID);

      expect(catalog.getAllByMarketId(MARKET_ID)).toHaveLength(0);
      expect(catalog.get(YES_TOKEN)).toBeUndefined();
      expect(catalog.get(NO_TOKEN)).toBeUndefined();
      expect(catalog.get(OTHER_TOKEN)).toBeDefined();
    });

    it('unknown marketId — no-op, не бросает', () => {
      expect(() => catalog.removeMarket(MARKET_ID)).not.toThrow();
      expect(catalog.getAll()).toHaveLength(0);
    });
  });
});
