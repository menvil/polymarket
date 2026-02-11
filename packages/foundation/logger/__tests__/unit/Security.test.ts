/**
 * Тесты безопасности для логгеров
 *
 * @remarks
 * Проверяет критичные сценарии безопасности:
 * - Fail-safe поведение при non-serializable данных
 * - Защита системных полей от переопределения
 * - Immutability глобальных структур
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from '@jest/globals';
import { ConsoleLogger } from '../../src/ConsoleLogger.js';
import { ColorConsoleLogger } from '../../src/ColorConsoleLogger.js';
import { LogLevel, LOG_LEVEL_WEIGHTS } from '../../src/LogLevel.js';
import { PaperClock } from '@polymarket/time';

describe('Logger Security Tests', () => {
  let clock: PaperClock;
  let consoleLogger: ConsoleLogger;
  let colorLogger: ColorConsoleLogger;
  let consoleSpy: {
    debug: jest.SpiedFunction<typeof console.debug>;
    info: jest.SpiedFunction<typeof console.info>;
    warn: jest.SpiedFunction<typeof console.warn>;
    error: jest.SpiedFunction<typeof console.error>;
    log: jest.SpiedFunction<typeof console.log>;
  };

  beforeEach(() => {
    clock = new PaperClock(new Date('2024-01-01T00:00:00.000Z'));
    consoleLogger = new ConsoleLogger(clock, LogLevel.TRACE);
    colorLogger = new ColorConsoleLogger(clock, LogLevel.TRACE);

    // Mock console methods
    consoleSpy = {
      debug: jest.spyOn(console, 'debug').mockImplementation(() => {}),
      info: jest.spyOn(console, 'info').mockImplementation(() => {}),
      warn: jest.spyOn(console, 'warn').mockImplementation(() => {}),
      error: jest.spyOn(console, 'error').mockImplementation(() => {}),
      log: jest.spyOn(console, 'log').mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    // Restore console methods
    consoleSpy.debug.mockRestore();
    consoleSpy.info.mockRestore();
    consoleSpy.warn.mockRestore();
    consoleSpy.error.mockRestore();
    consoleSpy.log.mockRestore();
  });

  describe('Fail-safe: Non-serializable data', () => {
    describe('ConsoleLogger', () => {
      it('should handle circular references without throwing', () => {
        const circular: any = { name: 'test' };
        circular.self = circular;

        expect(() => {
          consoleLogger.info('Test', { data: circular });
        }).not.toThrow();

        expect(consoleSpy.info).toHaveBeenCalledTimes(1);
        const loggedJson = consoleSpy.info.mock.calls[0][0] as string;
        expect(loggedJson).toContain('__error');
        expect(loggedJson).toContain('Circular reference detected');
      });

      it('should handle BigInt without throwing', () => {
        expect(() => {
          consoleLogger.info('Test', { value: BigInt(123) });
        }).not.toThrow();

        expect(consoleSpy.info).toHaveBeenCalledTimes(1);
        const loggedJson = consoleSpy.info.mock.calls[0][0] as string;
        const parsed = JSON.parse(loggedJson);
        expect(parsed.value).toBe('BigInt(123)');
      });

      it('should handle Symbol without throwing', () => {
        expect(() => {
          consoleLogger.info('Test', { key: Symbol('test') });
        }).not.toThrow();

        expect(consoleSpy.info).toHaveBeenCalledTimes(1);
        const loggedJson = consoleSpy.info.mock.calls[0][0] as string;
        const parsed = JSON.parse(loggedJson);
        expect(parsed.key).toContain('Symbol(test)');
      });

      it('should handle Function without throwing', () => {
        const testFunc = function namedFunc() {};

        expect(() => {
          consoleLogger.info('Test', { callback: testFunc });
        }).not.toThrow();

        expect(consoleSpy.info).toHaveBeenCalledTimes(1);
        const loggedJson = consoleSpy.info.mock.calls[0][0] as string;
        const parsed = JSON.parse(loggedJson);
        expect(parsed.callback).toBe('[Function: namedFunc]');
      });

      it('should handle anonymous Function', () => {
        expect(() => {
          consoleLogger.info('Test', { callback: () => {} });
        }).not.toThrow();

        expect(consoleSpy.info).toHaveBeenCalledTimes(1);
        const loggedJson = consoleSpy.info.mock.calls[0][0] as string;
        const parsed = JSON.parse(loggedJson);
        // Arrow functions may have the variable name or "anonymous"
        expect(parsed.callback).toMatch(/\[Function: (callback|anonymous)\]/);
      });

      it('should handle complex circular structure', () => {
        const obj1: any = { name: 'obj1' };
        const obj2: any = { name: 'obj2', ref: obj1 };
        obj1.ref = obj2; // Circular

        expect(() => {
          consoleLogger.info('Test', { data: obj1 });
        }).not.toThrow();

        // Should have logged (may include warnings from sanitization)
        expect(consoleSpy.info.mock.calls.length).toBeGreaterThanOrEqual(1);
      });
    });

    describe('ColorConsoleLogger', () => {
      it('should handle circular references without throwing', () => {
        const circular: any = { name: 'test' };
        circular.self = circular;

        expect(() => {
          colorLogger.info('Test', { data: circular });
        }).not.toThrow();

        expect(consoleSpy.log).toHaveBeenCalledTimes(1);
      });

      it('should handle BigInt without throwing', () => {
        expect(() => {
          colorLogger.info('Test', { value: BigInt(456) });
        }).not.toThrow();

        expect(consoleSpy.log).toHaveBeenCalledTimes(1);
        const logged = consoleSpy.log.mock.calls[0][0] as string;
        expect(logged).toContain('BigInt(456)');
      });

      it('should handle mixed problematic types', () => {
        const circular: any = {};
        circular.self = circular;

        expect(() => {
          colorLogger.info('Test', {
            bigint: BigInt(999),
            symbol: Symbol('sym'),
            func: () => {},
            circular,
          });
        }).not.toThrow();

        expect(consoleSpy.log).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('Reserved fields protection', () => {
    describe('ConsoleLogger', () => {
      it('should not allow overriding timestamp via context', () => {
        consoleLogger.info('Test', { timestamp: '1970-01-01T00:00:00.000Z' });

        expect(consoleSpy.info).toHaveBeenCalledTimes(1);
        const logged = JSON.parse(consoleSpy.info.mock.calls[0][0] as string);

        // Timestamp should be the real one from clock, not the fake one
        expect(logged.timestamp).not.toBe('1970-01-01T00:00:00.000Z');
        expect(logged.timestamp).toBe('2024-01-01T00:00:00.000Z');
      });

      it('should not allow overriding level via context', () => {
        consoleLogger.info('Test', { level: LogLevel.ERROR });

        expect(consoleSpy.info).toHaveBeenCalledTimes(1);
        const logged = JSON.parse(consoleSpy.info.mock.calls[0][0] as string);

        // Level should be INFO, not ERROR
        expect(logged.level).toBe(LogLevel.INFO);
        expect(logged.level).not.toBe(LogLevel.ERROR);
      });

      it('should not allow overriding message via context', () => {
        consoleLogger.info('Original message', { message: 'Fake message' });

        expect(consoleSpy.info).toHaveBeenCalledTimes(1);
        const logged = JSON.parse(consoleSpy.info.mock.calls[0][0] as string);

        // Message should be the original
        expect(logged.message).toBe('Original message');
        expect(logged.message).not.toBe('Fake message');
      });

      it('should not allow overriding multiple reserved fields', () => {
        consoleLogger.warn('Real message', {
          timestamp: '1990-01-01',
          level: LogLevel.FATAL,
          message: 'Hijacked',
          userId: '123', // This should be preserved
        });

        // Should have logged (note: sanitizeContext also calls console.warn for warnings)
        expect(consoleSpy.warn.mock.calls.length).toBeGreaterThanOrEqual(1);

        // Find the actual log entry (JSON string, not warning message)
        const logCall = consoleSpy.warn.mock.calls.find((call) => {
          const arg = call[0] as string;
          return arg.startsWith('{') && arg.includes('"level"');
        });

        expect(logCall).toBeDefined();
        const logged = JSON.parse(logCall![0] as string);

        // Reserved fields should be protected
        expect(logged.timestamp).toBe('2024-01-01T00:00:00.000Z');
        expect(logged.level).toBe(LogLevel.WARN);
        expect(logged.message).toBe('Real message');

        // User field should be preserved
        expect(logged.userId).toBe('123');
      });

      it('should not allow overriding via child bindings', () => {
        const child = consoleLogger.child({
          timestamp: '1970-01-01',
          level: LogLevel.FATAL,
          message: 'Hijacked',
          service: 'test-service', // This should be preserved
        });

        child.info('Test message');

        expect(consoleSpy.info).toHaveBeenCalledTimes(1);
        const logged = JSON.parse(consoleSpy.info.mock.calls[0][0] as string);

        // Reserved fields should be protected
        expect(logged.timestamp).toBe('2024-01-01T00:00:00.000Z');
        expect(logged.level).toBe(LogLevel.INFO);
        expect(logged.message).toBe('Test message');

        // User binding should be preserved
        expect(logged.service).toBe('test-service');
      });

      it('should silently ignore reserved fields without warning', () => {
        const warnSpy = jest
          .spyOn(console, 'warn')
          .mockImplementation(() => {});

        // Attempt to override timestamp
        consoleLogger.info('Test', { timestamp: '1970-01-01' });

        // Should NOT warn (to avoid breaking log-level filter)
        expect(warnSpy).not.toHaveBeenCalled();

        // But reserved field should still be ignored
        expect(consoleSpy.info).toHaveBeenCalledTimes(1);
        const logged = JSON.parse(consoleSpy.info.mock.calls[0][0] as string);
        expect(logged.timestamp).toBe('2024-01-01T00:00:00.000Z'); // Real timestamp, not overridden

        warnSpy.mockRestore();
      });
    });

    describe('ColorConsoleLogger', () => {
      it('should not allow overriding reserved fields', () => {
        // ColorConsoleLogger doesn't output JSON, but should still sanitize
        colorLogger.info('Test message', {
          timestamp: '1970-01-01',
          level: LogLevel.FATAL,
          message: 'Fake',
          userId: '456',
        });

        expect(consoleSpy.log).toHaveBeenCalledTimes(1);
        const logged = consoleSpy.log.mock.calls[0][0] as string;

        // Should contain real timestamp from clock
        expect(logged).toContain('2024-01-01');
        expect(logged).not.toContain('1970-01-01');

        // Should show INFO level, not FATAL
        expect(logged).toContain('[INFO]');
        expect(logged).not.toContain('[FATAL]');

        // Should show real message
        expect(logged).toContain('Test message');

        // Should preserve user data
        expect(logged).toContain('userId');
        expect(logged).toContain('456');
      });
    });
  });

  describe('LOG_LEVEL_WEIGHTS immutability', () => {
    it('should not allow direct mutation of weights', () => {
      const originalDebugWeight = LOG_LEVEL_WEIGHTS[LogLevel.DEBUG];

      // Attempt to mutate should throw in strict mode or be ignored
      expect(() => {
        (LOG_LEVEL_WEIGHTS as any)[LogLevel.DEBUG] = 999;
      }).toThrow();

      // Weight should remain unchanged
      expect(LOG_LEVEL_WEIGHTS[LogLevel.DEBUG]).toBe(originalDebugWeight);
    });

    it('should have Readonly type and be frozen', () => {
      // TypeScript compile-time check enforced by Readonly<> type
      // The following would not compile:
      // LOG_LEVEL_WEIGHTS[LogLevel.INFO] = 100;

      // Runtime check - Object.freeze should prevent mutation
      expect(Object.isFrozen(LOG_LEVEL_WEIGHTS)).toBe(true);
    });

    it('should preserve correct weights after mutation attempt', () => {
      // Save original weights
      const original = {
        [LogLevel.TRACE]: 0,
        [LogLevel.DEBUG]: 1,
        [LogLevel.INFO]: 2,
        [LogLevel.WARN]: 3,
        [LogLevel.ERROR]: 4,
        [LogLevel.FATAL]: 5,
      };

      // Attempt mutations
      try {
        (LOG_LEVEL_WEIGHTS as any)[LogLevel.TRACE] = 100;
      } catch {
        // ignore
      }

      try {
        (LOG_LEVEL_WEIGHTS as any)[LogLevel.FATAL] = 0;
      } catch {
        // ignore
      }

      // All weights should remain original
      expect(LOG_LEVEL_WEIGHTS[LogLevel.TRACE]).toBe(original[LogLevel.TRACE]);
      expect(LOG_LEVEL_WEIGHTS[LogLevel.DEBUG]).toBe(original[LogLevel.DEBUG]);
      expect(LOG_LEVEL_WEIGHTS[LogLevel.INFO]).toBe(original[LogLevel.INFO]);
      expect(LOG_LEVEL_WEIGHTS[LogLevel.WARN]).toBe(original[LogLevel.WARN]);
      expect(LOG_LEVEL_WEIGHTS[LogLevel.ERROR]).toBe(original[LogLevel.ERROR]);
      expect(LOG_LEVEL_WEIGHTS[LogLevel.FATAL]).toBe(original[LogLevel.FATAL]);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty context gracefully', () => {
      expect(() => {
        consoleLogger.info('Test', {});
      }).not.toThrow();
    });

    it('should handle undefined context gracefully', () => {
      expect(() => {
        consoleLogger.info('Test');
      }).not.toThrow();
    });

    it('should handle deeply nested circular structures', () => {
      const deep: any = { level1: { level2: { level3: {} } } };
      deep.level1.level2.level3.backToRoot = deep;

      expect(() => {
        consoleLogger.info('Test', { data: deep });
      }).not.toThrow();
    });

    it('should handle array with circular reference', () => {
      const arr: any[] = [1, 2, 3];
      arr.push(arr); // Circular

      expect(() => {
        consoleLogger.info('Test', { data: arr });
      }).not.toThrow();
    });

    it('should handle mixed valid and invalid data', () => {
      expect(() => {
        consoleLogger.info('Test', {
          validString: 'hello',
          validNumber: 42,
          bigint: BigInt(999),
          symbol: Symbol('test'),
          func: () => {},
          validArray: [1, 2, 3],
        });
      }).not.toThrow();

      expect(consoleSpy.info).toHaveBeenCalledTimes(1);
    });
  });

  describe('Getter exceptions protection', () => {
    it('should handle context with throwing getter without crashing', () => {
      const dangerousContext = {
        safeField: 'safe',
        get boom() {
          throw new Error('Getter explosion!');
        },
      };

      // Should NOT throw - fail-safe behavior
      expect(() => {
        consoleLogger.info('Test message', dangerousContext);
      }).not.toThrow();

      // Should have logged
      expect(consoleSpy.info).toHaveBeenCalledTimes(1);

      // Check that log was created with safe field and error placeholder
      const logged = JSON.parse(consoleSpy.info.mock.calls[0][0] as string);
      expect(logged.safeField).toBe('safe');
      expect(logged.boom).toMatch(/Error reading property/);
    });

    it('should handle multiple throwing getters', () => {
      const multiDangerous = {
        get error1() {
          throw new TypeError('Type error');
        },
        validField: 123,
        get error2() {
          throw new RangeError('Range error');
        },
      };

      expect(() => {
        consoleLogger.info('Test', multiDangerous);
      }).not.toThrow();

      const logged = JSON.parse(consoleSpy.info.mock.calls[0][0] as string);
      expect(logged.validField).toBe(123);
      expect(logged.error1).toMatch(/Error reading property.*Type error/);
      expect(logged.error2).toMatch(/Error reading property.*Range error/);
    });

    it('should handle getter throwing non-Error object', () => {
      const weirdContext = {
        get weird() {
          // eslint-disable-next-line no-throw-literal
          throw 'string error';
        },
      };

      expect(() => {
        consoleLogger.info('Test', weirdContext);
      }).not.toThrow();

      const logged = JSON.parse(consoleSpy.info.mock.calls[0][0] as string);
      expect(logged.weird).toMatch(/Error reading property.*string error/);
    });

    it('should handle ColorConsoleLogger with throwing getter', () => {
      const dangerousContext = {
        get boom() {
          throw new Error('Boom!');
        },
      };

      expect(() => {
        colorLogger.info('Test', dangerousContext);
      }).not.toThrow();

      expect(consoleSpy.log).toHaveBeenCalledTimes(1);
    });
  });

  describe('__proto__ payload protection', () => {
    it('should not allow __proto__ pollution via context', () => {
      const maliciousContext = {
        __proto__: { polluted: 'value' },
        normalField: 'normal',
      };

      consoleLogger.info('Test', maliciousContext);

      const logged = JSON.parse(consoleSpy.info.mock.calls[0][0] as string);

      // Should have normal field
      expect(logged.normalField).toBe('normal');

      // Should NOT have __proto__ as own property in logged output
      expect(Object.prototype.hasOwnProperty.call(logged, '__proto__')).toBe(
        false
      );

      // Verify no pollution occurred
      expect(logged.polluted).toBeUndefined();
    });

    it('should handle attempts to set constructor', () => {
      const maliciousContext = {
        constructor: { prototype: { polluted: true } },
        validField: 'valid',
      };

      expect(() => {
        consoleLogger.info('Test', maliciousContext);
      }).not.toThrow();

      const logged = JSON.parse(consoleSpy.info.mock.calls[0][0] as string);
      expect(logged.validField).toBe('valid');

      // Constructor should be serialized as a regular field (JSON.stringify handles it)
      // It doesn't cause prototype pollution
    });

    it('should sanitize __proto__ from bindings in child logger', () => {
      const maliciousBindings = {
        __proto__: { polluted: 'bad' },
        service: 'test',
      };

      const childLogger = consoleLogger.child(maliciousBindings);
      childLogger.info('Test message');

      const logged = JSON.parse(consoleSpy.info.mock.calls[0][0] as string);
      expect(logged.service).toBe('test');

      // Should NOT have __proto__ as own property
      expect(Object.prototype.hasOwnProperty.call(logged, '__proto__')).toBe(
        false
      );

      // Verify no pollution
      expect(logged.polluted).toBeUndefined();
    });
  });

  describe('Circular reference with log form preservation', () => {
    it('should preserve timestamp, level, message when circular data occurs', () => {
      const circular: any = { name: 'test', value: 42 };
      circular.self = circular;

      consoleLogger.info('Circular test', { data: circular });

      expect(consoleSpy.info).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(consoleSpy.info.mock.calls[0][0] as string);

      // System fields should ALWAYS be present (they are primitives)
      expect(logged.timestamp).toBe('2024-01-01T00:00:00.000Z');
      expect(logged.level).toBe(LogLevel.INFO);
      expect(logged.message).toBe('Circular test');

      // Should have __error marker
      expect(logged.__error).toBe('Circular reference detected');

      // Complex 'data' field is NOT preserved (it's an object with circular ref)
      // Only primitive fields from top-level logEntry are preserved
      expect(logged.data).toBeUndefined();
    });

    it('should preserve log form with primitive context fields', () => {
      const circular: any = { self: null };
      circular.self = circular;

      // Add primitive fields alongside circular one
      consoleLogger.info('Message', {
        id: 123,
        name: 'test',
        circular: circular,
      });

      const logged = JSON.parse(consoleSpy.info.mock.calls[0][0] as string);

      // Core log structure must survive
      expect(logged.timestamp).toBeDefined();
      expect(logged.level).toBeDefined();
      expect(logged.message).toBe('Message');

      // Primitive fields from context are preserved
      expect(logged.id).toBe(123);
      expect(logged.name).toBe('test');

      // Circular field is not preserved
      expect(logged.circular).toBeUndefined();

      // Error marker present
      expect(logged.__error).toBe('Circular reference detected');
    });

    it('should extract only primitive fields when serialization fails', () => {
      const complex: any = {
        id: 123,
        name: 'test',
        nested: {
          value: 'nested',
        },
      };
      complex.circular = complex;

      consoleLogger.info('Test', complex);

      const logged = JSON.parse(consoleSpy.info.mock.calls[0][0] as string);

      // System fields present (primitives)
      expect(logged.timestamp).toBeDefined();
      expect(logged.level).toBeDefined();
      expect(logged.message).toBe('Test');

      // Primitive fields from context are preserved
      expect(logged.id).toBe(123);
      expect(logged.name).toBe('test');

      // Complex nested object is NOT preserved
      expect(logged.nested).toBeUndefined();
      expect(logged.circular).toBeUndefined();

      // Error marker present
      expect(logged.__error).toBe('Circular reference detected');
    });
  });

  describe('Unknown serialization errors', () => {
    it('should handle unknown JSON.stringify errors gracefully', () => {
      // Create object that causes unusual serialization error
      // This is hard to trigger, but we test the fallback path
      const problematic = {
        toJSON() {
          throw new Error('toJSON failed');
        },
      };

      expect(() => {
        consoleLogger.info('Test', { data: problematic });
      }).not.toThrow();

      expect(consoleSpy.info).toHaveBeenCalled();
    });

    it('should handle serialization errors in ColorConsoleLogger', () => {
      const problematic = {
        toJSON() {
          throw new TypeError('Custom toJSON error');
        },
      };

      expect(() => {
        colorLogger.info('Test', { data: problematic });
      }).not.toThrow();

      expect(consoleSpy.log).toHaveBeenCalled();
    });
  });
});
