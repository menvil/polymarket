/**
 * Тесты для FeeFormatter
 */

import { describe, it, expect } from '@jest/globals';
import { Fee, FeeFormatter } from '../../../src/fee/index.js';
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

describe('FeeFormatter', () => {
  const testFee = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
  const zeroFee = Fee.zero(AssetIdHelpers.USDC);

  describe('toDisplay()', () => {
    it('should format fee with asset symbol', () => {
      const result = FeeFormatter.toDisplay(testFee);

      expect(result).toContain('0.1');
      expect(result).toContain('USDC');
    });

    it('should format zero fee', () => {
      const result = FeeFormatter.toDisplay(zeroFee);

      expect(result).toContain('0');
      expect(result).toContain('USDC');
    });

    it('should format outcome token fee', () => {
      const conditionRef: OnChainConditionRef = {
        kind: 'ONCHAIN',
        protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
        chainId: 137 as any,
        conditionId: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd' as ConditionId,
      };
      const tokenAssetResult = AssetIdHelpers.fromOutcomeToken(conditionRef, BinaryOutcome.DOWN);
      expect(tokenAssetResult.ok).toBe(true);
      if (!tokenAssetResult.ok) return;

      const tokenFee = Fee.of(new AssetQuantity(tokenAssetResult.value, Quantity.of(new Decimal('1.5'))));
      const result = FeeFormatter.toDisplay(tokenFee);

      expect(result).toContain('1.5');
      expect(result).toContain('DOWN:');
    });

    it('should preserve precision for large decimals', () => {
      const preciseFee = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('123456789.123456789012345'))));
      const result = FeeFormatter.toDisplay(preciseFee);

      expect(result).toBe('123456789.123456789012345 USDC');
    });
  });

  describe('toAmount()', () => {
    it('should format only amount', () => {
      const result = FeeFormatter.toAmount(testFee);

      expect(result).toBe('0.1');
    });

    it('should format zero amount', () => {
      const result = FeeFormatter.toAmount(zeroFee);

      expect(result).toBe('0');
    });

    it('should preserve precision for large decimals', () => {
      const preciseFee = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('123456789.123456789012345'))));
      const result = FeeFormatter.toAmount(preciseFee);

      expect(result).toBe('123456789.123456789012345');
    });
  });

  describe('toAssetSymbol()', () => {
    it('should return currency symbol for USDC', () => {
      const result = FeeFormatter.toAssetSymbol(testFee);

      expect(result).toBe('USDC');
    });

    it('should return currency symbol for zero fee', () => {
      const result = FeeFormatter.toAssetSymbol(zeroFee);

      expect(result).toBe('USDC');
    });

    it('should format outcome token symbol with short condition ID', () => {
      const conditionRef: OnChainConditionRef = {
        kind: 'ONCHAIN',
        protocolId: KnownOnChainProtocols.POLYMARKET_CTF,
        chainId: 137 as any,
        conditionId: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as ConditionId,
      };
      const tokenAssetResult = AssetIdHelpers.fromOutcomeToken(conditionRef, BinaryOutcome.UP);
      expect(tokenAssetResult.ok).toBe(true);
      if (!tokenAssetResult.ok) return;

      const tokenFee = Fee.of(new AssetQuantity(tokenAssetResult.value, Quantity.of(new Decimal('0.10'))));
      const result = FeeFormatter.toAssetSymbol(tokenFee);

      // Should be "UP:0x1234...cdef" (first 6 chars + ... + last 4 chars)
      expect(result).toContain('UP:');
      expect(result).toContain('0x1234');
      expect(result).toContain('cdef');
      expect(result).toContain('...');
    });
  });

  describe('toDebugString()', () => {
    it('should format for debugging', () => {
      const result = FeeFormatter.toDebugString(testFee);

      expect(result).toContain('Fee');
      expect(result).toContain('USDC');
      expect(result).toContain('0.1');
    });

    it('should format zero fee for debugging', () => {
      const result = FeeFormatter.toDebugString(zeroFee);

      expect(result).toContain('Fee');
      expect(result).toContain('USDC');
      expect(result).toContain('0');
    });
  });
});
