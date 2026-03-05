/**
 * Тесты для Trade entity
 */

import { Trade } from '../../src/Trade';
import type { TradeParams } from '../../src/Trade';
import { asVenueTradeId, asVenueId, parseAssetId } from '@polymarket/ids';
import { Price, Quantity, TimestampService } from '@polymarket/value-objects';
import Decimal from 'decimal.js';

// Вспомогательная функция для извлечения значения из Result в тестах
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }, ctx = ''): T {
  if (!result.ok) throw new Error(`Expected Ok result in test setup${ctx ? `: ${ctx}` : ''}`);
  return result.value;
}

// ==================== Helpers ====================

/**
 * Создаёт валидный AssetId для тестов
 * Формат: OUTCOME_TOKEN:ONCHAIN:protocolId:chainId:conditionId:outcomeKey
 */
function makeTokenId() {
  const conditionId = '0x' + 'a'.repeat(64);
  return parseAssetId(`OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:${conditionId}:YES`);
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
    timestamp: unwrap(TimestampService.create(1700000000000), 'Timestamp'),
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
        expect(trade.timestamp.toNumber()).toBe(1700000000000);
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

    it('возвращает ошибку если price нулевая (Price.of бросает исключение)', () => {
      // Price.of() сам бросает PriceInvariantViolation для значений < MIN_PRICE (0.0001)
      // Это означает, что Trade.create() вообще не вызывается с нулевой ценой
      expect(() => {
        Trade.create(makeValidParams({ price: Price.of(new Decimal('0')) }));
      }).toThrow();
    });

    it('возвращает ошибку если price отрицательная (Price.of бросает исключение)', () => {
      // Price.of() бросает PriceInvariantViolation для отрицательных значений
      expect(() => {
        Trade.create(makeValidParams({ price: Price.of(new Decimal('-0.1')) }));
      }).toThrow();
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
      const trade = unwrap(Trade.create(makeValidParams({ aggressorSide: 'BUY' })));
      expect(trade.isBuy()).toBe(true);
      expect(trade.isSell()).toBe(false);
    });

    it('isSell() возвращает true если aggressorSide === SELL', () => {
      const trade = unwrap(Trade.create(makeValidParams({ aggressorSide: 'SELL' })));
      expect(trade.isSell()).toBe(true);
      expect(trade.isBuy()).toBe(false);
    });

    it('оба возвращают false если aggressorSide undefined', () => {
      const trade = unwrap(Trade.create(makeValidParams({ aggressorSide: undefined })));
      expect(trade.isBuy()).toBe(false);
      expect(trade.isSell()).toBe(false);
    });
  });

  describe('compareByTime()', () => {
    it('возвращает отрицательное значение если this раньше', () => {
      const earlier = unwrap(Trade.create(
        makeValidParams({ timestamp: unwrap(TimestampService.create(1000000000000)) })
      ));
      const later = unwrap(Trade.create(
        makeValidParams({ timestamp: unwrap(TimestampService.create(2000000000000)) })
      ));

      expect(earlier.compareByTime(later)).toBeLessThan(0);
    });

    it('возвращает положительное значение если this позже', () => {
      const earlier = unwrap(Trade.create(
        makeValidParams({ timestamp: unwrap(TimestampService.create(1000000000000)) })
      ));
      const later = unwrap(Trade.create(
        makeValidParams({ timestamp: unwrap(TimestampService.create(2000000000000)) })
      ));

      expect(later.compareByTime(earlier)).toBeGreaterThan(0);
    });

    it('возвращает 0 если trades одновременные', () => {
      const ts = unwrap(TimestampService.create(1700000000000));
      const trade1 = unwrap(Trade.create(makeValidParams({ timestamp: ts })));
      const trade2 = unwrap(Trade.create(makeValidParams({ timestamp: ts })));

      expect(trade1.compareByTime(trade2)).toBe(0);
    });

    it('сортировка массива trades по времени', () => {
      const t1 = unwrap(Trade.create(
        makeValidParams({ timestamp: unwrap(TimestampService.create(1000000000000)) })
      ));
      const t2 = unwrap(Trade.create(
        makeValidParams({ timestamp: unwrap(TimestampService.create(2000000000000)) })
      ));
      const t3 = unwrap(Trade.create(
        makeValidParams({ timestamp: unwrap(TimestampService.create(3000000000000)) })
      ));

      const sorted = [t3, t1, t2].sort((a, b) => a.compareByTime(b));
      expect(sorted[0]).toBe(t1);
      expect(sorted[1]).toBe(t2);
      expect(sorted[2]).toBe(t3);
    });
  });

  describe('toSnapshot()', () => {
    it('сериализует Trade в плоский снапшот', () => {
      const params = makeValidParams();
      const trade = unwrap(Trade.create(params));
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
      const trade = unwrap(Trade.create(params));
      const snapshot = trade.toSnapshot();

      expect(snapshot.aggressorSide).toBeUndefined();
    });
  });

  describe('toString()', () => {
    it('возвращает читаемую строку', () => {
      const trade = unwrap(Trade.create(makeValidParams()));
      const str = trade.toString();

      expect(str).toContain('Trade[');
      expect(str).toContain('BUY');
      expect(str).toContain('100');
      expect(str).toContain('0.65');
      expect(str).toContain('POLYMARKET');
    });

    it('возвращает UNKNOWN для неизвестной стороны', () => {
      const trade = unwrap(Trade.create(makeValidParams({ aggressorSide: undefined })));
      expect(trade.toString()).toContain('UNKNOWN');
    });
  });
});
