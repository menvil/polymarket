/**
 * Тесты для TimestampSerializer
 */

import { describe, it, expect } from '@jest/globals';
import { Timestamp, TimestampService, TimestampSerializer } from '../../../src/timestamp/index.js';
import { unwrap } from '@polymarket/result/unsafe';

describe('TimestampSerializer', () => {
  describe('toJSON()', () => {
    it('should serialize Timestamp to epoch ms number', () => {
      const ts = unwrap(TimestampService.fromEpochMs(1609459200000));
      const json = TimestampSerializer.toJSON(ts);

      expect(json).toBe(1609459200000);
      expect(typeof json).toBe('number');
    });

    it('should serialize now() timestamp', () => {
      const ts = Timestamp.now();
      const json = TimestampSerializer.toJSON(ts);

      expect(typeof json).toBe('number');
      expect(json).toBeGreaterThan(0);
    });
  });

  describe('fromJSON()', () => {
    it('should deserialize epoch ms to Timestamp', () => {
      const result = TimestampSerializer.fromJSON(1609459200000);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(1609459200000);
      }
    });

    it('should fail for NaN', () => {
      const result = TimestampSerializer.fromJSON(NaN);

      expect(result.ok).toBe(false);
    });

    it('should fail for Infinity', () => {
      const result = TimestampSerializer.fromJSON(Infinity);

      expect(result.ok).toBe(false);
    });

    it('should fail for negative value', () => {
      const result = TimestampSerializer.fromJSON(-1000);

      expect(result.ok).toBe(false);
    });
  });

  describe('fromUnknown()', () => {
    it('should deserialize number to Timestamp', () => {
      const value: unknown = 1609459200000;
      const result = TimestampSerializer.fromUnknown(value);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(1609459200000);
      }
    });

    it('should fail for string', () => {
      const value: unknown = '1609459200000';
      const result = TimestampSerializer.fromUnknown(value);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('must be number');
      }
    });

    it('should fail for object', () => {
      const value: unknown = { timestamp: 1609459200000 };
      const result = TimestampSerializer.fromUnknown(value);

      expect(result.ok).toBe(false);
    });

    it('should fail for null', () => {
      const value: unknown = null;
      const result = TimestampSerializer.fromUnknown(value);

      expect(result.ok).toBe(false);
    });

    it('should fail for undefined', () => {
      const value: unknown = undefined;
      const result = TimestampSerializer.fromUnknown(value);

      expect(result.ok).toBe(false);
    });
  });

  describe('round-trip', () => {
    it('should preserve value through serialization round-trip', () => {
      const original = unwrap(TimestampService.fromEpochMs(1609459200000));
      const json = TimestampSerializer.toJSON(original);
      const result = TimestampSerializer.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.equals(original)).toBe(true);
      }
    });

    it('should work with JSON.stringify and JSON.parse', () => {
      const original = Timestamp.now();
      const json = TimestampSerializer.toJSON(original);
      const stringified = JSON.stringify({ timestamp: json });
      const parsed = JSON.parse(stringified);
      const result = TimestampSerializer.fromUnknown(parsed.timestamp);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.equals(original)).toBe(true);
      }
    });
  });
});
