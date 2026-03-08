/**
 * Тесты для Fee
 */

import { describe, it, expect } from '@jest/globals';
import { Fee, FeeOperationError, FeeOperationErrorReason } from '../../../src/fee/index.js';
import { AssetQuantity } from '../../../src/asset-quantity/core/AssetQuantity.js';
import { Quantity } from '../../../src/quantity/core/Quantity.js';
import {
  AssetIdHelpers,
  type OnChainConditionRef,
  type ConditionId,
  BinaryOutcome,
  KnownOnChainProtocols,
} from '@polymarket/ids';
import Decimal from 'decimal.js';

describe('Fee', () => {
  describe('of()', () => {
    it('should create Fee from AssetQuantity', () => {
      const qty = Quantity.of(new Decimal('0.10'));
      const assetQty = AssetQuantity.usdc(qty);
      const fee = Fee.of(assetQty);

      expect(fee.quantity.amount().toNumber()).toBe(0.10);
      expect(fee.asset.type).toBe('CURRENCY');
    });

    it('should create Fee with zero amount', () => {
      const assetQty = AssetQuantity.usdc(Quantity.ZERO);
      const fee = Fee.of(assetQty);

      expect(fee.isZero()).toBe(true);
    });

    it('should create Fee with positive amount', () => {
      const qty = Quantity.of(new Decimal('100'));
      const assetQty = AssetQuantity.usdc(qty);
      const fee = Fee.of(assetQty);

      expect(fee.quantity.amount().toNumber()).toBe(100);
      expect(fee.isZero()).toBe(false);
    });
  });

  describe('zero()', () => {
    it('should create zero Fee for USDC', () => {
      const fee = Fee.zero(AssetIdHelpers.USDC);

      expect(fee.isZero()).toBe(true);
      expect(fee.quantity.amount().toNumber()).toBe(0);
      expect(fee.asset.type).toBe('CURRENCY');
      if (fee.asset.type === 'CURRENCY') {
        expect(fee.asset.currency).toBe('USDC');
      }
    });

    it('should create zero Fee for same currency from different constructors', () => {
      const fee1 = Fee.zero(AssetIdHelpers.USDC);
      const fee2 = Fee.zero(AssetIdHelpers.fromCurrency('USDC'));

      expect(fee1.equals(fee2)).toBe(true);
    });
  });

  describe('quantity getter', () => {
    it('should return AssetQuantity', () => {
      const qty = Quantity.of(new Decimal('0.10'));
      const assetQty = AssetQuantity.usdc(qty);
      const fee = Fee.of(assetQty);

      const retrievedQty = fee.quantity;

      expect(retrievedQty.amount().toNumber()).toBe(0.10);
      expect(retrievedQty.asset().type).toBe('CURRENCY');
    });
  });

  describe('asset getter', () => {
    it('should return AssetId', () => {
      const fee = Fee.zero(AssetIdHelpers.USDC);
      const asset = fee.asset;

      expect(asset.type).toBe('CURRENCY');
      if (asset.type === 'CURRENCY') {
        expect(asset.currency).toBe('USDC');
      }
    });

    it('should be shortcut for quantity.asset()', () => {
      const qty = Quantity.of(new Decimal('0.10'));
      const assetQty = AssetQuantity.usdc(qty);
      const fee = Fee.of(assetQty);

      expect(fee.asset).toEqual(fee.quantity.asset());
    });
  });

  describe('isZero()', () => {
    it('should return true for zero fee', () => {
      const fee = Fee.zero(AssetIdHelpers.USDC);

      expect(fee.isZero()).toBe(true);
    });

    it('should return false for non-zero fee', () => {
      const qty = Quantity.of(new Decimal('0.10'));
      const assetQty = AssetQuantity.usdc(qty);
      const fee = Fee.of(assetQty);

      expect(fee.isZero()).toBe(false);
    });

    it('should return false for small positive fee', () => {
      const qty = Quantity.of(new Decimal('0.0001'));
      const assetQty = AssetQuantity.usdc(qty);
      const fee = Fee.of(assetQty);

      expect(fee.isZero()).toBe(false);
    });
  });

  describe('add()', () => {
    it('should add two fees with same asset', () => {
      const fee1 = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
      const fee2 = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.05'))));

      const total = fee1.add(fee2);

      expect(total.quantity.amount().toNumber()).toBe(0.15);
    });

    it('should add zero fee', () => {
      const fee = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
      const zeroFee = Fee.zero(AssetIdHelpers.USDC);

      const total = fee.add(zeroFee);

      expect(total.quantity.amount().toNumber()).toBe(0.10);
    });

    it('should add two zero fees', () => {
      const fee1 = Fee.zero(AssetIdHelpers.USDC);
      const fee2 = Fee.zero(AssetIdHelpers.USDC);

      const total = fee1.add(fee2);

      expect(total.isZero()).toBe(true);
    });

    it('should be commutative', () => {
      const fee1 = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
      const fee2 = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.05'))));

      const total1 = fee1.add(fee2);
      const total2 = fee2.add(fee1);

      expect(total1.equals(total2)).toBe(true);
    });

    it('should handle large fee amounts', () => {
      const fee1 = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('1000000'))));
      const fee2 = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('500000'))));

      const total = fee1.add(fee2);

      expect(total.quantity.amount().toNumber()).toBe(1500000);
    });

    it('should add fees with same currency from different constructors', () => {
      const usdcFee = Fee.zero(AssetIdHelpers.USDC);
      const otherAsset = AssetIdHelpers.fromCurrency('USDC');
      const otherFee = Fee.zero(otherAsset);

      // Should work because same currency
      expect(() => usdcFee.add(otherFee)).not.toThrow();
    });

    it('should use Decimal arithmetic for precision', () => {
      const fee1 = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.1'))));
      const fee2 = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.2'))));

      const total = fee1.add(fee2);

      // Should be exactly 0.3, not 0.30000000000000004 (float issue)
      expect(total.quantity.amount().toNumber()).toBe(0.3);
    });

    it('should throw FeeOperationError when adding fees with different assets', () => {
      const usdcFee = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));

      // Создаём outcome token fee
      const conditionRef: OnChainConditionRef = {
        kind: 'ONCHAIN',
        protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
        chainId: 137 as any,
        conditionId: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as ConditionId,
      };
      const tokenAssetResult = AssetIdHelpers.fromOutcomeToken(conditionRef, BinaryOutcome.UP);
      expect(tokenAssetResult.ok).toBe(true);
      if (!tokenAssetResult.ok) return;

      const tokenFee = Fee.of(new AssetQuantity(tokenAssetResult.value, Quantity.of(new Decimal('0.05'))));

      // Should throw FeeOperationError with ASSET_MISMATCH reason
      expect(() => usdcFee.add(tokenFee)).toThrow(FeeOperationError);

      try {
        usdcFee.add(tokenFee);
      } catch (e) {
        if (e instanceof FeeOperationError && e.context) {
          expect(e.context.reason).toBe(FeeOperationErrorReason.ASSET_MISMATCH);
          expect(e.context.operation).toBe('add');
          expect(e.context.asset1).toBeDefined();
          expect(e.context.asset2).toBeDefined();
        }
      }
    });
  });

  describe('equals()', () => {
    it('should return true for same asset and amount', () => {
      const fee1 = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
      const fee2 = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));

      expect(fee1.equals(fee2)).toBe(true);
    });

    it('should return false for same asset but different amount', () => {
      const fee1 = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
      const fee2 = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.20'))));

      expect(fee1.equals(fee2)).toBe(false);
    });

    it('should return true for two zero fees', () => {
      const fee1 = Fee.zero(AssetIdHelpers.USDC);
      const fee2 = Fee.zero(AssetIdHelpers.USDC);

      expect(fee1.equals(fee2)).toBe(true);
    });

    it('should be reflexive', () => {
      const fee = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));

      expect(fee.equals(fee)).toBe(true);
    });

    it('should be symmetric', () => {
      const fee1 = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
      const fee2 = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));

      expect(fee1.equals(fee2)).toBe(fee2.equals(fee1));
    });

    it('should be transitive', () => {
      const fee1 = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
      const fee2 = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
      const fee3 = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));

      expect(fee1.equals(fee2)).toBe(true);
      expect(fee2.equals(fee3)).toBe(true);
      expect(fee1.equals(fee3)).toBe(true);
    });
  });

  describe('toString()', () => {
    it('should return debug string for USDC fee', () => {
      const fee = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
      const str = fee.toString();

      expect(str).toContain('Fee');
      expect(str).toContain('CURRENCY:USDC');
      expect(str).toContain('0.1');
    });

    it('should return debug string for zero fee', () => {
      const fee = Fee.zero(AssetIdHelpers.USDC);
      const str = fee.toString();

      expect(str).toContain('Fee');
      expect(str).toContain('0');
    });

    it('should return debug string for outcome token fee', () => {
      const conditionRef: OnChainConditionRef = {
        kind: 'ONCHAIN',
        protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
        chainId: 137 as any,
        conditionId: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as ConditionId,
      };
      const tokenAssetResult = AssetIdHelpers.fromOutcomeToken(conditionRef, BinaryOutcome.UP);
      expect(tokenAssetResult.ok).toBe(true);
      if (!tokenAssetResult.ok) return;

      const tokenFee = Fee.of(new AssetQuantity(tokenAssetResult.value, Quantity.of(new Decimal('0.05'))));
      const str = tokenFee.toString();

      expect(str).toContain('Fee');
      expect(str).toContain('OUTCOME_TOKEN');
      expect(str).toContain('0x1234567890abcdef');
      expect(str).toContain('UP');
      expect(str).toContain('0.05');
    });
  });

  describe('toDebitDelta()', () => {
    it('возвращает отрицательный amount для ненулевой комиссии', () => {
      const fee = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.02'))));
      const delta = fee.toDebitDelta();

      expect(delta.amount.toNumber()).toBeCloseTo(-0.02, 10);
    });

    it('возвращает нулевой amount для нулевой комиссии', () => {
      const fee = Fee.zero(AssetIdHelpers.USDC);
      const delta = fee.toDebitDelta();

      expect(delta.amount.isZero()).toBe(true);
    });

    it('asset совпадает с fee.asset', () => {
      const fee = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
      const delta = fee.toDebitDelta();

      expect(delta.asset).toEqual(fee.asset);
    });

    it('amount всегда <= 0', () => {
      const fee = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('100'))));
      const delta = fee.toDebitDelta();

      expect(delta.amount.value().lte(0)).toBe(true);
    });

    it('не мутирует исходный Fee', () => {
      const fee = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
      fee.toDebitDelta();

      expect(fee.quantity.amount().toNumber()).toBe(0.10);
    });
  });

  describe('immutability', () => {
    it('should not modify original fee when adding', () => {
      const fee1 = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
      const fee2 = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.05'))));

      const originalAmount = fee1.quantity.amount().toNumber();
      fee1.add(fee2);

      expect(fee1.quantity.amount().toNumber()).toBe(originalAmount);
    });

    it('should return new Fee instance from add()', () => {
      const fee1 = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
      const fee2 = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.05'))));

      const total = fee1.add(fee2);

      expect(total).not.toBe(fee1);
      expect(total).not.toBe(fee2);
    });
  });
});
