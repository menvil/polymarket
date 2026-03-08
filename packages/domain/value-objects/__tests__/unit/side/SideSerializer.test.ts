/**
 * Тесты для SideSerializer
 */

import { describe, it, expect } from '@jest/globals';
import { SideSerializer, SideErrorReason } from '../../../src/side/index.js';

describe('SideSerializer', () => {
  describe('toJSON()', () => {
    it('should serialize BUY to string', () => {
      expect(SideSerializer.toJSON('BUY')).toBe('BUY');
    });

    it('should serialize SELL to string', () => {
      expect(SideSerializer.toJSON('SELL')).toBe('SELL');
    });

    it('should be identity function for Side', () => {
      const side = 'BUY';
      expect(SideSerializer.toJSON(side)).toBe(side);
    });
  });

  describe('fromJSON()', () => {
    it('should deserialize BUY from string', () => {
      const result = SideSerializer.fromJSON('BUY');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe('BUY');
      }
    });

    it('should deserialize SELL from string', () => {
      const result = SideSerializer.fromJSON('SELL');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe('SELL');
      }
    });

    it('should fail for invalid string', () => {
      const result = SideSerializer.fromJSON('INVALID');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Invalid side value');
        expect(result.error.context?.reason).toBe(SideErrorReason.INVALID_VALUE);
      }
    });

    it('should fail for empty string with INVALID_VALUE reason', () => {
      const result = SideSerializer.fromJSON('');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(SideErrorReason.INVALID_VALUE);
        expect(result.error.context?.value).toBe('');
      }
    });

    // Boundary: dirty runtime inputs через as any → INVALID_TYPE (не INVALID_VALUE)
    it('should fail for number input (123) via as any with INVALID_TYPE', () => {
      const result = SideSerializer.fromJSON(123 as any);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // fromJSON делегирует fromString, который имеет runtime type guard
        expect(result.error.context?.reason).toBe(SideErrorReason.INVALID_TYPE);
        expect(result.error.context?.actualTag).toBe('[object Number]');
      }
    });

    it('should fail for null input via as any with INVALID_TYPE', () => {
      const result = SideSerializer.fromJSON(null as any);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(SideErrorReason.INVALID_TYPE);
        expect(result.error.context?.actualTag).toBe('[object Null]');
      }
    });
  });

  describe('fromUnknown()', () => {
    it('should deserialize BUY from unknown', () => {
      const value: unknown = 'BUY';
      const result = SideSerializer.fromUnknown(value);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe('BUY');
      }
    });

    it('should deserialize SELL from unknown', () => {
      const value: unknown = 'SELL';
      const result = SideSerializer.fromUnknown(value);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe('SELL');
      }
    });

    it('should fail for non-string', () => {
      const value: unknown = 123;
      const result = SideSerializer.fromUnknown(value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(SideErrorReason.INVALID_TYPE);
      }
    });

    it('should fail for null with INVALID_TYPE and actualTag [object Null]', () => {
      const value: unknown = null;
      const result = SideSerializer.fromUnknown(value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(SideErrorReason.INVALID_TYPE);
        expect(result.error.context?.actualTag).toBe('[object Null]');
      }
    });
  });

  describe('round-trip', () => {
    it('should preserve BUY through serialization round-trip', () => {
      const original = 'BUY';
      const json = SideSerializer.toJSON(original);
      const result = SideSerializer.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(original);
      }
    });

    it('should preserve SELL through serialization round-trip', () => {
      const original = 'SELL';
      const json = SideSerializer.toJSON(original);
      const result = SideSerializer.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(original);
      }
    });
  });

  describe('JSON integration', () => {
    it('should work with JSON.stringify and JSON.parse for BUY', () => {
      const original = 'BUY';
      const json = SideSerializer.toJSON(original);
      const stringified = JSON.stringify({ side: json });
      const parsed = JSON.parse(stringified);
      const result = SideSerializer.fromUnknown(parsed.side);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(original);
      }
    });

    it('should work with JSON.stringify and JSON.parse for SELL', () => {
      const original = 'SELL';
      const json = SideSerializer.toJSON(original);
      const stringified = JSON.stringify({ side: json });
      const parsed = JSON.parse(stringified);
      const result = SideSerializer.fromUnknown(parsed.side);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(original);
      }
    });
  });
});
