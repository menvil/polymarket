/**
 * Тесты для TimestampFormatter
 */

import { describe, it, expect } from '@jest/globals';
import { TimestampService, TimestampFormatter } from '../src/index.js';
import { unwrap } from '@polymarket/result/unsafe';

describe('TimestampFormatter', () => {
  const testTimestamp = unwrap(TimestampService.create(1705315800000)); // 2024-01-15T10:50:00.000Z

  describe('toISO()', () => {
    it('should format as ISO 8601 string', () => {
      const result = TimestampFormatter.toISO(testTimestamp);

      // toISO() всегда возвращает UTC (с 'Z')
      expect(result).toBe('2024-01-15T10:50:00.000Z');
    });
  });

  describe('toDisplay()', () => {
    it('should format without milliseconds and with UTC timezone', () => {
      const result = TimestampFormatter.toDisplay(testTimestamp);

      expect(result).toContain('2024-01-15');
      expect(result).not.toContain('.000');
      expect(result).toContain(' UTC');
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/);
      // Проверяем, что нет ISO-формата с T между датой и временем
      expect(result).not.toMatch(/T\d{2}:/);
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

      // toTime() извлекает из ISO (UTC), поэтому всегда одинаковый результат
      expect(result).toBe('10:50:00');
    });
  });

  describe('toEpochMs()', () => {
    it('should format as epoch ms string', () => {
      const result = TimestampFormatter.toEpochMs(testTimestamp);

      expect(result).toBe('1705315800000');
      expect(typeof result).toBe('string');
    });
  });

  describe('toRelative()', () => {
    it('should format seconds ago', () => {
      const nowMs = Date.now();
      const now = unwrap(TimestampService.create(nowMs));
      const past = unwrap(TimestampService.create(nowMs - 30000)); // 30 seconds ago

      const result = TimestampFormatter.toRelative(past, now);

      expect(result).toContain('30');
      expect(result).toContain('second');
      expect(result).toContain('ago');
    });

    it('should format minutes ago', () => {
      const nowMs = Date.now();
      const now = unwrap(TimestampService.create(nowMs));
      const past = unwrap(TimestampService.create(nowMs - 120000)); // 2 minutes ago

      const result = TimestampFormatter.toRelative(past, now);

      expect(result).toContain('2');
      expect(result).toContain('minute');
      expect(result).toContain('ago');
    });

    it('should format hours ago', () => {
      const nowMs = Date.now();
      const now = unwrap(TimestampService.create(nowMs));
      const past = unwrap(TimestampService.create(nowMs - 7200000)); // 2 hours ago

      const result = TimestampFormatter.toRelative(past, now);

      expect(result).toContain('2');
      expect(result).toContain('hour');
      expect(result).toContain('ago');
    });

    it('should format days ago', () => {
      const nowMs = Date.now();
      const now = unwrap(TimestampService.create(nowMs));
      const past = unwrap(TimestampService.create(nowMs - 172800000)); // 2 days ago

      const result = TimestampFormatter.toRelative(past, now);

      expect(result).toContain('2');
      expect(result).toContain('day');
      expect(result).toContain('ago');
    });

    it('should format future timestamp with "in"', () => {
      const nowMs = Date.now();
      const now = unwrap(TimestampService.create(nowMs));
      const future = unwrap(TimestampService.create(nowMs + 30000)); // in 30 seconds

      const result = TimestampFormatter.toRelative(future, now);

      expect(result).toContain('in');
      expect(result).toContain('30');
      expect(result).toContain('second');
    });

    it('should use singular form for 1 second', () => {
      const nowMs = Date.now();
      const now = unwrap(TimestampService.create(nowMs));
      const past = unwrap(TimestampService.create(nowMs - 1000)); // 1 second ago

      const result = TimestampFormatter.toRelative(past, now);

      expect(result).toContain('1 second ago');
    });

    it('should use plural form for multiple seconds', () => {
      const nowMs = Date.now();
      const now = unwrap(TimestampService.create(nowMs));
      const past = unwrap(TimestampService.create(nowMs - 5000)); // 5 seconds ago

      const result = TimestampFormatter.toRelative(past, now);

      expect(result).toContain('5 seconds ago');
    });

    it('should use singular form for 1 minute', () => {
      const nowMs = Date.now();
      const now = unwrap(TimestampService.create(nowMs));
      const past = unwrap(TimestampService.create(nowMs - 60000)); // 1 minute ago

      const result = TimestampFormatter.toRelative(past, now);

      expect(result).toBe('1 minute ago');
    });

    it('should use singular form for 1 hour', () => {
      const nowMs = Date.now();
      const now = unwrap(TimestampService.create(nowMs));
      const past = unwrap(TimestampService.create(nowMs - 3600000)); // 1 hour ago

      const result = TimestampFormatter.toRelative(past, now);

      expect(result).toBe('1 hour ago');
    });

    it('should use singular form for 1 day', () => {
      const nowMs = Date.now();
      const now = unwrap(TimestampService.create(nowMs));
      const past = unwrap(TimestampService.create(nowMs - 86400000)); // 1 day ago

      const result = TimestampFormatter.toRelative(past, now);

      expect(result).toBe('1 day ago');
    });

    it('should handle boundary: exactly 60 seconds', () => {
      const nowMs = Date.now();
      const now = unwrap(TimestampService.create(nowMs));
      const past = unwrap(TimestampService.create(nowMs - 60000)); // exactly 60s

      const result = TimestampFormatter.toRelative(past, now);

      // 60 seconds = 1 minute
      expect(result).toBe('1 minute ago');
    });

    it('should handle boundary: exactly 3600 seconds', () => {
      const nowMs = Date.now();
      const now = unwrap(TimestampService.create(nowMs));
      const past = unwrap(TimestampService.create(nowMs - 3600000)); // exactly 3600s

      const result = TimestampFormatter.toRelative(past, now);

      // 3600 seconds = 1 hour
      expect(result).toBe('1 hour ago');
    });

    it('should handle boundary: exactly 86400 seconds', () => {
      const nowMs = Date.now();
      const now = unwrap(TimestampService.create(nowMs));
      const past = unwrap(TimestampService.create(nowMs - 86400000)); // exactly 86400s

      const result = TimestampFormatter.toRelative(past, now);

      // 86400 seconds = 1 day
      expect(result).toBe('1 day ago');
    });

    it('should use Timestamp.now() as default reference', () => {
      const past = unwrap(TimestampService.create(Date.now() - 5000)); // 5 seconds ago

      const result = TimestampFormatter.toRelative(past);

      expect(result).toContain('ago');
    });
  });

  describe('toLogString()', () => {
    it('should format with both ISO and epoch ms', () => {
      const result = TimestampFormatter.toLogString(testTimestamp);

      // Точный формат: "ISO (epochMs)"
      expect(result).toBe('2024-01-15T10:50:00.000Z (1705315800000)');
    });
  });
});
