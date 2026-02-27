/**
 * Тесты для SideService
 */

import { describe, it, expect } from '@jest/globals';
import { SideService, type Side, SideErrorReason } from '../../../src/side/index.js';

describe('SideService', () => {
  describe('fromString()', () => {
    it('should create Side from valid BUY string', () => {
      const result = SideService.fromString('BUY');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe('BUY');
      }
    });

    it('should create Side from valid SELL string', () => {
      const result = SideService.fromString('SELL');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe('SELL');
      }
    });

    it('should fail for invalid string', () => {
      const result = SideService.fromString('INVALID');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Invalid side value');
        expect(result.error.context?.reason).toBe(SideErrorReason.INVALID_VALUE);
        expect(result.error.context?.value).toBe('INVALID');
        expect(result.error.context?.expectedValues).toEqual(['BUY', 'SELL']);
      }
    });

    it('should fail for lowercase buy with INVALID_VALUE and expectedValues', () => {
      const result = SideService.fromString('buy');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(SideErrorReason.INVALID_VALUE);
        expect(result.error.context?.expectedValues).toEqual(['BUY', 'SELL']);
      }
    });

    it('should fail for empty string', () => {
      const result = SideService.fromString('');

      expect(result.ok).toBe(false);
    });
  });

  describe('fromUnknown()', () => {
    it('should create Side from valid BUY', () => {
      const value: unknown = 'BUY';
      const result = SideService.fromUnknown(value);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe('BUY');
      }
    });

    it('should create Side from valid SELL', () => {
      const value: unknown = 'SELL';
      const result = SideService.fromUnknown(value);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe('SELL');
      }
    });

    it('should fail for non-string type (number)', () => {
      const value: unknown = 123;
      const result = SideService.fromUnknown(value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('must be string');
        expect(result.error.context?.reason).toBe(SideErrorReason.INVALID_TYPE);
        expect(result.error.context?.type).toBe('number');
      }
    });

    it('should fail for null with INVALID_TYPE and distinct actualTag', () => {
      const value: unknown = null;
      const result = SideService.fromUnknown(value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(SideErrorReason.INVALID_TYPE);
        expect(result.error.context?.type).toBe('object');
        expect(result.error.context?.actualTag).toBe('[object Null]');
        expect(result.error.message).toContain('[object Null]');
      }
    });

    it('should fail for undefined', () => {
      const value: unknown = undefined;
      const result = SideService.fromUnknown(value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.type).toBe('undefined');
      }
    });

    it('should fail for object', () => {
      const value: unknown = { side: 'BUY' };
      const result = SideService.fromUnknown(value);

      expect(result.ok).toBe(false);
    });

    it('should fail for array with distinct actualTag [object Array]', () => {
      const value: unknown = ['BUY'];
      const result = SideService.fromUnknown(value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.actualTag).toBe('[object Array]');
        expect(result.error.message).toContain('[object Array]');
      }
    });
  });

  describe('isValid()', () => {
    it('should return true for BUY', () => {
      expect(SideService.isValid('BUY')).toBe(true);
    });

    it('should return true for SELL', () => {
      expect(SideService.isValid('SELL')).toBe(true);
    });

    it('should return false for invalid string', () => {
      expect(SideService.isValid('INVALID')).toBe(false);
    });

    it('should return false for lowercase', () => {
      expect(SideService.isValid('buy')).toBe(false);
      expect(SideService.isValid('sell')).toBe(false);
    });

    it('should return false for null', () => {
      expect(SideService.isValid(null)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(SideService.isValid(undefined)).toBe(false);
    });

    it('should return false for number', () => {
      expect(SideService.isValid(123)).toBe(false);
    });
  });

  describe('opposite()', () => {
    it('should return SELL for BUY', () => {
      expect(SideService.opposite('BUY')).toBe('SELL');
    });

    it('should return BUY for SELL', () => {
      expect(SideService.opposite('SELL')).toBe('BUY');
    });

    it('should be reversible', () => {
      const side: Side = 'BUY';
      const opp = SideService.opposite(side);
      const original = SideService.opposite(opp);
      expect(original).toBe(side);
    });
  });

  describe('canMatch()', () => {
    it('should return true for BUY and SELL', () => {
      expect(SideService.canMatch('BUY', 'SELL')).toBe(true);
    });

    it('should return true for SELL and BUY', () => {
      expect(SideService.canMatch('SELL', 'BUY')).toBe(true);
    });

    it('should return false for BUY and BUY', () => {
      expect(SideService.canMatch('BUY', 'BUY')).toBe(false);
    });

    it('should return false for SELL and SELL', () => {
      expect(SideService.canMatch('SELL', 'SELL')).toBe(false);
    });

    it('should be symmetric', () => {
      const side1: Side = 'BUY';
      const side2: Side = 'SELL';
      expect(SideService.canMatch(side1, side2)).toBe(SideService.canMatch(side2, side1));
    });
  });

  describe('equals()', () => {
    it('should return true for same side', () => {
      expect(SideService.equals('BUY', 'BUY')).toBe(true);
      expect(SideService.equals('SELL', 'SELL')).toBe(true);
    });

    it('should return false for different sides', () => {
      expect(SideService.equals('BUY', 'SELL')).toBe(false);
      expect(SideService.equals('SELL', 'BUY')).toBe(false);
    });

    it('should be reflexive', () => {
      const side: Side = 'BUY';
      expect(SideService.equals(side, side)).toBe(true);
    });

    it('should be symmetric', () => {
      const side1: Side = 'BUY';
      const side2: Side = 'SELL';
      expect(SideService.equals(side1, side2)).toBe(SideService.equals(side2, side1));
    });
  });

  describe('getAllValues()', () => {
    it('should return all Side values', () => {
      const all = SideService.getAllValues();

      expect(all).toEqual(['BUY', 'SELL']);
    });

    it('should return readonly array with correct length', () => {
      const all = SideService.getAllValues();

      expect(Array.isArray(all)).toBe(true);
      expect(all.length).toBe(2);
    });

    it('should return the same ALL_SIDES reference (no copy)', () => {
      // Проверяем что getAllValues() возвращает ALL_SIDES, а не копию
      const a = SideService.getAllValues();
      const b = SideService.getAllValues();

      expect(a).toBe(b);
    });
  });

  describe('isValidSide / ALL_SIDES consistency', () => {
    it('should accept every value from getAllValues()', () => {
      for (const side of SideService.getAllValues()) {
        expect(SideService.isValid(side)).toBe(true);
      }
    });

    it('should reject values not in getAllValues()', () => {
      expect(SideService.isValid('BUY_EXTRA')).toBe(false);
      expect(SideService.isValid('buy')).toBe(false);
      expect(SideService.isValid('')).toBe(false);
    });
  });

  describe('error context', () => {
    it('should include op and opChain in error context', () => {
      const result = SideService.fromString('INVALID');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.op).toBe('fromString');
        expect(result.error.context?.opChain).toBeDefined();
      }
    });

    it('should include service name in opChain', () => {
      const result = SideService.fromUnknown(123);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const opChain = result.error.context?.opChain;
        // opChain это массив операций
        expect(Array.isArray(opChain)).toBe(true);
        expect(opChain).toContain('SideService.fromUnknown');
      }
    });
  });
});
