/**
 * Тесты для Timestamp
 */

import { describe, it, expect } from '@jest/globals';
import { Timestamp, TimestampService, TimestampFormatter } from '../../../src/timestamp/index.js';
import { unwrap } from '@polymarket/result/unsafe';
import Decimal from 'decimal.js';
import { TimestampInvariantViolation } from '../../../src/timestamp/core/TimestampInvariantViolation.js';

describe('Timestamp', () => {
  describe('of() - Core invariants', () => {
    it('should create Timestamp from valid Decimal', () => {
      const ts = Timestamp.of(new Decimal(1609459200000));
      expect(ts.value().toNumber()).toBe(1609459200000);
    });

    it('should throw TimestampInvariantViolation for NaN', () => {
      expect(() => Timestamp.of(new Decimal(NaN))).toThrow(TimestampInvariantViolation);
      expect(() => Timestamp.of(new Decimal(NaN))).toThrow('Timestamp cannot be NaN');
    });

    it('should throw TimestampInvariantViolation for Infinity', () => {
      expect(() => Timestamp.of(new Decimal(Infinity))).toThrow(TimestampInvariantViolation);
      expect(() => Timestamp.of(new Decimal(Infinity))).toThrow('Timestamp must be finite');
    });

    it('should throw TimestampInvariantViolation for non-integer', () => {
      expect(() => Timestamp.of(new Decimal(1234.567))).toThrow(TimestampInvariantViolation);
      expect(() => Timestamp.of(new Decimal(1234.567))).toThrow('Timestamp must be integer');
    });

    it('should throw TimestampInvariantViolation for negative value', () => {
      expect(() => Timestamp.of(new Decimal(-1000))).toThrow(TimestampInvariantViolation);
      expect(() => Timestamp.of(new Decimal(-1000))).toThrow('must be non-negative');
    });

    it('should throw TimestampInvariantViolation for too large value', () => {
      const tooLarge = new Decimal('10000000000000');
      expect(() => Timestamp.of(tooLarge)).toThrow(TimestampInvariantViolation);
      expect(() => Timestamp.of(tooLarge)).toThrow('too large');
    });

    it('should accept zero (Unix epoch)', () => {
      const ts = Timestamp.of(new Decimal(0));
      expect(ts.value().toNumber()).toBe(0);
    });

    it('should accept maximum valid value', () => {
      const max = new Decimal('9999999999999');
      const ts = Timestamp.of(max);
      expect(ts.value().toString()).toBe('9999999999999');
    });
  });

  describe('addMs() - Core invariants', () => {
    it('should throw TimestampInvariantViolation for fractional delta', () => {
      const ts = Timestamp.of(new Decimal(1000));
      expect(() => ts.addMs(new Decimal(123.456))).toThrow(TimestampInvariantViolation);
      expect(() => ts.addMs(new Decimal(123.456))).toThrow('Delta must be integer');
    });

    it('should accept integer delta', () => {
      const ts = Timestamp.of(new Decimal(1000));
      const result = ts.addMs(new Decimal(500));
      expect(result.value().toNumber()).toBe(1500);
    });

    it('should accept negative integer delta', () => {
      const ts = Timestamp.of(new Decimal(2000));
      const result = ts.addMs(new Decimal(-500));
      expect(result.value().toNumber()).toBe(1500);
    });
  });

  describe('now()', () => {
    it('should create Timestamp for current time', () => {
      const before = Date.now();
      const ts = Timestamp.now();
      const after = Date.now();

      expect(ts.value().toNumber()).toBeGreaterThanOrEqual(before);
      expect(ts.value().toNumber()).toBeLessThanOrEqual(after);
    });

    it('should create different timestamps on sequential calls', () => {
      const ts1 = Timestamp.now();
      const ts2 = Timestamp.now();

      // Timestamps могут быть равны если вызваны очень быстро
      expect(ts2.value().toNumber()).toBeGreaterThanOrEqual(ts1.value().toNumber());
    });

    it('should accept IClock parameter', () => {
      const mockClock = {
        now: () => new Date('2024-01-01T00:00:00.000Z')
      };
      const ts = Timestamp.now(mockClock);
      expect(ts.toISO()).toBe('2024-01-01T00:00:00.000Z');
    });
  });

  describe('create()', () => {
    it('should create Timestamp from valid epoch ms', () => {
      const result = TimestampService.create(1609459200000);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(1609459200000);
      }
    });

    it('should truncate fractional milliseconds to integer', () => {
      const result = TimestampService.create(1609459200000.999);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(1609459200000);
      }
    });

    it('should fail for NaN', () => {
      const result = TimestampService.create(NaN);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('finite');
        expect(result.error.context?.reason).toBe('INVALID_FORMAT');
        expect(result.error.context?.op).toBe('create');
      }
    });

    it('should fail for Infinity', () => {
      const result = TimestampService.create(Infinity);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('finite');
        expect(result.error.context?.reason).toBe('INVALID_FORMAT');
        expect(result.error.context?.op).toBe('create');
      }
    });

    it('should fail for negative Infinity', () => {
      const result = TimestampService.create(-Infinity);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('finite');
      }
    });

    it('should accept zero (Unix epoch)', () => {
      const result = TimestampService.create(0);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(0);
        expect(result.value.toISO()).toBe('1970-01-01T00:00:00.000Z');
      }
    });

    it('should fail for negative value', () => {
      const result = TimestampService.create(-1);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('negative');
        expect(result.error.context?.reason).toBe('NEGATIVE');
        expect(result.error.context?.op).toBe('create');
      }
    });

    it('should fail for large negative value', () => {
      const result = TimestampService.create(-1000);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('negative');
        expect(result.error.context?.reason).toBe('NEGATIVE');
        expect(result.error.context?.op).toBe('create');
      }
    });

    it('should accept large epoch ms (year 2050)', () => {
      const year2050 = new Date('2050-01-01').getTime();
      const result = TimestampService.create(year2050);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toISO()).toContain('2050-01-01');
      }
    });

    it('should accept maximum valid timestamp (9999999999999 ~year 2286)', () => {
      const maxTimestamp = 9999999999999;
      const result = TimestampService.create(maxTimestamp);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(maxTimestamp);
        // 9999999999999 ms = Saturday, 20 November 2286 17:46:39.999 GMT
        expect(result.value.toISO()).toContain('2286');
      }
    });

    it('should fail for timestamp exceeding maximum (too large)', () => {
      const tooLarge = 10000000000000; // Больше чем 9999999999999
      const result = TimestampService.create(tooLarge);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('too large');
        expect(result.error.context?.reason).toBe('OUT_OF_RANGE');
        expect(result.error.context?.op).toBe('create');
      }
    });

    it('should fail for extremely large timestamp', () => {
      const veryLarge = 99999999999999; // 10x максимума
      const result = TimestampService.create(veryLarge);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('too large');
      }
    });
  });

  describe('fromDate()', () => {
    it('should create Timestamp from valid Date', () => {
      const date = new Date('2024-01-15T10:30:00.000Z');
      const result = TimestampService.fromDate(date);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toISO()).toBe('2024-01-15T10:30:00.000Z');
      }
    });

    it('should fail for invalid Date', () => {
      const invalidDate = new Date('invalid');
      const result = TimestampService.fromDate(invalidDate);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Invalid Date.getTime() returns NaN, handled by toDecimal
        expect(result.error.message).toContain('finite');
      }
    });

    it('should work with Date.now()', () => {
      const now = new Date();
      const result = TimestampService.fromDate(now);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(now.getTime());
        expect(result.value.toISO()).toBe(now.toISOString());
      }
    });
  });

  describe('fromISO()', () => {
    it('should create Timestamp from valid ISO string', () => {
      const result = TimestampService.fromISO('2024-01-15T10:30:00.000Z');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toISO()).toBe('2024-01-15T10:30:00.000Z');
      }
    });

    it('should handle ISO string without milliseconds', () => {
      const result = TimestampService.fromISO('2024-01-15T10:30:00Z');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toISO()).toContain('2024-01-15T10:30:00');
      }
    });

    it('should handle ISO string with timezone offset', () => {
      const result = TimestampService.fromISO('2024-01-15T10:30:00+03:00');

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Должен конвертировать в UTC
        expect(result.value.toISO()).toContain('2024-01-15T07:30:00');
      }
    });

    it('should fail for invalid ISO string', () => {
      const result = TimestampService.fromISO('invalid');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Invalid ISO timestamp');
      }
    });

    it('should fail for empty string', () => {
      const result = TimestampService.fromISO('');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('ISO');
      }
    });
  });

  describe('value getter', () => {
    it('should return epoch milliseconds', () => {
      const ts = unwrap(TimestampService.create(1609459200000));

      expect(ts.value().toNumber()).toBe(1609459200000);
    });
  });

  describe('toDate()', () => {
    it('should convert to JavaScript Date', () => {
      const ts = unwrap(TimestampService.create(1609459200000));
      const date = ts.toDate();

      expect(date).toBeInstanceOf(Date);
      expect(date.getTime()).toBe(1609459200000);
    });
  });

  describe('toISO()', () => {
    it('should convert to ISO 8601 string', () => {
      const ts = unwrap(TimestampService.create(1609459200000));

      expect(ts.toISO()).toBe('2021-01-01T00:00:00.000Z');
    });
  });

  describe('equals()', () => {
    it('should return true for same epoch ms', () => {
      const ts1 = unwrap(TimestampService.create(1000));
      const ts2 = unwrap(TimestampService.create(1000));

      expect(ts1.equals(ts2)).toBe(true);
    });

    it('should return false for different epoch ms', () => {
      const ts1 = unwrap(TimestampService.create(1000));
      const ts2 = unwrap(TimestampService.create(2000));

      expect(ts1.equals(ts2)).toBe(false);
    });

    it('should be reflexive', () => {
      const ts = Timestamp.now();

      expect(ts.equals(ts)).toBe(true);
    });

    it('should be symmetric', () => {
      const ts1 = unwrap(TimestampService.create(1000));
      const ts2 = unwrap(TimestampService.create(1000));

      expect(ts1.equals(ts2)).toBe(ts2.equals(ts1));
    });
  });

  describe('isBefore()', () => {
    it('should return true when earlier', () => {
      const earlier = unwrap(TimestampService.create(1000));
      const later = unwrap(TimestampService.create(2000));

      expect(earlier.isBefore(later)).toBe(true);
    });

    it('should return false when later', () => {
      const earlier = unwrap(TimestampService.create(1000));
      const later = unwrap(TimestampService.create(2000));

      expect(later.isBefore(earlier)).toBe(false);
    });

    it('should return false when equal', () => {
      const ts1 = unwrap(TimestampService.create(1000));
      const ts2 = unwrap(TimestampService.create(1000));

      expect(ts1.isBefore(ts2)).toBe(false);
    });
  });

  describe('isAfter()', () => {
    it('should return true when later', () => {
      const earlier = unwrap(TimestampService.create(1000));
      const later = unwrap(TimestampService.create(2000));

      expect(later.isAfter(earlier)).toBe(true);
    });

    it('should return false when earlier', () => {
      const earlier = unwrap(TimestampService.create(1000));
      const later = unwrap(TimestampService.create(2000));

      expect(earlier.isAfter(later)).toBe(false);
    });

    it('should return false when equal', () => {
      const ts1 = unwrap(TimestampService.create(1000));
      const ts2 = unwrap(TimestampService.create(1000));

      expect(ts1.isAfter(ts2)).toBe(false);
    });
  });

  describe('isBeforeOrEqual()', () => {
    it('should return true when earlier', () => {
      const earlier = unwrap(TimestampService.create(1000));
      const later = unwrap(TimestampService.create(2000));

      expect(earlier.isBeforeOrEqual(later)).toBe(true);
    });

    it('should return true when equal', () => {
      const ts1 = unwrap(TimestampService.create(1000));
      const ts2 = unwrap(TimestampService.create(1000));

      expect(ts1.isBeforeOrEqual(ts2)).toBe(true);
    });

    it('should return false when later', () => {
      const earlier = unwrap(TimestampService.create(1000));
      const later = unwrap(TimestampService.create(2000));

      expect(later.isBeforeOrEqual(earlier)).toBe(false);
    });
  });

  describe('isAfterOrEqual()', () => {
    it('should return true when later', () => {
      const earlier = unwrap(TimestampService.create(1000));
      const later = unwrap(TimestampService.create(2000));

      expect(later.isAfterOrEqual(earlier)).toBe(true);
    });

    it('should return true when equal', () => {
      const ts1 = unwrap(TimestampService.create(1000));
      const ts2 = unwrap(TimestampService.create(1000));

      expect(ts1.isAfterOrEqual(ts2)).toBe(true);
    });

    it('should return false when earlier', () => {
      const earlier = unwrap(TimestampService.create(1000));
      const later = unwrap(TimestampService.create(2000));

      expect(earlier.isAfterOrEqual(later)).toBe(false);
    });
  });

  describe('addMs()', () => {
    it('should add positive milliseconds', () => {
      const ts = unwrap(TimestampService.create(1000));
      const result = TimestampService.addMs(ts, 500);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(1500);
      }
    });

    it('should subtract (add negative) milliseconds', () => {
      const ts = unwrap(TimestampService.create(2000));
      const result = TimestampService.addMs(ts, -500);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(1500);
      }
    });

    it('should add 1 minute (60000 ms)', () => {
      const ts = unwrap(TimestampService.create(1000));
      const result = TimestampService.addMs(ts, 60000);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(61000);
      }
    });

    it('should fail if delta is NaN', () => {
      const ts = unwrap(TimestampService.create(1000));
      const result = TimestampService.addMs(ts, NaN);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('finite');
      }
    });

    it('should fail if delta is Infinity', () => {
      const ts = unwrap(TimestampService.create(1000));
      const result = TimestampService.addMs(ts, Infinity);

      expect(result.ok).toBe(false);
    });

    it('should fail if result would be negative', () => {
      const ts = unwrap(TimestampService.create(1000));
      const result = TimestampService.addMs(ts, -1001);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('negative');
      }
    });
  });

  describe('diffMs()', () => {
    it('should return positive diff when this is later', () => {
      const ts1 = unwrap(TimestampService.create(2000));
      const ts2 = unwrap(TimestampService.create(1000));

      expect(ts1.diffMs(ts2).toNumber()).toBe(1000);
    });

    it('should return negative diff when this is earlier', () => {
      const ts1 = unwrap(TimestampService.create(1000));
      const ts2 = unwrap(TimestampService.create(2000));

      expect(ts1.diffMs(ts2).toNumber()).toBe(-1000);
    });

    it('should return zero for equal timestamps', () => {
      const ts1 = unwrap(TimestampService.create(1000));
      const ts2 = unwrap(TimestampService.create(1000));

      expect(ts1.diffMs(ts2).toNumber()).toBe(0);
    });
  });

  describe('diffSeconds()', () => {
    it('should return diff in seconds', () => {
      const ts1 = unwrap(TimestampService.create(3000));
      const ts2 = unwrap(TimestampService.create(1000));

      expect(ts1.diffSeconds(ts2).toNumber()).toBe(2);
    });

    it('should return fractional seconds', () => {
      const ts1 = unwrap(TimestampService.create(1500));
      const ts2 = unwrap(TimestampService.create(1000));

      expect(ts1.diffSeconds(ts2).toNumber()).toBe(0.5);
    });

    it('should return negative for earlier timestamp', () => {
      const ts1 = unwrap(TimestampService.create(1000));
      const ts2 = unwrap(TimestampService.create(3000));

      expect(ts1.diffSeconds(ts2).toNumber()).toBe(-2);
    });
  });

  describe('toString()', () => {
    it('should return debug string with epoch ms and ISO', () => {
      const ts = unwrap(TimestampService.create(1609459200000));
      const str = TimestampFormatter.toString(ts);

      expect(str).toContain('1609459200000');
      expect(str).toContain('2021-01-01T00:00:00.000Z');
      expect(str).toContain('Timestamp');
    });
  });

  describe('round-trip conversions', () => {
    it('should preserve value through Date round-trip', () => {
      const original = unwrap(TimestampService.create(1609459200000));
      const date = original.toDate();
      const result = TimestampService.fromDate(date);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.equals(original)).toBe(true);
      }
    });

    it('should preserve value through ISO round-trip', () => {
      const original = unwrap(TimestampService.create(1609459200000));
      const iso = original.toISO();
      const result = TimestampService.fromISO(iso);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.equals(original)).toBe(true);
      }
    });
  });
});
