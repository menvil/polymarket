/**
 * Тесты для TradeMapper
 */

import { TradeMapper } from '../../src/mappers/TradeMapper';

// ==================== Helpers ====================

function makeValidEvent(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    market: '0xmarket123abc',
    asset_id: JSON.stringify({
      type: 'OUTCOME_TOKEN',
      conditionRef: { type: 'OFF_CHAIN', conditionId: 'condition-test-123' },
      outcomeKey: 'YES',
    }),
    price: '0.65',
    size: '100',
    side: 'BUY',
    timestamp: '1700000000',
    transaction_hash: '0xabcdef1234567890',
    ...overrides,
  };
}

// ==================== Tests ====================

describe('TradeMapper', () => {
  describe('fromPolymarketLastTradeEvent()', () => {
    it('парсит валидное событие в Trade', () => {
      const result = TradeMapper.fromPolymarketLastTradeEvent(makeValidEvent());

      expect(result.ok).toBe(true);
      if (result.ok) {
        const trade = result.value;
        expect(trade.marketId).toBe('0xmarket123abc');
        expect(trade.aggressorSide).toBe('BUY');
        expect(trade.price.value().toNumber()).toBeCloseTo(0.65, 5);
        expect(trade.size.value().toNumber()).toBeCloseTo(100, 5);
        expect(trade.timestamp.value).toBe(1700000000000); // секунды → мс
        expect(trade.venueId).toBe('POLYMARKET');
      }
    });

    it('генерирует VenueTradeId из txHash + timestamp', () => {
      const result = TradeMapper.fromPolymarketLastTradeEvent(makeValidEvent());

      expect(result.ok).toBe(true);
      if (result.ok) {
        // VenueTradeId = txHash_timestamp
        expect(result.value.id).toContain('0xabcdef1234567890');
        expect(result.value.id).toContain('1700000000');
      }
    });

    it('генерирует VenueTradeId из market+asset+timestamp если нет txHash', () => {
      const event = makeValidEvent({ transaction_hash: undefined });
      const result = TradeMapper.fromPolymarketLastTradeEvent(event);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toContain('1700000000');
        expect(result.value.txHash).toBeUndefined();
      }
    });

    it('парсит SELL сторону', () => {
      const result = TradeMapper.fromPolymarketLastTradeEvent(
        makeValidEvent({ side: 'SELL' })
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.aggressorSide).toBe('SELL');
      }
    });

    it('устанавливает aggressorSide undefined для неизвестной стороны', () => {
      const result = TradeMapper.fromPolymarketLastTradeEvent(
        makeValidEvent({ side: 'UNKNOWN' })
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.aggressorSide).toBeUndefined();
      }
    });

    it('принимает числовые price и size', () => {
      const result = TradeMapper.fromPolymarketLastTradeEvent(
        makeValidEvent({ price: 0.65, size: 100 })
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.price.value().toNumber()).toBeCloseTo(0.65, 5);
        expect(result.value.size.value().toNumber()).toBeCloseTo(100, 5);
      }
    });

    it('возвращает Err если market отсутствует', () => {
      const result = TradeMapper.fromPolymarketLastTradeEvent(
        makeValidEvent({ market: undefined })
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('market');
      }
    });

    it('возвращает Err если market пустой', () => {
      const result = TradeMapper.fromPolymarketLastTradeEvent(
        makeValidEvent({ market: '' })
      );

      expect(result.ok).toBe(false);
    });

    it('возвращает Err если asset_id отсутствует', () => {
      const result = TradeMapper.fromPolymarketLastTradeEvent(
        makeValidEvent({ asset_id: undefined })
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('asset_id');
      }
    });

    it('возвращает Err если price отсутствует', () => {
      const result = TradeMapper.fromPolymarketLastTradeEvent(
        makeValidEvent({ price: undefined })
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('price');
      }
    });

    it('возвращает Err если price нулевая', () => {
      const result = TradeMapper.fromPolymarketLastTradeEvent(
        makeValidEvent({ price: '0' })
      );

      expect(result.ok).toBe(false);
    });

    it('возвращает Err если price не число', () => {
      const result = TradeMapper.fromPolymarketLastTradeEvent(
        makeValidEvent({ price: 'not-a-number' })
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('price');
      }
    });

    it('возвращает Err если size отсутствует', () => {
      const result = TradeMapper.fromPolymarketLastTradeEvent(
        makeValidEvent({ size: undefined })
      );

      expect(result.ok).toBe(false);
    });

    it('возвращает Err если timestamp отсутствует', () => {
      const result = TradeMapper.fromPolymarketLastTradeEvent(
        makeValidEvent({ timestamp: undefined })
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('timestamp');
      }
    });

    it('возвращает Err если timestamp невалидный', () => {
      const result = TradeMapper.fromPolymarketLastTradeEvent(
        makeValidEvent({ timestamp: 'not-a-timestamp' })
      );

      expect(result.ok).toBe(false);
    });

    it('возвращает Err если timestamp отрицательный', () => {
      const result = TradeMapper.fromPolymarketLastTradeEvent(
        makeValidEvent({ timestamp: '-1000' })
      );

      expect(result.ok).toBe(false);
    });
  });

  describe('toSnapshot() / fromSnapshot()', () => {
    it('round-trip: Trade → snapshot → Trade сохраняет все поля', () => {
      const event = makeValidEvent();
      const original = TradeMapper.fromPolymarketLastTradeEvent(event).value!;

      const snapshot = TradeMapper.toSnapshot(original);
      const restoredResult = TradeMapper.fromSnapshot(snapshot);

      expect(restoredResult.ok).toBe(true);
      if (restoredResult.ok) {
        const restored = restoredResult.value;
        expect(restored.id).toBe(original.id);
        expect(restored.venueId).toBe(original.venueId);
        expect(restored.marketId).toBe(original.marketId);
        expect(restored.price.value().toNumber()).toBeCloseTo(
          original.price.value().toNumber(),
          5
        );
        expect(restored.size.value().toNumber()).toBeCloseTo(
          original.size.value().toNumber(),
          5
        );
        expect(restored.aggressorSide).toBe(original.aggressorSide);
        expect(restored.timestamp.value).toBe(original.timestamp.value);
      }
    });

    it('fromSnapshot() возвращает Err для невалидного snaphot ID', () => {
      const result = TradeMapper.fromSnapshot({
        id: '',
        venueId: 'POLYMARKET',
        marketId: 'market-1',
        tokenId: '{}',
        price: 0.65,
        size: 100,
        timestampMs: 1700000000000,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('trade ID');
      }
    });

    it('fromSnapshot() возвращает Err для невалидного venueId', () => {
      const result = TradeMapper.fromSnapshot({
        id: 'valid-trade-id',
        venueId: '',
        marketId: 'market-1',
        tokenId: '{}',
        price: 0.65,
        size: 100,
        timestampMs: 1700000000000,
      });

      expect(result.ok).toBe(false);
    });
  });
});
