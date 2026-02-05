/**
 * Тесты для ColorConsoleLogger
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { ColorConsoleLogger } from '../../src/ColorConsoleLogger.js';
import { LogLevel } from '../../src/LogLevel.js';
import type { ILogger } from '../../src/ILogger.js';
import { PaperClock } from '@polymarket/time';

describe('ColorConsoleLogger', () => {
  let clock: PaperClock;
  let logger: ColorConsoleLogger;

  beforeEach(() => {
    clock = new PaperClock(new Date('2024-01-01T00:00:00Z'));
    logger = new ColorConsoleLogger(clock, LogLevel.TRACE);
  });

  describe('constructor', () => {
    it('должен создавать экземпляр ColorConsoleLogger', () => {
      expect(logger).toBeInstanceOf(ColorConsoleLogger);
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

    it('должен использовать LogLevel.INFO по умолчанию', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const defaultLogger = new ColorConsoleLogger(clock);
      defaultLogger.debug('Debug message'); // НЕ логируется
      defaultLogger.info('Info message'); // ✅ Логируется

      expect(consoleSpy).toHaveBeenCalledTimes(1);

      consoleSpy.mockRestore();
    });
  });

  describe('trace()', () => {
    it('должен логировать трассировочное сообщение', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      logger.trace('Trace message');

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('[TRACE]');
      expect(output).toContain('Trace message');
      expect(output).toContain('2024-01-01T00:00:00.000Z');

      consoleSpy.mockRestore();
    });

    it('должен логировать с контекстом', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      logger.trace('Function entry', { function: 'handleOrder', args: { id: '123' } });

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('Function entry');
      expect(output).toContain('handleOrder');

      consoleSpy.mockRestore();
    });

    it('НЕ должен логировать если уровень выше TRACE', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const infoLogger = new ColorConsoleLogger(clock, LogLevel.INFO);
      infoLogger.trace('Trace message');

      expect(consoleSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('debug()', () => {
    it('должен логировать отладочное сообщение', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      logger.debug('Debug message');

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('[DEBUG]');
      expect(output).toContain('Debug message');

      consoleSpy.mockRestore();
    });
  });

  describe('info()', () => {
    it('должен логировать информационное сообщение', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      logger.info('Info message', { key: 'value' });

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('[INFO]');
      expect(output).toContain('Info message');
      expect(output).toContain('value');

      consoleSpy.mockRestore();
    });
  });

  describe('warn()', () => {
    it('должен логировать предупреждение', () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      logger.warn('Warning message', { severity: 'medium' });

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('[WARN]');
      expect(output).toContain('Warning message');
      expect(output).toContain('medium');

      consoleSpy.mockRestore();
    });
  });

  describe('error()', () => {
    it('должен логировать ошибку без Error объекта', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      logger.error('Error message', undefined, { key: 'value' });

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('[ERROR]');
      expect(output).toContain('Error message');

      consoleSpy.mockRestore();
    });

    it('должен логировать ошибку с Error объектом', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const error = new Error('Test error');
      logger.error('Operation failed', error, { orderId: 'order-123' });

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('[ERROR]');
      expect(output).toContain('Operation failed');
      expect(output).toContain('Test error');
      expect(output).toContain('order-123');

      consoleSpy.mockRestore();
    });

    it('должен включать stack trace из Error', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const error = new Error('Test error');
      logger.error('Failed', error);

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('error:');
      expect(output).toContain('stack:');

      consoleSpy.mockRestore();
    });
  });

  describe('fatal()', () => {
    it('должен логировать критическую ошибку', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      logger.fatal('Fatal error', undefined, { retries: 5 });

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('[FATAL]');
      expect(output).toContain('Fatal error');
      expect(output).toContain('5');

      consoleSpy.mockRestore();
    });

    it('должен логировать fatal с Error объектом', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const error = new Error('Connection refused');
      logger.fatal('Cannot connect', error, { exchange: 'Polymarket' });

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('[FATAL]');
      expect(output).toContain('Cannot connect');
      expect(output).toContain('Connection refused');
      expect(output).toContain('Polymarket');

      consoleSpy.mockRestore();
    });
  });

  describe('child()', () => {
    it('должен создавать дочерний логгер', () => {
      const childLogger = logger.child({ service: 'MarketMaker' });

      expect(childLogger).toBeInstanceOf(ColorConsoleLogger);
      expect(childLogger).not.toBe(logger);
    });

    it('должен добавлять bindings ко всем логам дочернего логгера', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const childLogger = logger.child({ service: 'MarketMaker', marketId: '0xabc' });
      childLogger.info('Quote sent', { price: 0.55 });

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('service=MarketMaker');
      expect(output).toContain('marketId=0xabc');
      expect(output).toContain('Quote sent');
      expect(output).toContain('0.55');

      consoleSpy.mockRestore();
    });

    it('должен объединять bindings при вложенных child', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const child1 = logger.child({ service: 'MarketMaker' });
      const child2 = child1.child({ orderId: 'order-123' });

      child2.info('Processing order');

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('service=MarketMaker');
      expect(output).toContain('orderId=order-123');

      consoleSpy.mockRestore();
    });

    it('должен наследовать уровень логирования родителя', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const infoLogger = new ColorConsoleLogger(clock, LogLevel.INFO);
      const childLogger = infoLogger.child({ service: 'Test' });

      childLogger.debug('Debug message'); // НЕ логируется
      childLogger.info('Info message'); // ✅ Логируется

      expect(consoleSpy).toHaveBeenCalledTimes(1);

      consoleSpy.mockRestore();
    });
  });

  describe('фильтрация по уровню', () => {
    it('TRACE уровень должен логировать всё', () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const traceLogger = new ColorConsoleLogger(clock, LogLevel.TRACE);

      traceLogger.trace('trace');
      traceLogger.debug('debug');
      traceLogger.info('info');
      traceLogger.warn('warn');
      traceLogger.error('error');
      traceLogger.fatal('fatal');

      expect(logSpy).toHaveBeenCalledTimes(3); // trace, debug, info
      expect(warnSpy).toHaveBeenCalledTimes(1); // warn
      expect(errorSpy).toHaveBeenCalledTimes(2); // error, fatal

      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('INFO уровень должен пропускать TRACE и DEBUG', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const infoLogger = new ColorConsoleLogger(clock, LogLevel.INFO);

      infoLogger.trace('trace'); // Пропускается
      infoLogger.debug('debug'); // Пропускается
      infoLogger.info('info'); // Логируется

      expect(consoleSpy).toHaveBeenCalledTimes(1);

      consoleSpy.mockRestore();
    });

    it('FATAL уровень должен логировать только FATAL', () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const fatalLogger = new ColorConsoleLogger(clock, LogLevel.FATAL);

      fatalLogger.trace('trace');
      fatalLogger.debug('debug');
      fatalLogger.info('info');
      fatalLogger.warn('warn');
      fatalLogger.error('error');
      fatalLogger.fatal('fatal'); // Только это логируется

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).not.toHaveBeenCalled();

      errorSpy.mockRestore();
      logSpy.mockRestore();
    });
  });

  describe('детерминированные timestamps', () => {
    it('должен использовать время из PaperClock', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      logger.info('Message 1');

      let output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('2024-01-01T00:00:00.000Z');

      clock.tick(5000); // +5 секунд
      logger.info('Message 2');

      output = consoleSpy.mock.calls[1][0] as string;
      expect(output).toContain('2024-01-01T00:00:05.000Z');

      consoleSpy.mockRestore();
    });

    it('timestamps должны быть детерминированными при повторных запусках', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const clock1 = new PaperClock(new Date('2024-01-01T10:00:00Z'));
      const logger1 = new ColorConsoleLogger(clock1, LogLevel.INFO);

      logger1.info('Test');

      const output1 = consoleSpy.mock.calls[0][0] as string;

      consoleSpy.mockClear();

      const clock2 = new PaperClock(new Date('2024-01-01T10:00:00Z'));
      const logger2 = new ColorConsoleLogger(clock2, LogLevel.INFO);

      logger2.info('Test');

      const output2 = consoleSpy.mock.calls[0][0] as string;

      // Timestamps должны совпадать
      expect(output1).toContain('2024-01-01T10:00:00.000Z');
      expect(output2).toContain('2024-01-01T10:00:00.000Z');

      consoleSpy.mockRestore();
    });
  });

  describe('цветной вывод', () => {
    it('должен включать ANSI коды по умолчанию', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      logger.info('Colored message');

      const output = consoleSpy.mock.calls[0][0] as string;
      // Должны быть ANSI коды для цветов
      expect(output).toContain('\x1b['); // ANSI escape code

      consoleSpy.mockRestore();
    });

    it('должен позволять отключить цвета', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const noColorLogger = new ColorConsoleLogger(
        clock,
        LogLevel.INFO,
        {}, // bindings
        false // useColors = false
      );

      noColorLogger.info('No color message');

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).not.toContain('\x1b['); // Нет ANSI кодов

      consoleSpy.mockRestore();
    });
  });

  describe('опции форматирования', () => {
    it('должен позволять скрыть timestamp', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const noTimestampLogger = new ColorConsoleLogger(
        clock,
        LogLevel.INFO,
        {},
        true,
        false // showTimestamp = false
      );

      noTimestampLogger.info('No timestamp');

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).not.toContain('2024-01-01');

      consoleSpy.mockRestore();
    });

    it('должен позволять скрыть metadata', () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      const noMetadataLogger = new ColorConsoleLogger(
        clock,
        LogLevel.INFO,
        {},
        true,
        true,
        false // showMetadata = false
      );

      noMetadataLogger.info('No metadata', { key: 'value' });

      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).not.toContain('value');

      consoleSpy.mockRestore();
    });
  });
});
