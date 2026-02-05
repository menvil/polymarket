/**
 * Тесты для LogLevel и утилит
 */

import { describe, it, expect } from '@jest/globals';
import { LogLevel, shouldLog, LOG_LEVEL_WEIGHTS } from '../../src/LogLevel.js';

describe('LogLevel', () => {
  describe('enum values', () => {
    it('должен иметь все уровни', () => {
      expect(LogLevel.DEBUG).toBe('DEBUG');
      expect(LogLevel.INFO).toBe('INFO');
      expect(LogLevel.WARN).toBe('WARN');
      expect(LogLevel.ERROR).toBe('ERROR');
    });

    it('должен быть строковым enum', () => {
      expect(typeof LogLevel.DEBUG).toBe('string');
      expect(typeof LogLevel.INFO).toBe('string');
      expect(typeof LogLevel.WARN).toBe('string');
      expect(typeof LogLevel.ERROR).toBe('string');
    });
  });

  describe('LOG_LEVEL_WEIGHTS', () => {
    it('должен иметь веса для всех уровней', () => {
      expect(LOG_LEVEL_WEIGHTS[LogLevel.DEBUG]).toBe(0);
      expect(LOG_LEVEL_WEIGHTS[LogLevel.INFO]).toBe(1);
      expect(LOG_LEVEL_WEIGHTS[LogLevel.WARN]).toBe(2);
      expect(LOG_LEVEL_WEIGHTS[LogLevel.ERROR]).toBe(3);
    });

    it('веса должны возрастать', () => {
      expect(LOG_LEVEL_WEIGHTS[LogLevel.DEBUG]).toBeLessThan(
        LOG_LEVEL_WEIGHTS[LogLevel.INFO]
      );
      expect(LOG_LEVEL_WEIGHTS[LogLevel.INFO]).toBeLessThan(
        LOG_LEVEL_WEIGHTS[LogLevel.WARN]
      );
      expect(LOG_LEVEL_WEIGHTS[LogLevel.WARN]).toBeLessThan(
        LOG_LEVEL_WEIGHTS[LogLevel.ERROR]
      );
    });
  });

  describe('shouldLog()', () => {
    describe('DEBUG уровень логгера', () => {
      const configuredLevel = LogLevel.DEBUG;

      it('должен логировать DEBUG', () => {
        expect(shouldLog(LogLevel.DEBUG, configuredLevel)).toBe(true);
      });

      it('должен логировать INFO', () => {
        expect(shouldLog(LogLevel.INFO, configuredLevel)).toBe(true);
      });

      it('должен логировать WARN', () => {
        expect(shouldLog(LogLevel.WARN, configuredLevel)).toBe(true);
      });

      it('должен логировать ERROR', () => {
        expect(shouldLog(LogLevel.ERROR, configuredLevel)).toBe(true);
      });
    });

    describe('INFO уровень логгера', () => {
      const configuredLevel = LogLevel.INFO;

      it('НЕ должен логировать DEBUG', () => {
        expect(shouldLog(LogLevel.DEBUG, configuredLevel)).toBe(false);
      });

      it('должен логировать INFO', () => {
        expect(shouldLog(LogLevel.INFO, configuredLevel)).toBe(true);
      });

      it('должен логировать WARN', () => {
        expect(shouldLog(LogLevel.WARN, configuredLevel)).toBe(true);
      });

      it('должен логировать ERROR', () => {
        expect(shouldLog(LogLevel.ERROR, configuredLevel)).toBe(true);
      });
    });

    describe('WARN уровень логгера', () => {
      const configuredLevel = LogLevel.WARN;

      it('НЕ должен логировать DEBUG', () => {
        expect(shouldLog(LogLevel.DEBUG, configuredLevel)).toBe(false);
      });

      it('НЕ должен логировать INFO', () => {
        expect(shouldLog(LogLevel.INFO, configuredLevel)).toBe(false);
      });

      it('должен логировать WARN', () => {
        expect(shouldLog(LogLevel.WARN, configuredLevel)).toBe(true);
      });

      it('должен логировать ERROR', () => {
        expect(shouldLog(LogLevel.ERROR, configuredLevel)).toBe(true);
      });
    });

    describe('ERROR уровень логгера', () => {
      const configuredLevel = LogLevel.ERROR;

      it('НЕ должен логировать DEBUG', () => {
        expect(shouldLog(LogLevel.DEBUG, configuredLevel)).toBe(false);
      });

      it('НЕ должен логировать INFO', () => {
        expect(shouldLog(LogLevel.INFO, configuredLevel)).toBe(false);
      });

      it('НЕ должен логировать WARN', () => {
        expect(shouldLog(LogLevel.WARN, configuredLevel)).toBe(false);
      });

      it('должен логировать ERROR', () => {
        expect(shouldLog(LogLevel.ERROR, configuredLevel)).toBe(true);
      });
    });

    describe('граничные случаи', () => {
      it('сообщение того же уровня что и логгер должно логироваться', () => {
        expect(shouldLog(LogLevel.DEBUG, LogLevel.DEBUG)).toBe(true);
        expect(shouldLog(LogLevel.INFO, LogLevel.INFO)).toBe(true);
        expect(shouldLog(LogLevel.WARN, LogLevel.WARN)).toBe(true);
        expect(shouldLog(LogLevel.ERROR, LogLevel.ERROR)).toBe(true);
      });

      it('более важное сообщение всегда логируется', () => {
        expect(shouldLog(LogLevel.ERROR, LogLevel.DEBUG)).toBe(true);
        expect(shouldLog(LogLevel.WARN, LogLevel.DEBUG)).toBe(true);
        expect(shouldLog(LogLevel.INFO, LogLevel.DEBUG)).toBe(true);
      });

      it('менее важное сообщение не логируется', () => {
        expect(shouldLog(LogLevel.DEBUG, LogLevel.ERROR)).toBe(false);
        expect(shouldLog(LogLevel.INFO, LogLevel.ERROR)).toBe(false);
        expect(shouldLog(LogLevel.WARN, LogLevel.ERROR)).toBe(false);
      });
    });
  });
});
