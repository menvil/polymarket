/**
 * Тесты для PinoLoggerAdapter
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { Writable } from 'stream';
import { PinoLoggerAdapter } from '../src/PinoLoggerAdapter.js';
import { PaperClock } from '@polymarket/time';
import type { ILogger } from '@polymarket/logger';

describe('PinoLoggerAdapter', () => {
  let clock: PaperClock;
  let logger: PinoLoggerAdapter;
  let output: string[];
  let dest: Writable;

  beforeEach(() => {
    clock = new PaperClock(new Date('2024-01-01T00:00:00Z'));
    output = [];

    // Destination stream для захвата output
    dest = new Writable({
      write(chunk: Buffer, _encoding: string, callback: () => void) {
        output.push(chunk.toString());
        callback();
      }
    });

    // Создаём adapter с тихим выводом (в наш dest)
    logger = new PinoLoggerAdapter(
      { level: 'trace' },
      clock,
      dest
    );
  });

  describe('constructor', () => {
    it('должен создавать экземпляр PinoLoggerAdapter', () => {
      expect(logger).toBeInstanceOf(PinoLoggerAdapter);
    });

    it('должен реализовывать интерфейс ILogger', () => {
      // TypeScript проверяет это на этапе компиляции
      const iLogger: ILogger = logger;
      expect(iLogger).toBe(logger);
    });
  });

  describe('trace()', () => {
    it('должен логировать trace сообщение', () => {
      logger.trace('Test message', { key: 'value' });

      expect(output.length).toBe(1);
      const log = JSON.parse(output[0]);
      expect(log.level).toBe(10); // TRACE
      expect(log.msg).toBe('Test message');
      expect(log.key).toBe('value');
      expect(log.time).toBe(clock.now().getTime());
    });

    it('должен работать без контекста', () => {
      logger.trace('Test message');

      expect(output.length).toBe(1);
      const log = JSON.parse(output[0]);
      expect(log.msg).toBe('Test message');
    });
  });

  describe('debug()', () => {
    it('должен логировать debug сообщение', () => {
      logger.debug('Debug message', { debugInfo: 'test' });

      expect(output.length).toBe(1);
      const log = JSON.parse(output[0]);
      expect(log.level).toBe(20); // DEBUG
      expect(log.msg).toBe('Debug message');
      expect(log.debugInfo).toBe('test');
    });
  });

  describe('info()', () => {
    it('должен логировать info сообщение', () => {
      logger.info('Info message', { userId: '123' });

      expect(output.length).toBe(1);
      const log = JSON.parse(output[0]);
      expect(log.level).toBe(30); // INFO
      expect(log.msg).toBe('Info message');
      expect(log.userId).toBe('123');
    });

    it('должен работать с несколькими вызовами', () => {
      logger.info('First');
      logger.info('Second');

      expect(output.length).toBe(2);
      expect(JSON.parse(output[0]).msg).toBe('First');
      expect(JSON.parse(output[1]).msg).toBe('Second');
    });
  });

  describe('warn()', () => {
    it('должен логировать warn сообщение', () => {
      logger.warn('Warning message', { code: 'DEPRECATED' });

      expect(output.length).toBe(1);
      const log = JSON.parse(output[0]);
      expect(log.level).toBe(40); // WARN
      expect(log.msg).toBe('Warning message');
      expect(log.code).toBe('DEPRECATED');
    });
  });

  describe('error()', () => {
    it('должен логировать error с Error объектом', () => {
      const error = new Error('Test error');
      logger.error('Error occurred', error, { orderId: '456' });

      expect(output.length).toBe(1);
      const log = JSON.parse(output[0]);
      expect(log.level).toBe(50); // ERROR
      expect(log.msg).toBe('Error occurred');
      expect(log.orderId).toBe('456');
      expect(log.err).toBeDefined();
      expect(log.err.message).toBe('Test error');
    });

    it('должен работать без Error объекта', () => {
      logger.error('Error message', undefined, { code: '500' });

      expect(output.length).toBe(1);
      const log = JSON.parse(output[0]);
      expect(log.msg).toBe('Error message');
      expect(log.code).toBe('500');
    });

    it('должен корректно сериализовать Error (stack, type)', () => {
      const error = new Error('Network timeout');
      logger.error('Failed', error);

      const log = JSON.parse(output[0]);
      expect(log.err.type).toBe('Error');
      expect(log.err.stack).toBeDefined();
      expect(log.err.stack).toContain('Network timeout');
    });
  });

  describe('fatal()', () => {
    it('должен логировать fatal с Error объектом', () => {
      const error = new Error('Critical failure');
      logger.fatal('System crash', error, { exitCode: 1 });

      expect(output.length).toBe(1);
      const log = JSON.parse(output[0]);
      expect(log.level).toBe(60); // FATAL
      expect(log.msg).toBe('System crash');
      expect(log.exitCode).toBe(1);
      expect(log.err.message).toBe('Critical failure');
    });

    it('должен работать без Error объекта', () => {
      logger.fatal('Fatal error');

      expect(output.length).toBe(1);
      const log = JSON.parse(output[0]);
      expect(log.msg).toBe('Fatal error');
    });
  });

  describe('child()', () => {
    it('должен создавать child logger с bindings', () => {
      const childLogger = logger.child({ requestId: 'req-123' });

      childLogger.info('Child log');

      expect(output.length).toBe(1);
      const log = JSON.parse(output[0]);
      expect(log.msg).toBe('Child log');
      expect(log.requestId).toBe('req-123');
    });

    it('child logger должен наследовать IClock от родителя', () => {
      const childLogger = logger.child({ service: 'api' });

      childLogger.info('Test');

      const log = JSON.parse(output[0]);
      expect(log.time).toBe(clock.now().getTime());
    });
  });

  describe('IClock integration', () => {
    it('должен использовать timestamp из IClock', () => {
      const fixedTime = clock.now().getTime();

      logger.info('Message 1');
      clock.tick(5000); // +5 секунд
      logger.info('Message 2');

      const log1 = JSON.parse(output[0]);
      const log2 = JSON.parse(output[1]);

      expect(log1.time).toBe(fixedTime);
      expect(log2.time).toBe(fixedTime + 5000);
    });
  });
});
