/**
 * Тесты для PinoLoggerAdapter
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import pino from 'pino';
import { PinoLoggerAdapter } from '../src/PinoLoggerAdapter.js';
import { PaperClock } from '@polymarket/time';
import type { ILogger } from '@polymarket/logger';

describe('PinoLoggerAdapter', () => {
  let clock: PaperClock;
  let logger: PinoLoggerAdapter;

  beforeEach(() => {
    clock = new PaperClock(new Date('2024-01-01T00:00:00Z'));

    // Создаём adapter с минимальной конфигурацией для тестов
    logger = new PinoLoggerAdapter(
      {
        level: 'trace'
      },
      clock
    );
  });

  describe('constructor', () => {
    it('должен создавать экземпляр PinoLoggerAdapter', () => {
      expect(logger).toBeInstanceOf(PinoLoggerAdapter);
    });

    it('должен реализовывать интерфейс ILogger', () => {
      const iLogger: ILogger = logger;
      expect(iLogger.trace).toBeDefined();
      expect(iLogger.debug).toBeDefined();
      expect(iLogger.info).toBeDefined();
      expect(iLogger.warn).toBeDefined();
      expect(iLogger.error).toBeDefined();
      expect(iLogger.fatal).toBeDefined();
      expect(iLogger.child).toBeDefined();
    });
  });

  describe('trace()', () => {
    it('должен вызывать pino.trace с timestamp из IClock', () => {
      logger.trace('Test message', { key: 'value' });

      expect(pinoLogger.trace).toHaveBeenCalledWith(
        {
          key: 'value',
          time: clock.now().getTime(),
        },
        'Test message'
      );
    });

    it('должен работать без контекста', () => {
      logger.trace('Test message');

      expect(pinoLogger.trace).toHaveBeenCalledWith(
        {
          time: clock.now().getTime(),
        },
        'Test message'
      );
    });
  });

  describe('debug()', () => {
    it('должен вызывать pino.debug с timestamp из IClock', () => {
      logger.debug('Debug message', { debugInfo: 'test' });

      expect(pinoLogger.debug).toHaveBeenCalledWith(
        {
          debugInfo: 'test',
          time: clock.now().getTime(),
        },
        'Debug message'
      );
    });
  });

  describe('info()', () => {
    it('должен вызывать pino.info с timestamp из IClock', () => {
      logger.info('Info message', { key: 'value' });

      expect(pinoLogger.info).toHaveBeenCalledWith(
        {
          key: 'value',
          time: clock.now().getTime(),
        },
        'Info message'
      );
    });

    it('должен обновлять timestamp при tick', () => {
      logger.info('First');
      const firstTime = clock.now().getTime();

      clock.tick(5000); // +5 секунд
      logger.info('Second');
      const secondTime = clock.now().getTime();

      expect(secondTime).toBe(firstTime + 5000);
      expect(pinoLogger.info).toHaveBeenCalledTimes(2);
    });
  });

  describe('warn()', () => {
    it('должен вызывать pino.warn с timestamp из IClock', () => {
      logger.warn('Warning message', { severity: 'medium' });

      expect(pinoLogger.warn).toHaveBeenCalledWith(
        {
          severity: 'medium',
          time: clock.now().getTime(),
        },
        'Warning message'
      );
    });
  });

  describe('error()', () => {
    it('должен вызывать pino.error без Error объекта', () => {
      logger.error('Error message', undefined, { key: 'value' });

      expect(pinoLogger.error).toHaveBeenCalledWith(
        {
          key: 'value',
          time: clock.now().getTime(),
        },
        'Error message'
      );
    });

    it('должен корректно обрабатывать Error объект', () => {
      const error = new Error('Test error');
      logger.error('Failed', error, { orderId: '123' });

      expect(pinoLogger.error).toHaveBeenCalledWith(
        {
          orderId: '123',
          err: error, // Pino ожидает err, не error
          time: clock.now().getTime(),
        },
        'Failed'
      );
    });

    it('должен передавать Error с полным stack trace', () => {
      const error = new Error('Test error with stack');
      error.stack = 'Error: Test error\n    at test.ts:10:5';

      logger.error('Operation failed', error);

      const callArgs = (pinoLogger.error as jest.Mock).mock.calls[0][0] as { err: Error; time: number };
      expect(callArgs.err).toBe(error);
      expect(callArgs.err.stack).toContain('at test.ts:10:5');
    });
  });

  describe('fatal()', () => {
    it('должен вызывать pino.fatal без Error объекта', () => {
      logger.fatal('Fatal error', undefined, { retries: 5 });

      expect(pinoLogger.fatal).toHaveBeenCalledWith(
        {
          retries: 5,
          time: clock.now().getTime(),
        },
        'Fatal error'
      );
    });

    it('должен корректно обрабатывать Error объект', () => {
      const error = new Error('Connection refused');
      logger.fatal('Cannot connect', error, { exchange: 'Polymarket' });

      expect(pinoLogger.fatal).toHaveBeenCalledWith(
        {
          exchange: 'Polymarket',
          err: error,
          time: clock.now().getTime(),
        },
        'Cannot connect'
      );
    });
  });

  describe('child()', () => {
    it('должен создавать child logger через pino.child', () => {
      const childLogger = logger.child({ service: 'MarketMaker' });

      expect(pinoLogger.child).toHaveBeenCalledWith({ service: 'MarketMaker' });
      expect(childLogger).toBeInstanceOf(PinoLoggerAdapter);
    });

    it('должен возвращать новый экземпляр PinoLoggerAdapter', () => {
      const childLogger = logger.child({ service: 'MarketMaker' });

      expect(childLogger).not.toBe(logger);
      expect(childLogger).toBeInstanceOf(PinoLoggerAdapter);
    });

    it('дочерний логгер должен использовать тот же IClock', () => {
      // Создаём mock для child logger
      const childPinoLogger = pino({ level: 'trace' });
      jest.spyOn(childPinoLogger, 'info');
      (pinoLogger.child as jest.Mock).mockReturnValue(childPinoLogger);

      const child = logger.child({ service: 'Test2' });
      child.info('Test');

      // Timestamp должен быть из того же clock
      expect(childPinoLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          time: clock.now().getTime(),
        }),
        'Test'
      );
    });
  });

  describe('все 6 уровней логирования', () => {
    it('должен поддерживать все уровни Pino', () => {
      logger.trace('trace');
      logger.debug('debug');
      logger.info('info');
      logger.warn('warn');
      logger.error('error');
      logger.fatal('fatal');

      expect(pinoLogger.trace).toHaveBeenCalledTimes(1);
      expect(pinoLogger.debug).toHaveBeenCalledTimes(1);
      expect(pinoLogger.info).toHaveBeenCalledTimes(1);
      expect(pinoLogger.warn).toHaveBeenCalledTimes(1);
      expect(pinoLogger.error).toHaveBeenCalledTimes(1);
      expect(pinoLogger.fatal).toHaveBeenCalledTimes(1);
    });
  });

  describe('детерминированные timestamps', () => {
    it('должен использовать время из PaperClock', () => {
      const initialTime = clock.now().getTime();

      logger.info('Message 1');
      expect(pinoLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ time: initialTime }),
        'Message 1'
      );

      clock.tick(10000); // +10 секунд
      logger.info('Message 2');
      expect(pinoLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ time: initialTime + 10000 }),
        'Message 2'
      );
    });

    it('timestamps должны быть детерминированными при повторных запусках', () => {
      const clock1 = new PaperClock(new Date('2024-01-01T10:00:00Z'));
      const logger1 = new PinoLoggerAdapter(pinoLogger, clock1);

      logger1.info('Test');
      const firstCall = (pinoLogger.info as jest.Mock).mock.calls[0][0] as { time: number };

      (pinoLogger.info as jest.Mock).mockClear();

      const clock2 = new PaperClock(new Date('2024-01-01T10:00:00Z'));
      const logger2 = new PinoLoggerAdapter(pinoLogger, clock2);

      logger2.info('Test');
      const secondCall = (pinoLogger.info as jest.Mock).mock.calls[0][0] as { time: number };

      // Timestamps должны совпадать
      expect(firstCall.time).toBe(secondCall.time);
    });
  });

  describe('интеграция контекста', () => {
    it('должен мерджить context с timestamp', () => {
      logger.info('Test', {
        orderId: '123',
        price: 0.65,
        quantity: 100,
      });

      expect(pinoLogger.info).toHaveBeenCalledWith(
        {
          orderId: '123',
          price: 0.65,
          quantity: 100,
          time: clock.now().getTime(),
        },
        'Test'
      );
    });

    it('не должен терять данные контекста', () => {
      const context = {
        complex: {
          nested: {
            data: 'value',
          },
        },
        array: [1, 2, 3],
        boolean: true,
        number: 42,
        string: 'test',
      };

      logger.debug('Complex context', context);

      expect(pinoLogger.debug).toHaveBeenCalledWith(
        {
          ...context,
          time: clock.now().getTime(),
        },
        'Complex context'
      );
    });
  });
});
