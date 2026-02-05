/**
 * Тесты для ConsoleLogger
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { ConsoleLogger } from '../../src/ConsoleLogger.js';
import { LogLevel } from '../../src/LogLevel.js';
import type { ILogger } from '../../src/ILogger.js';
import { PaperClock } from '@polymarket/time';

describe('ConsoleLogger', () => {
  let clock: PaperClock;
  let logger: ConsoleLogger;
  let consoleSpy: {
    debug: jest.SpiedFunction<typeof console.debug>;
    info: jest.SpiedFunction<typeof console.info>;
    warn: jest.SpiedFunction<typeof console.warn>;
    error: jest.SpiedFunction<typeof console.error>;
  };

  beforeEach(() => {
    clock = new PaperClock(new Date('2024-01-01T00:00:00.000Z'));

    // Mock console methods
    consoleSpy = {
      debug: jest.spyOn(console, 'debug').mockImplementation(() => {}),
      info: jest.spyOn(console, 'info').mockImplementation(() => {}),
      warn: jest.spyOn(console, 'warn').mockImplementation(() => {}),
      error: jest.spyOn(console, 'error').mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    // Restore console methods
    consoleSpy.debug.mockRestore();
    consoleSpy.info.mockRestore();
    consoleSpy.warn.mockRestore();
    consoleSpy.error.mockRestore();
  });

  describe('constructor', () => {
    it('должен создавать экземпляр ConsoleLogger', () => {
      logger = new ConsoleLogger(clock);
      expect(logger).toBeInstanceOf(ConsoleLogger);
    });

    it('должен использовать INFO уровень по умолчанию', () => {
      logger = new ConsoleLogger(clock);

      logger.debug('debug message');
      expect(consoleSpy.debug).not.toHaveBeenCalled();

      logger.info('info message');
      expect(consoleSpy.info).toHaveBeenCalled();
    });

    it('должен принимать кастомный уровень', () => {
      logger = new ConsoleLogger(clock, LogLevel.DEBUG);

      logger.debug('debug message');
      expect(consoleSpy.debug).toHaveBeenCalled();
    });

    it('должен реализовывать интерфейс ILogger', () => {
      const iLogger: ILogger = new ConsoleLogger(clock);
      expect(iLogger.debug).toBeDefined();
      expect(iLogger.info).toBeDefined();
      expect(iLogger.warn).toBeDefined();
      expect(iLogger.error).toBeDefined();
    });
  });

  describe('debug()', () => {
    beforeEach(() => {
      logger = new ConsoleLogger(clock, LogLevel.DEBUG);
    });

    it('должен логировать debug сообщение', () => {
      logger.debug('debug message');

      expect(consoleSpy.debug).toHaveBeenCalledTimes(1);
      const loggedData = JSON.parse(consoleSpy.debug.mock.calls[0][0] as string);

      expect(loggedData).toEqual({
        timestamp: '2024-01-01T00:00:00.000Z',
        level: 'DEBUG',
        message: 'debug message',
      });
    });

    it('должен включать контекст', () => {
      logger.debug('debug message', { userId: '123', step: 'validation' });

      const loggedData = JSON.parse(consoleSpy.debug.mock.calls[0][0] as string);

      expect(loggedData).toEqual({
        timestamp: '2024-01-01T00:00:00.000Z',
        level: 'DEBUG',
        message: 'debug message',
        userId: '123',
        step: 'validation',
      });
    });

    it('НЕ должен логировать если уровень выше DEBUG', () => {
      const infoLogger = new ConsoleLogger(clock, LogLevel.INFO);
      infoLogger.debug('debug message');

      expect(consoleSpy.debug).not.toHaveBeenCalled();
    });

    it('должен использовать детерминированный timestamp', () => {
      logger.debug('first');
      clock.tick(5000);
      logger.debug('second');

      const first = JSON.parse(consoleSpy.debug.mock.calls[0][0] as string);
      const second = JSON.parse(consoleSpy.debug.mock.calls[1][0] as string);

      expect(first.timestamp).toBe('2024-01-01T00:00:00.000Z');
      expect(second.timestamp).toBe('2024-01-01T00:00:05.000Z');
    });
  });

  describe('info()', () => {
    beforeEach(() => {
      logger = new ConsoleLogger(clock, LogLevel.INFO);
    });

    it('должен логировать info сообщение', () => {
      logger.info('info message');

      expect(consoleSpy.info).toHaveBeenCalledTimes(1);
      const loggedData = JSON.parse(consoleSpy.info.mock.calls[0][0] as string);

      expect(loggedData).toEqual({
        timestamp: '2024-01-01T00:00:00.000Z',
        level: 'INFO',
        message: 'info message',
      });
    });

    it('должен включать контекст', () => {
      logger.info('Order placed', { orderId: 'order-123', price: 0.65 });

      const loggedData = JSON.parse(consoleSpy.info.mock.calls[0][0] as string);

      expect(loggedData).toEqual({
        timestamp: '2024-01-01T00:00:00.000Z',
        level: 'INFO',
        message: 'Order placed',
        orderId: 'order-123',
        price: 0.65,
      });
    });

    it('НЕ должен логировать если уровень выше INFO', () => {
      const warnLogger = new ConsoleLogger(clock, LogLevel.WARN);
      warnLogger.info('info message');

      expect(consoleSpy.info).not.toHaveBeenCalled();
    });
  });

  describe('warn()', () => {
    beforeEach(() => {
      logger = new ConsoleLogger(clock, LogLevel.WARN);
    });

    it('должен логировать warn сообщение', () => {
      logger.warn('warning message');

      expect(consoleSpy.warn).toHaveBeenCalledTimes(1);
      const loggedData = JSON.parse(consoleSpy.warn.mock.calls[0][0] as string);

      expect(loggedData).toEqual({
        timestamp: '2024-01-01T00:00:00.000Z',
        level: 'WARN',
        message: 'warning message',
      });
    });

    it('должен включать контекст', () => {
      logger.warn('High latency', { latency: 2500, threshold: 1000 });

      const loggedData = JSON.parse(consoleSpy.warn.mock.calls[0][0] as string);

      expect(loggedData).toEqual({
        timestamp: '2024-01-01T00:00:00.000Z',
        level: 'WARN',
        message: 'High latency',
        latency: 2500,
        threshold: 1000,
      });
    });

    it('НЕ должен логировать если уровень выше WARN', () => {
      const errorLogger = new ConsoleLogger(clock, LogLevel.ERROR);
      errorLogger.warn('warning message');

      expect(consoleSpy.warn).not.toHaveBeenCalled();
    });
  });

  describe('error()', () => {
    beforeEach(() => {
      logger = new ConsoleLogger(clock, LogLevel.ERROR);
    });

    it('должен логировать error сообщение', () => {
      logger.error('error message');

      expect(consoleSpy.error).toHaveBeenCalledTimes(1);
      const loggedData = JSON.parse(consoleSpy.error.mock.calls[0][0] as string);

      expect(loggedData).toEqual({
        timestamp: '2024-01-01T00:00:00.000Z',
        level: 'ERROR',
        message: 'error message',
      });
    });

    it('должен включать Error объект', () => {
      const error = new Error('Something went wrong');
      logger.error('Operation failed', error);

      const loggedData = JSON.parse(consoleSpy.error.mock.calls[0][0] as string);

      expect(loggedData.timestamp).toBe('2024-01-01T00:00:00.000Z');
      expect(loggedData.level).toBe('ERROR');
      expect(loggedData.message).toBe('Operation failed');
      expect(loggedData.error).toEqual({
        message: 'Something went wrong',
        name: 'Error',
        stack: error.stack,
      });
    });

    it('должен включать контекст вместе с Error', () => {
      const error = new Error('Database error');
      logger.error('Failed to save order', error, { orderId: 'order-123' });

      const loggedData = JSON.parse(consoleSpy.error.mock.calls[0][0] as string);

      expect(loggedData.orderId).toBe('order-123');
      expect(loggedData.error.message).toBe('Database error');
    });

    it('должен работать без Error объекта', () => {
      logger.error('Simple error', undefined, { code: 500 });

      const loggedData = JSON.parse(consoleSpy.error.mock.calls[0][0] as string);

      expect(loggedData.error).toBeUndefined();
      expect(loggedData.code).toBe(500);
    });
  });

  describe('фильтрация по уровню', () => {
    it('DEBUG уровень должен логировать всё', () => {
      logger = new ConsoleLogger(clock, LogLevel.DEBUG);

      logger.debug('debug');
      logger.info('info');
      logger.warn('warn');
      logger.error('error');

      expect(consoleSpy.debug).toHaveBeenCalledTimes(1);
      expect(consoleSpy.info).toHaveBeenCalledTimes(1);
      expect(consoleSpy.warn).toHaveBeenCalledTimes(1);
      expect(consoleSpy.error).toHaveBeenCalledTimes(1);
    });

    it('INFO уровень НЕ должен логировать DEBUG', () => {
      logger = new ConsoleLogger(clock, LogLevel.INFO);

      logger.debug('debug');
      logger.info('info');
      logger.warn('warn');
      logger.error('error');

      expect(consoleSpy.debug).not.toHaveBeenCalled();
      expect(consoleSpy.info).toHaveBeenCalledTimes(1);
      expect(consoleSpy.warn).toHaveBeenCalledTimes(1);
      expect(consoleSpy.error).toHaveBeenCalledTimes(1);
    });

    it('WARN уровень должен логировать только WARN и ERROR', () => {
      logger = new ConsoleLogger(clock, LogLevel.WARN);

      logger.debug('debug');
      logger.info('info');
      logger.warn('warn');
      logger.error('error');

      expect(consoleSpy.debug).not.toHaveBeenCalled();
      expect(consoleSpy.info).not.toHaveBeenCalled();
      expect(consoleSpy.warn).toHaveBeenCalledTimes(1);
      expect(consoleSpy.error).toHaveBeenCalledTimes(1);
    });

    it('ERROR уровень должен логировать только ERROR', () => {
      logger = new ConsoleLogger(clock, LogLevel.ERROR);

      logger.debug('debug');
      logger.info('info');
      logger.warn('warn');
      logger.error('error');

      expect(consoleSpy.debug).not.toHaveBeenCalled();
      expect(consoleSpy.info).not.toHaveBeenCalled();
      expect(consoleSpy.warn).not.toHaveBeenCalled();
      expect(consoleSpy.error).toHaveBeenCalledTimes(1);
    });
  });

  describe('детерминированность с PaperClock', () => {
    it('должен использовать время из PaperClock', () => {
      logger = new ConsoleLogger(clock, LogLevel.INFO);

      logger.info('first message');

      clock.tick(1000);
      logger.info('second message');

      clock.tick(2000);
      logger.info('third message');

      const first = JSON.parse(consoleSpy.info.mock.calls[0][0] as string);
      const second = JSON.parse(consoleSpy.info.mock.calls[1][0] as string);
      const third = JSON.parse(consoleSpy.info.mock.calls[2][0] as string);

      expect(first.timestamp).toBe('2024-01-01T00:00:00.000Z');
      expect(second.timestamp).toBe('2024-01-01T00:00:01.000Z');
      expect(third.timestamp).toBe('2024-01-01T00:00:03.000Z');
    });

    it('должен быть детерминированным при повторном запуске', () => {
      const clock1 = new PaperClock(new Date('2024-01-01'));
      const logger1 = new ConsoleLogger(clock1, LogLevel.INFO);

      const clock2 = new PaperClock(new Date('2024-01-01'));
      const logger2 = new ConsoleLogger(clock2, LogLevel.INFO);

      logger1.info('test message');
      logger2.info('test message');

      const log1 = JSON.parse(consoleSpy.info.mock.calls[0][0] as string);
      const log2 = JSON.parse(consoleSpy.info.mock.calls[1][0] as string);

      expect(log1.timestamp).toBe(log2.timestamp);
    });
  });

  describe('structured logging', () => {
    beforeEach(() => {
      logger = new ConsoleLogger(clock, LogLevel.INFO);
    });

    it('должен форматировать в JSON', () => {
      logger.info('test message', { key: 'value' });

      const output = consoleSpy.info.mock.calls[0][0] as string;
      expect(() => JSON.parse(output)).not.toThrow();
    });

    it('должен включать все поля', () => {
      logger.info('test', { nested: { obj: 'value' }, array: [1, 2, 3] });

      const loggedData = JSON.parse(consoleSpy.info.mock.calls[0][0] as string);

      expect(loggedData).toHaveProperty('timestamp');
      expect(loggedData).toHaveProperty('level');
      expect(loggedData).toHaveProperty('message');
      expect(loggedData).toHaveProperty('nested');
      expect(loggedData).toHaveProperty('array');
    });

    it('должен обрабатывать пустой контекст', () => {
      logger.info('test message');

      const loggedData = JSON.parse(consoleSpy.info.mock.calls[0][0] as string);

      expect(loggedData).toEqual({
        timestamp: '2024-01-01T00:00:00.000Z',
        level: 'INFO',
        message: 'test message',
      });
    });
  });
});
