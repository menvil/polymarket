/**
 * Интеграционные тесты для модуля @polymarket/logger
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { ILogger } from '../../src/ILogger.js';
import { ConsoleLogger } from '../../src/ConsoleLogger.js';
import { NoOpLogger } from '../../src/NoOpLogger.js';
import { LogLevel } from '../../src/LogLevel.js';
import { LiveClock, PaperClock, ReplayClock } from '@polymarket/time';

describe('Logger Integration', () => {
  // Mock console methods to prevent noise in test output
  let consoleSpies: {
    debug: jest.SpiedFunction<typeof console.debug>;
    info: jest.SpiedFunction<typeof console.info>;
    warn: jest.SpiedFunction<typeof console.warn>;
    error: jest.SpiedFunction<typeof console.error>;
    log: jest.SpiedFunction<typeof console.log>;
  };

  beforeEach(() => {
    consoleSpies = {
      debug: jest.spyOn(console, 'debug').mockImplementation(() => {}),
      info: jest.spyOn(console, 'info').mockImplementation(() => {}),
      warn: jest.spyOn(console, 'warn').mockImplementation(() => {}),
      error: jest.spyOn(console, 'error').mockImplementation(() => {}),
      log: jest.spyOn(console, 'log').mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    // Restore console methods
    consoleSpies.debug.mockRestore();
    consoleSpies.info.mockRestore();
    consoleSpies.warn.mockRestore();
    consoleSpies.error.mockRestore();
    consoleSpies.log.mockRestore();
  });

  describe('Полиморфное использование через ILogger', () => {
    it('все реализации должны быть совместимы с ILogger', () => {
      const clock = new PaperClock(new Date());

      const loggers: ILogger[] = [
        new ConsoleLogger(clock, LogLevel.INFO),
        new NoOpLogger(),
      ];

      loggers.forEach((logger) => {
        expect(() => {
          logger.debug('test');
          logger.info('test');
          logger.warn('test');
          logger.error('test');
        }).not.toThrow();
      });
    });

    it('должны работать в функции принимающей ILogger', () => {
      const logMessage = (logger: ILogger, message: string): void => {
        logger.info(message);
      };

      const clock = new PaperClock(new Date());
      const consoleLogger = new ConsoleLogger(clock, LogLevel.INFO);
      const noOpLogger = new NoOpLogger();

      expect(() => logMessage(consoleLogger, 'test')).not.toThrow();
      expect(() => logMessage(noOpLogger, 'test')).not.toThrow();
    });
  });

  describe('Сценарий: Сервис с разными логгерами', () => {
    class OrderService {
      constructor(private readonly logger: ILogger) {}

      placeOrder(orderId: string, price: number): void {
        this.logger.info('Placing order', { orderId, price });
      }

      cancelOrder(orderId: string): void {
        this.logger.warn('Cancelling order', { orderId });
      }

      handleError(orderId: string, error: Error): void {
        this.logger.error('Order failed', error, { orderId });
      }
    }

    it('должен работать с ConsoleLogger', () => {
      const clock = new PaperClock(new Date('2024-01-01'));
      const logger = new ConsoleLogger(clock, LogLevel.INFO);
      const service = new OrderService(logger);

      expect(() => {
        service.placeOrder('order-1', 0.65);
        service.cancelOrder('order-2');
        service.handleError('order-3', new Error('Network error'));
      }).not.toThrow();
    });

    it('должен работать с NoOpLogger', () => {
      const logger = new NoOpLogger();
      const service = new OrderService(logger);

      expect(() => {
        service.placeOrder('order-1', 0.65);
        service.cancelOrder('order-2');
        service.handleError('order-3', new Error('Network error'));
      }).not.toThrow();
    });
  });

  describe('Сценарий: Логирование в разных режимах Clock', () => {
    let consoleSpy: jest.SpiedFunction<typeof console.info>;

    beforeEach(() => {
      consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleSpy.mockRestore();
    });

    it('LIVE режим должен использовать реальное время', () => {
      const logger = new ConsoleLogger(new LiveClock(), LogLevel.INFO);

      const beforeTime = Date.now();
      logger.info('Test message');
      const afterTime = Date.now();

      const loggedData = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      const loggedTime = new Date(loggedData.timestamp).getTime();

      expect(loggedTime).toBeGreaterThanOrEqual(beforeTime);
      expect(loggedTime).toBeLessThanOrEqual(afterTime);
    });

    it('PAPER режим должен использовать управляемое время', () => {
      const clock = new PaperClock(new Date('2024-01-01T00:00:00Z'));
      const logger = new ConsoleLogger(clock, LogLevel.INFO);

      logger.info('First message');
      clock.tick(5000);
      logger.info('Second message');

      const first = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      const second = JSON.parse(consoleSpy.mock.calls[1][0] as string);

      expect(first.timestamp).toBe('2024-01-01T00:00:00.000Z');
      expect(second.timestamp).toBe('2024-01-01T00:00:05.000Z');
    });

    it('REPLAY режим должен использовать время из событий', () => {
      const clock = new ReplayClock(new Date(0));
      const logger = new ConsoleLogger(clock, LogLevel.INFO);

      const events = [
        { timestamp: new Date('2024-01-01T10:00:00Z'), data: 'event1' },
        { timestamp: new Date('2024-01-01T10:00:01Z'), data: 'event2' },
        { timestamp: new Date('2024-01-01T10:00:02Z'), data: 'event3' },
      ];

      events.forEach((event) => {
        clock.update(event.timestamp);
        logger.info('Event processed', { data: event.data });
      });

      const log1 = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      const log2 = JSON.parse(consoleSpy.mock.calls[1][0] as string);
      const log3 = JSON.parse(consoleSpy.mock.calls[2][0] as string);

      expect(log1.timestamp).toBe('2024-01-01T10:00:00.000Z');
      expect(log2.timestamp).toBe('2024-01-01T10:00:01.000Z');
      expect(log3.timestamp).toBe('2024-01-01T10:00:02.000Z');
    });
  });

  describe('Сценарий: Детерминированное логирование в тестах', () => {
    it('должен обеспечивать идентичные timestamps при повторном запуске', () => {
      const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

      // Первый запуск
      const clock1 = new PaperClock(new Date('2024-01-01'));
      const logger1 = new ConsoleLogger(clock1, LogLevel.INFO);

      logger1.info('Test 1');
      clock1.tick(1000);
      logger1.info('Test 2');

      // Второй запуск
      const clock2 = new PaperClock(new Date('2024-01-01'));
      const logger2 = new ConsoleLogger(clock2, LogLevel.INFO);

      logger2.info('Test 1');
      clock2.tick(1000);
      logger2.info('Test 2');

      // Timestamps должны быть идентичны
      const log1_1 = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      const log1_2 = JSON.parse(consoleSpy.mock.calls[1][0] as string);
      const log2_1 = JSON.parse(consoleSpy.mock.calls[2][0] as string);
      const log2_2 = JSON.parse(consoleSpy.mock.calls[3][0] as string);

      expect(log1_1.timestamp).toBe(log2_1.timestamp);
      expect(log1_2.timestamp).toBe(log2_2.timestamp);

      consoleSpy.mockRestore();
    });
  });

  describe('Сценарий: Переключение между логгерами', () => {
    class ConfigurableService {
      constructor(private logger: ILogger) {}

      setLogger(logger: ILogger): void {
        this.logger = logger;
      }

      logMessage(message: string): void {
        this.logger.info(message);
      }
    }

    it('должен позволять переключаться между реализациями', () => {
      const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

      const clock = new PaperClock(new Date());
      const service = new ConfigurableService(new ConsoleLogger(clock, LogLevel.INFO));

      // С ConsoleLogger
      service.logMessage('With console logger');
      expect(consoleSpy).toHaveBeenCalledTimes(1);

      consoleSpy.mockClear();

      // Переключение на NoOpLogger
      service.setLogger(new NoOpLogger());
      service.logMessage('With no-op logger');
      expect(consoleSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('Сценарий: Structured logging workflow', () => {
    it('должен поддерживать complex context objects', () => {
      const consoleSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

      const clock = new PaperClock(new Date('2024-01-01'));
      const logger = new ConsoleLogger(clock, LogLevel.INFO);

      const orderContext = {
        orderId: 'order-123',
        user: {
          id: 'user-456',
          email: 'test@example.com',
        },
        items: [
          { productId: 'prod-1', quantity: 2 },
          { productId: 'prod-2', quantity: 1 },
        ],
        metadata: {
          source: 'mobile-app',
          version: '2.1.0',
        },
      };

      logger.info('Order created', orderContext);

      const loggedData = JSON.parse(consoleSpy.mock.calls[0][0] as string);

      expect(loggedData.orderId).toBe('order-123');
      expect(loggedData.user.email).toBe('test@example.com');
      expect(loggedData.items).toHaveLength(2);
      expect(loggedData.metadata.version).toBe('2.1.0');

      consoleSpy.mockRestore();
    });
  });

  describe('Сценарий: Error tracking', () => {
    it('должен правильно логировать цепочку ошибок', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const clock = new PaperClock(new Date('2024-01-01'));
      const logger = new ConsoleLogger(clock, LogLevel.ERROR);

      try {
        throw new Error('Database connection failed');
      } catch (dbError) {
        try {
          throw new Error('Failed to save order');
        } catch (orderError) {
          logger.error('Critical error in order processing', orderError as Error, {
            orderId: 'order-123',
            cause: (dbError as Error).message,
          });
        }
      }

      const loggedData = JSON.parse(consoleSpy.mock.calls[0][0] as string);

      expect(loggedData.level).toBe('ERROR');
      expect(loggedData.message).toBe('Critical error in order processing');
      expect(loggedData.orderId).toBe('order-123');
      expect(loggedData.cause).toBe('Database connection failed');
      expect(loggedData.error.message).toBe('Failed to save order');
      expect(loggedData.error.stack).toBeDefined();

      consoleSpy.mockRestore();
    });
  });
});
