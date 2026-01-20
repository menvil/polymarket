/**
 * Тесты для TradingError
 */

import { describe, it, expect } from '@jest/globals';
import { TradingError } from '../../../src/base/TradingError';
import { ErrorSeverity } from '../../../src/base/ITradingError';

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
      expect(error.stack).toContain('TestError');
    });

    it('должен использовать fallback для stack trace в non-V8 окружениях', () => {
      // Сохраняем оригинальную функцию
      const originalCaptureStackTrace = (Error as any).captureStackTrace;

      // Временно удаляем captureStackTrace для эмуляции non-V8 окружения
      (Error as any).captureStackTrace = undefined;

      const error = new TestError('Test error');

      expect(error.stack).toBeDefined();
      expect(typeof error.stack).toBe('string');

      // Восстанавливаем оригинальную функцию
      (Error as any).captureStackTrace = originalCaptureStackTrace;
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

    it('должен использовать статическое сообщение если функция передана без context', () => {
      const error = new TestError((ctx) => `Field ${ctx.field} is invalid`);

      expect(error.message).toBe('Unknown error');
    });

    it('должен использовать статическое сообщение если передана строка с context', () => {
      const error = new TestError('Static message', {
        context: { field: 'price', value: -10 }
      });

      expect(error.message).toBe('Static message');
      expect(error.context).toEqual({ field: 'price', value: -10 });
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

      const jsonString = JSON.stringify(error.toJSON());
      const parsed = JSON.parse(jsonString);

      expect(parsed.name).toBe('TestError');
      expect(parsed.code).toBe('TEST_CODE');
      expect(parsed.message).toBe('Test error');
      expect(parsed.severity).toBe('medium');
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
