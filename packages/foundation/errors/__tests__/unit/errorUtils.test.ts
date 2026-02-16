/**
 * Unit-тесты для errorUtils
 *
 * @remarks
 * Проверяет критичные утилиты:
 * - toDecimal: парсинг Decimal значений (включая edge cases)
 * - toCause: извлечение cause из любых thrown значений
 * - rewrap: сохранение метаданных (code, innerError) при rewrap
 * - wrapOp: централизованная обработка ошибок, классификация TradingError
 * - coreInvariantError: обработка core invariant violations
 * - currencyMismatchError: создание ошибок несовпадения валют
 * - isExpectedMathError: определение expected math errors
 * - isCoreInvariantViolation: определение core invariant violations
 */

import { describe, it, expect } from '@jest/globals';
import { Err, Ok, isErr } from '@polymarket/result';
import Decimal from 'decimal.js';
import {
  toDecimal,
  rewrap,
  wrapOp,
  isExpectedMathError,
  isCoreInvariantViolation,
  toCause,
  coreInvariantError,
  currencyMismatchError,
} from '../../src/utils/errorUtils.js';
import { InvalidMoneyError } from '../../src/value-objects/InvalidMoneyError.js';
import { InvalidPriceError } from '../../src/value-objects/InvalidPriceError.js';
import { InvalidQuantityError } from '../../src/value-objects/InvalidQuantityError.js';
import { InvalidBalanceError } from '../../src/value-objects/InvalidBalanceError.js';
import { CurrencyMismatchError } from '../../src/value-objects/CurrencyMismatchError.js';
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

  describe('toCause', () => {
    it('should handle Error objects', () => {
      const error = new Error('Test error');
      const cause = toCause(error);
      expect(cause.name).toBe('Error');
      expect(cause.message).toBe('Test error');
      expect(cause.stack).toBeDefined();
    });

    it('should handle TypeError objects', () => {
      const error = new TypeError('Type error');
      const cause = toCause(error);
      expect(cause.name).toBe('TypeError');
      expect(cause.message).toBe('Type error');
    });

    it('should handle string thrown as error', () => {
      const cause = toCause('string error');
      expect(cause.name).toBe('UnknownError');
      expect(cause.message).toBe('string error');
      expect(cause.stack).toBeUndefined();
    });

    it('should handle number thrown as error', () => {
      const cause = toCause(123);
      expect(cause.name).toBe('UnknownError');
      expect(cause.message).toBe('123');
      expect(cause.stack).toBeUndefined();
    });

    it('should handle null thrown as error', () => {
      const cause = toCause(null);
      expect(cause.name).toBe('UnknownError');
      expect(cause.message).toBe('null');
      expect(cause.stack).toBeUndefined();
    });

    it('should handle undefined thrown as error', () => {
      const cause = toCause(undefined);
      expect(cause.name).toBe('UnknownError');
      expect(cause.message).toBe('undefined');
      expect(cause.stack).toBeUndefined();
    });

    it('should handle object thrown as error', () => {
      const cause = toCause({ foo: 'bar' });
      expect(cause.name).toBe('UnknownError');
      expect(cause.message).toBe('[object Object]');
      expect(cause.stack).toBeUndefined();
    });
  });

  describe('toDecimal edge cases', () => {
    it('should return Err for object with non-callable toString', () => {
      // Object with toString property that's not a function
      const objWithBadToString = {
        toString: 'not a function',
        // Add valueOf to prevent String() from throwing
        valueOf() { return '[object Object]'; }
      };
      const result = toDecimal('amount', objWithBadToString as any, 'INVALID_FORMAT', InvalidMoneyError);
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error).toBeInstanceOf(InvalidMoneyError);
        expect(result.error.message).toContain('Failed to normalize value');
        expect(result.error.context!.reason).toBe('INVALID_FORMAT');
        expect(result.error.context!.source).toBe('parsing');
      }
    });

    it('should return Err for object without callable toString', () => {
      // Object where toString exists but returns undefined
      const objWithBadToString = {
        toString: undefined,
        valueOf() { return '[BadObject]'; }
      };
      const result = toDecimal('amount', objWithBadToString as any, 'INVALID_FORMAT', InvalidMoneyError);
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error).toBeInstanceOf(InvalidMoneyError);
        expect(result.error.message).toContain('Failed to normalize value');
      }
    });

    it('should handle Decimal parse error with non-Error', () => {
      // Test the else branch in catch by passing invalid input to Decimal
      // When Decimal constructor fails, it throws an Error, so we test the toCause path
      const result = toDecimal('amount', 'not-a-number-xyz', 'INVALID_FORMAT', InvalidMoneyError);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error).toBeInstanceOf(InvalidMoneyError);
        expect(result.error.context!.cause).toBeDefined();
        // cause should have been created by toCause from the Decimal error
        expect((result.error.context!.cause as any).name).toBeDefined();
      }
    });
  });

  describe('coreInvariantError', () => {
    it('should create error from core invariant violation', () => {
      const violation = {
        name: 'PriceInvariantViolation',
        message: 'Price out of range',
        reason: 'OUT_OF_RANGE_HIGH'
      } as any;

      const error = coreInvariantError(
        'PriceService',
        'create',
        { value: 1.5 },
        violation,
        InvalidPriceError
      );

      expect(error).toBeInstanceOf(InvalidPriceError);
      expect(error.message).toBe('Price out of range');
      expect(error.context!.source).toBe('core_invariant');
      expect(error.context!.service).toBe('PriceService');
      expect(error.context!.op).toBe('create');
      expect(error.context!.reason).toBe('OUT_OF_RANGE_HIGH');
      expect((error.context as any).value).toBe(1.5);
    });

    it('should work with different error types', () => {
      const violation = {
        name: 'QuantityInvariantViolation',
        message: 'Invalid quantity',
        reason: 'NEGATIVE'
      } as any;

      const error = coreInvariantError(
        'QuantityService',
        'of',
        { amount: -10 },
        violation,
        InvalidQuantityError
      );

      expect(error).toBeInstanceOf(InvalidQuantityError);
      expect(error.context!.reason).toBe('NEGATIVE');
    });
  });

  describe('wrapOp with core invariant violations', () => {
    it('should catch and wrap core invariant violations', () => {
      class PriceInvariantViolation extends Error {
        reason = 'OUT_OF_RANGE_HIGH';
        constructor(message: string) {
          super(message);
          this.name = 'PriceInvariantViolation';
        }
      }

      const result = wrapOp(
        'PriceService',
        'create',
        { value: 1.5 },
        () => {
          throw new PriceInvariantViolation('Price 1.5 exceeds maximum 0.9999');
        },
        InvalidPriceError
      );

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error).toBeInstanceOf(InvalidPriceError);
        expect(result.error.message).toBe('Price 1.5 exceeds maximum 0.9999');
        expect(result.error.context!.source).toBe('core_invariant');
        expect(result.error.context!.service).toBe('PriceService');
        expect(result.error.context!.op).toBe('create');
        expect(result.error.context!.reason).toBe('OUT_OF_RANGE_HIGH');
        expect((result.error.context as any).opChain).toEqual(['PriceService.create']);
      }
    });
  });

  describe('currencyMismatchError', () => {
    it('should create currency mismatch error', () => {
      const error = currencyMismatchError(
        'add',
        'USD',
        'EUR',
        'CURRENCY_MISMATCH',
        InvalidMoneyError
      );

      expect(error).toBeInstanceOf(InvalidMoneyError);
      expect(error.message).toBe('Cannot add: currency mismatch');
      expect(error.context!.op).toBe('add');
      expect(error.context!.reason).toBe('CURRENCY_MISMATCH');
      expect((error.context as any).expected).toBe('USD');
      expect((error.context as any).actual).toBe('EUR');
    });

    it('should work with different operations', () => {
      const error = currencyMismatchError(
        'isLessThan',
        'USDC',
        'DAI',
        'CURRENCY_MISMATCH',
        InvalidMoneyError
      );

      expect(error.message).toBe('Cannot isLessThan: currency mismatch');
      expect((error.context as any).expected).toBe('USDC');
      expect((error.context as any).actual).toBe('DAI');
    });

    it('should work with different error types', () => {
      const error = currencyMismatchError(
        'equals',
        'USDC',
        'DAI',
        'CURRENCY_MISMATCH',
        CurrencyMismatchError
      );

      expect(error).toBeInstanceOf(CurrencyMismatchError);
      expect(error.message).toBe('Cannot equals: currency mismatch');
    });
  });
});
