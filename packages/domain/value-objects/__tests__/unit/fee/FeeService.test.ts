/**
 * Тесты для FeeService
 */

import { describe, it, expect, jest } from '@jest/globals';
import { FeeService, FeeOperationError, FeeOperationErrorReason } from '../../../src/fee/index.js';
import { AssetQuantity } from '../../../src/asset-quantity/core/AssetQuantity.js';
import { Quantity } from '../../../src/quantity/core/Quantity.js';
import {
  AssetIdHelpers,
  type OnChainConditionRef,
  type ConditionId,
  BinaryOutcome,
  KnownOnChainProtocols,
} from '@polymarket/ids';
import { FeeErrorReason } from '../../../src/fee/errors/FeeErrorReason.js';
import Decimal from 'decimal.js';

describe('FeeService', () => {
  describe('create()', () => {
    it('should create Fee from number', () => {
      const result = FeeService.create(AssetIdHelpers.USDC, 0.10);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.quantity.amount().toNumber()).toBe(0.10);
        expect(result.value.asset.type).toBe('CURRENCY');
      }
    });

    it('should create Fee from string', () => {
      const result = FeeService.create(AssetIdHelpers.USDC, '0.123456789012345');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.quantity.amount().value().toString()).toBe('0.123456789012345');
      }
    });

    it('should create Fee from Decimal', () => {
      const result = FeeService.create(AssetIdHelpers.USDC, new Decimal('5.5'));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.quantity.amount().toNumber()).toBe(5.5);
      }
    });

    it('should create zero Fee', () => {
      const result = FeeService.create(AssetIdHelpers.USDC, 0);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isZero()).toBe(true);
      }
    });

    it('should fail for negative amount', () => {
      const result = FeeService.create(AssetIdHelpers.USDC, -10);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(FeeErrorReason.NEGATIVE_FEE);
        expect(result.error.message).toContain('non-negative');
      }
    });

    it('should fail for NaN amount', () => {
      const result = FeeService.create(AssetIdHelpers.USDC, NaN);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(FeeErrorReason.INVALID_QUANTITY);
      }
    });

    it('should fail for Infinity amount', () => {
      const result = FeeService.create(AssetIdHelpers.USDC, Infinity);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(FeeErrorReason.INVALID_QUANTITY);
        expect(result.error.message).toContain('finite');
      }
    });

    it('should fail for invalid asset (null)', () => {
      const result = FeeService.create(null as any, 10);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Invalid asset');
        expect(result.error.context?.reason).toBe(FeeErrorReason.INVALID_ASSET);
      }
    });

    it('should fail for invalid asset (not object)', () => {
      const result = FeeService.create('USDC' as any, 10);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Invalid asset');
        expect(result.error.context?.reason).toBe(FeeErrorReason.INVALID_ASSET);
      }
    });

    it('should preserve precision for large decimals', () => {
      const precise = '123456789.123456789012345';
      const result = FeeService.create(AssetIdHelpers.USDC, precise);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.quantity.amount().value().toString()).toBe(precise);
      }
    });
  });

  describe('of()', () => {
    it('should create Fee from AssetQuantity', () => {
      const qty = Quantity.of(new Decimal('0.10'));
      const assetQty = AssetQuantity.usdc(qty);
      const fee = FeeService.of(assetQty);

      expect(fee.quantity.amount().toNumber()).toBe(0.10);
    });
  });

  describe('zero()', () => {
    it('should create zero Fee', () => {
      const fee = FeeService.zero(AssetIdHelpers.USDC);

      expect(fee.isZero()).toBe(true);
    });
  });

  describe('add()', () => {
    it('should add two fees with same asset', () => {
      const fee1 = FeeService.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
      const fee2 = FeeService.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.05'))));

      const result = FeeService.add(fee1, fee2);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.quantity.amount().toNumber()).toBe(0.15);
      }
    });

    it('should add zero fee', () => {
      const fee = FeeService.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
      const zeroFee = FeeService.zero(AssetIdHelpers.USDC);

      const result = FeeService.add(fee, zeroFee);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.quantity.amount().toNumber()).toBe(0.10);
      }
    });

    it('should fail when adding fees with different assets', () => {
      const usdcFee = FeeService.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));

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

      const tokenFee = FeeService.of(new AssetQuantity(tokenAssetResult.value, Quantity.of(new Decimal('0.05'))));

      const result = FeeService.add(usdcFee, tokenFee);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(FeeOperationErrorReason.ASSET_MISMATCH);
        expect(result.error.context?.operation).toBe('add');
      }
    });

    it('should preserve precision when adding large decimals', () => {
      const fee1Result = FeeService.create(AssetIdHelpers.USDC, '123456789.123456789012345');
      const fee2Result = FeeService.create(AssetIdHelpers.USDC, '987654321.987654321098765');

      expect(fee1Result.ok).toBe(true);
      expect(fee2Result.ok).toBe(true);
      if (!fee1Result.ok || !fee2Result.ok) return;

      const result = FeeService.add(fee1Result.value, fee2Result.value);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Decimal.js результат (с учетом precision)
        const expected = '1111111111.1111111101';
        expect(result.value.quantity.amount().value().toString()).toBe(expected);
      }
    });

    it('should never throw (Never Throws contract)', () => {
      const fee1 = FeeService.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
      const fee2 = FeeService.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.05'))));

      // Should not throw regardless of inputs
      expect(() => FeeService.add(fee1, fee2)).not.toThrow();
    });

    it('should return Result for all error cases (Never Throws contract)', () => {
      const fee1 = FeeService.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
      const fee2 = FeeService.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.05'))));

      // Normal case
      const result = FeeService.add(fee1, fee2);
      expect(result).toHaveProperty('ok');

      // Error case
      const conditionRef: OnChainConditionRef = {
        kind: 'ONCHAIN',
        protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
        chainId: 137 as any,
        conditionId: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890' as ConditionId,
      };
      const tokenAssetResult = AssetIdHelpers.fromOutcomeToken(conditionRef, BinaryOutcome.UP);
      if (!tokenAssetResult.ok) return;
      const tokenFee = FeeService.of(new AssetQuantity(tokenAssetResult.value, Quantity.of(new Decimal('0.05'))));

      const errorResult = FeeService.add(fee1, tokenFee);
      expect(errorResult).toHaveProperty('ok');
      expect(errorResult.ok).toBe(false);
    });

    it('should wrap unexpected errors in FeeOperationError with UNEXPECTED_ERROR', () => {
      const fee1 = FeeService.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
      const fee2 = FeeService.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.05'))));

      // Mock fee1.add to throw unexpected error
      const addSpy = jest.spyOn(fee1, 'add').mockImplementation(() => {
        throw new Error('Unexpected runtime error');
      });

      const result = FeeService.add(fee1, fee2);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(FeeOperationError);
        expect(result.error.context?.reason).toBe(FeeOperationErrorReason.UNEXPECTED_ERROR);
        expect(result.error.message).toContain('Unexpected runtime error');
      }

      addSpy.mockRestore();
    });
  });

  describe('equals()', () => {
    it('should compare two fees', () => {
      const fee1 = FeeService.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
      const fee2 = FeeService.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));

      expect(FeeService.equals(fee1, fee2)).toBe(true);
    });

    it('should return false for different fees', () => {
      const fee1 = FeeService.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
      const fee2 = FeeService.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.20'))));

      expect(FeeService.equals(fee1, fee2)).toBe(false);
    });
  });
});
