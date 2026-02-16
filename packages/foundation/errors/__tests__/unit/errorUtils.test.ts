/**
 * Unit-тесты для errorUtils
 *
 * @remarks
 * Проверяет критичные утилиты:
 * - toDecimal: парсинг Decimal значений
 * - rewrap: сохранение метаданных (code, innerError) при rewrap
 * - wrapOp: централизованная обработка ошибок, классификация TradingError
 * - isExpectedMathError: определение expected math errors
 */

import { describe, it, expect } from '@jest/globals';
import { Err, Ok } from '@polymarket/result';
import Decimal from 'decimal.js';
import {
  toDecimal,
  rewrap,
  wrapOp,
  isExpectedMathError,
  isCoreInvariantViolation,
} from '../../src/utils/errorUtils.js';
import { InvalidMoneyError } from '../../src/value-objects/InvalidMoneyError.js';
import { InvalidPriceError } from '../../src/value-objects/InvalidPriceError.js';
import { InvalidQuantityError } from '../../src/value-objects/InvalidQuantityError.js';
import { InvalidBalanceError } from '../../src/value-objects/InvalidBalanceError.js';
import { ArithmeticOverflowError } from '../../src/value-objects/ArithmeticOverflowError.js';
import { DivisionByZeroError } from '../../src/value-objects/DivisionByZeroError.js';
import { InvalidOperandError } from '../../src/math/InvalidOperandError.js';

describe('errorUtils', () => {
  describe('toDecimal', () => {
    it('should parse valid decimal string', () => {
      const result = toDecimal(
        'price',
        '123.45',
        'INVALID_FORMAT' as any,
        InvalidPriceError
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toString()).toBe('123.45');
      }
    });

    it('should parse valid decimal number', () => {
      const result = toDecimal(
        'quantity',
        100,
        'INVALID_FORMAT' as any,
        InvalidQuantityError
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toString()).toBe('100');
      }
    });

    it('should accept existing Decimal', () => {
      const decimal = new Decimal('456.78');
      const result = toDecimal(
        'amount',
        decimal,
        'INVALID_FORMAT' as any,
        InvalidMoneyError
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toString()).toBe('456.78');
      }
    });

    it('should return Err for invalid string', () => {
      const result = toDecimal(
        'price',
        'invalid',
        'INVALID_FORMAT' as any,
        InvalidPriceError
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidPriceError);
        const raw = result.error.context?.raw as any;
        expect(raw?.field).toBe('price');
        expect(raw?.value).toBe('invalid');
      }
    });

    it('should accept NaN (Decimal.js behavior)', () => {
      // Note: Decimal.js accepts NaN and creates a NaN Decimal
      const result = toDecimal(
        'quantity',
        NaN,
        'INVALID_FORMAT' as any,
        InvalidQuantityError
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isNaN()).toBe(true);
      }
    });

    it('should accept Infinity (Decimal.js behavior)', () => {
      // Note: Decimal.js accepts Infinity and creates an Infinity Decimal
      const result = toDecimal(
        'price',
        Infinity,
        'INVALID_FORMAT' as any,
        InvalidPriceError
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isFinite()).toBe(false);
      }
    });

    it('should return Err for null (Decimal throws)', () => {
      const result = toDecimal(
        'quantity',
        null as any,
        'INVALID_FORMAT' as any,
        InvalidQuantityError
      );

      // Decimal(null) throws exception → catch block → Err
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidQuantityError);
        expect(result.error.message).toContain('Cannot read properties of null');
      }
    });

    it('should return Err for undefined (Decimal throws)', () => {
      const result = toDecimal(
        'price',
        undefined as any,
        'INVALID_FORMAT' as any,
        InvalidPriceError
      );

      // Decimal(undefined) throws exception → catch block → Err
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidPriceError);
        expect(result.error.message).toContain('Cannot read properties of undefined');
      }
    });
  });

  describe('rewrap', () => {
    it('should preserve message from original error', () => {
      const original = new InvalidPriceError('Original price error', {
        context: { price: '100' },
      });

      const rewrapped = rewrap(
        'PriceService',
        'validate',
        { orderId: 'order-1' },
        original,
        InvalidPriceError
      );

      expect(rewrapped.message).toBe('Original price error');
    });

    it('should preserve code from original error', () => {
      const original = new InvalidPriceError('Price error', {
        code: 'PRICE_TOO_HIGH',
        context: { price: '1000' },
      });

      const rewrapped = rewrap(
        'PriceService',
        'validate',
        {},
        original,
        InvalidPriceError
      );

      expect(rewrapped.code).toBe('PRICE_TOO_HIGH');
    });

    it('should preserve innerError from original error', () => {
      const innerErr = new Error('Inner validation error');
      const original = new InvalidPriceError('Price validation failed', {
        context: {},
      });
      // Simulate innerError set by constructor
      Object.defineProperty(original, 'innerError', {
        value: innerErr,
        writable: false,
        enumerable: true,
      });

      const rewrapped = rewrap(
        'PriceService',
        'validate',
        {},
        original,
        InvalidPriceError
      );

      expect(rewrapped.innerError).toBe(innerErr);
    });

    it('should add service and op to context', () => {
      const original = new InvalidPriceError('Price error', {
        context: { price: '100' },
      });

      const rewrapped = rewrap(
        'PriceService',
        'validate',
        {},
        original,
        InvalidPriceError
      );

      expect(rewrapped.context?.service).toBe('PriceService');
      expect(rewrapped.context?.op).toBe('validate');
    });

    it('should build opChain correctly', () => {
      const original = new InvalidPriceError('Price error', {
        context: {
          service: 'QuoteService',
          op: 'calculateSpread',
          price: '100',
        },
      });

      const rewrapped = rewrap(
        'PriceService',
        'validate',
        {},
        original,
        InvalidPriceError
      );

      expect(rewrapped.context?.opChain).toEqual([
        'QuoteService.calculateSpread',
        'PriceService.validate',
      ]);
    });

    it('should preserve root service (not overwrite)', () => {
      const original = new InvalidPriceError('Price error', {
        context: {
          service: 'QuoteService', // Root service
          op: 'calculate',
        },
      });

      const rewrapped = rewrap(
        'PriceService',
        'validate',
        {},
        original,
        InvalidPriceError
      );

      // Root service should remain QuoteService
      expect(rewrapped.context?.service).toBe('QuoteService');
      expect(rewrapped.context?.op).toBe('validate');
    });

    it('should merge context from rewrap call', () => {
      const original = new InvalidPriceError('Price error', {
        context: { price: '100' },
      });

      const rewrapped = rewrap(
        'PriceService',
        'validate',
        { orderId: 'order-1', userId: 'user-1' },
        original,
        InvalidPriceError
      );

      expect(rewrapped.context?.price).toBe('100');
      expect(rewrapped.context?.orderId).toBe('order-1');
      expect(rewrapped.context?.userId).toBe('user-1');
    });

    it('should preserve root fields (cause, reason, raw, source)', () => {
      const original = new InvalidPriceError('Price error', {
        context: {
          cause: 'negative_value',
          reason: 'INVALID_RANGE',
          raw: 'raw-data',
          source: 'external-api',
        },
      });

      const rewrapped = rewrap(
        'PriceService',
        'validate',
        {},
        original,
        InvalidPriceError
      );

      expect(rewrapped.context?.cause).toBe('negative_value');
      expect(rewrapped.context?.reason).toBe('INVALID_RANGE');
      expect(rewrapped.context?.raw).toBe('raw-data');
      expect(rewrapped.context?.source).toBe('external-api');
    });
  });

  describe('wrapOp', () => {
    it('should return Ok result unchanged', () => {
      const result = wrapOp(
        'PriceService',
        'validate',
        {},
        () => Ok(new Decimal('100')),
        InvalidPriceError
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toString()).toBe('100');
      }
    });

    it('should rewrap Err result from function', () => {
      const originalError = new InvalidPriceError('Invalid price', {
        context: { price: '100' },
      });

      const result = wrapOp(
        'PriceService',
        'validate',
        { orderId: 'order-1' },
        () => Err(originalError),
        InvalidPriceError
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidPriceError);
        expect(result.error.message).toBe('Invalid price');
        expect(result.error.context?.service).toBe('PriceService');
        expect(result.error.context?.op).toBe('validate');
        expect(result.error.context?.orderId).toBe('order-1');
      }
    });

    it('should catch and rewrap thrown TradingError (whitelist type)', () => {
      const result = wrapOp(
        'PriceService',
        'validate',
        { orderId: 'order-1' },
        () => {
          throw new InvalidPriceError('Thrown error', {
            context: { price: '-10' },
          });
        },
        InvalidPriceError
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidPriceError);
        expect(result.error.context?.service).toBe('PriceService');
        expect(result.error.context?.op).toBe('validate');
      }
    });

    it('should catch and rewrap thrown TradingError (NON-whitelist type)', () => {
      // InvalidBalanceError НЕ в whitelist DomainError, но является TradingError
      const result = wrapOp<Decimal, InvalidPriceError>(
        'PriceService',
        'validate',
        { orderId: 'order-1' },
        () => {
          throw new InvalidBalanceError('Balance error', {
            context: { balance: '0' },
          });
        },
        InvalidPriceError
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Должно быть rewrapped как InvalidPriceError (ErrorConstructor)
        expect(result.error).toBeInstanceOf(InvalidPriceError);
        expect(result.error.context?.service).toBe('PriceService');
        expect(result.error.context?.op).toBe('validate');
      }
    });

    it('should handle expected math errors', () => {
      const result = wrapOp(
        'PriceService',
        'multiply',
        {},
        () => {
          throw new ArithmeticOverflowError('Overflow', { context: {} });
        },
        InvalidPriceError
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidPriceError);
        expect(result.error.context?.service).toBe('PriceService');
        expect(result.error.context?.op).toBe('multiply');
      }
    });

    it('should handle unexpected errors', () => {
      const result = wrapOp(
        'PriceService',
        'validate',
        {},
        () => {
          throw new Error('Unexpected error');
        },
        InvalidPriceError
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidPriceError);
        expect(result.error.context?.service).toBe('PriceService');
        expect(result.error.context?.op).toBe('validate');
        // Should have cause from unexpected error
        expect(result.error.context?.cause).toBeDefined();
      }
    });

    it('should preserve code and innerError through rewrap', () => {
      const originalError = new InvalidPriceError('Price error', {
        code: 'PRICE_NEGATIVE',
        context: { price: '-10' },
      });

      const result = wrapOp(
        'PriceService',
        'validate',
        {},
        () => Err(originalError),
        InvalidPriceError
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PRICE_NEGATIVE');
      }
    });
  });

  describe('isExpectedMathError', () => {
    it('should return true for ArithmeticOverflowError', () => {
      const error = new ArithmeticOverflowError('Overflow', { context: {} });
      expect(isExpectedMathError(error)).toBe(true);
    });

    it('should return true for DivisionByZeroError', () => {
      const error = new DivisionByZeroError('Division by zero', {
        context: {},
      });
      expect(isExpectedMathError(error)).toBe(true);
    });

    it('should return true for InvalidOperandError', () => {
      const error = new InvalidOperandError('Invalid operand', { context: {} });
      expect(isExpectedMathError(error)).toBe(true);
    });

    it('should return false for InvalidPriceError', () => {
      const error = new InvalidPriceError('Invalid price', { context: {} });
      expect(isExpectedMathError(error)).toBe(false);
    });

    it('should return false for generic Error', () => {
      const error = new Error('Generic error');
      expect(isExpectedMathError(error)).toBe(false);
    });

    it('should return false for null', () => {
      expect(isExpectedMathError(null)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isExpectedMathError(undefined)).toBe(false);
    });

    it('should return false for string', () => {
      expect(isExpectedMathError('error')).toBe(false);
    });
  });

  describe('Integration: rewrap + wrapOp', () => {
    it('should build opChain across multiple services', () => {
      // Simulate QuoteService calling PriceService calling QuantityService
      const quantityError = new InvalidQuantityError('Invalid quantity', {
        context: {
          service: 'QuantityService',
          op: 'validate',
          quantity: '0',
        },
      });

      // PriceService rewraps
      const priceWrapped = rewrap(
        'PriceService',
        'calculateTotal',
        { price: '100' },
        quantityError,
        InvalidPriceError
      );

      // QuoteService rewraps
      const quoteResult = wrapOp(
        'QuoteService',
        'generate',
        { quoteId: 'quote-1' },
        () => Err(priceWrapped),
        InvalidPriceError
      );

      expect(quoteResult.ok).toBe(false);
      if (!quoteResult.ok) {
        expect(quoteResult.error.context?.service).toBe('QuantityService'); // Root service
        expect(quoteResult.error.context?.op).toBe('generate'); // Current op
        expect(quoteResult.error.context?.opChain).toEqual([
          'QuantityService.validate',
          'PriceService.calculateTotal',
          'QuoteService.generate',
        ]);
        expect(quoteResult.error.context?.quantity).toBe('0');
        expect(quoteResult.error.context?.price).toBe('100');
        expect(quoteResult.error.context?.quoteId).toBe('quote-1');
      }
    });
  });

  describe('isCoreInvariantViolation', () => {
    it('should return true for PriceInvariantViolation', () => {
      const error = new Error('Price must be positive');
      error.name = 'PriceInvariantViolation';
      (error as any).reason = 'NEGATIVE_VALUE';

      expect(isCoreInvariantViolation(error)).toBe(true);
    });

    it('should return true for QuantityInvariantViolation', () => {
      const error = new Error('Quantity must be non-negative');
      error.name = 'QuantityInvariantViolation';
      (error as any).reason = 'NEGATIVE_VALUE';

      expect(isCoreInvariantViolation(error)).toBe(true);
    });

    it('should return true for MoneyInvariantViolation', () => {
      const error = new Error('Money amount invalid');
      error.name = 'MoneyInvariantViolation';
      (error as any).reason = 'INVALID_AMOUNT';

      expect(isCoreInvariantViolation(error)).toBe(true);
    });

    it('should return true for BalanceInvariantViolation', () => {
      const error = new Error('Balance invariant violated');
      error.name = 'BalanceInvariantViolation';
      (error as any).reason = 'NEGATIVE_AVAILABLE';

      expect(isCoreInvariantViolation(error)).toBe(true);
    });

    it('should return true for TokenBalanceInvariantViolation', () => {
      const error = new Error('TokenBalance invariant violated');
      error.name = 'TokenBalanceInvariantViolation';
      (error as any).reason = 'INVALID_TOKEN';

      expect(isCoreInvariantViolation(error)).toBe(true);
    });

    it('should return true for SpreadInvariantViolation', () => {
      const error = new Error('Spread invariant violated');
      error.name = 'SpreadInvariantViolation';
      (error as any).reason = 'BID_EXCEEDS_ASK';

      expect(isCoreInvariantViolation(error)).toBe(true);
    });

    it('should return true for QuoteInvariantViolation', () => {
      const error = new Error('Quote invariant violated');
      error.name = 'QuoteInvariantViolation';
      (error as any).reason = 'INVALID_SPREAD';

      expect(isCoreInvariantViolation(error)).toBe(true);
    });

    it('should return true for RatioInvariantViolation', () => {
      const error = new Error('Ratio invariant violated');
      error.name = 'RatioInvariantViolation';
      (error as any).reason = 'NEGATIVE_VALUE';

      expect(isCoreInvariantViolation(error)).toBe(true);
    });

    it('should return false for unknown error type', () => {
      const error = new Error('Some error');
      error.name = 'UnknownError';
      (error as any).reason = 'SOME_REASON';

      expect(isCoreInvariantViolation(error)).toBe(false);
    });

    it('should return false for Error without reason property', () => {
      const error = new Error('Price must be positive');
      error.name = 'PriceInvariantViolation';
      // No reason property

      expect(isCoreInvariantViolation(error)).toBe(false);
    });

    it('should return false for non-Error objects', () => {
      expect(isCoreInvariantViolation('string')).toBe(false);
      expect(isCoreInvariantViolation(123)).toBe(false);
      expect(isCoreInvariantViolation(null)).toBe(false);
      expect(isCoreInvariantViolation(undefined)).toBe(false);
      expect(isCoreInvariantViolation({})).toBe(false);
    });
  });
});
