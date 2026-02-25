/**
 * Тесты для FeeFormatter
 */

import { describe, it, expect } from '@jest/globals';
import { Fee, FeeFormatter } from '../../../src/fee/index.js';
import { AssetQuantity } from '../../../src/asset-quantity/core/AssetQuantity.js';
import { Quantity } from '../../../src/quantity/core/Quantity.js';
import { AssetIdHelpers } from '@polymarket/ids';
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
  });

  describe('toLogString()', () => {
    it('should format for logging', () => {
      const result = FeeFormatter.toLogString(testFee);

      expect(result).toContain('Fee');
      expect(result).toContain('USDC');
      expect(result).toContain('0.1');
    });
  });

  describe('toPercent()', () => {
    it('should format as percentage with default precision', () => {
      const feeRate = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.001'))));
      const result = FeeFormatter.toPercent(feeRate);

      expect(result).toBe('0.10%');
    });

    it('should format as percentage with custom precision', () => {
      const feeRate = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.0015'))));
      const result = FeeFormatter.toPercent(feeRate, 3);

      expect(result).toBe('0.150%');
    });

    it('should format zero as percentage', () => {
      const result = FeeFormatter.toPercent(zeroFee);

      expect(result).toBe('0.00%');
    });

    it('should format 1% correctly', () => {
      const onePercent = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.01'))));
      const result = FeeFormatter.toPercent(onePercent);

      expect(result).toBe('1.00%');
    });

    it('should format 10% correctly', () => {
      const tenPercent = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
      const result = FeeFormatter.toPercent(tenPercent);

      expect(result).toBe('10.00%');
    });
  });
});
