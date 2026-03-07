/**
 * Тесты для TradeMapper
 */

import { TradeMapper } from '../../src/mappers/TradeMapper';

// Вспомогательная функция для извлечения значения из Result в тестах
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }, ctx = ''): T {
  if (!result.ok) throw new Error(`Expected Ok result in test setup${ctx ? `: ${ctx}` : ''}`);
  return result.value;
}

// ==================== Helpers ====================

/**
 * Валидный AssetId в строковом формате для тестов
 * Формат: OUTCOME_TOKEN:ONCHAIN:protocolId:chainId:conditionId:outcomeKey
 */
const TEST_TOKEN_ID = `OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:0x${'a'.repeat(64)}:YES`;

/**
 * Реальное событие last_trade_price из Polymarket API.
 * asset_id — числовой CTF token ID; timestamp — в миллисекундах.
 */
const REAL_POLYMARKET_EVENT: Record<string, unknown> = {
  market: '0xb9ed6ed97ce9146ef1a01278d5fc0f8bd04050a69f0a5568a66075b3c0c6b2c3',
  asset_id: '62305814799875783974460176688386847666394972778903073967664089920408777315323',
  price: '0.44',
  size: '7.861135',
  fee_rate_bps: '0',
  side: 'BUY',
  timestamp: '1767463212903',
  event_type: 'last_trade_price',
  transaction_hash: '0x989369fbc370b9384be69c36876e25170f25d87a83ef1413cbf7ca6913533f21',
};

function makeValidEvent(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    market: '0xmarket123abc',
    asset_id: TEST_TOKEN_ID,
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
    it('возвращает Err если raw === null', () => {
      const result = TradeMapper.fromPolymarketLastTradeEvent(
        null as unknown as Record<string, unknown>
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('expected non-null object');
      }
    });

    it('возвращает Err если raw — массив', () => {
      const result = TradeMapper.fromPolymarketLastTradeEvent(
        [] as unknown as Record<string, unknown>
      );

      expect(result.ok).toBe(false);
    });

    it('возвращает Err если raw — примитив', () => {
      const result = TradeMapper.fromPolymarketLastTradeEvent(
        42 as unknown as Record<string, unknown>
      );

      expect(result.ok).toBe(false);
    });

    it('парсит валидное событие в Trade', () => {
      const result = TradeMapper.fromPolymarketLastTradeEvent(makeValidEvent());

      expect(result.ok).toBe(true);
      if (result.ok) {
        const trade = result.value;
        expect(trade.marketId).toBe('0xmarket123abc');
        expect(trade.aggressorSide).toBe('BUY');
        expect(trade.price.value().toNumber()).toBeCloseTo(0.65, 5);
        expect(trade.size.value().toNumber()).toBeCloseTo(100, 5);
        expect(trade.timestamp.toNumber()).toBe(1700000000000); // секунды → мс
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

  describe('реальное событие Polymarket (REAL_POLYMARKET_EVENT)', () => {
    it('парсит реальный last_trade_price event', () => {
      const result = TradeMapper.fromPolymarketLastTradeEvent(REAL_POLYMARKET_EVENT);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const trade = result.value;
        expect(trade.marketId).toBe(
          '0xb9ed6ed97ce9146ef1a01278d5fc0f8bd04050a69f0a5568a66075b3c0c6b2c3'
        );
        expect(trade.aggressorSide).toBe('BUY');
        expect(trade.price.value().toNumber()).toBeCloseTo(0.44, 5);
        expect(trade.size.value().toNumber()).toBeCloseTo(7.861135, 5);
        // timestamp в ms — не умножается на 1000
        expect(trade.timestamp.toNumber()).toBe(1767463212903);
        expect(trade.venueId).toBe('POLYMARKET');
      }
    });

    it('asset_id числовой CTF token ID → тип POLYMARKET_CTF_TOKEN', () => {
      const result = TradeMapper.fromPolymarketLastTradeEvent(REAL_POLYMARKET_EVENT);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.tokenId.type).toBe('POLYMARKET_CTF_TOKEN');
        if (result.value.tokenId.type === 'POLYMARKET_CTF_TOKEN') {
          expect(result.value.tokenId.tokenId).toBe(
            '62305814799875783974460176688386847666394972778903073967664089920408777315323'
          );
        }
      }
    });

    it('VenueTradeId генерируется из txHash + timestamp (мс)', () => {
      const result = TradeMapper.fromPolymarketLastTradeEvent(REAL_POLYMARKET_EVENT);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toContain(
          '0x989369fbc370b9384be69c36876e25170f25d87a83ef1413cbf7ca6913533f21'
        );
        expect(result.value.id).toContain('1767463212903');
      }
    });

    it('игнорирует лишние поля (fee_rate_bps, event_type)', () => {
      const result = TradeMapper.fromPolymarketLastTradeEvent(REAL_POLYMARKET_EVENT);
      expect(result.ok).toBe(true);
    });

    it('round-trip реального события через snapshot', () => {
      const original = unwrap(TradeMapper.fromPolymarketLastTradeEvent(REAL_POLYMARKET_EVENT));

      const snapshot = TradeMapper.toSnapshot(original);
      const restored = unwrap(TradeMapper.fromSnapshot(snapshot));

      expect(restored.id).toBe(original.id);
      expect(restored.price.value().toString()).toBe(original.price.value().toString());
      expect(restored.size.value().toString()).toBe(original.size.value().toString());
      expect(restored.timestamp.toNumber()).toBe(original.timestamp.toNumber());
    });
  });

  describe('автоопределение формата timestamp (секунды vs мс)', () => {
    it('timestamp в секундах (10 цифр) конвертируется в мс', () => {
      const result = TradeMapper.fromPolymarketLastTradeEvent(makeValidEvent());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.timestamp.toNumber()).toBe(1700000000000);
      }
    });

    it('timestamp в миллисекундах (13 цифр) не умножается на 1000', () => {
      const result = TradeMapper.fromPolymarketLastTradeEvent(
        makeValidEvent({ timestamp: '1700000000000' })
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.timestamp.toNumber()).toBe(1700000000000);
      }
    });
  });

  describe('toSnapshot() / fromSnapshot()', () => {
    it('round-trip: Trade → snapshot → Trade сохраняет все поля', () => {
      const event = makeValidEvent();
      const original = unwrap(TradeMapper.fromPolymarketLastTradeEvent(event));

      const snapshot = TradeMapper.toSnapshot(original);
      const restoredResult = TradeMapper.fromSnapshot(snapshot);

      expect(restoredResult.ok).toBe(true);
      if (restoredResult.ok) {
        const restored = restoredResult.value;
        expect(restored.id).toBe(original.id);
        expect(restored.venueId).toBe(original.venueId);
        expect(restored.marketId).toBe(original.marketId);
        expect(restored.price.value().toString()).toBe(original.price.value().toString());
        expect(restored.size.value().toString()).toBe(original.size.value().toString());
        expect(restored.aggressorSide).toBe(original.aggressorSide);
        expect(restored.timestamp.toNumber()).toBe(original.timestamp.toNumber());
      }
    });

    it('fromSnapshot() возвращает Err если marketId состоит из пробелов', () => {
      const result = TradeMapper.fromSnapshot({
        id: 'valid-trade-id',
        venueId: 'POLYMARKET',
        marketId: '   ',
        tokenId: TEST_TOKEN_ID,
        price: '0.65',
        size: '100',
        timestampMs: 1700000000000,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('marketId');
      }
    });

    it('fromSnapshot() возвращает Err если tokenId не парсится', () => {
      const result = TradeMapper.fromSnapshot({
        id: 'valid-trade-id',
        venueId: 'POLYMARKET',
        marketId: 'market-1',
        tokenId: 'not-a-valid-token-id',
        price: '0.65',
        size: '100',
        timestampMs: 1700000000000,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('tokenId');
      }
    });

    it('fromSnapshot() возвращает Err если price нулевая', () => {
      const result = TradeMapper.fromSnapshot({
        id: 'valid-trade-id',
        venueId: 'POLYMARKET',
        marketId: 'market-1',
        tokenId: TEST_TOKEN_ID,
        price: '0',
        size: '100',
        timestampMs: 1700000000000,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('price');
      }
    });

    it('fromSnapshot() возвращает Err если price отрицательная', () => {
      const result = TradeMapper.fromSnapshot({
        id: 'valid-trade-id',
        venueId: 'POLYMARKET',
        marketId: 'market-1',
        tokenId: TEST_TOKEN_ID,
        price: '-0.5',
        size: '100',
        timestampMs: 1700000000000,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('price');
      }
    });

    it('fromSnapshot() возвращает Err если price NaN', () => {
      const result = TradeMapper.fromSnapshot({
        id: 'valid-trade-id',
        venueId: 'POLYMARKET',
        marketId: 'market-1',
        tokenId: TEST_TOKEN_ID,
        price: 'NaN',
        size: '100',
        timestampMs: 1700000000000,
      });

      expect(result.ok).toBe(false);
    });

    it('fromSnapshot() возвращает Err если size отрицательный', () => {
      const result = TradeMapper.fromSnapshot({
        id: 'valid-trade-id',
        venueId: 'POLYMARKET',
        marketId: 'market-1',
        tokenId: TEST_TOKEN_ID,
        price: '0.65',
        size: '-10',
        timestampMs: 1700000000000,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('size');
      }
    });

    it('fromSnapshot() возвращает Err если size нулевой', () => {
      const result = TradeMapper.fromSnapshot({
        id: 'valid-trade-id',
        venueId: 'POLYMARKET',
        marketId: 'market-1',
        tokenId: TEST_TOKEN_ID,
        price: '0.65',
        size: '0',
        timestampMs: 1700000000000,
      });

      expect(result.ok).toBe(false);
    });

    it('fromSnapshot() возвращает Err если timestampMs NaN', () => {
      const result = TradeMapper.fromSnapshot({
        id: 'valid-trade-id',
        venueId: 'POLYMARKET',
        marketId: 'market-1',
        tokenId: TEST_TOKEN_ID,
        price: '0.65',
        size: '100',
        timestampMs: NaN,
      });

      expect(result.ok).toBe(false);
    });

    it('fromSnapshot() сохраняет txHash при round-trip', () => {
      const snapshot = {
        id: 'valid-trade-id',
        venueId: 'POLYMARKET',
        marketId: 'market-1',
        tokenId: TEST_TOKEN_ID,
        price: '0.65',
        size: '100',
        timestampMs: 1700000000000,
        txHash: '0xabcdef1234567890',
      };

      const result = TradeMapper.fromSnapshot(snapshot);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.txHash).toBe(snapshot.txHash);
      }
    });

    it('fromSnapshot() восстанавливает агрессора (aggressorSide)', () => {
      const snapshot = {
        id: 'valid-trade-id',
        venueId: 'POLYMARKET',
        marketId: 'market-1',
        tokenId: TEST_TOKEN_ID,
        price: '0.65',
        size: '100',
        timestampMs: 1700000000000,
        aggressorSide: 'SELL' as const,
      };

      const result = TradeMapper.fromSnapshot(snapshot);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.aggressorSide).toBe('SELL');
      }
    });

    it('fromSnapshot() возвращает Err для невалидного snapshot ID', () => {
      const result = TradeMapper.fromSnapshot({
        id: '',
        venueId: 'POLYMARKET',
        marketId: 'market-1',
        tokenId: TEST_TOKEN_ID,
        price: '0.65',
        size: '100',
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
        tokenId: TEST_TOKEN_ID,
        price: '0.65',
        size: '100',
        timestampMs: 1700000000000,
      });

      expect(result.ok).toBe(false);
    });
  });
});
