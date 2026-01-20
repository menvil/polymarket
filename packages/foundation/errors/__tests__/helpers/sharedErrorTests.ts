/**
 * Общие тесты для всех классов ошибок
 *
 * @remarks
 * Этот helper создаёт стандартный набор тестов для любого класса,
 * наследующего TradingError. Избегает копирования одинакового кода.
 *
 * @example
 * ```typescript
 * import { testTradingError } from '../helpers/sharedErrorTests';
 * import { ValidationError } from '../../src/base/ValidationError';
 *
 * describe('ValidationError', () => {
 *   // Запускаем стандартные тесты
 *   testTradingError({
 *     ErrorClass: ValidationError,
 *     expectedName: 'ValidationError',
 *     expectedSeverity: 'low',
 *     testMessage: 'Test validation error'
 *   });
 *
 *   // Добавляем специфичные тесты
 *   describe('custom behavior', () => {
 *     it('должен работать со специфичной логикой', () => {
 *       // ...
 *     });
 *   });
 * });
 * ```
 */

import { describe, it, expect } from '@jest/globals';
import { TradingError } from '../../src/base/TradingError';
import { ErrorSeverity } from '../../src/base/ITradingError';

/**
 * Тип конструктора для TradingError с статическими методами
 */
export type TradingErrorConstructor = (new (
  message: string | ((context: Record<string, unknown>) => string),
  options?: { code?: string; context?: Record<string, unknown> }
) => TradingError) & {
  is(error: unknown): error is TradingError;
};

/**
 * Параметры для стандартных тестов
 */
export interface SharedErrorTestOptions {
  /** Класс ошибки для тестирования */
  ErrorClass: TradingErrorConstructor;
  /** Ожидаемое имя ошибки (this.name) */
  expectedName: string;
  /** Ожидаемый уровень серьёзности */
  expectedSeverity: ErrorSeverity;
  /** Тестовое сообщение */
  testMessage: string;
}

/**
 * Создаёт стандартный набор тестов для класса ошибки
 *
 * @param options - Параметры тестирования
 *
 * @remarks
 * Проверяет (27 тестов):
 * - Создание экземпляра
 * - Наследование от Error и TradingError
 * - Автоматическую установку name
 * - Правильный severity
 * - Сохранение context и code
 * - Создание timestamp
 * - Создание stack trace
 * - Работу toJSON()
 * - Работу static is()
 * - Работу instanceof
 * - Динамические сообщения
 * - Graceful обработку ошибок из template функций
 * - Свойство innerError при ошибках шаблона
 */
export function testTradingError(options: SharedErrorTestOptions): void {
  const { ErrorClass, expectedName, expectedSeverity, testMessage } = options;

  describe('standard behavior', () => {
    describe('constructor', () => {
      it('должен создавать экземпляр с минимальными параметрами', () => {
        const error = new ErrorClass(testMessage);

        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(TradingError);
        expect(error).toBeInstanceOf(ErrorClass);
        expect(error.message).toBe(testMessage);
      });

      it(`должен иметь severity = "${expectedSeverity}"`, () => {
        const error = new ErrorClass(testMessage);
        expect(error.severity).toBe(expectedSeverity);
      });

      it(`должен автоматически устанавливать name = "${expectedName}"`, () => {
        const error = new ErrorClass(testMessage);
        expect(error.name).toBe(expectedName);
      });

      it('должен сохранять context', () => {
        const context = { field: 'price', value: -10 };
        const error = new ErrorClass(testMessage, { context });

        expect(error.context).toEqual(context);
      });

      it('должен сохранять code', () => {
        const error = new ErrorClass(testMessage, { code: 'TEST_CODE' });
        expect(error.code).toBe('TEST_CODE');
      });

      it('должен работать с code и context вместе', () => {
        const context = { field: 'price', value: -10 };
        const error = new ErrorClass(testMessage, {
          code: 'TEST_CODE',
          context,
        });

        expect(error.code).toBe('TEST_CODE');
        expect(error.context).toEqual(context);
      });

      it('должен создавать timestamp', () => {
        const before = new Date();
        const error = new ErrorClass(testMessage);
        const after = new Date();

        expect(error.timestamp).toBeInstanceOf(Date);
        expect(error.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
        expect(error.timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
      });

      it('должен создавать stack trace', () => {
        const error = new ErrorClass(testMessage);

        expect(error.stack).toBeDefined();
        expect(typeof error.stack).toBe('string');

        // Проверяем что stack содержит имя класса только в V8 окружениях (Node.js, Chrome)
        // В других средах (Firefox, Safari) используется fallback и stack может отличаться
        if (typeof (Error as any).captureStackTrace === 'function') {
          expect(error.stack).toContain(expectedName);
        }
      });
    });

    describe('dynamic messages', () => {
      it('должен поддерживать функцию-шаблон для динамических сообщений', () => {
        const error = new ErrorClass(
          (ctx) => `${ctx.field} must be positive but current value is ${ctx.value}`,
          { context: { field: 'price', value: -10 } }
        );

        expect(error.message).toBe('price must be positive but current value is -10');
        expect(error.context).toEqual({ field: 'price', value: -10 });
      });

      it('должен поддерживать методы строк в шаблоне', () => {
        const error = new ErrorClass(
          (ctx: any) => `${ctx.field.toUpperCase()} = ${ctx.value}`,
          { context: { field: 'price', value: -10 } }
        );

        expect(error.message).toBe('PRICE = -10');
      });

      it('должен выбросить TypeError если функция передана без context', () => {
        expect(() => {
          new ErrorClass((ctx) => `Field ${ctx.field} is invalid`);
        }).toThrow(TypeError);

        expect(() => {
          new ErrorClass((ctx) => `Field ${ctx.field} is invalid`);
        }).toThrow(
          'TradingError: Message template function provided without context. Pass context in options or use a static string message.'
        );
      });

      it('должен использовать статическое сообщение если передана строка с context', () => {
        const error = new ErrorClass('Static message', {
          context: { field: 'price', value: -10 },
        });

        expect(error.message).toBe('Static message');
        expect(error.context).toEqual({ field: 'price', value: -10 });
      });
    });

    describe('toJSON()', () => {
      it('должен сериализовать без code', () => {
        const error = new ErrorClass(testMessage, {
          context: { field: 'price', value: -10 },
        });

        const json = error.toJSON();

        expect(json).toEqual({
          name: expectedName,
          message: testMessage,
          severity: expectedSeverity,
          timestamp: error.timestamp.toISOString(),
          context: { field: 'price', value: -10 },
        });
      });

      it('должен сериализовать с code', () => {
        const error = new ErrorClass(testMessage, {
          code: 'TEST_CODE',
          context: { field: 'price', value: -10 },
        });

        const json = error.toJSON();

        expect(json).toEqual({
          name: expectedName,
          code: 'TEST_CODE',
          message: testMessage,
          severity: expectedSeverity,
          timestamp: error.timestamp.toISOString(),
          context: { field: 'price', value: -10 },
        });
      });

      it('должен работать с JSON.stringify()', () => {
        const error = new ErrorClass(testMessage, {
          code: 'TEST_CODE',
          context: { field: 'price' },
        });

        // Проверяем что JSON.stringify автоматически вызывает toJSON()
        const jsonString = JSON.stringify(error);
        const parsed = JSON.parse(jsonString);

        expect(parsed.name).toBe(expectedName);
        expect(parsed.code).toBe('TEST_CODE');
        expect(parsed.severity).toBe(expectedSeverity);
      });
    });

    describe('static is()', () => {
      it(`должен правильно определять ${expectedName}`, () => {
        const error = new ErrorClass(testMessage);
        expect(ErrorClass.is(error)).toBe(true);
      });

      it('должен возвращать false для других типов TradingError', () => {
        class AnotherError extends TradingError {
          public readonly severity = 'high' as const;
        }

        const error = new AnotherError('Another error');
        expect(ErrorClass.is(error)).toBe(false);
      });

      it('должен возвращать false для обычных ошибок', () => {
        const error = new Error('Regular error');
        expect(ErrorClass.is(error)).toBe(false);
      });

      it('должен возвращать false для не-ошибок', () => {
        expect(ErrorClass.is(null)).toBe(false);
        expect(ErrorClass.is(undefined)).toBe(false);
        expect(ErrorClass.is({})).toBe(false);
        expect(ErrorClass.is('string')).toBe(false);
      });

      it('должен работать в типичном catch блоке', () => {
        try {
          throw new ErrorClass(testMessage);
        } catch (error) {
          expect(ErrorClass.is(error)).toBe(true);

          if (ErrorClass.is(error)) {
            expect(error.message).toBe(testMessage);
            expect(error.severity).toBe(expectedSeverity);
          }
        }
      });
    });

    describe('instanceof', () => {
      it('должен работать с instanceof', () => {
        const error = new ErrorClass(testMessage);

        expect(error instanceof ErrorClass).toBe(true);
        expect(error instanceof TradingError).toBe(true);
        expect(error instanceof Error).toBe(true);
      });

      it('должен работать в типичном catch блоке', () => {
        try {
          throw new ErrorClass(testMessage);
        } catch (error) {
          expect(error instanceof ErrorClass).toBe(true);

          if (error instanceof ErrorClass) {
            expect(error.message).toBe(testMessage);
            expect(error.severity).toBe(expectedSeverity);
          }
        }
      });
    });

    describe('innerError handling', () => {
      it('должен обрабатывать ошибки из функции-шаблона gracefully', () => {
        const error = new ErrorClass(
          () => {
            throw new Error('Template failed');
          },
          { context: { field: 'test' } }
        );

        // Не должно выбросить исключение
        expect(error).toBeInstanceOf(ErrorClass);
        expect(error.message).toBe('Message template function failed: Template failed');
        expect(error.innerError).toBeInstanceOf(Error);
        expect(error.innerError?.message).toBe('Template failed');
      });

      it('должен сохранять context даже при ошибке в шаблоне', () => {
        const error = new ErrorClass(
          () => {
            throw new Error('Template failed');
          },
          { context: { field: 'test', value: 123 } }
        );

        expect(error.context).toEqual({ field: 'test', value: 123 });
      });

      it('должен включать innerError в toJSON() при наличии', () => {
        const error = new ErrorClass(
          () => {
            throw new Error('Template failed');
          },
          { context: { field: 'test' } }
        );

        const json = error.toJSON();

        expect(json.innerError).toBeDefined();
        expect((json.innerError as any).message).toBe('Template failed');
        expect((json.innerError as any).stack).toBeDefined();
      });

      it('не должен устанавливать innerError при успешном выполнении шаблона', () => {
        const error = new ErrorClass((ctx) => `Test ${ctx.field}`, {
          context: { field: 'value' },
        });

        expect(error.innerError).toBeUndefined();
      });

      it('не должен включать innerError в toJSON() когда его нет', () => {
        const error = new ErrorClass(testMessage);

        const json = error.toJSON();

        expect(json).not.toHaveProperty('innerError');
      });
    });
  });
}
