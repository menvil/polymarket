/**
 * Тесты для FillLedgerAdapter
 */

import { FillLedgerAdapter } from '../../src/adapters/FillLedgerAdapter';
import { ALL_LEDGER_ENTRY_TYPES } from '../../src/LedgerEntryType';
import { Fill } from '@polymarket/fill';
import type { FillParams } from '@polymarket/fill';
import {
  asFillId,
  asOrderId,
  asMarketId,
  accountIdFromWallet,
  parseWalletAddress,
  asVenueId,
  parseAssetId,
  AssetIdHelpers,
  assetIdToString,
} from '@polymarket/ids';
import { OutcomePrice, Quantity, Fee } from '@polymarket/value-objects';
import { TimestampService } from '@polymarket/timestamp';
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
    marketId: asMarketId('market-abc')!,
    tokenId,
    settlementAssetId: AssetIdHelpers.USDC,
    price: OutcomePrice.of(new Decimal('0.62')),
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
      const entries = FillLedgerAdapter.toLedgerEntries(fill);

      expect(entries).toHaveLength(2);
    });

    it('POSITION_DELTA: balanceDelta.asset=tokenId, amount=+qty (BUY)', () => {
      const fill = makeFill({ side: 'BUY', size: Quantity.of(new Decimal('10')) });
      const entries = FillLedgerAdapter.toLedgerEntries(fill);

      const posEntry = entries.find(e => e.type === 'POSITION_DELTA');
      expect(posEntry).toBeDefined();
      expect(posEntry!.balanceDelta.asset).toBe(fill.tokenId);
      expect(posEntry!.balanceDelta.amount.toNumber()).toBe(10);
    });

    it('CASH_DELTA: balanceDelta.asset=USDC, amount=-(price×qty) для BUY', () => {
      // BUY 10 @ 0.62 = -6.20
      const fill = makeFill({
        side: 'BUY',
        price: OutcomePrice.of(new Decimal('0.62')),
        size: Quantity.of(new Decimal('10')),
        fee: makeZeroFee(),
      });
      const entries = FillLedgerAdapter.toLedgerEntries(fill);

      const cashEntry = entries.find(e => e.type === 'CASH_DELTA');
      expect(cashEntry).toBeDefined();
      expect(assetIdToString(cashEntry!.balanceDelta.asset)).toContain('USDC');
      expect(cashEntry!.balanceDelta.amount.toNumber()).toBeCloseTo(-6.20, 5);
    });
  });

  describe('toLedgerEntries() — SELL без комиссии', () => {
    it('POSITION_DELTA: balanceDelta.amount=-qty для SELL', () => {
      const fill = makeFill({ side: 'SELL', size: Quantity.of(new Decimal('10')) });
      const entries = FillLedgerAdapter.toLedgerEntries(fill);

      const posEntry = entries.find(e => e.type === 'POSITION_DELTA');
      expect(posEntry).toBeDefined();
      expect(posEntry!.balanceDelta.amount.toNumber()).toBe(-10);
    });

    it('CASH_DELTA: balanceDelta.amount=+(price×qty) для SELL', () => {
      // SELL 10 @ 0.62 = +6.20
      const fill = makeFill({
        side: 'SELL',
        price: OutcomePrice.of(new Decimal('0.62')),
        size: Quantity.of(new Decimal('10')),
        fee: makeZeroFee(),
      });
      const entries = FillLedgerAdapter.toLedgerEntries(fill);

      const cashEntry = entries.find(e => e.type === 'CASH_DELTA');
      expect(cashEntry).toBeDefined();
      expect(cashEntry!.balanceDelta.amount.toNumber()).toBeCloseTo(6.20, 5);
    });
  });

  describe('toLedgerEntries() — с комиссией', () => {
    it('возвращает 3 записи при ненулевой комиссии', () => {
      const fill = makeFill({ fee: makeNonZeroFee('0.02') });
      const entries = FillLedgerAdapter.toLedgerEntries(fill);

      expect(entries).toHaveLength(3);
    });

    it('FEE_DEBIT: balanceDelta.amount=-feeAmount', () => {
      const fill = makeFill({ fee: makeNonZeroFee('0.02') });
      const entries = FillLedgerAdapter.toLedgerEntries(fill);

      const feeEntry = entries.find(e => e.type === 'FEE_DEBIT');
      expect(feeEntry).toBeDefined();
      expect(feeEntry!.balanceDelta.amount.toNumber()).toBeCloseTo(-0.02, 5);
    });
  });

  describe('toLedgerEntries() — метаданные записей', () => {
    it('все записи имеют одинаковый fillId и accountId', () => {
      const fill = makeFill({ fee: makeNonZeroFee('0.01') });
      const entries = FillLedgerAdapter.toLedgerEntries(fill);

      for (const entry of entries) {
        expect(entry.fillId).toBe(fill.id);
        expect(entry.accountId).toBe(fill.accountId);
        expect(entry.timestamp).toBe(fill.timestamp);
      }
    });

    it('суммарный USDC delta = getNetCashFlow().amount', () => {
      // BUY 10 @ 0.62, fee 0.02 → net = -6.22
      const fill = makeFill({
        side: 'BUY',
        price: OutcomePrice.of(new Decimal('0.62')),
        size: Quantity.of(new Decimal('10')),
        fee: makeNonZeroFee('0.02'),
      });
      const entries = FillLedgerAdapter.toLedgerEntries(fill);

      const usdcStr = assetIdToString(AssetIdHelpers.USDC);
      const usdcEntries = entries.filter(
        e => assetIdToString(e.balanceDelta.asset) === usdcStr
      );
      const totalUsdcDelta = usdcEntries.reduce(
        (acc, e) => acc.plus(e.balanceDelta.amount.value()),
        new Decimal(0)
      );

      expect(totalUsdcDelta.toNumber()).toBeCloseTo(fill.getNetCashFlow().amount.toNumber(), 5);
    });
  });
});

describe('ALL_LEDGER_ENTRY_TYPES', () => {
  it('содержит все три допустимых типа записей', () => {
    expect(ALL_LEDGER_ENTRY_TYPES).toContain('POSITION_DELTA');
    expect(ALL_LEDGER_ENTRY_TYPES).toContain('CASH_DELTA');
    expect(ALL_LEDGER_ENTRY_TYPES).toContain('FEE_DEBIT');
    expect(ALL_LEDGER_ENTRY_TYPES).toHaveLength(3);
  });

  it('является readonly (Object.isFrozen)', () => {
    expect(Object.isFrozen(ALL_LEDGER_ENTRY_TYPES)).toBe(true);
  });
});
