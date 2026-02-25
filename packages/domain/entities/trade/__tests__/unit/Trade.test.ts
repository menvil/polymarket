/**
 * Тесты для Trade entity
 */

import { Trade } from '../../src/Trade';
import type { TradeParams } from '../../src/Trade';
import { asVenueTradeId, asVenueId, parseAssetId } from '@polymarket/ids';
import { Price, Quantity, Timestamp } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

// ==================== Helpers ====================

/**
 * Создаёт валидный AssetId для тестов
 */
function makeTokenId() {
  return parseAssetId(JSON.stringify({
    type: 'OUTCOME_TOKEN',
    conditionRef: {
      type: 'OFF_CHAIN',
      conditionId: 'condition-test-123',
    },
    outcomeKey: 'YES',
  }));
}

/**
 * Создаёт базовые параметры для валидного Trade
 */
function makeValidParams(overrides?: Partial<TradeParams>): TradeParams {
  const tokenId = makeTokenId();
  if (!tokenId) throw new Error('Test setup: invalid tokenId');

  return {
    id: asVenueTradeId('0xabc_1700000000000')!,
    venueId: asVenueId('POLYMARKET')!,
    marketId: 'market-abc',
    tokenId,
    price: Price.of(new Decimal('0.65')),
    size: Quantity.of(new Decimal('100')),
    aggressorSide: 'BUY',
    timestamp: Timestamp.fromEpochMs(1700000000000).value!,
    ...overrides,
  };
}

// ==================== Tests ====================

describe('Trade', () => {
  describe('create()', () => {
    it('создаёт валидный Trade со всеми полями', () => {
      const params = makeValidParams();
      const result = Trade.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const trade = result.value;
        expect(trade.id).toBe('0xabc_1700000000000');
        expect(trade.venueId).toBe('POLYMARKET');
        expect(trade.marketId).toBe('market-abc');
        expect(trade.aggressorSide).toBe('BUY');
        expect(trade.price.value().toNumber()).toBe(0.65);
        expect(trade.size.value().toNumber()).toBe(100);
        expect(trade.timestamp.value).toBe(1700000000000);
      }
    });

    it('создаёт Trade без aggressorSide (опционально)', () => {
      const params = makeValidParams({ aggressorSide: undefined });
      const result = Trade.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.aggressorSide).toBeUndefined();
        expect(result.value.isBuy()).toBe(false);
        expect(result.value.isSell()).toBe(false);
      }
    });

    it('создаёт Trade без txHash (опционально)', () => {
      const params = makeValidParams({ txHash: undefined });
      const result = Trade.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.txHash).toBeUndefined();
      }
    });

    it('возвращает Err если id пустой', () => {
      // Нельзя передать пустой VenueTradeId напрямую (branded type)
      // Проверяем через null-подобное значение
      const params = makeValidParams({ id: '' as ReturnType<typeof asVenueTradeId> });
      const result = Trade.create(params);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Trade ID is required');
      }
    });

    it('возвращает Err если venueId пустой', () => {
      const params = makeValidParams({ venueId: '' as ReturnType<typeof asVenueId> });
      const result = Trade.create(params);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Venue ID is required');
      }
    });

    it('возвращает Err если marketId пустой', () => {
      const params = makeValidParams({ marketId: '' });
      const result = Trade.create(params);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Market ID is required');
      }
    });

    it('возвращает Err если marketId только пробелы', () => {
      const params = makeValidParams({ marketId: '   ' });
      const result = Trade.create(params);

      expect(result.ok).toBe(false);
    });

    it('возвращает Err если price нулевая', () => {
      const params = makeValidParams({ price: Price.of(new Decimal('0')) });
      const result = Trade.create(params);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('price must be positive');
      }
    });

    it('возвращает Err если price отрицательная', () => {
      // Price.of с отрицательным может выбросить или вернуть невалидный Price
      // Тест инварианта Trade
      const params = makeValidParams({ price: Price.of(new Decimal('-0.1')) });
      const result = Trade.create(params);

      expect(result.ok).toBe(false);
    });

    it('возвращает Err если size нулевой', () => {
      // Quantity.of(0) может быть валиден, но Trade требует size > 0
      const params = makeValidParams({ size: Quantity.of(new Decimal('0')) });
      const result = Trade.create(params);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('size must be positive');
      }
    });
  });

  describe('getNotional()', () => {
    it('вычисляет notional как price × size', () => {
      const params = makeValidParams({
        price: Price.of(new Decimal('0.65')),
        size: Quantity.of(new Decimal('100')),
      });
      const result = Trade.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.getNotional().toNumber()).toBeCloseTo(65, 5);
      }
    });

    it('вычисляет нотионал для дробных значений', () => {
      const params = makeValidParams({
        price: Price.of(new Decimal('0.333')),
        size: Quantity.of(new Decimal('30')),
      });
      const result = Trade.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.getNotional().toNumber()).toBeCloseTo(9.99, 5);
      }
    });
  });

  describe('isBuy() / isSell()', () => {
    it('isBuy() возвращает true если aggressorSide === BUY', () => {
      const trade = Trade.create(makeValidParams({ aggressorSide: 'BUY' })).value!;
      expect(trade.isBuy()).toBe(true);
      expect(trade.isSell()).toBe(false);
    });

    it('isSell() возвращает true если aggressorSide === SELL', () => {
      const trade = Trade.create(makeValidParams({ aggressorSide: 'SELL' })).value!;
      expect(trade.isSell()).toBe(true);
      expect(trade.isBuy()).toBe(false);
    });

    it('оба возвращают false если aggressorSide undefined', () => {
      const trade = Trade.create(makeValidParams({ aggressorSide: undefined })).value!;
      expect(trade.isBuy()).toBe(false);
      expect(trade.isSell()).toBe(false);
    });
  });

  describe('compareByTime()', () => {
    it('возвращает отрицательное значение если this раньше', () => {
      const earlier = Trade.create(
        makeValidParams({ timestamp: Timestamp.fromEpochMs(1000000000000).value! })
      ).value!;
      const later = Trade.create(
        makeValidParams({ timestamp: Timestamp.fromEpochMs(2000000000000).value! })
      ).value!;

      expect(earlier.compareByTime(later)).toBeLessThan(0);
    });

    it('возвращает положительное значение если this позже', () => {
      const earlier = Trade.create(
        makeValidParams({ timestamp: Timestamp.fromEpochMs(1000000000000).value! })
      ).value!;
      const later = Trade.create(
        makeValidParams({ timestamp: Timestamp.fromEpochMs(2000000000000).value! })
      ).value!;

      expect(later.compareByTime(earlier)).toBeGreaterThan(0);
    });

    it('возвращает 0 если trades одновременные', () => {
      const ts = Timestamp.fromEpochMs(1700000000000).value!;
      const trade1 = Trade.create(makeValidParams({ timestamp: ts })).value!;
      const trade2 = Trade.create(makeValidParams({ timestamp: ts })).value!;

      expect(trade1.compareByTime(trade2)).toBe(0);
    });

    it('сортировка массива trades по времени', () => {
      const t1 = Trade.create(
        makeValidParams({ timestamp: Timestamp.fromEpochMs(1000000000000).value! })
      ).value!;
      const t2 = Trade.create(
        makeValidParams({ timestamp: Timestamp.fromEpochMs(2000000000000).value! })
      ).value!;
      const t3 = Trade.create(
        makeValidParams({ timestamp: Timestamp.fromEpochMs(3000000000000).value! })
      ).value!;

      const sorted = [t3, t1, t2].sort((a, b) => a.compareByTime(b));
      expect(sorted[0]).toBe(t1);
      expect(sorted[1]).toBe(t2);
      expect(sorted[2]).toBe(t3);
    });
  });

  describe('toSnapshot()', () => {
    it('сериализует Trade в плоский снапшот', () => {
      const params = makeValidParams();
      const trade = Trade.create(params).value!;
      const snapshot = trade.toSnapshot();

      expect(snapshot.id).toBe('0xabc_1700000000000');
      expect(snapshot.venueId).toBe('POLYMARKET');
      expect(snapshot.marketId).toBe('market-abc');
      expect(snapshot.price).toBe(0.65);
      expect(snapshot.size).toBe(100);
      expect(snapshot.aggressorSide).toBe('BUY');
      expect(snapshot.timestampMs).toBe(1700000000000);
    });

    it('сериализует Trade без aggressorSide', () => {
      const params = makeValidParams({ aggressorSide: undefined });
      const trade = Trade.create(params).value!;
      const snapshot = trade.toSnapshot();

      expect(snapshot.aggressorSide).toBeUndefined();
    });
  });

  describe('toString()', () => {
    it('возвращает читаемую строку', () => {
      const trade = Trade.create(makeValidParams()).value!;
      const str = trade.toString();

      expect(str).toContain('Trade[');
      expect(str).toContain('BUY');
      expect(str).toContain('100');
      expect(str).toContain('0.65');
      expect(str).toContain('POLYMARKET');
    });

    it('возвращает UNKNOWN для неизвестной стороны', () => {
      const trade = Trade.create(makeValidParams({ aggressorSide: undefined })).value!;
      expect(trade.toString()).toContain('UNKNOWN');
    });
  });
});
