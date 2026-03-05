/**
 * Тесты для Ledger — in-memory бухгалтерской книги
 */

import { Ledger } from '../../src/Ledger';
import { LedgerEntry } from '../../src/LedgerEntry';
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
  assetIdToString,
  accountIdToString,
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

function makeAnotherAccountId() {
  const wallet = parseWalletAddress('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
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
    settlementAssetId: AssetIdHelpers.USDC,
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

describe('Ledger', () => {
  describe('append() + getEntries()', () => {
    it('пустой Ledger — getEntries возвращает пустой массив', () => {
      const ledger = new Ledger();
      expect(ledger.getEntries()).toHaveLength(0);
    });

    it('append() добавляет записи', () => {
      const ledger = new Ledger();
      const fill = makeFill({ fee: makeZeroFee() });
      const entries = FillLedgerAdapter.toLedgerEntries(fill);

      ledger.append(entries);

      expect(ledger.getEntries()).toHaveLength(2);
    });

    it('append() с комиссией добавляет 3 записи', () => {
      const ledger = new Ledger();
      const fill = makeFill({ fee: makeNonZeroFee('0.02') });
      const entries = FillLedgerAdapter.toLedgerEntries(fill);

      ledger.append(entries);

      expect(ledger.getEntries()).toHaveLength(3);
    });

    it('getEntries({ accountId }) фильтрует по аккаунту', () => {
      const ledger = new Ledger();
      const accountId = makeAccountId();
      const otherAccountId = makeAnotherAccountId();

      const fill1 = makeFill({ accountId });
      const fill2 = makeFill({
        id: asFillId('fill-999')!,
        accountId: otherAccountId,
      });

      ledger.append(FillLedgerAdapter.toLedgerEntries(fill1));
      ledger.append(FillLedgerAdapter.toLedgerEntries(fill2));

      const filtered = ledger.getEntries({ accountId });
      expect(filtered.length).toBe(2); // 2 записи из fill1 (нулевая fee)

      for (const entry of filtered) {
        expect(accountIdToString(entry.accountId)).toBe(accountIdToString(accountId));
      }
    });

    it('getEntries({ asset }) фильтрует по активу', () => {
      const ledger = new Ledger();
      const fill = makeFill({ fee: makeNonZeroFee('0.02') });
      ledger.append(FillLedgerAdapter.toLedgerEntries(fill));

      const usdcEntries = ledger.getEntries({ asset: AssetIdHelpers.USDC });
      // CASH_DELTA + FEE_DEBIT = 2 записи в USDC
      expect(usdcEntries.length).toBe(2);
      for (const entry of usdcEntries) {
        expect(assetIdToString(entry.balanceDelta.asset)).toContain('USDC');
      }
    });

    it('getEntries({ accountId, asset }) фильтрует по обоим полям', () => {
      const ledger = new Ledger();
      const fill = makeFill({ fee: makeZeroFee() });
      ledger.append(FillLedgerAdapter.toLedgerEntries(fill));

      const entries = ledger.getEntries({ accountId: fill.accountId, asset: AssetIdHelpers.USDC });
      expect(entries.length).toBe(1); // только CASH_DELTA в USDC
      expect(entries[0].type).toBe('CASH_DELTA');
    });
  });

  describe('getBalance()', () => {
    it('BUY: баланс USDC уменьшается', () => {
      const ledger = new Ledger();
      // BUY 10 @ 0.62 = USDC -6.20
      const fill = makeFill({ side: 'BUY', price: Price.of(new Decimal('0.62')), size: Quantity.of(new Decimal('10')) });
      ledger.append(FillLedgerAdapter.toLedgerEntries(fill));

      const usdcBalance = ledger.getBalance(fill.accountId, AssetIdHelpers.USDC);
      expect(usdcBalance.toNumber()).toBeCloseTo(-6.20, 5);
    });

    it('BUY: баланс токена увеличивается', () => {
      const ledger = new Ledger();
      const fill = makeFill({ side: 'BUY', size: Quantity.of(new Decimal('10')) });
      ledger.append(FillLedgerAdapter.toLedgerEntries(fill));

      const tokenBalance = ledger.getBalance(fill.accountId, fill.tokenId);
      expect(tokenBalance.toNumber()).toBe(10);
    });

    it('SELL: баланс USDC увеличивается', () => {
      const ledger = new Ledger();
      const fill = makeFill({ side: 'SELL', price: Price.of(new Decimal('0.62')), size: Quantity.of(new Decimal('10')) });
      ledger.append(FillLedgerAdapter.toLedgerEntries(fill));

      const usdcBalance = ledger.getBalance(fill.accountId, AssetIdHelpers.USDC);
      expect(usdcBalance.toNumber()).toBeCloseTo(6.20, 5);
    });

    it('несколько Fill: балансы суммируются', () => {
      const ledger = new Ledger();
      const accountId = makeAccountId();
      const tokenId = makeTokenId()!;

      // Fill 1: BUY 10 @ 0.62 = USDC -6.20, token +10
      const fill1 = makeFill({
        id: asFillId('fill-001')!,
        accountId,
        side: 'BUY',
        price: Price.of(new Decimal('0.62')),
        size: Quantity.of(new Decimal('10')),
        tokenId,
      });

      // Fill 2: BUY 5 @ 0.65 = USDC -3.25, token +5
      const fill2 = makeFill({
        id: asFillId('fill-002')!,
        accountId,
        side: 'BUY',
        price: Price.of(new Decimal('0.65')),
        size: Quantity.of(new Decimal('5')),
        tokenId,
      });

      ledger.append(FillLedgerAdapter.toLedgerEntries(fill1));
      ledger.append(FillLedgerAdapter.toLedgerEntries(fill2));

      const usdcBalance = ledger.getBalance(accountId, AssetIdHelpers.USDC);
      expect(usdcBalance.toNumber()).toBeCloseTo(-9.45, 5); // -6.20 + -3.25

      const tokenBalance = ledger.getBalance(accountId, tokenId);
      expect(tokenBalance.toNumber()).toBe(15); // 10 + 5
    });

    it('баланс несуществующего актива = 0', () => {
      const ledger = new Ledger();
      const accountId = makeAccountId();

      const balance = ledger.getBalance(accountId, AssetIdHelpers.USDC);
      expect(balance.toNumber()).toBe(0);
    });

    it('BUY + SELL нейтрализуют баланс токена', () => {
      const ledger = new Ledger();
      const accountId = makeAccountId();
      const tokenId = makeTokenId()!;

      const buy = makeFill({
        id: asFillId('fill-buy')!,
        accountId,
        side: 'BUY',
        size: Quantity.of(new Decimal('10')),
        tokenId,
      });

      const sell = makeFill({
        id: asFillId('fill-sell')!,
        accountId,
        side: 'SELL',
        size: Quantity.of(new Decimal('10')),
        tokenId,
      });

      ledger.append(FillLedgerAdapter.toLedgerEntries(buy));
      ledger.append(FillLedgerAdapter.toLedgerEntries(sell));

      const tokenBalance = ledger.getBalance(accountId, tokenId);
      expect(tokenBalance.toNumber()).toBe(0);
    });
  });

  describe('getAllBalances()', () => {
    it('возвращает Map с балансами всех активов', () => {
      const ledger = new Ledger();
      const fill = makeFill({ fee: makeNonZeroFee('0.02') });
      ledger.append(FillLedgerAdapter.toLedgerEntries(fill));

      const balances = ledger.getAllBalances(fill.accountId);

      // Должны быть записи для tokenId и USDC
      expect(balances.size).toBe(2);

      const usdcStr = assetIdToString(AssetIdHelpers.USDC);
      expect(balances.has(usdcStr)).toBe(true);

      // USDC: CASH_DELTA + FEE_DEBIT = -(0.62*10) + (-0.02) = -6.22
      expect(balances.get(usdcStr)!.toNumber()).toBeCloseTo(-6.22, 5);
    });

    it('возвращает пустую Map для неизвестного аккаунта', () => {
      const ledger = new Ledger();
      const accountId = makeAccountId();

      const balances = ledger.getAllBalances(accountId);
      expect(balances.size).toBe(0);
    });
  });

  describe('replay()', () => {
    it('возвращает записи в хронологическом порядке', () => {
      const ledger = new Ledger();
      const accountId = makeAccountId();
      const tokenId = makeTokenId()!;

      const fill1 = makeFill({
        id: asFillId('fill-early')!,
        accountId,
        tokenId,
        timestamp: unwrap(TimestampService.create(1700000001000), 'ts1'),
      });

      const fill2 = makeFill({
        id: asFillId('fill-late')!,
        accountId,
        tokenId,
        timestamp: unwrap(TimestampService.create(1700000002000), 'ts2'),
      });

      // Добавляем в обратном порядке
      ledger.append(FillLedgerAdapter.toLedgerEntries(fill2));
      ledger.append(FillLedgerAdapter.toLedgerEntries(fill1));

      const history = ledger.replay(accountId);

      // replay сортирует хронологически
      expect(history.length).toBe(4); // 2 записи x2 fill
      for (let i = 1; i < history.length; i++) {
        expect(history[i].timestamp.toNumber()).toBeGreaterThanOrEqual(
          history[i - 1].timestamp.toNumber()
        );
      }
    });

    it('replay фильтрует только по запрошенному аккаунту', () => {
      const ledger = new Ledger();
      const accountId = makeAccountId();
      const otherId = makeAnotherAccountId();

      ledger.append(FillLedgerAdapter.toLedgerEntries(makeFill({ accountId })));
      ledger.append(FillLedgerAdapter.toLedgerEntries(
        makeFill({ id: asFillId('fill-other')!, accountId: otherId })
      ));

      const history = ledger.replay(accountId);
      expect(history.length).toBe(2);
      for (const e of history) {
        expect(accountIdToString(e.accountId)).toBe(accountIdToString(accountId));
      }
    });
  });

  describe('LedgerEntry.create() — инварианты', () => {
    it('инвариант 1: amount=0 возвращает Err', () => {
      const tokenId = makeTokenId()!;
      const result = LedgerEntry.create({
        fillId: asFillId('fill-123')!,
        accountId: makeAccountId(),
        balanceDelta: { asset: tokenId, amount: new Decimal(0) },
        type: 'POSITION_DELTA',
        timestamp: unwrap(TimestampService.create(1700000000000)),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('must not be zero');
      }
    });

    it('инвариант 2: FEE_DEBIT с положительным amount возвращает Err', () => {
      const result = LedgerEntry.create({
        fillId: asFillId('fill-123')!,
        accountId: makeAccountId(),
        balanceDelta: { asset: AssetIdHelpers.USDC, amount: new Decimal('0.02') },
        type: 'FEE_DEBIT',
        timestamp: unwrap(TimestampService.create(1700000000000)),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('FEE_DEBIT');
      }
    });

    it('создаёт валидный POSITION_DELTA с положительным amount', () => {
      const tokenId = makeTokenId()!;
      const result = LedgerEntry.create({
        fillId: asFillId('fill-123')!,
        accountId: makeAccountId(),
        balanceDelta: { asset: tokenId, amount: new Decimal('10') },
        type: 'POSITION_DELTA',
        timestamp: unwrap(TimestampService.create(1700000000000)),
      });

      expect(result.ok).toBe(true);
    });

    it('создаёт валидный FEE_DEBIT с отрицательным amount', () => {
      const result = LedgerEntry.create({
        fillId: asFillId('fill-123')!,
        accountId: makeAccountId(),
        balanceDelta: { asset: AssetIdHelpers.USDC, amount: new Decimal('-0.02') },
        type: 'FEE_DEBIT',
        timestamp: unwrap(TimestampService.create(1700000000000)),
      });

      expect(result.ok).toBe(true);
    });
  });
});
