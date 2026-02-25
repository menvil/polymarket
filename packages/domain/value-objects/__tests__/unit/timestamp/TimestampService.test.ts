/**
 * Тесты для TimestampService
 */

import { describe, it, expect } from '@jest/globals';
import { TimestampService } from '../../../src/timestamp/index.js';
import { unwrap } from '@polymarket/result/unsafe';

describe('TimestampService', () => {
  describe('fromEpochMs()', () => {
    it('should create Timestamp from epoch ms', () => {
      const result = TimestampService.fromEpochMs(1609459200000);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(1609459200000);
      }
    });

    it('should include service name in error context', () => {
      const result = TimestampService.fromEpochMs(NaN);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.op).toBe('fromEpochMs');
        expect(result.error.context?.opChain).toContain('TimestampService.fromEpochMs');
      }
    });
  });

  describe('fromDate()', () => {
    it('should create Timestamp from Date', () => {
      const date = new Date('2024-01-15T10:30:00.000Z');
      const result = TimestampService.fromDate(date);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toISO()).toBe('2024-01-15T10:30:00.000Z');
      }
    });

    it('should include service name in error context', () => {
      const invalidDate = new Date('invalid');
      const result = TimestampService.fromDate(invalidDate);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // fromDate delegates to fromEpochMs
        expect(result.error.context?.op).toBe('fromEpochMs');
      }
    });
  });

  describe('fromISO()', () => {
    it('should create Timestamp from ISO string', () => {
      const result = TimestampService.fromISO('2024-01-15T10:30:00.000Z');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toISO()).toBe('2024-01-15T10:30:00.000Z');
      }
    });

    it('should include service name in error context', () => {
      const result = TimestampService.fromISO('invalid');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.op).toBe('fromISO');
      }
    });
  });

  describe('now()', () => {
    it('should create Timestamp for current time', () => {
      const before = Date.now();
      const ts = TimestampService.now();
      const after = Date.now();

      expect(ts.value().toNumber()).toBeGreaterThanOrEqual(before);
      expect(ts.value().toNumber()).toBeLessThanOrEqual(after);
    });
  });

  describe('addMs()', () => {
    it('should add milliseconds to timestamp', () => {
      const ts = TimestampService.now();
      const result = TimestampService.addMs(ts, 60000);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(ts.value().toNumber() + 60000);
      }
    });

    it('should include service name in error context', () => {
      const ts = TimestampService.now();
      const result = TimestampService.addMs(ts, NaN);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.op).toBe('addMs');
      }
    });
  });

  describe('diffMs()', () => {
    it('should calculate difference in milliseconds', () => {
      const ts1 = unwrap(TimestampService.fromEpochMs(2000));
      const ts2 = unwrap(TimestampService.fromEpochMs(1000));

      const diff = TimestampService.diffMs(ts1, ts2);

      expect(diff.toNumber()).toBe(1000);
    });
  });

  describe('diffSeconds()', () => {
    it('should calculate difference in seconds', () => {
      const ts1 = unwrap(TimestampService.fromEpochMs(3000));
      const ts2 = unwrap(TimestampService.fromEpochMs(1000));

      const diff = TimestampService.diffSeconds(ts1, ts2);

      expect(diff.toNumber()).toBe(2);
    });
  });
});
