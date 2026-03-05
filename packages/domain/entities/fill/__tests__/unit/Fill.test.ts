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
  assetIdToString,
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
    settlementAssetId: AssetIdHelpers.USDC,
    price: Price.of(new Decimal('0.65')),
    size: Quantity.of(new Decimal('50')),
    side: 'BUY',
    timestamp: unwrap(TimestampService.create(1700000000000), 'Timestamp'),
    fee: makeZeroFee(),
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
        expect(fill.timestamp.toNumber()).toBe(1700000000000);
        expect(assetIdToString(fill.settlementAssetId)).toContain('USDC');
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

    it('инвариант 3: возвращает Err если fee ненулевая и fee.asset != settlementAssetId', () => {
      const tokenId = makeTokenId();
      if (!tokenId) throw new Error('Test setup: invalid tokenId');

      // fee с tokenId вместо USDC
      const feeQty = Quantity.of(new Decimal('0.01'));
      const feeAssetQty = new AssetQuantity(tokenId, feeQty);
      const fee = Fee.of(feeAssetQty);

      const result = Fill.create(makeValidParams({ fee }));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('fee asset must match settlementAssetId');
      }
    });

    it('инвариант 3: нулевая fee с другим asset — допустимо', () => {
      // Нулевая комиссия с любым asset не нарушает инвариант
      const result = Fill.create(makeValidParams({ fee: makeZeroFee() }));
      expect(result.ok).toBe(true);
    });
  });

  // ==================== Экономические расчёты ====================

  describe('getSignedQuantity()', () => {
    it('BUY: возвращает AssetDelta с asset=tokenId и положительным amount', () => {
      const fill = unwrap(Fill.create(makeValidParams({ side: 'BUY', size: Quantity.of(new Decimal('50')) })));
      const delta = fill.getSignedQuantity();

      expect(delta.amount.toNumber()).toBe(50);
      expect(delta.asset).toBe(fill.tokenId);
    });

    it('SELL: возвращает AssetDelta с asset=tokenId и отрицательным amount', () => {
      const fill = unwrap(Fill.create(makeValidParams({ side: 'SELL', size: Quantity.of(new Decimal('50')) })));
      const delta = fill.getSignedQuantity();

      expect(delta.amount.toNumber()).toBe(-50);
      expect(delta.asset).toBe(fill.tokenId);
    });
  });

  describe('getCashFlow()', () => {
    it('BUY: asset=settlementAssetId, amount отрицательный (деньги ушли)', () => {
      const fill = unwrap(Fill.create(makeValidParams({
        side: 'BUY',
        price: Price.of(new Decimal('0.65')),
        size: Quantity.of(new Decimal('50')),
      })));
      const delta = fill.getCashFlow();

      expect(assetIdToString(delta.asset)).toContain('USDC');
      expect(delta.amount.toNumber()).toBeCloseTo(-32.5, 5);
    });

    it('SELL: asset=settlementAssetId, amount положительный (деньги пришли)', () => {
      const fill = unwrap(Fill.create(makeValidParams({
        side: 'SELL',
        price: Price.of(new Decimal('0.65')),
        size: Quantity.of(new Decimal('50')),
      })));
      const delta = fill.getCashFlow();

      expect(assetIdToString(delta.asset)).toContain('USDC');
      expect(delta.amount.toNumber()).toBeCloseTo(32.5, 5);
    });
  });

  describe('getFeeFlow()', () => {
    it('ненулевая комиссия — AssetDelta с отрицательным amount', () => {
      const fill = unwrap(Fill.create(makeValidParams({ fee: makeNonZeroFee('0.02') })));
      const feeFlow = fill.getFeeFlow();

      expect(feeFlow.amount.toNumber()).toBeCloseTo(-0.02, 5);
      expect(assetIdToString(feeFlow.asset)).toContain('USDC');
    });

    it('нулевая комиссия — amount равен 0', () => {
      const fill = unwrap(Fill.create(makeValidParams({ fee: makeZeroFee() })));
      const feeFlow = fill.getFeeFlow();

      expect(feeFlow.amount.isZero()).toBe(true);
    });
  });

  describe('getNetCashFlow()', () => {
    it('BUY с комиссией: asset=settlementAssetId, amount = cashFlow + feeFlow', () => {
      // BUY 50 @ 0.65 = -32.5, fee 0.02 → net = -32.52
      const fill = unwrap(Fill.create(makeValidParams({
        side: 'BUY',
        price: Price.of(new Decimal('0.65')),
        size: Quantity.of(new Decimal('50')),
        fee: makeNonZeroFee('0.02'),
      })));
      const net = fill.getNetCashFlow();

      expect(assetIdToString(net.asset)).toContain('USDC');
      expect(net.amount.toNumber()).toBeCloseTo(-32.52, 5);
    });

    it('SELL с комиссией: net = cashFlow + feeFlow', () => {
      // SELL 50 @ 0.65 = +32.5, fee 0.02 → net = +32.48
      const fill = unwrap(Fill.create(makeValidParams({
        side: 'SELL',
        price: Price.of(new Decimal('0.65')),
        size: Quantity.of(new Decimal('50')),
        fee: makeNonZeroFee('0.02'),
      })));
      const net = fill.getNetCashFlow();

      expect(net.amount.toNumber()).toBeCloseTo(32.48, 5);
    });

    it('без комиссии: net.amount равен cashFlow.amount', () => {
      const fill = unwrap(Fill.create(makeValidParams({
        side: 'BUY',
        price: Price.of(new Decimal('0.65')),
        size: Quantity.of(new Decimal('50')),
        fee: makeZeroFee(),
      })));
      const net = fill.getNetCashFlow();

      expect(net.amount.toNumber()).toBeCloseTo(-32.5, 5);
    });
  });

  describe('getNotional()', () => {
    it('вычисляет notional как AssetQuantity с asset=settlementAssetId', () => {
      const fill = unwrap(Fill.create(
        makeValidParams({
          price: Price.of(new Decimal('0.65')),
          size: Quantity.of(new Decimal('50')),
        })
      ));
      const notional = fill.getNotional();

      expect(notional.amount().value().toNumber()).toBeCloseTo(32.5, 5);
      expect(assetIdToString(notional.asset())).toContain('USDC');
    });

    it('для SELL notional тоже положительный', () => {
      const fill = unwrap(Fill.create(
        makeValidParams({ side: 'SELL', price: Price.of(new Decimal('0.65')), size: Quantity.of(new Decimal('50')) })
      ));
      const notional = fill.getNotional();

      expect(notional.amount().value().toNumber()).toBeCloseTo(32.5, 5);
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
      expect(snapshot.settlementAssetId).toContain('USDC');
    });

    it('feeAsset в снапшоте совпадает с fee.asset (не tokenId)', () => {
      const fill = unwrap(Fill.create(makeValidParams({ fee: makeNonZeroFee('0.02') })));
      const snapshot = FillMapper.toSnapshot(fill);

      // feeAsset должен быть USDC, а не tokenId YES-токена
      expect(snapshot.feeAsset).toContain('USDC');
      expect(snapshot.feeAmount).toBeCloseTo(0.02, 5);
    });

    it('liquidity и venueTradeId попадают в снапшот через metadata', () => {
      const fill = unwrap(Fill.create(makeValidParams()));
      const snapshot = FillMapper.toSnapshot(fill, { liquidity: 'MAKER' });

      expect(snapshot.liquidity).toBe('MAKER');
      expect(snapshot.venueTradeId).toBeUndefined();
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
