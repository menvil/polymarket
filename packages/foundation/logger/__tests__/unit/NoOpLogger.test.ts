/**
 * Тесты для NoOpLogger
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { NoOpLogger } from '../../src/NoOpLogger.js';
import type { ILogger } from '../../src/ILogger.js';

describe('NoOpLogger', () => {
  let logger: NoOpLogger;

  beforeEach(() => {
    logger = new NoOpLogger();
  });

  describe('constructor', () => {
    it('должен создавать экземпляр NoOpLogger', () => {
      expect(logger).toBeInstanceOf(NoOpLogger);
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
    it('НЕ должен выбрасывать ошибку', () => {
      expect(() => logger.trace('test')).not.toThrow();
    });

    it('НЕ должен выбрасывать ошибку с контекстом', () => {
      expect(() => logger.trace('test', { key: 'value' })).not.toThrow();
    });

    it('должен возвращать void', () => {
      const result = logger.trace('test');
      expect(result).toBeUndefined();
    });
  });

  describe('debug()', () => {
    it('НЕ должен выбрасывать ошибку', () => {
      expect(() => logger.debug('test')).not.toThrow();
    });

    it('НЕ должен выбрасывать ошибку с контекстом', () => {
      expect(() => logger.debug('test', { key: 'value' })).not.toThrow();
    });

    it('должен возвращать void', () => {
      const result = logger.debug('test');
      expect(result).toBeUndefined();
    });
  });

  describe('info()', () => {
    it('НЕ должен выбрасывать ошибку', () => {
      expect(() => logger.info('test')).not.toThrow();
    });

    it('НЕ должен выбрасывать ошибку с контекстом', () => {
      expect(() => logger.info('test', { key: 'value' })).not.toThrow();
    });

    it('должен возвращать void', () => {
      const result = logger.info('test');
      expect(result).toBeUndefined();
    });
  });

  describe('warn()', () => {
    it('НЕ должен выбрасывать ошибку', () => {
      expect(() => logger.warn('test')).not.toThrow();
    });

    it('НЕ должен выбрасывать ошибку с контекстом', () => {
      expect(() => logger.warn('test', { key: 'value' })).not.toThrow();
    });

    it('должен возвращать void', () => {
      const result = logger.warn('test');
      expect(result).toBeUndefined();
    });
  });

  describe('error()', () => {
    it('НЕ должен выбрасывать ошибку', () => {
      expect(() => logger.error('test')).not.toThrow();
    });

    it('НЕ должен выбрасывать ошибку с Error объектом', () => {
      const error = new Error('test error');
      expect(() => logger.error('test', error)).not.toThrow();
    });

    it('НЕ должен выбрасывать ошибку с контекстом', () => {
      expect(() => logger.error('test', undefined, { key: 'value' })).not.toThrow();
    });

    it('должен возвращать void', () => {
      const result = logger.error('test');
      expect(result).toBeUndefined();
    });
  });

  describe('fatal()', () => {
    it('НЕ должен выбрасывать ошибку', () => {
      expect(() => logger.fatal('test')).not.toThrow();
    });

    it('НЕ должен выбрасывать ошибку с Error объектом', () => {
      const error = new Error('test error');
      expect(() => logger.fatal('test', error)).not.toThrow();
    });

    it('НЕ должен выбрасывать ошибку с контекстом', () => {
      expect(() => logger.fatal('test', undefined, { key: 'value' })).not.toThrow();
    });

    it('должен возвращать void', () => {
      const result = logger.fatal('test');
      expect(result).toBeUndefined();
    });
  });

  describe('child()', () => {
    it('должен возвращать новый NoOpLogger', () => {
      const child = logger.child({ service: 'Test' });
      expect(child).toBeInstanceOf(NoOpLogger);
    });

    it('должен возвращать разные экземпляры', () => {
      const child1 = logger.child({ service: 'Test1' });
      const child2 = logger.child({ service: 'Test2' });
      expect(child1).not.toBe(child2);
    });

    it('НЕ должен выбрасывать ошибку', () => {
      expect(() => logger.child({ key: 'value' })).not.toThrow();
    });
  });

  describe('нулевой overhead', () => {
    it('не должен вызывать console методы', () => {
      const consoleSpies = {
        trace: jest.spyOn(console, 'trace'),
        debug: jest.spyOn(console, 'debug'),
        info: jest.spyOn(console, 'info'),
        warn: jest.spyOn(console, 'warn'),
        error: jest.spyOn(console, 'error'),
        log: jest.spyOn(console, 'log'),
      };

      try {
        logger.trace('test');
        logger.debug('test');
        logger.info('test');
        logger.warn('test');
        logger.error('test', new Error('test'));
        logger.fatal('test', new Error('test'));

        expect(consoleSpies.trace).not.toHaveBeenCalled();
        expect(consoleSpies.debug).not.toHaveBeenCalled();
        expect(consoleSpies.info).not.toHaveBeenCalled();
        expect(consoleSpies.warn).not.toHaveBeenCalled();
        expect(consoleSpies.error).not.toHaveBeenCalled();
        expect(consoleSpies.log).not.toHaveBeenCalled();
      } finally {
        Object.values(consoleSpies).forEach((spy) => spy.mockRestore());
      }
    });

    it('должен игнорировать любые аргументы', () => {
      // Сложные объекты не должны обрабатываться
      const complexContext = {
        deep: {
          nested: {
            object: {
              with: {
                many: {
                  levels: 'value',
                },
              },
            },
          },
        },
        array: [1, 2, 3, 4, 5],
        date: new Date(),
        undefined: undefined,
        null: null,
      };

      expect(() => logger.info('test', complexContext)).not.toThrow();
    });
  });

  describe('использование как default logger', () => {
    it('должен работать в Null Object Pattern', () => {
      class Service {
        constructor(private readonly logger: ILogger = new NoOpLogger()) {}

        doSomething(): string {
          this.logger.info('Doing something');
          return 'done';
        }
      }

      const service = new Service(); // Default logger = NoOpLogger
      const result = service.doSomething();

      expect(result).toBe('done');
    });

    it('должен соответствовать интерфейсу ILogger', () => {
      interface Config {
        logger: ILogger;
      }

      const config1: Config = { logger: new NoOpLogger() };
      const config2: Config = { logger: new NoOpLogger() };

      expect(config1.logger).toBeInstanceOf(NoOpLogger);
      expect(config2.logger).toBeInstanceOf(NoOpLogger);
    });
  });

  describe('множественные экземпляры', () => {
    it('каждый экземпляр должен быть независимым', () => {
      const logger1 = new NoOpLogger();
      const logger2 = new NoOpLogger();

      expect(logger1).not.toBe(logger2);
      expect(logger1).toBeInstanceOf(NoOpLogger);
      expect(logger2).toBeInstanceOf(NoOpLogger);
    });

    it('все экземпляры должны вести себя одинаково', () => {
      const logger1 = new NoOpLogger();
      const logger2 = new NoOpLogger();

      expect(() => {
        logger1.info('test');
        logger2.info('test');
      }).not.toThrow();
    });
  });
});
