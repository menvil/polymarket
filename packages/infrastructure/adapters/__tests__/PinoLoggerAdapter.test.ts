/**
 * Тесты для PinoLoggerAdapter
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { Writable } from 'stream';
import { PinoLoggerAdapter } from '../src/PinoLoggerAdapter.js';
import { PaperClock } from '@polymarket/time';

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

    it('должен отфильтровывать поле time из child bindings', () => {
      const childLogger = logger.child({ time: 999, service: 'test' });

      childLogger.info('Child message');

      const log = JSON.parse(output[0]);

      // time должен быть из IClock, не из bindings
      expect(log.time).toBe(clock.now().getTime());
      expect(log.time).not.toBe(999);

      // service должен сохраниться
      expect(log.service).toBe('test');
    });

    it('должен отфильтровывать поле msg из child bindings', () => {
      const childLogger = logger.child({ msg: 'wrong message', component: 'api' });

      childLogger.info('Correct message');

      const log = JSON.parse(output[0]);

      // msg должен быть из параметра message, не из bindings
      expect(log.msg).toBe('Correct message');
      expect(log.msg).not.toBe('wrong message');

      // component должен сохраниться
      expect(log.component).toBe('api');
    });

    it('должен отфильтровывать поле level из child bindings', () => {
      const childLogger = logger.child({ level: 60, module: 'auth' });

      childLogger.debug('Debug message');

      const log = JSON.parse(output[0]);

      // level должен быть DEBUG (20), не FATAL (60) из bindings
      expect(log.level).toBe(20);
      expect(log.level).not.toBe(60);

      // module должен сохраниться
      expect(log.module).toBe('auth');
    });

    it('должен отфильтровывать все системные поля из child bindings', () => {
      const childLogger = logger.child({
        time: 999,
        msg: 'wrong',
        level: 60,
        pid: 12345,
        hostname: 'fake',
        err: new Error('fake'),
        validField: 'should remain'
      });

      childLogger.info('Test message');

      const log = JSON.parse(output[0]);

      // validField должен остаться
      expect(log.validField).toBe('should remain');

      // Системные поля не из bindings
      expect(log.time).toBe(clock.now().getTime());
      expect(log.msg).toBe('Test message');
      expect(log.level).toBe(30); // INFO
      expect(log.pid).not.toBe(12345);
      expect(log.hostname).not.toBe('fake');
      expect(log.err).toBeUndefined(); // Нет параметра error
    });

    it('child logger должен наследовать защиту от коллизий в context', () => {
      const childLogger = logger.child({ service: 'api' });

      // Пытаемся передать системные поля через context
      childLogger.info('Message', { time: 888, requestId: '123' });

      const log = JSON.parse(output[0]);

      // time должен быть из IClock
      expect(log.time).toBe(clock.now().getTime());
      expect(log.time).not.toBe(888);

      // Оба поля должны присутствовать
      expect(log.service).toBe('api'); // Из child bindings
      expect(log.requestId).toBe('123'); // Из context
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

  describe('фильтрация системных полей', () => {
    it('должен отфильтровывать поле time из context', () => {
      logger.info('Test', { time: 999, userId: '123' });

      expect(output.length).toBe(1);
      const log = JSON.parse(output[0]);

      // time должен быть из IClock, не из context
      expect(log.time).toBe(clock.now().getTime());
      expect(log.time).not.toBe(999);

      // userId должен сохраниться
      expect(log.userId).toBe('123');
    });

    it('должен отфильтровывать поле msg из context', () => {
      logger.info('Correct message', { msg: 'Wrong message', data: 'test' });

      const log = JSON.parse(output[0]);

      // msg должен быть из параметра message, не из context
      expect(log.msg).toBe('Correct message');
      expect(log.msg).not.toBe('Wrong message');

      // data должен сохраниться
      expect(log.data).toBe('test');
    });

    it('должен отфильтровывать поле level из context', () => {
      logger.info('Info message', { level: 60, tag: 'test' });

      const log = JSON.parse(output[0]);

      // level должен быть INFO (30), не FATAL (60) из context
      expect(log.level).toBe(30);
      expect(log.level).not.toBe(60);

      // tag должен сохраниться
      expect(log.tag).toBe('test');
    });

    it('должен отфильтровывать системные поля из error context', () => {
      const error = new Error('Test error');
      logger.error('Error occurred', error, {
        time: 999,
        msg: 'wrong',
        level: 10,
        orderId: '456'
      });

      const log = JSON.parse(output[0]);

      // Системные поля должны быть правильные
      expect(log.time).toBe(clock.now().getTime());
      expect(log.msg).toBe('Error occurred');
      expect(log.level).toBe(50); // ERROR

      // orderId должен сохраниться
      expect(log.orderId).toBe('456');

      // err должен быть из параметра error
      expect(log.err).toBeDefined();
      expect(log.err.message).toBe('Test error');
    });

    it('должен отфильтровывать все зарезервированные поля (time, msg, level, pid, hostname, err)', () => {
      logger.info('Test', {
        time: 999,
        msg: 'wrong',
        level: 60,
        pid: 12345,
        hostname: 'fake',
        err: new Error('fake'),
        validField: 'should remain'
      });

      const log = JSON.parse(output[0]);

      // validField должен остаться
      expect(log.validField).toBe('should remain');

      // Системные поля не из context
      expect(log.time).toBe(clock.now().getTime());
      expect(log.msg).toBe('Test');
      expect(log.level).toBe(30); // INFO
      expect(log.pid).not.toBe(12345); // Реальный PID процесса
      expect(log.hostname).not.toBe('fake'); // Реальный hostname
      expect(log.err).toBeUndefined(); // Не должно быть err без параметра error
    });

    it('должен работать без context (покрытие ветки)', () => {
      logger.debug('Debug without context');

      const log = JSON.parse(output[0]);
      expect(log.msg).toBe('Debug without context');
      expect(log.level).toBe(20); // DEBUG
    });

    it('должен работать с пустым context (покрытие ветки)', () => {
      logger.warn('Warn with empty context', {});

      const log = JSON.parse(output[0]);
      expect(log.msg).toBe('Warn with empty context');
      expect(log.level).toBe(40); // WARN
    });
  });
});
