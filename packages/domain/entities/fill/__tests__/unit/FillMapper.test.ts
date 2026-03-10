/**
 * Тесты для FillMapper
 */

import { FillMapper } from '../../src/mappers/FillMapper';
import {
  AssetIdHelpers,
  assetIdToString,
  accountIdToString,
  accountIdFromWallet,
  parseWalletAddress,
} from '@polymarket/ids';
import type { AccountId } from '@polymarket/ids';
import type { FillSnapshot } from '../../src/FillSnapshot';

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
 * Тестовый AccountId (owner трейда в сессионном контексте)
 */
function makeAccountId(): AccountId {
  const wallet = parseWalletAddress('0x1234567890abcdef1234567890abcdef12345678');
  if (!wallet) throw new Error('Test setup: invalid wallet address');
  return accountIdFromWallet(wallet);
}

/**
 * UUID мейкера — совпадает с owner в maker_orders для тестов
 */
const MAKER_UUID = '9180014b-33c8-9240-a14b-bdca11c0a465';

/**
 * Создаёт валидное Polymarket user-channel trade событие (TAKER)
 */
function makeValidTakerEvent(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    event_type: 'trade',
    type: 'TRADE',
    id: '28c4d2eb-bbea-40e7-a9f0-b2fdb56b2c2e',
    taker_order_id: '0x' + 'a'.repeat(64),
    market: '0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af',
    asset_id: TEST_TOKEN_ID,
    side: 'BUY',
    size: '10',
    price: '0.65',
    fee_rate_bps: '20',
    status: 'MATCHED',
    owner: 'some-uuid-for-taker',
    timestamp: '1700000000',
    trader_side: 'TAKER',
    transaction_hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    maker_orders: [],
    ...overrides,
  };
}

/**
 * Создаёт валидное Polymarket user-channel trade событие (MAKER)
 */
function makeValidMakerEvent(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    event_type: 'trade',
    type: 'TRADE',
    id: '38c4d2eb-bbea-40e7-a9f0-b2fdb56b2c2f',
    taker_order_id: '0x' + 'b'.repeat(64),
    market: '0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af',
    asset_id: TEST_TOKEN_ID,
    side: 'BUY',  // сторона ТЕЙКЕРА
    size: '10',
    price: '0.65',
    fee_rate_bps: '0',
    status: 'MATCHED',
    owner: MAKER_UUID,
    timestamp: '1700000000',
    trader_side: 'MAKER',
    transaction_hash: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567891',
    maker_orders: [
      {
        order_id: '0x' + 'c'.repeat(64),
        matched_amount: '10',
        price: '0.65',
        owner: MAKER_UUID,
      },
    ],
    ...overrides,
  };
}

// ==================== Tests ====================

describe('FillMapper', () => {
  describe('fromPolymarketTradeEvent() — TAKER', () => {
    it('парсит валидное TAKER событие в Fill + ExecutionMetadata', () => {
      const accountId = makeAccountId();
      const result = FillMapper.fromPolymarketTradeEvent(makeValidTakerEvent(), accountId);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const { fill, metadata } = result.value;
        expect(fill.id).toBe('28c4d2eb-bbea-40e7-a9f0-b2fdb56b2c2e');
        expect(fill.orderId).toBe('0x' + 'a'.repeat(64));
        expect(fill.marketId).toBe('0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af');
        expect(fill.side).toBe('BUY');
        expect(fill.price.value().toNumber()).toBeCloseTo(0.65, 5);
        expect(fill.size.value().toNumber()).toBeCloseTo(10, 5);
        expect(fill.timestamp.toNumber()).toBe(1700000000000);
        expect(fill.venueId).toBe('POLYMARKET');
        expect(assetIdToString(fill.settlementAssetId)).toContain('USDC');
        expect(metadata.liquidity).toBe('TAKER');
        expect(metadata.tradeStatus).toBe('MATCHED');
      }
    });

    it('вычисляет fee из fee_rate_bps: price × size × bps / 10000', () => {
      const accountId = makeAccountId();
      // 0.65 × 10 × 20 / 10000 = 0.013
      const result = FillMapper.fromPolymarketTradeEvent(
        makeValidTakerEvent({ fee_rate_bps: '20', price: '0.65', size: '10' }),
        accountId
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.fill.fee.quantity.amount().value().toNumber()).toBeCloseTo(0.013, 5);
        expect(result.value.fill.hasFee()).toBe(true);
      }
    });

    it('нулевая fee при fee_rate_bps = 0', () => {
      const accountId = makeAccountId();
      const result = FillMapper.fromPolymarketTradeEvent(
        makeValidTakerEvent({ fee_rate_bps: '0' }),
        accountId
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.fill.hasFee()).toBe(false);
      }
    });

    it('парсит SELL сторону', () => {
      const accountId = makeAccountId();
      const result = FillMapper.fromPolymarketTradeEvent(
        makeValidTakerEvent({ side: 'SELL' }),
        accountId
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.fill.side).toBe('SELL');
      }
    });

    it('metadata.venueTradeId создаётся из transaction_hash', () => {
      const accountId = makeAccountId();
      const result = FillMapper.fromPolymarketTradeEvent(makeValidTakerEvent(), accountId);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.metadata.venueTradeId).toContain('0xabcdef1234567890');
      }
    });

    it('metadata.venueTradeId undefined если нет transaction_hash', () => {
      const accountId = makeAccountId();
      const result = FillMapper.fromPolymarketTradeEvent(
        makeValidTakerEvent({ transaction_hash: undefined }),
        accountId
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.metadata.venueTradeId).toBeUndefined();
      }
    });

    it('metadata.tradeStatus undefined для неизвестного значения', () => {
      const accountId = makeAccountId();
      const result = FillMapper.fromPolymarketTradeEvent(
        makeValidTakerEvent({ status: 'UNKNOWN_STATUS' }),
        accountId
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.metadata.tradeStatus).toBeUndefined();
      }
    });

    it('парсит все валидные статусы', () => {
      const accountId = makeAccountId();
      const statuses = ['MATCHED', 'MINED', 'CONFIRMED', 'RETRYING', 'FAILED'] as const;

      for (const status of statuses) {
        const result = FillMapper.fromPolymarketTradeEvent(
          makeValidTakerEvent({ status }),
          accountId
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.metadata.tradeStatus).toBe(status);
        }
      }
    });
  });

  describe('fromPolymarketTradeEvent() — MAKER', () => {
    it('парсит валидное MAKER событие — orderId из maker_orders', () => {
      const accountId = makeAccountId();
      const result = FillMapper.fromPolymarketTradeEvent(makeValidMakerEvent(), accountId);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const { fill, metadata } = result.value;
        // orderId = maker_orders[0].order_id
        expect(fill.orderId).toBe('0x' + 'c'.repeat(64));
        // side инвертирован: тейкер BUY → мейкер SELL
        expect(fill.side).toBe('SELL');
        // size из matched_amount
        expect(fill.size.value().toNumber()).toBe(10);
        expect(metadata.liquidity).toBe('MAKER');
      }
    });

    it('MAKER: side инвертирован (тейкер SELL → мейкер BUY)', () => {
      const accountId = makeAccountId();
      const event = makeValidMakerEvent({
        side: 'SELL',
        maker_orders: [
          {
            order_id: '0x' + 'd'.repeat(64),
            matched_amount: '5',
            price: '0.65',
            owner: MAKER_UUID,
          },
        ],
      });
      const result = FillMapper.fromPolymarketTradeEvent(event, accountId);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.fill.side).toBe('BUY');
      }
    });

    it('MAKER: находит правильный maker_order по owner UUID', () => {
      const accountId = makeAccountId();
      const myOrderId = '0x' + 'e'.repeat(64);
      const event = makeValidMakerEvent({
        owner: MAKER_UUID,
        maker_orders: [
          { order_id: '0x' + 'f'.repeat(64), matched_amount: '3', price: '0.60', owner: 'other-uuid' },
          { order_id: myOrderId, matched_amount: '7', price: '0.65', owner: MAKER_UUID },
        ],
      });
      const result = FillMapper.fromPolymarketTradeEvent(event, accountId);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.fill.orderId).toBe(myOrderId);
        expect(result.value.fill.size.value().toNumber()).toBe(7);
      }
    });

    it('MAKER: возвращает Err если maker_orders пустой', () => {
      const accountId = makeAccountId();
      const result = FillMapper.fromPolymarketTradeEvent(
        makeValidMakerEvent({ maker_orders: [] }),
        accountId
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('maker_orders');
      }
    });

    it('MAKER: возвращает Err если maker_order.order_id отсутствует', () => {
      const accountId = makeAccountId();
      const result = FillMapper.fromPolymarketTradeEvent(
        makeValidMakerEvent({
          maker_orders: [
            { order_id: '', matched_amount: '10', price: '0.65', owner: MAKER_UUID },
          ],
        }),
        accountId
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('order_id');
      }
    });

    it('MAKER: возвращает Err если maker_order.order_id невалидный', () => {
      const accountId = makeAccountId();
      const result = FillMapper.fromPolymarketTradeEvent(
        makeValidMakerEvent({
          maker_orders: [
            { order_id: 'has\u0000control-char', matched_amount: '10', price: '0.65', owner: MAKER_UUID },
          ],
        }),
        accountId
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('order_id');
      }
    });

    it('MAKER: возвращает Err если maker_order.price невалидный', () => {
      const accountId = makeAccountId();
      const result = FillMapper.fromPolymarketTradeEvent(
        makeValidMakerEvent({
          maker_orders: [
            { order_id: '0x' + 'c'.repeat(64), matched_amount: '10', price: 'INVALID_PRICE', owner: MAKER_UUID },
          ],
        }),
        accountId
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message.toLowerCase()).toContain('price');
      }
    });

    it('MAKER: возвращает Err если maker_order.matched_amount невалидный', () => {
      const accountId = makeAccountId();
      const result = FillMapper.fromPolymarketTradeEvent(
        makeValidMakerEvent({
          maker_orders: [
            { order_id: '0x' + 'c'.repeat(64), matched_amount: 'INVALID_AMOUNT', price: '0.65', owner: MAKER_UUID },
          ],
        }),
        accountId
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message.toLowerCase()).toContain('amount');
      }
    });
  });

  describe('fromPolymarketTradeEvent() — ошибки валидации', () => {
    it('возвращает Err если market отсутствует', () => {
      const accountId = makeAccountId();
      const result = FillMapper.fromPolymarketTradeEvent(
        makeValidTakerEvent({ market: undefined }),
        accountId
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('market');
      }
    });

    it('возвращает Err если market пустой', () => {
      const accountId = makeAccountId();
      const result = FillMapper.fromPolymarketTradeEvent(
        makeValidTakerEvent({ market: '' }),
        accountId
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('market');
      }
    });

    it('возвращает Err если asset_id отсутствует', () => {
      const accountId = makeAccountId();
      const result = FillMapper.fromPolymarketTradeEvent(
        makeValidTakerEvent({ asset_id: undefined }),
        accountId
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('asset_id');
      }
    });

    it('возвращает Err если asset_id невалидный формат', () => {
      const accountId = makeAccountId();
      const result = FillMapper.fromPolymarketTradeEvent(
        makeValidTakerEvent({ asset_id: 'INVALID:::FORMAT:::UNPARSEABLE' }),
        accountId
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('asset_id');
      }
    });

    it('возвращает Err если timestamp невалидная строка', () => {
      const accountId = makeAccountId();
      const result = FillMapper.fromPolymarketTradeEvent(
        makeValidTakerEvent({ timestamp: 'not-a-number' }),
        accountId
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('timestamp');
      }
    });

    it('возвращает Err если id отсутствует', () => {
      const accountId = makeAccountId();
      const result = FillMapper.fromPolymarketTradeEvent(
        makeValidTakerEvent({ id: undefined }),
        accountId
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('id');
      }
    });

    it('возвращает Err если trader_side невалидный', () => {
      const accountId = makeAccountId();
      const result = FillMapper.fromPolymarketTradeEvent(
        makeValidTakerEvent({ trader_side: 'UNKNOWN' }),
        accountId
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('trader_side');
      }
    });

    it('возвращает Err если taker_order_id отсутствует (TAKER)', () => {
      const accountId = makeAccountId();
      const result = FillMapper.fromPolymarketTradeEvent(
        makeValidTakerEvent({ taker_order_id: undefined }),
        accountId
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('taker_order_id');
      }
    });

    it('возвращает Err если side невалидный', () => {
      const accountId = makeAccountId();
      const result = FillMapper.fromPolymarketTradeEvent(
        makeValidTakerEvent({ side: 'INVALID' }),
        accountId
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('side');
      }
    });

    it('возвращает Err если price нулевая', () => {
      const accountId = makeAccountId();
      const result = FillMapper.fromPolymarketTradeEvent(
        makeValidTakerEvent({ price: '0' }),
        accountId
      );

      expect(result.ok).toBe(false);
    });

    it('возвращает Err если timestamp отсутствует', () => {
      const accountId = makeAccountId();
      const result = FillMapper.fromPolymarketTradeEvent(
        makeValidTakerEvent({ timestamp: undefined }),
        accountId
      );

      expect(result.ok).toBe(false);
    });
  });

  describe('toSnapshot() / fromSnapshot()', () => {
    it('round-trip: Fill → snapshot → Fill сохраняет основные поля', () => {
      const accountId = makeAccountId();
      const { fill: original, metadata: originalMeta } = unwrap(
        FillMapper.fromPolymarketTradeEvent(makeValidTakerEvent(), accountId)
      );

      const snapshot = FillMapper.toSnapshot(original, originalMeta);
      const restoredResult = FillMapper.fromSnapshot(snapshot);

      expect(restoredResult.ok).toBe(true);
      if (restoredResult.ok) {
        const { fill: restored, metadata: restoredMeta } = restoredResult.value;
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
        expect(assetIdToString(restored.settlementAssetId)).toContain('USDC');
        // metadata сохраняется в round-trip
        expect(restoredMeta.liquidity).toBe(originalMeta.liquidity);
        expect(restoredMeta.tradeStatus).toBe(originalMeta.tradeStatus);
      }
    });

    it('snapshot содержит settlementAssetId и tradeStatus', () => {
      const accountId = makeAccountId();
      const { fill, metadata } = unwrap(
        FillMapper.fromPolymarketTradeEvent(makeValidTakerEvent(), accountId)
      );
      const snapshot = FillMapper.toSnapshot(fill, metadata);

      expect(snapshot.settlementAssetId).toContain('USDC');
      expect(snapshot.tradeStatus).toBe('MATCHED');
    });

    it('fromSnapshot() возвращает Err для невалидного fill ID', () => {
      const result = FillMapper.fromSnapshot({
        id: '',
        orderId: 'order-456',
        accountId: 'wallet:0x1234567890abcdef1234567890abcdef12345678',
        venueId: 'POLYMARKET',
        marketId: 'market-1',
        tokenId: TEST_TOKEN_ID,
        settlementAssetId: assetIdToString(AssetIdHelpers.USDC),
        price: 0.65,
        size: 50,
        side: 'BUY',
        timestampMs: 1700000000000,
        feeAmount: 0,
        feeAsset: assetIdToString(AssetIdHelpers.USDC),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('fill ID');
      }
    });

    it('fromSnapshot() возвращает Err для невалидного order ID', () => {
      const result = FillMapper.fromSnapshot({
        id: 'valid-fill-id',
        orderId: '',
        accountId: 'wallet:0x1234567890abcdef1234567890abcdef12345678',
        venueId: 'POLYMARKET',
        marketId: 'market-1',
        tokenId: TEST_TOKEN_ID,
        settlementAssetId: assetIdToString(AssetIdHelpers.USDC),
        price: 0.65,
        size: 50,
        side: 'BUY',
        timestampMs: 1700000000000,
        feeAmount: 0,
        feeAsset: assetIdToString(AssetIdHelpers.USDC),
      });

      expect(result.ok).toBe(false);
    });
  });

  // ==================== fromSnapshot() — Fix #1: VO throws → Err ====================

  describe('fromSnapshot() — VO throws → Err (Fix #1)', () => {
    /**
     * Создаёт валидный FillSnapshot с возможностью переопределения полей
     */
    function makeValidSnapshot(overrides?: Partial<FillSnapshot>): FillSnapshot {
      return {
        id: 'fill-123',
        orderId: '0x' + 'a'.repeat(64),
        accountId: accountIdToString(makeAccountId()),
        venueId: 'POLYMARKET',
        marketId: '0x' + 'b'.repeat(64),
        tokenId: TEST_TOKEN_ID,
        settlementAssetId: assetIdToString(AssetIdHelpers.USDC),
        price: 0.65,
        size: 50,
        side: 'BUY',
        timestampMs: 1700000000000,
        feeAmount: 0,
        feeAsset: assetIdToString(AssetIdHelpers.USDC),
        ...overrides,
      };
    }

    it('price=0 → Err (не throw)', () => {
      const result = FillMapper.fromSnapshot(makeValidSnapshot({ price: 0 }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('price');
      }
    });

    it('price=-1 → Err (не throw)', () => {
      const result = FillMapper.fromSnapshot(makeValidSnapshot({ price: -1 }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('price');
      }
    });

    it('size=0 → Err (не throw)', () => {
      const result = FillMapper.fromSnapshot(makeValidSnapshot({ size: 0 }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('size');
      }
    });

    it('size=-0.001 → Err (не throw)', () => {
      const result = FillMapper.fromSnapshot(makeValidSnapshot({ size: -0.001 }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('size');
      }
    });

    it('feeAmount=-0.01 → Err (не throw)', () => {
      const result = FillMapper.fromSnapshot(makeValidSnapshot({ feeAmount: -0.01 }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('feeAmount');
      }
    });
  });

  // ==================== fromSnapshot() — Invalid ID branches ====================

  describe('fromSnapshot() — invalid ID branches', () => {
    function makeValidSnapshot(overrides?: Partial<FillSnapshot>): FillSnapshot {
      return {
        id: 'fill-123',
        orderId: '0x' + 'a'.repeat(64),
        accountId: accountIdToString(makeAccountId()),
        venueId: 'POLYMARKET',
        marketId: '0x' + 'b'.repeat(64),
        tokenId: TEST_TOKEN_ID,
        settlementAssetId: assetIdToString(AssetIdHelpers.USDC),
        price: 0.65,
        size: 50,
        side: 'BUY',
        timestampMs: 1700000000000,
        feeAmount: 0,
        feeAsset: assetIdToString(AssetIdHelpers.USDC),
        ...overrides,
      };
    }

    it('accountId=invalid-format → Err', () => {
      const result = FillMapper.fromSnapshot(makeValidSnapshot({ accountId: 'invalid-format' }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('account');
      }
    });

    it('venueId=empty → Err', () => {
      const result = FillMapper.fromSnapshot(makeValidSnapshot({ venueId: '' }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('venue');
      }
    });

    it('marketId=empty → Err', () => {
      const result = FillMapper.fromSnapshot(makeValidSnapshot({ marketId: '' }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('market');
      }
    });

    it('tokenId=invalid → Err', () => {
      const result = FillMapper.fromSnapshot(makeValidSnapshot({ tokenId: 'invalid' }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('tokenId');
      }
    });

    it('settlementAssetId=invalid → Err', () => {
      const result = FillMapper.fromSnapshot(makeValidSnapshot({ settlementAssetId: 'invalid' }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('settlementAssetId');
      }
    });

    it('feeAsset=invalid → Err', () => {
      const result = FillMapper.fromSnapshot(makeValidSnapshot({ feeAsset: 'invalid' }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('feeAsset');
      }
    });

    it('side="INVALID" → Err (side must be BUY or SELL)', () => {
      const result = FillMapper.fromSnapshot(makeValidSnapshot({ side: 'INVALID' as 'BUY' }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('side must be BUY or SELL');
      }
    });
  });

  // ==================== fromSnapshot() — нечисловые значения ====================

  describe('fromSnapshot() — нечисловые значения', () => {
    function makeValidSnapshot(overrides?: Record<string, unknown>): FillSnapshot {
      return {
        id: 'fill-123',
        orderId: '0x' + 'a'.repeat(64),
        accountId: accountIdToString(makeAccountId()),
        venueId: 'POLYMARKET',
        marketId: '0x' + 'b'.repeat(64),
        tokenId: TEST_TOKEN_ID,
        settlementAssetId: assetIdToString(AssetIdHelpers.USDC),
        price: 0.65,
        size: 50,
        side: 'BUY',
        timestampMs: 1700000000000,
        feeAmount: 0,
        feeAsset: assetIdToString(AssetIdHelpers.USDC),
        ...overrides,
      } as FillSnapshot;
    }

    it('price="abc" → Err (Decimal parsing fails)', () => {
      const result = FillMapper.fromSnapshot(makeValidSnapshot({ price: 'abc' as unknown as number }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('price');
      }
    });

    it('size=NaN → Err', () => {
      const result = FillMapper.fromSnapshot(makeValidSnapshot({ size: NaN }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('size');
      }
    });

    it('feeAmount="abc" → Err', () => {
      const result = FillMapper.fromSnapshot(makeValidSnapshot({ feeAmount: 'abc' as unknown as number }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('fee');
      }
    });

    it('price=Infinity → Err', () => {
      const result = FillMapper.fromSnapshot(makeValidSnapshot({ price: Infinity }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('price');
      }
    });
  });

  // ==================== fromPolymarketTradeEvent() — null/primitive (Fix #2) ====================

  describe('fromPolymarketTradeEvent() — null/primitive входные данные (Fix #2)', () => {
    it('raw=null → Err (не throw)', () => {
      const accountId = makeAccountId();
      const result = FillMapper.fromPolymarketTradeEvent(null as unknown as Record<string, unknown>, accountId);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('non-null object');
      }
    });

    it('raw=42 → Err (не throw)', () => {
      const accountId = makeAccountId();
      const result = FillMapper.fromPolymarketTradeEvent(42 as unknown as Record<string, unknown>, accountId);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('non-null object');
      }
    });

    it('raw="string" → Err (не throw)', () => {
      const accountId = makeAccountId();
      const result = FillMapper.fromPolymarketTradeEvent('string' as unknown as Record<string, unknown>, accountId);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('non-null object');
      }
    });
  });

  // ==================== MAKER — owner policies (Fix #3) ====================

  describe('fromPolymarketTradeEvent() — MAKER owner policies (Fix #3)', () => {
    it('MAKER без поля owner → Err с "missing owner"', () => {
      const accountId = makeAccountId();
      const result = FillMapper.fromPolymarketTradeEvent(
        makeValidMakerEvent({ owner: undefined }),
        accountId
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('owner');
      }
    });

    it('MAKER с owner не совпадающим ни с одним maker_orders → Err с "no maker_orders entry"', () => {
      const accountId = makeAccountId();
      const result = FillMapper.fromPolymarketTradeEvent(
        makeValidMakerEvent({
          owner: 'unknown-uuid-not-in-maker-orders',
          maker_orders: [
            { order_id: '0x' + 'c'.repeat(64), matched_amount: '10', price: '0.65', owner: MAKER_UUID },
          ],
        }),
        accountId
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('no maker_orders entry');
      }
    });

    it('MAKER с несколькими maker_orders — выбирает правильного по owner, не первого', () => {
      const accountId = makeAccountId();
      const correctOrderId = '0x' + 'e'.repeat(64);
      const result = FillMapper.fromPolymarketTradeEvent(
        makeValidMakerEvent({
          owner: MAKER_UUID,
          maker_orders: [
            { order_id: '0x' + 'f'.repeat(64), matched_amount: '3', price: '0.60', owner: 'other-uuid-1' },
            { order_id: '0x' + 'd'.repeat(64), matched_amount: '2', price: '0.62', owner: 'other-uuid-2' },
            { order_id: correctOrderId, matched_amount: '7', price: '0.65', owner: MAKER_UUID },
          ],
        }),
        accountId
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Должен выбрать third entry (по MAKER_UUID), не первый
        expect(result.value.fill.orderId).toBe(correctOrderId);
        expect(result.value.fill.size.value().toNumber()).toBe(7);
      }
    });
  });

  // ==================== fromPolymarketTradeEvent() — проверка текстов ошибок ====================

  describe('fromPolymarketTradeEvent() — проверка текстов ошибок', () => {
    it('id с control character → Err, сообщение содержит "id"', () => {
      const accountId = makeAccountId();
      // asFillId отклоняет строки с control characters (U+0000..U+001F)
      const result = FillMapper.fromPolymarketTradeEvent(
        makeValidTakerEvent({ id: 'fill\u0000null-byte' }),
        accountId
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message.toLowerCase()).toContain('id');
      }
    });

    it('taker_order_id с control character → Err, сообщение содержит "taker_order_id"', () => {
      const accountId = makeAccountId();
      // asOrderId отклоняет строки с control characters
      const result = FillMapper.fromPolymarketTradeEvent(
        makeValidTakerEvent({ taker_order_id: '0xabc\u001fnull' }),
        accountId
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('taker_order_id');
      }
    });
  });
});
