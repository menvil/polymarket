/**
 * Тесты TradeIndexCollector (пассивный буфер построенных Trade, Этап 2/7).
 *
 * @remarks
 * `record`/`get` — базовый буфер по точному VenueTradeId (почти всегда miss на
 * реальном трафике, см. TSDoc класса). `findMatch` — реальный путь
 * `ExecutionLinker` (Этап 7): fuzzy/windowed matching по (tokenId, price, size,
 * временное окно).
 */
import { describe, it, expect } from '@jest/globals';
import { PaperClock } from '@polymarket/time';
import { TradeIndexCollector } from '../src/TradeIndexCollector.js';
import { asVenueTradeId, asVenueId, parseAssetId, unsafeMarketId } from '@polymarket/ids';
import type { AssetId } from '@polymarket/ids';
import { OutcomePrice, Quantity } from '@polymarket/value-objects';
import { TimestampService } from '@polymarket/timestamp';
import type { Timestamp } from '@polymarket/timestamp';
import { Trade } from '@polymarket/trade';
import Decimal from 'decimal.js';

function makeTs(ms: number): Timestamp {
  const r = TimestampService.create(ms);
  if (!r.ok) throw new Error(`bad ts ${ms}`);
  return r.value;
}
const px = (v: string): OutcomePrice => OutcomePrice.of(new Decimal(v));
const qty = (v: string): Quantity => Quantity.of(new Decimal(v));

const T0 = 1_700_000_000_000;
const TOKEN_A = parseAssetId('62305814799875783974460176688386847666394972778903073967664089920408777315323')!;
const TOKEN_B = parseAssetId('11111111111111111111111111111111111111111111111111111111111111111111111111')!;
const VENUE_ID = asVenueId('POLYMARKET')!;
const MARKET_ID = unsafeMarketId('0xb9ed6ed97ce9146ef1a01278d5fc0f8bd04050a69f0a5568a66075b3c0c6b2c3');

function makeTrade(overrides: {
  idSuffix: string;
  tokenId?: AssetId;
  price?: string;
  size?: string;
  ms?: number;
}): Trade {
  const result = Trade.create({
    id: asVenueTradeId(`trade-${overrides.idSuffix}`)!,
    venueId: VENUE_ID,
    marketId: MARKET_ID,
    tokenId: overrides.tokenId ?? TOKEN_A,
    price: px(overrides.price ?? '0.65'),
    size: qty(overrides.size ?? '100'),
    aggressorSide: 'BUY',
    timestamp: makeTs(overrides.ms ?? T0),
  });
  if (!result.ok) throw new Error(`Failed to build test Trade: ${result.error.message}`);
  return result.value;
}

function makeIndex(config: { maxCount?: number; maxAgeMs?: number } = { maxCount: 1000 }): TradeIndexCollector {
  const result = TradeIndexCollector.create(config, new PaperClock(new Date(T0)));
  if (!result.ok) throw new Error(`Failed to create TradeIndexCollector: ${result.error.message}`);
  return result.value;
}

describe('TradeIndexCollector', () => {
  describe('create', () => {
    it('Ok для валидной retention-политики', () => {
      const result = TradeIndexCollector.create({ maxCount: 100 }, new PaperClock(new Date(T0)));
      expect(result.ok).toBe(true);
    });

    it('Err для пустой политики (ни maxCount, ни maxAgeMs)', () => {
      const result = TradeIndexCollector.create({}, new PaperClock(new Date(T0)));
      expect(result.ok).toBe(false);
    });
  });

  describe('record / get / size / isEmpty', () => {
    it('пустой индекс: isEmpty=true, size=0, get всегда undefined', () => {
      const index = makeIndex();
      expect(index.isEmpty()).toBe(true);
      expect(index.size()).toBe(0);
      expect(index.get(asVenueTradeId('trade-missing')!)).toBeUndefined();
    });

    it('record добавляет Trade, get находит по точному id', () => {
      const index = makeIndex();
      const trade = makeTrade({ idSuffix: '1' });
      index.record(trade);
      expect(index.isEmpty()).toBe(false);
      expect(index.size()).toBe(1);
      expect(index.get(trade.id)).toBe(trade);
    });

    it('get возвращает undefined для несуществующего id', () => {
      const index = makeIndex();
      index.record(makeTrade({ idSuffix: '1' }));
      expect(index.get(asVenueTradeId('trade-nonexistent')!)).toBeUndefined();
    });
  });

  describe('findMatch', () => {
    it('находит Trade по точному совпадению tokenId+price+size в пределах окна', () => {
      const index = makeIndex();
      const trade = makeTrade({ idSuffix: '1', ms: T0 });
      index.record(trade);

      const found = index.findMatch(TOKEN_A, px('0.65'), qty('100'), makeTs(T0 + 1000), 30_000);
      expect(found).toBe(trade);
    });

    it('не находит совпадение при другом tokenId', () => {
      const index = makeIndex();
      index.record(makeTrade({ idSuffix: '1', tokenId: TOKEN_A, ms: T0 }));

      const found = index.findMatch(TOKEN_B, px('0.65'), qty('100'), makeTs(T0 + 1000), 30_000);
      expect(found).toBeUndefined();
    });

    it('не находит совпадение при другой цене', () => {
      const index = makeIndex();
      index.record(makeTrade({ idSuffix: '1', price: '0.65', ms: T0 }));

      const found = index.findMatch(TOKEN_A, px('0.70'), qty('100'), makeTs(T0 + 1000), 30_000);
      expect(found).toBeUndefined();
    });

    it('не находит совпадение при другом размере', () => {
      const index = makeIndex();
      index.record(makeTrade({ idSuffix: '1', size: '100', ms: T0 }));

      const found = index.findMatch(TOKEN_A, px('0.65'), qty('50'), makeTs(T0 + 1000), 30_000);
      expect(found).toBeUndefined();
    });

    it('не находит совпадение вне временного окна (слишком старый трейд)', () => {
      const index = makeIndex();
      index.record(makeTrade({ idSuffix: '1', ms: T0 }));

      // atOrBefore = T0 + 60_000, windowMs = 30_000 → окно [T0+30_000, T0+60_000], трейд в T0 вне окна.
      const found = index.findMatch(TOKEN_A, px('0.65'), qty('100'), makeTs(T0 + 60_000), 30_000);
      expect(found).toBeUndefined();
    });

    it('не находит совпадение для трейда ПОЗЖЕ atOrBefore (будущее относительно fill)', () => {
      const index = makeIndex();
      index.record(makeTrade({ idSuffix: '1', ms: T0 + 5000 }));

      const found = index.findMatch(TOKEN_A, px('0.65'), qty('100'), makeTs(T0), 30_000);
      expect(found).toBeUndefined();
    });

    it('граничное значение: трейд ровно на границе окна (atOrBefore - windowMs) — находится', () => {
      const index = makeIndex();
      index.record(makeTrade({ idSuffix: '1', ms: T0 }));

      const found = index.findMatch(TOKEN_A, px('0.65'), qty('100'), makeTs(T0 + 30_000), 30_000);
      expect(found).toBeDefined();
    });

    it('граничное значение: трейд ровно на atOrBefore — находится', () => {
      const index = makeIndex();
      const trade = makeTrade({ idSuffix: '1', ms: T0 });
      index.record(trade);

      const found = index.findMatch(TOKEN_A, px('0.65'), qty('100'), makeTs(T0), 30_000);
      expect(found).toBe(trade);
    });

    it('несколько подходящих трейдов — возвращает ближайший по времени к atOrBefore', () => {
      const index = makeIndex();
      const older = makeTrade({ idSuffix: 'older', ms: T0 });
      const closer = makeTrade({ idSuffix: 'closer', ms: T0 + 5000 });
      index.record(older);
      index.record(closer);

      const found = index.findMatch(TOKEN_A, px('0.65'), qty('100'), makeTs(T0 + 6000), 30_000);
      expect(found).toBe(closer);
    });

    it('пустой индекс — всегда undefined', () => {
      const index = makeIndex();
      const found = index.findMatch(TOKEN_A, px('0.65'), qty('100'), makeTs(T0), 30_000);
      expect(found).toBeUndefined();
    });
  });
});
