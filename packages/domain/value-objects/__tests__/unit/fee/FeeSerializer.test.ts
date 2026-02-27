/**
 * Тесты для FeeSerializer
 */

import { describe, it, expect } from '@jest/globals';
import { Fee, FeeSerializer } from '../../../src/fee/index.js';
import { AssetQuantity } from '../../../src/asset-quantity/core/AssetQuantity.js';
import { Quantity } from '../../../src/quantity/core/Quantity.js';
import { AssetIdHelpers } from '@polymarket/ids';
import { FeeErrorReason } from '../../../src/fee/errors/FeeErrorReason.js';
import Decimal from 'decimal.js';

describe('FeeSerializer', () => {
  describe('toJSON()', () => {
    it('should serialize Fee to JSON with string amount', () => {
      const fee = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal('0.10'))));
      const json = FeeSerializer.toJSON(fee);

      expect(json.asset.type).toBe('CURRENCY');
      if (json.asset.type === 'CURRENCY') {
        expect(json.asset.currency).toBe('USDC');
      }
      expect(json.amount).toBe('0.1');
      expect(typeof json.amount).toBe('string');
    });

    it('should serialize zero fee', () => {
      const fee = Fee.zero(AssetIdHelpers.USDC);
      const json = FeeSerializer.toJSON(fee);

      expect(json.amount).toBe('0');
      expect(typeof json.amount).toBe('string');
    });

    it('should preserve precision for large decimal values', () => {
      const preciseAmount = '123456789.123456789012345';
      const fee = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal(preciseAmount))));
      const json = FeeSerializer.toJSON(fee);

      expect(json.amount).toBe(preciseAmount);
    });
  });

  describe('fromJSON()', () => {
    it('should deserialize Fee from JSON with string amount', () => {
      const json = {
        asset: AssetIdHelpers.USDC,
        amount: '0.10',
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
        amount: '0',
      };
      const result = FeeSerializer.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isZero()).toBe(true);
      }
    });

    it('should preserve precision when deserializing large decimals', () => {
      const preciseAmount = '123456789.123456789012345';
      const json = {
        asset: AssetIdHelpers.USDC,
        amount: preciseAmount,
      };
      const result = FeeSerializer.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.quantity.amount().value().toString()).toBe(preciseAmount);
      }
    });
  });

  describe('fromUnknown()', () => {
    it('should deserialize Fee from unknown with string amount', () => {
      const value: unknown = {
        asset: AssetIdHelpers.USDC,
        amount: '0.10',
      };
      const result = FeeSerializer.fromUnknown(value);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.quantity.amount().toNumber()).toBe(0.10);
      }
    });

    it('should accept number amount for backward compatibility', () => {
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

    it('should fail for non-object with INVALID_STRUCTURE', () => {
      const value: unknown = 'not an object';
      const result = FeeSerializer.fromUnknown(value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('must be object');
        expect(result.error.context?.reason).toBe(FeeErrorReason.INVALID_STRUCTURE);
      }
    });

    it('should fail for null with INVALID_STRUCTURE', () => {
      const value: unknown = null;
      const result = FeeSerializer.fromUnknown(value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(FeeErrorReason.INVALID_STRUCTURE);
      }
    });

    it('should fail for missing asset field with INVALID_STRUCTURE', () => {
      const value: unknown = {
        amount: '0.10',
      };
      const result = FeeSerializer.fromUnknown(value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('must have asset and amount fields');
        expect(result.error.context?.reason).toBe(FeeErrorReason.INVALID_STRUCTURE);
      }
    });

    it('should fail for missing amount field with INVALID_STRUCTURE', () => {
      const value: unknown = {
        asset: AssetIdHelpers.USDC,
      };
      const result = FeeSerializer.fromUnknown(value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(FeeErrorReason.INVALID_STRUCTURE);
      }
    });

    it('should fail for invalid amount type', () => {
      const value: unknown = {
        asset: AssetIdHelpers.USDC,
        amount: null,
      };
      const result = FeeSerializer.fromUnknown(value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('amount must be string or number');
      }
    });

    it('should fail for object amount', () => {
      const value: unknown = {
        asset: AssetIdHelpers.USDC,
        amount: { value: 0.10 },
      };
      const result = FeeSerializer.fromUnknown(value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('amount must be string or number');
      }
    });

    it('should fail when fromJSON fails (NaN amount)', () => {
      const value: unknown = {
        asset: AssetIdHelpers.USDC,
        amount: NaN,
      };
      const result = FeeSerializer.fromUnknown(value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Error from Quantity.of() which rejects NaN
        expect(result.error).toBeDefined();
      }
    });

    it('should fail when fromJSON fails (Infinity amount)', () => {
      const value: unknown = {
        asset: AssetIdHelpers.USDC,
        amount: Infinity,
      };
      const result = FeeSerializer.fromUnknown(value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Error from Quantity.of() which rejects Infinity
        expect(result.error).toBeDefined();
      }
    });

    it('should fail when fromJSON fails (negative amount)', () => {
      const value: unknown = {
        asset: AssetIdHelpers.USDC,
        amount: -10,
      };
      const result = FeeSerializer.fromUnknown(value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Error from Quantity.of() which rejects negative
        expect(result.error).toBeDefined();
      }
    });

    it('should fail for invalid asset (null) with INVALID_ASSET', () => {
      const value: unknown = {
        asset: null,
        amount: '10',
      };
      const result = FeeSerializer.fromUnknown(value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(FeeErrorReason.INVALID_ASSET);
        expect(result.error.message).toContain('must be object with type field');
      }
    });

    it('should fail for invalid asset (string) with INVALID_ASSET', () => {
      const value: unknown = {
        asset: 'USDC',
        amount: '10',
      };
      const result = FeeSerializer.fromUnknown(value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(FeeErrorReason.INVALID_ASSET);
      }
    });

    it('should fail for asset without type field with INVALID_ASSET', () => {
      const value: unknown = {
        asset: { currency: 'USDC' },
        amount: '10',
      };
      const result = FeeSerializer.fromUnknown(value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(FeeErrorReason.INVALID_ASSET);
      }
    });

    it('should fail for invalid asset type with INVALID_ASSET', () => {
      const value: unknown = {
        asset: { type: 'INVALID_TYPE' },
        amount: '10',
      };
      const result = FeeSerializer.fromUnknown(value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(FeeErrorReason.INVALID_ASSET);
        expect(result.error.message).toContain('must be CURRENCY or OUTCOME_TOKEN');
      }
    });

    it('should fail for CURRENCY asset without currency field', () => {
      const value: unknown = {
        asset: { type: 'CURRENCY' },
        amount: '10',
      };
      const result = FeeSerializer.fromUnknown(value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(FeeErrorReason.INVALID_ASSET);
        expect(result.error.message).toContain('missing or invalid currency field');
      }
    });

    it('should fail for OUTCOME_TOKEN asset without conditionRef', () => {
      const value: unknown = {
        asset: { type: 'OUTCOME_TOKEN', outcomeKey: 'UP' },
        amount: '10',
      };
      const result = FeeSerializer.fromUnknown(value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(FeeErrorReason.INVALID_ASSET);
        expect(result.error.message).toContain('missing conditionRef or outcomeKey');
      }
    });

    it('should fail for OUTCOME_TOKEN asset without outcomeKey', () => {
      const value: unknown = {
        asset: { type: 'OUTCOME_TOKEN', conditionRef: {} },
        amount: '10',
      };
      const result = FeeSerializer.fromUnknown(value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(FeeErrorReason.INVALID_ASSET);
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

    it('should preserve precision for large decimal values in round-trip', () => {
      const preciseAmount = '123456789.123456789012345';
      const original = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal(preciseAmount))));
      const json = FeeSerializer.toJSON(original);
      const result = FeeSerializer.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.equals(original)).toBe(true);
        expect(result.value.quantity.amount().value().toString()).toBe(preciseAmount);
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

    it('should preserve precision through JSON.stringify round-trip', () => {
      const preciseAmount = '987654321.987654321098765';
      const original = Fee.of(AssetQuantity.usdc(Quantity.of(new Decimal(preciseAmount))));
      const json = FeeSerializer.toJSON(original);
      const stringified = JSON.stringify(json);
      const parsed = JSON.parse(stringified);
      const result = FeeSerializer.fromUnknown(parsed);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.equals(original)).toBe(true);
        expect(result.value.quantity.amount().value().toString()).toBe(preciseAmount);
      }
    });
  });
});
