/**
 * Тесты для FeeSerializer
 */

import { describe, it, expect } from '@jest/globals';
import { Fee, FeeSerializer } from '../../../src/fee/index.js';
import { AssetQuantity } from '../../../src/asset-quantity/core/AssetQuantity.js';
import { Quantity } from '../../../src/quantity/core/Quantity.js';
import { AssetIdHelpers } from '@polymarket/ids';
import Decimal from 'decimal.js';

describe('FeeSerializer', () => {
  describe('toJSON()', () => {
    it('should serialize Fee to JSON', () => {
      const fee = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
      const json = FeeSerializer.toJSON(fee);

      expect(json.asset.type).toBe('CURRENCY');
      if (json.asset.type === 'CURRENCY') {
        expect(json.asset.currency).toBe('USDC');
      }
      expect(json.amount).toBe(0.10);
    });

    it('should serialize zero fee', () => {
      const fee = Fee.zero(AssetIdHelpers.USDC);
      const json = FeeSerializer.toJSON(fee);

      expect(json.amount).toBe(0);
    });
  });

  describe('fromJSON()', () => {
    it('should deserialize Fee from JSON', () => {
      const json = {
        asset: AssetIdHelpers.USDC,
        amount: 0.10,
      };
      const result = FeeSerializer.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.quantity.amount().toNumber()).toBe(0.10);
        expect(result.value.asset.type).toBe('CURRENCY');
      }
    });

    it('should deserialize zero fee', () => {
      const json = {
        asset: AssetIdHelpers.USDC,
        amount: 0,
      };
      const result = FeeSerializer.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isZero()).toBe(true);
      }
    });
  });

  describe('fromUnknown()', () => {
    it('should deserialize Fee from unknown', () => {
      const value: unknown = {
        asset: AssetIdHelpers.USDC,
        amount: 0.10,
      };
      const result = FeeSerializer.fromUnknown(value);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.quantity.amount().toNumber()).toBe(0.10);
      }
    });

    it('should fail for non-object', () => {
      const value: unknown = 'not an object';
      const result = FeeSerializer.fromUnknown(value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('must be object');
      }
    });

    it('should fail for null', () => {
      const value: unknown = null;
      const result = FeeSerializer.fromUnknown(value);

      expect(result.ok).toBe(false);
    });

    it('should fail for missing asset field', () => {
      const value: unknown = {
        amount: 0.10,
      };
      const result = FeeSerializer.fromUnknown(value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('must have asset and amount fields');
      }
    });

    it('should fail for missing amount field', () => {
      const value: unknown = {
        asset: AssetIdHelpers.USDC,
      };
      const result = FeeSerializer.fromUnknown(value);

      expect(result.ok).toBe(false);
    });

    it('should fail for non-number amount', () => {
      const value: unknown = {
        asset: AssetIdHelpers.USDC,
        amount: '0.10',
      };
      const result = FeeSerializer.fromUnknown(value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('amount must be number');
      }
    });
  });

  describe('round-trip', () => {
    it('should preserve value through serialization round-trip', () => {
      const original = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
      const json = FeeSerializer.toJSON(original);
      const result = FeeSerializer.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.equals(original)).toBe(true);
      }
    });

    it('should work with JSON.stringify and JSON.parse', () => {
      const original = Fee.zero(AssetIdHelpers.USDC);
      const json = FeeSerializer.toJSON(original);
      const stringified = JSON.stringify(json);
      const parsed = JSON.parse(stringified);
      const result = FeeSerializer.fromUnknown(parsed);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.equals(original)).toBe(true);
      }
    });
  });
});
