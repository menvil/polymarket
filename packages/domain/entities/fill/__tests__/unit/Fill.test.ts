/**
 * Тесты для Fill domain record
 */

import { Fill } from '../../src/Fill';
import type { FillParams } from '../../src/Fill';
import { FillMapper } from '../../src/mappers/FillMapper';
import {
  asFillId,
  asOrderId,
  accountIdFromWallet,
  parseWalletAddress,
  asVenueId,
  parseAssetId,
  AssetIdHelpers,
} from '@polymarket/ids';
import { Price, Quantity, TimestampService, Fee } from '@polymarket/value-objects';
import { AssetQuantity } from '@polymarket/value-objects/asset-quantity';
import Decimal from 'decimal.js';

// Вспомогательная функция для извлечения значения из Result в тестах
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }, ctx = ''): T {
  if (!result.ok) throw new Error(`Expected Ok result in test setup${ctx ? `: ${ctx}` : ''}`);
  return result.value;
}

// ==================== Helpers ====================

function makeTokenId() {
  const conditionId = '0x' + 'a'.repeat(64);
  return parseAssetId(`OUTCOME_TOKEN:ONCHAIN:POLYMARKET_CTF:137:${conditionId}:YES`);
}

function makeAccountId() {
  const wallet = parseWalletAddress('0x1234567890abcdef1234567890abcdef12345678');
  if (!wallet) throw new Error('Test setup: invalid wallet address');
  return accountIdFromWallet(wallet);
}

function makeZeroFee() {
  return Fee.zero(AssetIdHelpers.USDC);
}

function makeNonZeroFee(amount: string) {
  const feeQty = Quantity.of(new Decimal(amount));
  const feeAssetQty = new AssetQuantity(AssetIdHelpers.USDC, feeQty);
  return Fee.of(feeAssetQty);
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
    timestamp: unwrap(TimestampService.create(1700000000000), 'Timestamp'),
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
        expect(fill.timestamp.toNumber()).toBe(1700000000000);
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

    it('возвращает Err если marketId пустой', () => {
      const result = Fill.create(makeValidParams({ marketId: '' }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Market ID is required');
      }
    });

    it('возвращает Err если marketId только пробелы', () => {
      const result = Fill.create(makeValidParams({ marketId: '   ' }));

      expect(result.ok).toBe(false);
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

    it('Price.of бросает исключение для нулевой цены — до вызова Fill.create', () => {
      // Price VO сам валидирует себя (PriceInvariantViolation)
      expect(() => {
        Fill.create(makeValidParams({ price: Price.of(new Decimal('0')) }));
      }).toThrow();
    });
  });

  // ==================== Экономические расчёты ====================

  describe('getSignedQuantity()', () => {
    it('BUY: возвращает положительный объём', () => {
      const fill = unwrap(Fill.create(makeValidParams({ side: 'BUY', size: Quantity.of(new Decimal('50')) })));
      expect(fill.getSignedQuantity().toNumber()).toBe(50);
    });

    it('SELL: возвращает отрицательный объём', () => {
      const fill = unwrap(Fill.create(makeValidParams({ side: 'SELL', size: Quantity.of(new Decimal('50')) })));
      expect(fill.getSignedQuantity().toNumber()).toBe(-50);
    });
  });

  describe('getCashFlow()', () => {
    it('BUY: cash flow отрицательный (деньги ушли)', () => {
      // BUY 50 @ 0.65 = -32.5
      const fill = unwrap(Fill.create(makeValidParams({
        side: 'BUY',
        price: Price.of(new Decimal('0.65')),
        size: Quantity.of(new Decimal('50')),
      })));
      expect(fill.getCashFlow().toNumber()).toBeCloseTo(-32.5, 5);
    });

    it('SELL: cash flow положительный (деньги пришли)', () => {
      // SELL 50 @ 0.65 = +32.5
      const fill = unwrap(Fill.create(makeValidParams({
        side: 'SELL',
        price: Price.of(new Decimal('0.65')),
        size: Quantity.of(new Decimal('50')),
      })));
      expect(fill.getCashFlow().toNumber()).toBeCloseTo(32.5, 5);
    });
  });

  describe('getFeeFlow()', () => {
    it('ненулевая комиссия — всегда отрицательный поток', () => {
      const fill = unwrap(Fill.create(makeValidParams({ fee: makeNonZeroFee('0.02') })));
      expect(fill.getFeeFlow().toNumber()).toBeCloseTo(-0.02, 5);
    });

    it('нулевая комиссия — возвращает 0', () => {
      const fill = unwrap(Fill.create(makeValidParams({ fee: makeZeroFee() })));
      expect(fill.getFeeFlow().isZero()).toBe(true);
    });
  });

  describe('getNetCashFlow()', () => {
    it('BUY с комиссией: net = cashFlow + feeFlow', () => {
      // BUY 50 @ 0.65 = -32.5, fee 0.02 → net = -32.52
      const fill = unwrap(Fill.create(makeValidParams({
        side: 'BUY',
        price: Price.of(new Decimal('0.65')),
        size: Quantity.of(new Decimal('50')),
        fee: makeNonZeroFee('0.02'),
      })));
      expect(fill.getNetCashFlow().toNumber()).toBeCloseTo(-32.52, 5);
    });

    it('SELL с комиссией: net = cashFlow + feeFlow', () => {
      // SELL 50 @ 0.65 = +32.5, fee 0.02 → net = +32.48
      const fill = unwrap(Fill.create(makeValidParams({
        side: 'SELL',
        price: Price.of(new Decimal('0.65')),
        size: Quantity.of(new Decimal('50')),
        fee: makeNonZeroFee('0.02'),
      })));
      expect(fill.getNetCashFlow().toNumber()).toBeCloseTo(32.48, 5);
    });

    it('без комиссии: net равен cashFlow', () => {
      const fill = unwrap(Fill.create(makeValidParams({
        side: 'BUY',
        price: Price.of(new Decimal('0.65')),
        size: Quantity.of(new Decimal('50')),
        fee: makeZeroFee(),
      })));
      expect(fill.getNetCashFlow().toNumber()).toBeCloseTo(-32.5, 5);
    });
  });

  describe('getNotional()', () => {
    it('вычисляет notional как price × size (всегда положительный)', () => {
      const fill = unwrap(Fill.create(
        makeValidParams({
          price: Price.of(new Decimal('0.65')),
          size: Quantity.of(new Decimal('50')),
        })
      ));
      expect(fill.getNotional().toNumber()).toBeCloseTo(32.5, 5);
    });

    it('для SELL notional тоже положительный', () => {
      const fill = unwrap(Fill.create(
        makeValidParams({ side: 'SELL', price: Price.of(new Decimal('0.65')), size: Quantity.of(new Decimal('50')) })
      ));
      expect(fill.getNotional().toNumber()).toBeCloseTo(32.5, 5);
    });
  });

  // ==================== Predicates ====================

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
      const fill = unwrap(Fill.create(makeValidParams({ fee: makeNonZeroFee('0.01') })));
      expect(fill.hasFee()).toBe(true);
    });
  });

  // ==================== Сериализация (через FillMapper) ====================

  describe('FillMapper.toSnapshot()', () => {
    it('сериализует Fill в плоский снапшот', () => {
      const fill = unwrap(Fill.create(makeValidParams()));
      const snapshot = FillMapper.toSnapshot(fill);

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

    it('feeAsset в снапшоте совпадает с fee.asset (не tokenId)', () => {
      const fill = unwrap(Fill.create(makeValidParams({ fee: makeNonZeroFee('0.02') })));
      const snapshot = FillMapper.toSnapshot(fill);

      // feeAsset должен быть USDC, а не tokenId YES-токена
      expect(snapshot.feeAsset).toContain('USDC');
      expect(snapshot.feeAmount).toBeCloseTo(0.02, 5);
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
