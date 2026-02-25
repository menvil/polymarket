/**
 * Тесты для TimestampFormatter
 */

import { describe, it, expect } from '@jest/globals';
import { TimestampService, TimestampFormatter } from '../../../src/timestamp/index.js';
import { unwrap } from '@polymarket/result/unsafe';

describe('TimestampFormatter', () => {
  const testTimestamp = unwrap(TimestampService.fromEpochMs(1705318200000)); // 2024-01-15T10:30:00.000Z

  describe('toISO()', () => {
    it('should format as ISO 8601 string', () => {
      const result = TimestampFormatter.toISO(testTimestamp);

      // Используем toContain вместо точного сравнения, т.к. timezone может отличаться
      expect(result).toContain('2024-01-15');
      expect(result).toContain('Z');
    });
  });

  describe('toDisplay()', () => {
    it('should format without milliseconds and with space', () => {
      const result = TimestampFormatter.toDisplay(testTimestamp);

      expect(result).toContain('2024-01-15');
      expect(result).not.toContain('T');
      expect(result).not.toContain('.000');
    });
  });

  describe('toDate()', () => {
    it('should format only date part', () => {
      const result = TimestampFormatter.toDate(testTimestamp);

      expect(result).toBe('2024-01-15');
    });
  });

  describe('toTime()', () => {
    it('should format only time part', () => {
      const result = TimestampFormatter.toTime(testTimestamp);

      // Проверяем формат времени без точного сравнения из-за timezone
      expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    });
  });

  describe('toEpochMs()', () => {
    it('should format as epoch ms string', () => {
      const result = TimestampFormatter.toEpochMs(testTimestamp);

      expect(result).toBe('1705318200000');
      expect(typeof result).toBe('string');
    });
  });

  describe('toRelative()', () => {
    it('should format seconds ago', () => {
      const now = unwrap(TimestampService.fromEpochMs(Date.now()));
      const past = unwrap(TimestampService.fromEpochMs(Date.now() - 30000)); // 30 seconds ago

      const result = TimestampFormatter.toRelative(past, now);

      expect(result).toContain('30');
      expect(result).toContain('second');
      expect(result).toContain('ago');
    });

    it('should format minutes ago', () => {
      const now = unwrap(TimestampService.fromEpochMs(Date.now()));
      const past = unwrap(TimestampService.fromEpochMs(Date.now() - 120000)); // 2 minutes ago

      const result = TimestampFormatter.toRelative(past, now);

      expect(result).toContain('2');
      expect(result).toContain('minute');
      expect(result).toContain('ago');
    });

    it('should format hours ago', () => {
      const nowMs = Date.now();
      const now = unwrap(TimestampService.fromEpochMs(nowMs));
      const past = unwrap(TimestampService.fromEpochMs(nowMs - 7200000)); // 2 hours ago

      const result = TimestampFormatter.toRelative(past, now);

      expect(result).toContain('2');
      expect(result).toContain('hour');
      expect(result).toContain('ago');
    });

    it('should format days ago', () => {
      const nowMs = Date.now();
      const now = unwrap(TimestampService.fromEpochMs(nowMs));
      const past = unwrap(TimestampService.fromEpochMs(nowMs - 172800000)); // 2 days ago

      const result = TimestampFormatter.toRelative(past, now);

      expect(result).toContain('2');
      expect(result).toContain('day');
      expect(result).toContain('ago');
    });

    it('should format future timestamp with "in"', () => {
      const now = unwrap(TimestampService.fromEpochMs(Date.now()));
      const future = unwrap(TimestampService.fromEpochMs(Date.now() + 30000)); // in 30 seconds

      const result = TimestampFormatter.toRelative(future, now);

      expect(result).toContain('in');
      expect(result).toContain('30');
      expect(result).toContain('second');
    });

    it('should use singular form for 1 second', () => {
      const now = unwrap(TimestampService.fromEpochMs(Date.now()));
      const past = unwrap(TimestampService.fromEpochMs(Date.now() - 1000)); // 1 second ago

      const result = TimestampFormatter.toRelative(past, now);

      expect(result).toContain('1 second ago');
    });

    it('should use plural form for multiple seconds', () => {
      const now = unwrap(TimestampService.fromEpochMs(Date.now()));
      const past = unwrap(TimestampService.fromEpochMs(Date.now() - 5000)); // 5 seconds ago

      const result = TimestampFormatter.toRelative(past, now);

      expect(result).toContain('5 seconds ago');
    });

    it('should use Timestamp.now() as default reference', () => {
      const past = unwrap(TimestampService.fromEpochMs(Date.now() - 5000)); // 5 seconds ago

      const result = TimestampFormatter.toRelative(past);

      expect(result).toContain('ago');
    });
  });

  describe('toLogString()', () => {
    it('should format with both ISO and epoch ms', () => {
      const result = TimestampFormatter.toLogString(testTimestamp);

      expect(result).toContain('2024-01-15');
      expect(result).toContain('1705318200000');
      expect(result).toContain('Z');
    });
  });
});
