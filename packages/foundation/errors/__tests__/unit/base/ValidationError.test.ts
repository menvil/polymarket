/**
 * Тесты для ValidationError
 */

import { describe, it, expect } from '@jest/globals';
import { ValidationError } from '../../../src/base/ValidationError';
import { TradingError } from '../../../src/base/TradingError';
import { testTradingError } from '../../helpers/sharedErrorTests';

describe('ValidationError', () => {
  // Запускаем стандартные тесты для всех TradingError
  testTradingError({
    ErrorClass: ValidationError,
    expectedName: 'ValidationError',
    expectedSeverity: 'low',
    testMessage: 'Invalid price',
  });

  // Специфичные тесты для ValidationError
  describe('specific use cases', () => {
    it('должен работать для валидации полей формы', () => {
      const error = new ValidationError('Price must be positive', {
        code: 'PRICE_NEGATIVE',
        context: { field: 'price', value: -10, min: 0 },
      });

      expect(error.message).toBe('Price must be positive');
      expect(error.code).toBe('PRICE_NEGATIVE');
      expect(error.context?.field).toBe('price');
      expect(error.context?.value).toBe(-10);
      expect(error.context?.min).toBe(0);
    });

    it('должен работать для множественных ошибок валидации', () => {
      const errors = [
        new ValidationError('Price is required', {
          code: 'FIELD_REQUIRED',
          context: { field: 'price' },
        }),
        new ValidationError('Quantity must be positive', {
          code: 'QUANTITY_NEGATIVE',
          context: { field: 'quantity', value: -5 },
        }),
      ];

      expect(errors).toHaveLength(2);
      errors.forEach((error) => {
        expect(error instanceof ValidationError).toBe(true);
        expect(error.severity).toBe('low');
      });
    });

    it('должен работать в обработчике с несколькими типами ошибок', () => {
      class NetworkError extends TradingError {
        public readonly severity = 'high' as const;
      }

      const validationError = new ValidationError('Invalid data');
      const networkError = new NetworkError('Connection failed');

      expect(ValidationError.is(validationError)).toBe(true);
      expect(ValidationError.is(networkError)).toBe(false);
      expect(NetworkError.is(networkError)).toBe(true);
      expect(NetworkError.is(validationError)).toBe(false);
    });

    it('должен работать с комплексными динамическими шаблонами для валидации диапазонов', () => {
      const error = new ValidationError(
        (ctx: any) =>
          `Validation failed: ${ctx.field} = ${ctx.value} (expected: min=${ctx.min}, max=${ctx.max})`,
        {
          code: 'RANGE_ERROR',
          context: { field: 'quantity', value: 150, min: 1, max: 100 },
        }
      );

      expect(error.message).toBe(
        'Validation failed: quantity = 150 (expected: min=1, max=100)'
      );
      expect(error.code).toBe('RANGE_ERROR');
      expect(error.severity).toBe('low');
    });
  });
});
