/**
 * Тесты для Fill entity
 */

import { Fill } from '../../src/Fill';
import type { FillParams } from '../../src/Fill';
import {
  asFillId,
  asOrderId,
  accountIdFromWallet,
  parseWalletAddress,
  asVenueId,
  parseAssetId,
  AssetIdHelpers,
} from '@polymarket/ids';
import { Price, Quantity, Timestamp, Fee } from '@polymarket/value-objects';
import { AssetQuantity } from '@polymarket/value-objects/asset-quantity';
import Decimal from 'decimal.js';

// Вспомогательная функция для извлечения значения из Result в тестах
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }, ctx = ''): T {
  if (!result.ok) throw new Error(`Expected Ok result in test setup${ctx ? `: ${ctx}` : ''}`);
  return result.value;
}

// ==================== Helpers ====================

function makeTokenId() {
  return parseAssetId(JSON.stringify({
    type: 'OUTCOME_TOKEN',
    conditionRef: { type: 'OFF_CHAIN', conditionId: 'condition-test-123' },
    outcomeKey: 'YES',
  }));
}

function makeAccountId() {
  const wallet = parseWalletAddress('0x1234567890abcdef1234567890abcdef12345678');
  if (!wallet) throw new Error('Test setup: invalid wallet address');
  return accountIdFromWallet(wallet);
}

function makeZeroFee() {
  return Fee.zero(AssetIdHelpers.USDC);
}

function makeValidParams(overrides?: Partial<FillParams>): FillParams {
  const tokenId = makeTokenId();
  if (!tokenId) throw new Error('Test setup: invalid tokenId');

  return {
    id: asFillId('fill-123')!,
    orderId: asOrderId('order-456')!,
    accountId: makeAccountId(),
    venueId: asVenueId('POLYMARKET')!,
    marketId: 'market-abc',
    tokenId,
    price: Price.of(new Decimal('0.65')),
    size: Quantity.of(new Decimal('50')),
    side: 'BUY',
    timestamp: unwrap(Timestamp.fromEpochMs(1700000000000), 'Timestamp'),
    fee: makeZeroFee(),
    liquidity: 'MAKER',
    ...overrides,
  };
}

// ==================== Tests ====================

describe('Fill', () => {
  describe('create()', () => {
    it('создаёт валидный Fill со всеми полями', () => {
      const params = makeValidParams();
      const result = Fill.create(params);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const fill = result.value;
        expect(fill.id).toBe('fill-123');
        expect(fill.orderId).toBe('order-456');
        expect(fill.venueId).toBe('POLYMARKET');
        expect(fill.marketId).toBe('market-abc');
        expect(fill.side).toBe('BUY');
        expect(fill.price.value().toNumber()).toBe(0.65);
        expect(fill.size.value().toNumber()).toBe(50);
        expect(fill.liquidity).toBe('MAKER');
        expect(fill.timestamp.value).toBe(1700000000000);
      }
    });

    it('создаёт Fill без liquidity (опционально)', () => {
      const result = Fill.create(makeValidParams({ liquidity: undefined }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.liquidity).toBeUndefined();
      }
    });

    it('создаёт Fill без venueTradeId (опционально)', () => {
      const result = Fill.create(makeValidParams({ venueTradeId: undefined }));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.venueTradeId).toBeUndefined();
      }
    });

    it('возвращает Err если id пустой', () => {
      const params = makeValidParams({ id: '' as ReturnType<typeof asFillId> });
      const result = Fill.create(params);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Fill ID is required');
      }
    });

    it('возвращает Err если orderId отсутствует', () => {
      const params = makeValidParams({ orderId: '' as ReturnType<typeof asOrderId> });
      const result = Fill.create(params);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Order ID is required');
      }
    });

    it('возвращает Err если accountId отсутствует', () => {
      const params = makeValidParams({ accountId: null as unknown as ReturnType<typeof makeAccountId> });
      const result = Fill.create(params);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Account ID is required');
      }
    });

    it('возвращает Err если venueId пустой', () => {
      const params = makeValidParams({ venueId: '' as ReturnType<typeof asVenueId> });
      const result = Fill.create(params);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Venue ID is required');
      }
    });

    it('возвращает Err если marketId пустой', () => {
      const result = Fill.create(makeValidParams({ marketId: '' }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Market ID is required');
      }
    });

    it('возвращает Err если size нулевой', () => {
      const result = Fill.create(
        makeValidParams({ size: Quantity.of(new Decimal('0')) })
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('size must be positive');
      }
    });

    it('возвращает Err если price нулевая', () => {
      const result = Fill.create(
        makeValidParams({ price: Price.of(new Decimal('0')) })
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('price must be positive');
      }
    });

    it('возвращает Err если fee отсутствует', () => {
      const result = Fill.create(
        makeValidParams({ fee: null as unknown as ReturnType<typeof makeZeroFee> })
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Fee is required');
      }
    });
  });

  describe('getNotional()', () => {
    it('вычисляет notional как price × size', () => {
      const fill = unwrap(Fill.create(
        makeValidParams({
          price: Price.of(new Decimal('0.65')),
          size: Quantity.of(new Decimal('50')),
        })
      ));

      expect(fill.getNotional().toNumber()).toBeCloseTo(32.5, 5);
    });
  });

  describe('isBuy() / isSell()', () => {
    it('isBuy() возвращает true для BUY', () => {
      const fill = unwrap(Fill.create(makeValidParams({ side: 'BUY' })));
      expect(fill.isBuy()).toBe(true);
      expect(fill.isSell()).toBe(false);
    });

    it('isSell() возвращает true для SELL', () => {
      const fill = unwrap(Fill.create(makeValidParams({ side: 'SELL' })));
      expect(fill.isSell()).toBe(true);
      expect(fill.isBuy()).toBe(false);
    });
  });

  describe('isMaker() / isTaker()', () => {
    it('isMaker() возвращает true для MAKER', () => {
      const fill = unwrap(Fill.create(makeValidParams({ liquidity: 'MAKER' })));
      expect(fill.isMaker()).toBe(true);
      expect(fill.isTaker()).toBe(false);
    });

    it('isTaker() возвращает true для TAKER', () => {
      const fill = unwrap(Fill.create(makeValidParams({ liquidity: 'TAKER' })));
      expect(fill.isTaker()).toBe(true);
      expect(fill.isMaker()).toBe(false);
    });

    it('оба false если liquidity undefined', () => {
      const fill = unwrap(Fill.create(makeValidParams({ liquidity: undefined })));
      expect(fill.isMaker()).toBe(false);
      expect(fill.isTaker()).toBe(false);
    });
  });

  describe('hasFee()', () => {
    it('возвращает false для нулевой комиссии', () => {
      const fill = unwrap(Fill.create(makeValidParams({ fee: makeZeroFee() })));
      expect(fill.hasFee()).toBe(false);
    });

    it('возвращает true для ненулевой комиссии', () => {
      const feeQty = Quantity.of(new Decimal('0.01'));
      const feeAssetQty = new AssetQuantity(AssetIdHelpers.USDC, feeQty);
      const fee = Fee.of(feeAssetQty);

      const fill = unwrap(Fill.create(makeValidParams({ fee })));
      expect(fill.hasFee()).toBe(true);
    });
  });

  describe('toSnapshot()', () => {
    it('сериализует Fill в плоский снапшот', () => {
      const fill = unwrap(Fill.create(makeValidParams()));
      const snapshot = fill.toSnapshot();

      expect(snapshot.id).toBe('fill-123');
      expect(snapshot.orderId).toBe('order-456');
      expect(snapshot.venueId).toBe('POLYMARKET');
      expect(snapshot.marketId).toBe('market-abc');
      expect(snapshot.side).toBe('BUY');
      expect(snapshot.price).toBe(0.65);
      expect(snapshot.size).toBe(50);
      expect(snapshot.timestampMs).toBe(1700000000000);
      expect(snapshot.feeAmount).toBe(0);
      expect(snapshot.liquidity).toBe('MAKER');
    });
  });

  describe('toString()', () => {
    it('возвращает читаемую строку', () => {
      const fill = unwrap(Fill.create(makeValidParams()));
      const str = fill.toString();

      expect(str).toContain('Fill[');
      expect(str).toContain('fill-123');
      expect(str).toContain('BUY');
      expect(str).toContain('50');
      expect(str).toContain('0.65');
      expect(str).toContain('order-456');
    });
  });
});
