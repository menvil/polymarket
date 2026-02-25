/**
 * Тесты для FeeService
 */

import { describe, it, expect } from '@jest/globals';
import { FeeService } from '../../../src/fee/index.js';
import { AssetQuantity } from '../../../src/asset-quantity/core/AssetQuantity.js';
import { Quantity } from '../../../src/quantity/core/Quantity.js';
import { AssetIdHelpers } from '@polymarket/ids';
import Decimal from 'decimal.js';

describe('FeeService', () => {
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
    it('should add two fees', () => {
      const fee1 = FeeService.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
      const fee2 = FeeService.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.05'))));

      const total = FeeService.add(fee1, fee2);

      expect(total.quantity.amount().toNumber()).toBe(0.15);
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
