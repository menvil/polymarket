/**
 * Тесты для FillLedgerAdapter
 */

import { FillLedgerAdapter } from '../../src/adapters/FillLedgerAdapter';
import { Fill } from '@polymarket/fill';
import type { FillParams } from '@polymarket/fill';
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

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }, ctx = ''): T {
  if (!result.ok) throw new Error(`Expected Ok result in test setup${ctx ? `: ${ctx}` : ''}`);
  return result.value;
}

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

function makeFill(overrides?: Partial<FillParams>): Fill {
  const tokenId = makeTokenId();
  if (!tokenId) throw new Error('Test setup: invalid tokenId');

  const params: FillParams = {
    id: asFillId('fill-123')!,
    orderId: asOrderId('order-456')!,
    accountId: makeAccountId(),
    venueId: asVenueId('POLYMARKET')!,
    marketId: 'market-abc',
    tokenId,
    price: Price.of(new Decimal('0.62')),
    size: Quantity.of(new Decimal('10')),
    side: 'BUY',
    timestamp: unwrap(TimestampService.create(1700000000000), 'Timestamp'),
    fee: makeZeroFee(),
    ...overrides,
  };

  return unwrap(Fill.create(params), 'Fill.create');
}

// ==================== Tests ====================

describe('FillLedgerAdapter', () => {
  describe('toLedgerEntries() — BUY без комиссии', () => {
    it('возвращает 2 записи при нулевой комиссии', () => {
      const fill = makeFill({ side: 'BUY', fee: makeZeroFee() });
      const entries = FillLedgerAdapter.toLedgerEntries(fill, AssetIdHelpers.USDC);

      expect(entries).toHaveLength(2);
    });

    it('POSITION_DELTA: asset=tokenId, delta=+qty (BUY)', () => {
      const fill = makeFill({ side: 'BUY', size: Quantity.of(new Decimal('10')) });
      const entries = FillLedgerAdapter.toLedgerEntries(fill, AssetIdHelpers.USDC);

      const posEntry = entries.find(e => e.type === 'POSITION_DELTA');
      expect(posEntry).toBeDefined();
      expect(posEntry!.asset).toBe(fill.tokenId);
      expect(posEntry!.delta.toNumber()).toBe(10);
    });

    it('CASH_DELTA: asset=USDC, delta=-(price×qty) для BUY', () => {
      // BUY 10 @ 0.62 = -6.20
      const fill = makeFill({
        side: 'BUY',
        price: Price.of(new Decimal('0.62')),
        size: Quantity.of(new Decimal('10')),
        fee: makeZeroFee(),
      });
      const entries = FillLedgerAdapter.toLedgerEntries(fill, AssetIdHelpers.USDC);

      const cashEntry = entries.find(e => e.type === 'CASH_DELTA');
      expect(cashEntry).toBeDefined();
      expect(cashEntry!.asset).toBe(AssetIdHelpers.USDC);
      expect(cashEntry!.delta.toNumber()).toBeCloseTo(-6.20, 5);
    });
  });

  describe('toLedgerEntries() — SELL без комиссии', () => {
    it('POSITION_DELTA: delta=-qty для SELL', () => {
      const fill = makeFill({ side: 'SELL', size: Quantity.of(new Decimal('10')) });
      const entries = FillLedgerAdapter.toLedgerEntries(fill, AssetIdHelpers.USDC);

      const posEntry = entries.find(e => e.type === 'POSITION_DELTA');
      expect(posEntry!.delta.toNumber()).toBe(-10);
    });

    it('CASH_DELTA: delta=+(price×qty) для SELL', () => {
      // SELL 10 @ 0.62 = +6.20
      const fill = makeFill({
        side: 'SELL',
        price: Price.of(new Decimal('0.62')),
        size: Quantity.of(new Decimal('10')),
        fee: makeZeroFee(),
      });
      const entries = FillLedgerAdapter.toLedgerEntries(fill, AssetIdHelpers.USDC);

      const cashEntry = entries.find(e => e.type === 'CASH_DELTA');
      expect(cashEntry!.delta.toNumber()).toBeCloseTo(6.20, 5);
    });
  });

  describe('toLedgerEntries() — с комиссией', () => {
    it('возвращает 3 записи при ненулевой комиссии', () => {
      const fill = makeFill({ fee: makeNonZeroFee('0.02') });
      const entries = FillLedgerAdapter.toLedgerEntries(fill, AssetIdHelpers.USDC);

      expect(entries).toHaveLength(3);
    });

    it('FEE_DEBIT: asset=fee.asset, delta=-feeAmount', () => {
      const fill = makeFill({ fee: makeNonZeroFee('0.02') });
      const entries = FillLedgerAdapter.toLedgerEntries(fill, AssetIdHelpers.USDC);

      const feeEntry = entries.find(e => e.type === 'FEE_DEBIT');
      expect(feeEntry).toBeDefined();
      expect(feeEntry!.delta.toNumber()).toBeCloseTo(-0.02, 5);
    });
  });

  describe('toLedgerEntries() — метаданные записей', () => {
    it('все записи имеют одинаковый fillId и accountId', () => {
      const fill = makeFill({ fee: makeNonZeroFee('0.01') });
      const entries = FillLedgerAdapter.toLedgerEntries(fill, AssetIdHelpers.USDC);

      for (const entry of entries) {
        expect(entry.fillId).toBe(fill.id);
        expect(entry.accountId).toBe(fill.accountId);
        expect(entry.timestamp).toBe(fill.timestamp);
      }
    });

    it('суммарный cash delta + fee delta = getNetCashFlow()', () => {
      // BUY 10 @ 0.62, fee 0.02 → net = -6.22
      const fill = makeFill({
        side: 'BUY',
        price: Price.of(new Decimal('0.62')),
        size: Quantity.of(new Decimal('10')),
        fee: makeNonZeroFee('0.02'),
      });
      const entries = FillLedgerAdapter.toLedgerEntries(fill, AssetIdHelpers.USDC);

      const usdcEntries = entries.filter(e => e.asset === AssetIdHelpers.USDC);
      const totalUsdcDelta = usdcEntries.reduce(
        (acc, e) => acc.plus(e.delta),
        new Decimal(0)
      );

      expect(totalUsdcDelta.toNumber()).toBeCloseTo(fill.getNetCashFlow().toNumber(), 5);
    });
  });
});
