/**
 * Тесты для TradingError
 */

import { describe, it, expect } from '@jest/globals';
import { TradingError, ErrorSeverity } from '../../../src/base';

// Тестовый класс для проверки наследования
class TestError extends TradingError {
  public readonly severity: ErrorSeverity = 'medium';
  constructor(
    message: string | ((context: Record<string, unknown>) => string),
    options?: { code?: string; context?: Record<string, unknown> }
  ) {
    super(message, options);
  }
}

describe('TradingError', () => {
  describe('constructor', () => {
    it('должен создавать экземпляр с минимальными параметрами', () => {
      const error = new TestError('Test error');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(TradingError);
      expect(error.message).toBe('Test error');
      expect(error.severity).toBe('medium');
    });

    it('должен автоматически устанавливать name из constructor.name', () => {
      const error = new TestError('Test error');
      expect(error.name).toBe('TestError');
    });

    it('должен создавать timestamp', () => {
      const before = new Date();
      const error = new TestError('Test error');
      const after = new Date();

      expect(error.timestamp).toBeInstanceOf(Date);
      expect(error.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(error.timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('должен сохранять context', () => {
      const context = { field: 'price', value: -10 };
      const error = new TestError('Test error', { context });

      expect(error.context).toEqual(context);
    });

    it('должен сохранять code', () => {
      const error = new TestError('Test error', { code: 'TEST_CODE' });
      expect(error.code).toBe('TEST_CODE');
    });

    it('должен работать без code и context', () => {
      const error = new TestError('Test error');
      expect(error.code).toBeUndefined();
      expect(error.context).toBeUndefined();
    });

    it('должен создавать stack trace', () => {
      const error = new TestError('Test error');
      expect(error.stack).toBeDefined();
      expect(typeof error.stack).toBe('string');

      // Проверяем содержимое stack только в V8 окружениях (Node.js, Chrome)
      const ErrorCtor = Error as unknown as { captureStackTrace?: (targetObject: object, constructorOpt?: unknown) => void };
      if (typeof ErrorCtor.captureStackTrace === 'function') {
        expect(error.stack).toContain('TestError');
      }
    });

    it('должен использовать fallback для stack trace в non-V8 окружениях', () => {
      // Сохраняем оригинальную функцию
      const originalCaptureStackTrace = (Error as any).captureStackTrace;

      try {
        // Временно удаляем captureStackTrace для эмуляции non-V8 окружения
        (Error as any).captureStackTrace = undefined;

        const error = new TestError('Test error');

        expect(error.stack).toBeDefined();
        expect(typeof error.stack).toBe('string');
      } finally {
        // Восстанавливаем оригинальную функцию
        (Error as any).captureStackTrace = originalCaptureStackTrace;
      }
    });

    it('должен поддерживать функцию-шаблон для динамических сообщений', () => {
      const error = new TestError(
        (ctx) => `${ctx.field} must be positive but current value is ${ctx.value}`,
        { context: { field: 'price', value: -10, min: 0 } }
      );

      expect(error.message).toBe('price must be positive but current value is -10');
      expect(error.context).toEqual({ field: 'price', value: -10, min: 0 });
    });

    it('должен поддерживать .toUpperCase() в шаблоне', () => {
      const error = new TestError(
        (ctx: any) => `${ctx.field.toUpperCase()} must be positive but current value is ${ctx.value}`,
        { context: { field: 'price', value: -10 } }
      );

      expect(error.message).toBe('PRICE must be positive but current value is -10');
    });

    it('должен выбросить TypeError если функция передана без context', () => {
      expect(() => {
        new TestError((ctx) => `Field ${ctx.field} is invalid`);
      }).toThrow(TypeError);

      expect(() => {
        new TestError((ctx) => `Field ${ctx.field} is invalid`);
      }).toThrow(
        'TradingError: Message template function provided without context. Pass context in options or use a static string message.'
      );
    });

    it('должен использовать статическое сообщение если передана строка с context', () => {
      const error = new TestError('Static message', {
        context: { field: 'price', value: -10 }
      });

      expect(error.message).toBe('Static message');
      expect(error.context).toEqual({ field: 'price', value: -10 });
    });

    it('должен выбросить TypeError если message не строка и не функция', () => {
      expect(() => {
        new TestError(123 as any);
      }).toThrow('TradingError: Message must be a string or function, got number');

      expect(() => {
        new TestError({ invalid: 'object' } as any);
      }).toThrow('TradingError: Message must be a string or function, got object');

      expect(() => {
        new TestError(null as any);
      }).toThrow('TradingError: Message must be a string or function, got object');
    });
  });

  describe('toJSON()', () => {
    it('должен сериализовать ошибку без code', () => {
      const error = new TestError('Test error', {
        context: { field: 'price' }
      });

      const json = error.toJSON();

      expect(json).toEqual({
        name: 'TestError',
        message: 'Test error',
        severity: 'medium',
        timestamp: error.timestamp.toISOString(),
        context: { field: 'price' }
      });
    });

    it('должен сериализовать ошибку с code', () => {
      const error = new TestError('Test error', {
        code: 'TEST_CODE',
        context: { field: 'price' }
      });

      const json = error.toJSON();

      expect(json).toEqual({
        name: 'TestError',
        code: 'TEST_CODE',
        message: 'Test error',
        severity: 'medium',
        timestamp: error.timestamp.toISOString(),
        context: { field: 'price' }
      });
    });

    it('должен сериализовать ошибку без code и context', () => {
      const error = new TestError('Test error');

      const json = error.toJSON();

      expect(json).toEqual({
        name: 'TestError',
        message: 'Test error',
        severity: 'medium',
        timestamp: error.timestamp.toISOString()
      });

      // Проверяем что context и code не присутствуют в объекте
      expect(json).not.toHaveProperty('code');
      expect(json).not.toHaveProperty('context');
    });

    it('должен работать с JSON.stringify()', () => {
      const error = new TestError('Test error', {
        code: 'TEST_CODE',
        context: { field: 'price' }
      });

      // Проверяем что JSON.stringify автоматически вызывает toJSON()
      const jsonString = JSON.stringify(error);
      const parsed = JSON.parse(jsonString);

      expect(parsed.name).toBe('TestError');
      expect(parsed.code).toBe('TEST_CODE');
      expect(parsed.message).toBe('Test error');
      expect(parsed.severity).toBe('medium');
    });

    it('должен безопасно сериализовать циклический context', () => {
      // Создаём context с циклической ссылкой
      const context: Record<string, unknown> = {
        field: 'price',
        value: 100
      };
      context.self = context; // Циклическая ссылка

      const error = new TestError('Test error', { context });

      // toJSON() должен успешно выполниться без TypeError
      const json = error.toJSON();

      expect(json.name).toBe('TestError');
      expect(json.message).toBe('Test error');
      expect(json.context).toBeDefined();

      // Циклическая ссылка заменена на маркер
      expect((json.context as Record<string, unknown>).self).toBe('[Circular]');
      expect((json.context as Record<string, unknown>).field).toBe('price');
      expect((json.context as Record<string, unknown>).value).toBe(100);

      // JSON.stringify тоже должен работать без ошибок
      expect(() => JSON.stringify(json)).not.toThrow();
    });

    it('должен обрабатывать вложенные циклические ссылки', () => {
      const inner: Record<string, unknown> = { level: 'inner' };
      const outer: Record<string, unknown> = { level: 'outer', inner };
      inner.parent = outer; // Циклическая ссылка

      const error = new TestError('Test error', { context: outer });
      const json = error.toJSON();

      expect((json.context as Record<string, unknown>).level).toBe('outer');
      expect(((json.context as Record<string, unknown>).inner as Record<string, unknown>).level).toBe('inner');
      expect(((json.context as Record<string, unknown>).inner as Record<string, unknown>).parent).toBe('[Circular]');

      // JSON.stringify должен работать
      expect(() => JSON.stringify(json)).not.toThrow();
    });

    it('должен обрабатывать массивы с циклическими ссылками', () => {
      const arr: unknown[] = [1, 2, 3];
      arr.push(arr); // Циклическая ссылка в массиве

      const context = { items: arr };
      const error = new TestError('Test error', { context });
      const json = error.toJSON();

      const items = (json.context as Record<string, unknown>).items as unknown[];
      expect(items[0]).toBe(1);
      expect(items[1]).toBe(2);
      expect(items[2]).toBe(3);
      expect(items[3]).toBe('[Circular]');

      // JSON.stringify должен работать
      expect(() => JSON.stringify(json)).not.toThrow();
    });

    it('должен корректно обрабатывать shared references (не циклы)', () => {
      // Shared reference - один объект используется в нескольких местах,
      // но без циклов (это НЕ должно быть помечено как [Circular])
      const shared = { value: 42, name: 'shared' };
      const context = {
        a: shared,
        b: shared,  // Тот же объект, но не цикл
        c: { nested: shared }  // И еще раз
      };

      const error = new TestError('Test error', { context });
      const json = error.toJSON();

      // Все три reference должны быть сериализованы как отдельные копии,
      // а не как "[Circular]"
      const ctx = json.context as Record<string, unknown>;
      expect(ctx.a).toEqual({ value: 42, name: 'shared' });
      expect(ctx.b).toEqual({ value: 42, name: 'shared' });
      expect((ctx.c as Record<string, unknown>).nested).toEqual({ value: 42, name: 'shared' });

      // Ни один не должен быть "[Circular]"
      expect(ctx.a).not.toBe('[Circular]');
      expect(ctx.b).not.toBe('[Circular]');
      expect((ctx.c as Record<string, unknown>).nested).not.toBe('[Circular]');

      // JSON.stringify должен работать
      expect(() => JSON.stringify(json)).not.toThrow();
    });

    it('должен корректно обрабатывать примитивы и null в context (defensive)', () => {
      const context: Record<string, unknown> = {
        stringValue: 'test',
        numberValue: 123,
        boolValue: true,
        nullValue: null,
        undefinedValue: undefined,
        nested: {
          primitive: 'nested string',
          nullInside: null
        }
      };

      const error = new TestError('Test error', { context });
      const json = error.toJSON();

      expect(json.context).toBeDefined();
      const ctx = json.context as Record<string, unknown>;

      expect(ctx.stringValue).toBe('test');
      expect(ctx.numberValue).toBe(123);
      expect(ctx.boolValue).toBe(true);
      expect(ctx.nullValue).toBe(null);
      expect(ctx.undefinedValue).toBe(undefined);

      const nested = ctx.nested as Record<string, unknown>;
      expect(nested.primitive).toBe('nested string');
      expect(nested.nullInside).toBe(null);

      expect(() => JSON.stringify(json)).not.toThrow();
    });
  });

  describe('innerError handling', () => {
    it('должен устанавливать innerError когда функция-шаблон выбрасывает ошибку', () => {
      const templateError = new Error('Template execution failed');
      const error = new TestError(
        () => {
          throw templateError;
        },
        { context: { field: 'price' } }
      );

      expect(error.innerError).toBe(templateError);
      expect(error.innerError?.message).toBe('Template execution failed');
    });

    it('должен использовать безопасное сообщение когда функция-шаблон выбрасывает ошибку', () => {
      const error = new TestError(
        () => {
          throw new Error('Template failed');
        },
        { context: { field: 'price' } }
      );

      expect(error.message).toBe('Message template function failed: Template failed');
    });

    it('должен сохранять context когда функция-шаблон выбрасывает ошибку', () => {
      const error = new TestError(
        () => {
          throw new Error('Template failed');
        },
        { context: { field: 'price', value: -10 } }
      );

      expect(error.context).toEqual({ field: 'price', value: -10 });
    });

    it('должен включать innerError в toJSON() когда он есть', () => {
      const error = new TestError(
        () => {
          throw new Error('Template failed');
        },
        { context: { field: 'price' } }
      );

      const json = error.toJSON();

      expect(json.innerError).toBeDefined();
      expect((json.innerError as any).name).toBe('Error');
      expect((json.innerError as any).message).toBe('Template failed');
      expect((json.innerError as any).stack).toBeDefined();
    });

    it('должен преобразовать non-Error исключение в Error', () => {
      const error = new TestError(
        () => {
          throw 'String error';
        },
        { context: { field: 'price' } }
      );

      expect(error.innerError).toBeInstanceOf(Error);
      expect(error.innerError?.message).toBe('String error');
    });

    it('не должен устанавливать innerError когда функция-шаблон выполняется успешно', () => {
      const error = new TestError((ctx) => `Field ${ctx.field} is invalid`, {
        context: { field: 'price' },
      });

      expect(error.innerError).toBeUndefined();
    });

    it('не должен включать innerError в toJSON() когда его нет', () => {
      const error = new TestError('Test error');

      const json = error.toJSON();

      expect(json).not.toHaveProperty('innerError');
    });
  });

  describe('static is()', () => {
    it('должен правильно определять тип ошибки', () => {
      const error = new TestError('Test error');

      expect(TestError.is(error)).toBe(true);
      expect(TradingError.is(error)).toBe(true);
    });

    it('должен возвращать false для других типов ошибок', () => {
      class AnotherError extends TradingError {
        public readonly severity: ErrorSeverity = 'high';
      }

      const error = new TestError('Test error');
      expect(AnotherError.is(error)).toBe(false);
    });

    it('должен возвращать false для обычных ошибок', () => {
      const error = new Error('Regular error');
      expect(TestError.is(error)).toBe(false);
    });

    it('должен возвращать false для не-ошибок', () => {
      expect(TestError.is(null)).toBe(false);
      expect(TestError.is(undefined)).toBe(false);
      expect(TestError.is({})).toBe(false);
      expect(TestError.is('string')).toBe(false);
      expect(TestError.is(123)).toBe(false);
    });

    it('должен работать для разных классов независимо', () => {
      class ErrorA extends TradingError {
        public readonly severity: ErrorSeverity = 'low';
      }
      class ErrorB extends TradingError {
        public readonly severity: ErrorSeverity = 'high';
      }

      const errorA = new ErrorA('Error A');
      const errorB = new ErrorB('Error B');

      expect(ErrorA.is(errorA)).toBe(true);
      expect(ErrorA.is(errorB)).toBe(false);
      expect(ErrorB.is(errorA)).toBe(false);
      expect(ErrorB.is(errorB)).toBe(true);
    });
  });

  describe('instanceof', () => {
    it('должен работать с instanceof', () => {
      const error = new TestError('Test error');

      expect(error instanceof TestError).toBe(true);
      expect(error instanceof TradingError).toBe(true);
      expect(error instanceof Error).toBe(true);
    });
  });
});
