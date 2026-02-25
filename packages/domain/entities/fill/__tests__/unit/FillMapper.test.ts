/**
 * Тесты для FillMapper
 */

import { FillMapper } from '../../src/mappers/FillMapper';
import { parseAssetId } from '@polymarket/ids';
import type { Fill } from '../../src/Fill';
import type { FillSnapshot } from '../../src/FillSnapshot';

// Вспомогательная функция для извлечения значения из Result в тестах
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }, ctx = ''): T {
  if (!result.ok) throw new Error(`Expected Ok result in test setup${ctx ? `: ${ctx}` : ''}`);
  return result.value;
}

// ==================== Helpers ====================

function makeValidEvent(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    fill_id: 'fill-123',
    order_id: 'order-456',
    account_id: 'wallet:0x1234567890abcdef1234567890abcdef12345678',
    market: '0xmarket123abc',
    asset_id: JSON.stringify({
      type: 'OUTCOME_TOKEN',
      conditionRef: { type: 'OFF_CHAIN', conditionId: 'condition-test-123' },
      outcomeKey: 'YES',
    }),
    price: '0.65',
    size: '50',
    side: 'BUY',
    timestamp: '1700000000',
    fee_amount: '0.01',
    liquidity: 'MAKER',
    transaction_hash: '0xabcdef1234567890',
    ...overrides,
  };
}

// ==================== Tests ====================

describe('FillMapper', () => {
  describe('fromPolymarketOrderExecutionEvent()', () => {
    it('парсит валидное событие в Fill', () => {
      const result = FillMapper.fromPolymarketOrderExecutionEvent(makeValidEvent());

      expect(result.ok).toBe(true);
      if (result.ok) {
        const fill = result.value;
        expect(fill.id).toBe('fill-123');
        expect(fill.orderId).toBe('order-456');
        expect(fill.marketId).toBe('0xmarket123abc');
        expect(fill.side).toBe('BUY');
        expect(fill.price.value().toNumber()).toBeCloseTo(0.65, 5);
        expect(fill.size.value().toNumber()).toBeCloseTo(50, 5);
        expect(fill.timestamp.value).toBe(1700000000000);
        expect(fill.venueId).toBe('POLYMARKET');
        expect(fill.liquidity).toBe('MAKER');
      }
    });

    it('парсит SELL сторону', () => {
      const result = FillMapper.fromPolymarketOrderExecutionEvent(
        makeValidEvent({ side: 'SELL' })
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.side).toBe('SELL');
      }
    });

    it('принимает нулевую fee', () => {
      const result = FillMapper.fromPolymarketOrderExecutionEvent(
        makeValidEvent({ fee_amount: '0' })
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.hasFee()).toBe(false);
      }
    });

    it('создаёт Fill с liquidity undefined для неизвестного значения', () => {
      const result = FillMapper.fromPolymarketOrderExecutionEvent(
        makeValidEvent({ liquidity: 'UNKNOWN' })
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.liquidity).toBeUndefined();
      }
    });

    it('создаёт venueTradeId из transaction_hash', () => {
      const result = FillMapper.fromPolymarketOrderExecutionEvent(makeValidEvent());

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.venueTradeId).toContain('0xabcdef1234567890');
      }
    });

    it('venueTradeId undefined если нет transaction_hash', () => {
      const result = FillMapper.fromPolymarketOrderExecutionEvent(
        makeValidEvent({ transaction_hash: undefined })
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.venueTradeId).toBeUndefined();
      }
    });

    it('возвращает Err если fill_id отсутствует', () => {
      const result = FillMapper.fromPolymarketOrderExecutionEvent(
        makeValidEvent({ fill_id: undefined })
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('fill_id');
      }
    });

    it('возвращает Err если order_id отсутствует', () => {
      const result = FillMapper.fromPolymarketOrderExecutionEvent(
        makeValidEvent({ order_id: undefined })
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('order_id');
      }
    });

    it('возвращает Err если side невалидный', () => {
      const result = FillMapper.fromPolymarketOrderExecutionEvent(
        makeValidEvent({ side: 'INVALID' })
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('side');
      }
    });

    it('возвращает Err если price нулевая', () => {
      const result = FillMapper.fromPolymarketOrderExecutionEvent(
        makeValidEvent({ price: '0' })
      );

      expect(result.ok).toBe(false);
    });

    it('возвращает Err если timestamp отсутствует', () => {
      const result = FillMapper.fromPolymarketOrderExecutionEvent(
        makeValidEvent({ timestamp: undefined })
      );

      expect(result.ok).toBe(false);
    });
  });

  describe('toSnapshot() / fromSnapshot()', () => {
    it('round-trip: Fill → snapshot → Fill сохраняет основные поля', () => {
      const event = makeValidEvent();
      const original = unwrap(FillMapper.fromPolymarketOrderExecutionEvent(event));

      const snapshot = FillMapper.toSnapshot(original);
      const restoredResult = FillMapper.fromSnapshot(snapshot);

      expect(restoredResult.ok).toBe(true);
      if (restoredResult.ok) {
        const restored = restoredResult.value;
        expect(restored.id).toBe(original.id);
        expect(restored.orderId).toBe(original.orderId);
        expect(restored.venueId).toBe(original.venueId);
        expect(restored.marketId).toBe(original.marketId);
        expect(restored.side).toBe(original.side);
        expect(restored.price.value().toNumber()).toBeCloseTo(
          original.price.value().toNumber(),
          5
        );
        expect(restored.size.value().toNumber()).toBeCloseTo(
          original.size.value().toNumber(),
          5
        );
        expect(restored.timestamp.value).toBe(original.timestamp.value);
        expect(restored.liquidity).toBe(original.liquidity);
      }
    });

    it('fromSnapshot() возвращает Err для невалидного fill ID', () => {
      const tokenId = parseAssetId(JSON.stringify({
        type: 'OUTCOME_TOKEN',
        conditionRef: { type: 'OFF_CHAIN', conditionId: 'condition-test-123' },
        outcomeKey: 'YES',
      }))!;

      const result = FillMapper.fromSnapshot({
        id: '',
        orderId: 'order-456',
        accountId: 'wallet:0x1234567890abcdef1234567890abcdef12345678',
        venueId: 'POLYMARKET',
        marketId: 'market-1',
        tokenId: JSON.stringify(tokenId),
        price: 0.65,
        size: 50,
        side: 'BUY',
        timestampMs: 1700000000000,
        feeAmount: 0,
        feeAsset: JSON.stringify(tokenId),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('fill ID');
      }
    });

    it('fromSnapshot() возвращает Err для невалидного order ID', () => {
      const tokenId = parseAssetId(JSON.stringify({
        type: 'OUTCOME_TOKEN',
        conditionRef: { type: 'OFF_CHAIN', conditionId: 'condition-test-123' },
        outcomeKey: 'YES',
      }))!;

      const result = FillMapper.fromSnapshot({
        id: 'valid-fill-id',
        orderId: '',
        accountId: 'wallet:0x1234567890abcdef1234567890abcdef12345678',
        venueId: 'POLYMARKET',
        marketId: 'market-1',
        tokenId: JSON.stringify(tokenId),
        price: 0.65,
        size: 50,
        side: 'BUY',
        timestampMs: 1700000000000,
        feeAmount: 0,
        feeAsset: JSON.stringify(tokenId),
      });

      expect(result.ok).toBe(false);
    });
  });
});
