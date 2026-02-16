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
  expectedMathError,
  unexpectedError,
  developerMisuseError,
  currencyMismatchError,
} from '../../src/utils/errorUtils.js';
import { ErrorSource } from '../../src/ErrorSource.js';
import { TradingError } from '../../src/base/TradingError.js';
import { InvalidMoneyError } from '../../src/value-objects/InvalidMoneyError.js';
import { InvalidPriceError } from '../../src/value-objects/InvalidPriceError.js';
import { InvalidQuantityError } from '../../src/value-objects/InvalidQuantityError.js';
import { InvalidBalanceError } from '../../src/value-objects/InvalidBalanceError.js';
import { CurrencyMismatchError } from '../../src/value-objects/CurrencyMismatchError.js';
import { ArithmeticOverflowError } from '../../src/value-objects/ArithmeticOverflowError.js';
import { DivisionByZeroError } from '../../src/value-objects/DivisionByZeroError.js';
import { InvalidOperandError } from '../../src/math/InvalidOperandError.js';
import { InvalidRoundingModeError } from '../../src/math/InvalidRoundingModeError.js';

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

    it('should reject NaN (validation)', () => {
      // toDecimal теперь проверяет isFinite и отвергает NaN
      const result = toDecimal(
        'quantity',
        NaN,
        'INVALID_FORMAT' as any,
        InvalidQuantityError
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context!.source).toBe('parsing');
        expect(result.error.message).toContain('finite');
      }
    });

    it('should reject Infinity (validation)', () => {
      // toDecimal теперь проверяет isFinite и отвергает Infinity
      const result = toDecimal(
        'price',
        Infinity,
        'INVALID_FORMAT' as any,
        InvalidPriceError
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context!.source).toBe('parsing');
        expect(result.error.message).toContain('finite');
      }
    });

    it('should return Err for null (Decimal throws)', () => {
      const result = toDecimal(
        'quantity',
        null as any,
        'INVALID_FORMAT' as any,
        InvalidQuantityError
      );

      // toString() on null throws TypeError → catch block → Err
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidQuantityError);
        expect(result.error.message.length).toBeGreaterThan(0);
        expect(result.error.message).toMatch(/null|undefined|read|property/i);
      }
    });

    it('should return Err for undefined (toString throws)', () => {
      const result = toDecimal(
        'price',
        undefined as any,
        'INVALID_FORMAT' as any,
        InvalidPriceError
      );

      // toString() on undefined throws TypeError → catch block → Err
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidPriceError);
        expect(result.error.message.length).toBeGreaterThan(0);
        expect(result.error.message).toMatch(/null|undefined|read|property/i);
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

    it('сохраняет origin-данные первой ошибки (timestamp, stack, name, code)', () => {
      const original = new InvalidPriceError('Original error', {
        code: 'ORIGINAL_CODE',
        context: { value: -1 },
      });

      // Сохраняем оригинальные значения до rewrap
      const originalTimestamp = original.timestamp.toISOString();
      const firstTradingErrorStack = original.stack;
      const originalName = original.name;
      const originalCode = original.code;

      // Первый rewrap
      const rewrapped1 = rewrap(
        'PriceService',
        'create',
        {},
        original,
        InvalidPriceError
      );

      // Проверяем что origin-данные сохранены в context
      expect(rewrapped1.context?.firstTradingErrorTimestamp).toBe(originalTimestamp);
      expect(rewrapped1.context?.firstTradingErrorStack).toBe(firstTradingErrorStack);
      expect(rewrapped1.context?.originalName).toBe(originalName);
      expect(rewrapped1.context?.originalCode).toBe(originalCode);

      // Сама ошибка имеет свой timestamp и stack (могут быть одинаковые если быстро)
      expect(rewrapped1.timestamp).toBeInstanceOf(Date);
      expect(rewrapped1.stack).toBeDefined();
      // firstTradingErrorTimestamp в ISO формате, не Date объект
      expect(typeof rewrapped1.context?.firstTradingErrorTimestamp).toBe('string');

      // Второй rewrap (вложенный)
      const rewrapped2 = rewrap(
        'OrderService',
        'validate',
        {},
        rewrapped1,
        InvalidPriceError
      );

      // Origin-данные должны остаться от ПЕРВОЙ ошибки (не перезаписаны)
      expect(rewrapped2.context?.firstTradingErrorTimestamp).toBe(originalTimestamp);
      expect(rewrapped2.context?.firstTradingErrorStack).toBe(firstTradingErrorStack);
      expect(rewrapped2.context?.originalName).toBe(originalName);
      expect(rewrapped2.context?.originalCode).toBe(originalCode);

      // firstTradingErrorTimestamp - это сохраненная ISO строка от первой ошибки
      expect(rewrapped2.context?.firstTradingErrorTimestamp).toBe(originalTimestamp);
      // firstTradingErrorStack - это сохраненный stack от первой ошибки
      expect(rewrapped2.context?.firstTradingErrorStack).toBe(firstTradingErrorStack);
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

    it('should catch and convert foreign TradingError to expected type (strict contract)', () => {
      // InvalidBalanceError является DomainError, но ErrorConstructor ожидает InvalidPriceError
      // Тест проверяет что wrapOp конвертирует в TError, сохраняя оригинальные данные
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
        // Должен конвертировать в InvalidPriceError (strict контракт)
        expect(result.error).toBeInstanceOf(InvalidPriceError);
        expect(result.error).not.toBeInstanceOf(InvalidBalanceError);

        // Оригинальные данные сохранены в context
        expect((result.error.context as any).originalErrorName).toBe('InvalidBalanceError');
        expect((result.error.context as any).originalErrorContext).toEqual({ balance: '0' });

        // Трассировка добавлена
        expect(result.error.context?.service).toBe('PriceService');
        expect(result.error.context?.op).toBe('validate');
        expect((result.error.context as any).orderId).toBe('order-1');
      }
    });

    it('should classify ArithmeticOverflowError as foreign TradingError expected math error', () => {
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
        expect(result.error.context?.source).toBe('math_operation');
      }
    });

    it('классифицирует foreign TradingError из whitelist как math_operation', () => {
      // InvalidOperandError является expected math error из whitelist
      // Бросаем его в функции которая ожидает InvalidPriceError
      // Должен быть классифицирован как math_operation, а не unexpected
      const result = wrapOp(
        'PriceService',
        'divide',
        { dividend: '10', divisor: 'NaN' },
        () => {
          throw new InvalidOperandError(
            (ctx) => `Operand must be finite, got ${ctx.operand}`,
            {
              code: 'INVALID_OPERAND',
              context: { operand: 'NaN', operation: 'divide' },
            }
          );
        },
        InvalidPriceError
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Конвертирован в ожидаемый тип
        expect(result.error).toBeInstanceOf(InvalidPriceError);
        expect(result.error).not.toBeInstanceOf(InvalidOperandError);

        // Классифицирован как math_operation, не unexpected
        expect(result.error.context?.source).toBe('math_operation');

        // Код и контекст сохранены
        expect(result.error.code).toBe('INVALID_OPERAND');
        expect(result.error.context?.operand).toBe('NaN');
        expect(result.error.context?.operation).toBe('divide');

        // Трассировка добавлена
        expect(result.error.context?.service).toBe('PriceService');
        expect(result.error.context?.op).toBe('divide');
        expect(result.error.context?.dividend).toBe('10');
        expect(result.error.context?.divisor).toBe('NaN');
      }
    });

    it('классифицирует NON-TradingError с name из whitelist как math_operation', () => {
      // Тест для непокрытой ветки: строки 735-738 в errorUtils.ts
      // Создаем обычный Error (не TradingError), но с name из expected math whitelist
      const result = wrapOp(
        'PriceService',
        'divide',
        { dividend: '10', divisor: '0' },
        () => {
          // Симулируем legacy код или external библиотеку, которая бросает Error по name
          const error = new Error('Division by zero detected');
          error.name = 'DivisionByZeroError'; // Whitelist name
          throw error;
        },
        InvalidPriceError
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Конвертирован в ожидаемый тип
        expect(result.error).toBeInstanceOf(InvalidPriceError);

        // Классифицирован как math_operation (не unexpected!)
        expect(result.error.context?.source).toBe('math_operation');

        // Оригинальная ошибка сохранена в cause
        expect(result.error.context?.cause).toBeDefined();
        const cause = result.error.context?.cause as any;
        expect(cause.message).toBe('Division by zero detected');
        expect(cause.name).toBe('DivisionByZeroError');

        // Трассировка добавлена
        expect(result.error.context?.service).toBe('PriceService');
        expect(result.error.context?.op).toBe('divide');
        expect(result.error.context?.dividend).toBe('10');
        expect(result.error.context?.divisor).toBe('0');
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
        expect(result.error.context?.source).toBe('unexpected');
      }
    });

    it('различает TypeError (developer misuse) от обычных unexpected', () => {
      const result = wrapOp(
        'PriceService',
        'calculate',
        {},
        () => {
          // TypeError indicates developer misuse (wrong API usage)
          throw new TypeError('Cannot read property "value" of undefined');
        },
        InvalidPriceError
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidPriceError);
        expect(result.error.message).toContain('Developer misuse');
        expect(result.error.context?.service).toBe('PriceService');
        expect(result.error.context?.op).toBe('calculate');
        expect(result.error.context?.source).toBe('developer_misuse');
        expect(result.error.context?.reason).toBe('MISUSE');
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

    it('should return true for InvalidRoundingModeError', () => {
      const error = new InvalidRoundingModeError('Invalid rounding mode', {
        code: InvalidRoundingModeError.code,
        context: { roundingMode: 9 },
      });
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

    it('возвращает true для ошибок с kind=INVARIANT_VIOLATION (стабильный маркер)', () => {
      const error = new Error('Invariant violated');
      (error as any).kind = 'INVARIANT_VIOLATION';
      (error as any).reason = 'CUSTOM_VIOLATION';
      // name может быть любым - kind имеет приоритет
      error.name = 'CustomInvariantViolation';

      expect(isCoreInvariantViolation(error)).toBe(true);
    });

    it('kind маркер имеет приоритет над name whitelist', () => {
      const error = new Error('Invariant violated');
      (error as any).kind = 'INVARIANT_VIOLATION';
      (error as any).reason = 'TEST_REASON';
      // Даже с неизвестным name - распознается по kind
      error.name = 'SomeUnknownInvariantViolation';

      expect(isCoreInvariantViolation(error)).toBe(true);
    });

    it('fallback на name whitelist если kind отсутствует', () => {
      const error = new Error('Price must be positive');
      error.name = 'PriceInvariantViolation';
      (error as any).reason = 'NEGATIVE_VALUE';
      // kind НЕ установлен - используется fallback по name

      expect(isCoreInvariantViolation(error)).toBe(true);
    });
  });

  describe('toCause', () => {
    it('обрабатывает Error объекты', () => {
      const error = new Error('Test error');
      const cause = toCause(error);
      expect(cause.name).toBe('Error');
      expect(cause.message).toBe('Test error');
      expect(cause.stack).toBeDefined();
    });

    it('обрабатывает TypeError объекты', () => {
      const error = new TypeError('Type error');
      const cause = toCause(error);
      expect(cause.name).toBe('TypeError');
      expect(cause.message).toBe('Type error');
    });

    it('обрабатывает string брошенный как ошибка', () => {
      const cause = toCause('string error');
      expect(cause.name).toBe('UnknownError');
      expect(cause.message).toBe('string error');
      expect(cause.stack).toBeUndefined();
    });

    it('обрабатывает number брошенный как ошибка', () => {
      const cause = toCause(123);
      expect(cause.name).toBe('UnknownError');
      expect(cause.message).toBe('123');
      expect(cause.stack).toBeUndefined();
    });

    it('обрабатывает null брошенный как ошибка', () => {
      const cause = toCause(null);
      expect(cause.name).toBe('UnknownError');
      expect(cause.message).toBe('null');
      expect(cause.stack).toBeUndefined();
    });

    it('обрабатывает undefined брошенный как ошибка', () => {
      const cause = toCause(undefined);
      expect(cause.name).toBe('UnknownError');
      expect(cause.message).toBe('undefined');
      expect(cause.stack).toBeUndefined();
    });

    it('обрабатывает object брошенный как ошибка', () => {
      const cause = toCause({ foo: 'bar' });
      expect(cause.name).toBe('UnknownError');
      expect(cause.message).toBe('[object Object]');
      expect(cause.stack).toBeUndefined();
    });
  });

  describe('toDecimal edge cases', () => {
    it('возвращает Err для объекта с non-callable toString', () => {
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

    it('возвращает Err для объекта без callable toString', () => {
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

    it('обрабатывает ошибку парсинга Decimal', () => {
      // Decimal constructor throws Error on invalid input
      const result = toDecimal('amount', 'not-a-number-xyz', 'INVALID_FORMAT', InvalidMoneyError);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error).toBeInstanceOf(InvalidMoneyError);
        expect(result.error.context!.cause).toBeDefined();
        // cause should have been created by toCause from the Decimal error
        expect((result.error.context!.cause as any).name).toBeDefined();
        // Message from the Decimal Error (not the fallback 'Failed to parse value')
        expect(result.error.message).not.toBe('Failed to parse value');
      }
    });

    it('обрабатывает злой объект с throwing toString() без throw', () => {
      // Создаем "злой" объект который бросает исключение при вызове toString()
      const evilObject = {
        toString() {
          throw new Error('Evil toString!');
        }
      };

      // toDecimal должен вернуть Err, а не выбросить исключение
      const result = toDecimal('amount', evilObject as any, 'INVALID_FORMAT', InvalidMoneyError);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error).toBeInstanceOf(InvalidMoneyError);
        expect(result.error.message).toBe('Evil toString!');
        expect(result.error.context!.source).toBe('parsing');
        expect(result.error.context!.cause).toBeDefined();
        expect((result.error.context!.cause as any).message).toBe('Evil toString!');
      }
    });

    it('обрабатывает объект без toString() без throw', () => {
      // Объект без метода toString
      const noToStringObject = Object.create(null);

      const result = toDecimal('amount', noToStringObject, 'INVALID_FORMAT', InvalidMoneyError);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error).toBeInstanceOf(InvalidMoneyError);
        expect(result.error.message).toContain('no valid toString()');
        expect(result.error.context!.source).toBe('parsing');
      }
    });

    it('обрабатывает toString(), который бросает non-Error (строку)', () => {
      // Defensive programming: toString() бросает строку вместо Error
      const evilObjectThrowsString = {
        toString() {
          throw 'Evil string thrown from toString!'; // Бросаем строку, не Error
        }
      };

      const result = toDecimal('amount', evilObjectThrowsString as any, 'INVALID_FORMAT', InvalidMoneyError);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error).toBeInstanceOf(InvalidMoneyError);
        // Fallback message для non-Error
        expect(result.error.message).toBe('toString() threw exception');
        expect(result.error.context!.source).toBe('parsing');
        expect(result.error.context!.cause).toBeDefined();
      }
    });
  });

  describe('coreInvariantError', () => {
    it('создаёт ошибку из core invariant violation БЕЗ service/op', () => {
      const violation = {
        name: 'PriceInvariantViolation',
        message: 'Price out of range',
        reason: 'OUT_OF_RANGE_HIGH'
      } as any;

      // Фабрика больше НЕ принимает service/op/ctx
      const error = coreInvariantError(violation, InvalidPriceError);

      expect(error).toBeInstanceOf(InvalidPriceError);
      expect(error.message).toBe('Price out of range');
      expect(error.context!.source).toBe('core_invariant');
      expect(error.context!.reason).toBe('OUT_OF_RANGE_HIGH');

      // service/op НЕ добавлены фабрикой (будут добавлены через rewrap)
      expect(error.context!.service).toBeUndefined();
      expect(error.context!.op).toBeUndefined();
    });

    it('работает с разными типами ошибок', () => {
      const violation = {
        name: 'QuantityInvariantViolation',
        message: 'Invalid quantity',
        reason: 'NEGATIVE'
      } as any;

      const error = coreInvariantError(violation, InvalidQuantityError);

      expect(error).toBeInstanceOf(InvalidQuantityError);
      expect(error.context!.reason).toBe('NEGATIVE');
      expect(error.context!.source).toBe('core_invariant');
      // service/op НЕ добавлены
      expect(error.context!.service).toBeUndefined();
    });
  });

  describe('expectedMathError', () => {
    it('создаёт ошибку для math operation с правильным source', () => {
      const mathError = new Error('Arithmetic overflow');
      const error = expectedMathError(mathError, InvalidPriceError);

      expect(error).toBeInstanceOf(InvalidPriceError);
      expect(error.message).toBe('Math operation failed: Arithmetic overflow');
      expect(error.context!.source).toBe('math_operation');
      expect(error.context!.cause).toBeDefined();
      expect((error.context!.cause as any).message).toBe('Arithmetic overflow');
    });

    it('сохраняет code и context при преобразовании TradingError', () => {
      const tradingError = new InvalidQuantityError(
        (ctx) => `Invalid quantity: ${ctx.value}`,
        {
          code: 'INVALID_QUANTITY',
          context: { value: -5, min: 0, operation: 'divide' },
        }
      );

      const error = expectedMathError(tradingError, InvalidPriceError);

      expect(error).toBeInstanceOf(InvalidPriceError);
      expect(error.message).toContain('Math operation failed');
      expect(error.code).toBe('INVALID_QUANTITY');
      expect(error.context!.source).toBe('math_operation');
      expect(error.context!.originalCode).toBe('INVALID_QUANTITY');
      expect(error.context!.value).toBe(-5);
      expect(error.context!.min).toBe(0);
      expect(error.context!.operation).toBe('divide');
      expect(error.context!.cause).toBeDefined();
    });

    it('работает с TradingError без code', () => {
      const tradingError = new TradingError('Generic error', {
        context: { field: 'price', userId: 123 },
      });

      const error = expectedMathError(tradingError, InvalidMoneyError);

      expect(error).toBeInstanceOf(InvalidMoneyError);
      expect(error.code).toBeUndefined();
      expect(error.context!.source).toBe('math_operation');
      expect(error.context!.field).toBe('price');
      expect(error.context!.userId).toBe(123);
    });
  });

  describe('unexpectedError', () => {
    it('создаёт ошибку для unexpected exception с правильным source', () => {
      const unexpectedErr = new Error('Network timeout');
      const error = unexpectedError(unexpectedErr, InvalidMoneyError);

      expect(error).toBeInstanceOf(InvalidMoneyError);
      expect(error.message).toBe('Unexpected error: Network timeout');
      expect(error.context!.source).toBe('unexpected');
      expect(error.context!.cause).toBeDefined();
      expect((error.context!.cause as any).message).toBe('Network timeout');
    });

    it('обрабатывает non-Error exceptions', () => {
      const error = unexpectedError('string error' as any, InvalidPriceError);

      expect(error).toBeInstanceOf(InvalidPriceError);
      expect(error.message).toBe('Unexpected error: string error');
      expect(error.context!.source).toBe('unexpected');
      expect(error.context!.cause).toBeDefined();
    });
  });

  describe('developerMisuseError', () => {
    it('создаёт ошибку для developer mistake с правильным source', () => {
      const typeError = new TypeError('Cannot read property of null');
      const error = developerMisuseError(typeError, InvalidQuantityError);

      expect(error).toBeInstanceOf(InvalidQuantityError);
      expect(error.message).toBe('Developer misuse: Cannot read property of null');
      expect(error.context!.source).toBe('developer_misuse');
      expect(error.context!.reason).toBe('MISUSE');
      expect(error.context!.cause).toBeDefined();
    });
  });

  describe('wrapOp with core invariant violations', () => {
    it('ловит и оборачивает core invariant violations', () => {
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

    it('сохраняет исходный cause и stack из core invariant violation', () => {
      class PriceInvariantViolation extends Error {
        reason = 'OUT_OF_RANGE_HIGH';
        kind = 'INVARIANT_VIOLATION' as const;
        constructor(message: string) {
          super(message);
          this.name = 'PriceInvariantViolation';
          // Симулируем реальный stack trace
          Error.captureStackTrace(this, PriceInvariantViolation);
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
        // Проверяем что cause сохранён
        expect(result.error.context!.cause).toBeDefined();
        expect((result.error.context!.cause as any).name).toBe('PriceInvariantViolation');
        expect((result.error.context!.cause as any).message).toBe('Price 1.5 exceeds maximum 0.9999');
        // Проверяем что stack trace сохранён
        expect((result.error.context!.cause as any).stack).toBeDefined();
        expect((result.error.context!.cause as any).stack).toContain('PriceInvariantViolation');
        // Проверяем что reason тоже сохранён
        expect(result.error.context!.reason).toBe('OUT_OF_RANGE_HIGH');
      }
    });
  });

  describe('currencyMismatchError', () => {
    it('создаёт ошибку несовпадения валют с source', () => {
      const error = currencyMismatchError(
        'USD',
        'EUR',
        'CURRENCY_MISMATCH',
        InvalidMoneyError
      );

      expect(error).toBeInstanceOf(InvalidMoneyError);
      expect(error.message).toBe('Currency mismatch: expected USD, got EUR');
      expect(error.context!.source).toBe('rule_validation');
      expect(error.context!.reason).toBe('CURRENCY_MISMATCH');
      expect((error.context as any).expected).toBe('USD');
      expect((error.context as any).actual).toBe('EUR');
      // op НЕ добавлен фабрикой (должен добавить caller если нужно)
      expect(error.context!.op).toBeUndefined();
    });

    it('работает с разными валютами', () => {
      const error = currencyMismatchError(
        'USDC',
        'DAI',
        'CURRENCY_MISMATCH',
        InvalidMoneyError
      );

      expect(error.message).toBe('Currency mismatch: expected USDC, got DAI');
      expect((error.context as any).expected).toBe('USDC');
      expect((error.context as any).actual).toBe('DAI');
      expect(error.context!.source).toBe('rule_validation');
    });

    it('работает с разными типами ошибок', () => {
      const error = currencyMismatchError(
        'USDC',
        'DAI',
        'CURRENCY_MISMATCH',
        CurrencyMismatchError
      );

      expect(error).toBeInstanceOf(CurrencyMismatchError);
      expect(error.message).toBe('Currency mismatch: expected USDC, got DAI');
      expect(error.context!.source).toBe('rule_validation');
    });
  });

  describe('wrapOp с "чужим" TradingError (strict контракт)', () => {
    it('конвертирует чужой TradingError в TError, сохраняя оригинальные данные', () => {
      // MoneyService бросил InvalidMoneyError
      const originalError = new InvalidMoneyError('Amount must be positive', {
        code: 'NEGATIVE_AMOUNT',
        context: {
          source: ErrorSource.PARSING,
          reason: 'NEGATIVE_VALUE',
          value: -100
        }
      });

      // PriceService ловит эту ошибку в wrapOp с ErrorConstructor=InvalidPriceError
      const result = wrapOp(
        'PriceService',
        'calculateTotal',
        { price: 1.5, quantity: 10 },
        () => {
          throw originalError;
        },
        InvalidPriceError
      );

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        // ВАЖНО: тип должен конвертироваться в InvalidPriceError (strict контракт)
        expect(result.error).toBeInstanceOf(InvalidPriceError);
        expect(result.error).not.toBeInstanceOf(InvalidMoneyError);

        // Оригинальные данные сохранены в context
        expect((result.error.context as any).originalErrorName).toBe('InvalidMoneyError');
        expect((result.error.context as any).originalErrorCode).toBe('NEGATIVE_AMOUNT');
        expect((result.error.context as any).originalErrorContext).toEqual({
          source: ErrorSource.PARSING,
          reason: 'NEGATIVE_VALUE',
          value: -100
        });

        // Трассировка добавлена
        expect(result.error.context!.service).toBe('PriceService');
        expect(result.error.context!.op).toBe('calculateTotal');
        expect((result.error.context as any).price).toBe(1.5);
        expect((result.error.context as any).quantity).toBe(10);
      }
    });

    it('конвертирует чужой TradingError с полным контекстом', () => {
      // Создаем ошибку с полным контекстом
      const moneyError = new InvalidMoneyError('Invalid amount', {
        code: 'INVALID_FORMAT',
        context: {
          source: ErrorSource.PARSING,
          reason: 'INVALID_FORMAT',
          raw: { field: 'amount', value: 'abc' },
          cause: {
            name: 'TypeError',
            message: 'Cannot convert abc to number'
          }
        }
      });

      // QuantityService оборачивает эту ошибку
      const quantityResult = wrapOp(
        'QuantityService',
        'create',
        { asset: 'USDC' },
        () => {
          throw moneyError;
        },
        InvalidQuantityError
      );

      expect(isErr(quantityResult)).toBe(true);
      if (isErr(quantityResult)) {
        // Тип конвертирован в InvalidQuantityError
        expect(quantityResult.error).toBeInstanceOf(InvalidQuantityError);
        expect(quantityResult.error).not.toBeInstanceOf(InvalidMoneyError);

        // Оригинальные данные сохранены
        expect((quantityResult.error.context as any).originalErrorName).toBe('InvalidMoneyError');
        expect((quantityResult.error.context as any).originalErrorCode).toBe('INVALID_FORMAT');
        expect((quantityResult.error.context as any).originalErrorContext).toEqual({
          source: ErrorSource.PARSING,
          reason: 'INVALID_FORMAT',
          raw: { field: 'amount', value: 'abc' },
          cause: {
            name: 'TypeError',
            message: 'Cannot convert abc to number'
          }
        });

        // Трассировка добавлена
        expect(quantityResult.error.context!.service).toBe('QuantityService');
        expect(quantityResult.error.context!.op).toBe('create');
        expect((quantityResult.error.context as any).asset).toBe('USDC');
      }
    });

    it('rewrap для того же типа TradingError (не конвертирует)', () => {
      // Создаем InvalidPriceError, который будет обработан wrapOp<InvalidPriceError>
      const error1 = new InvalidPriceError('Price too low', {
        code: 'PRICE_TOO_LOW',
        context: {
          service: 'PriceService',
          op: 'validate',
          source: ErrorSource.RULE_VALIDATION,
          price: '0.001'
        }
      });

      // Повторный wrapOp с тем же ErrorConstructor
      const result = wrapOp(
        'OrderService',
        'create',
        { orderId: 'order-123' },
        () => {
          throw error1;
        },
        InvalidPriceError
      );

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        // Тип должен остаться InvalidPriceError (instanceof ErrorConstructor)
        expect(result.error).toBeInstanceOf(InvalidPriceError);

        // Оригинальный код сохранен
        expect(result.error.code).toBe('PRICE_TOO_LOW');

        // service остался PriceService (первоначальный)
        expect(result.error.context!.service).toBe('PriceService');
        expect(result.error.context!.op).toBe('create');
        expect((result.error.context as any).opChain).toContain('PriceService.validate');
        expect((result.error.context as any).opChain).toContain('OrderService.create');

        // Новый контекст добавлен
        expect((result.error.context as any).orderId).toBe('order-123');

        // НЕТ originalError* полей (same-type rewrap)
        expect((result.error.context as any).originalErrorName).toBeUndefined();
        expect((result.error.context as any).originalErrorCode).toBeUndefined();
      }
    });

    it('конвертирует foreign TradingError возвращенный из fn (не thrown)', () => {
      // Edge case: fn возвращает Err с чужой TradingError, не бросает её
      const foreignError = new InvalidMoneyError('Wrong currency', {
        code: 'WRONG_CURRENCY',
        context: {
          source: ErrorSource.RULE_VALIDATION,
          currency: 'EUR'
        }
      });

      const result = wrapOp(
        'PriceService',
        'validate',
        { expectedCurrency: 'USD' },
        () => {
          // fn возвращает Err напрямую (не throw)
          return Err(foreignError);
        },
        InvalidPriceError
      );

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        // Должен rewrap ошибку (добавить tracing)
        expect(result.error).toBeInstanceOf(InvalidPriceError);
        expect(result.error.message).toBe('Wrong currency');
        expect(result.error.code).toBe('WRONG_CURRENCY');

        // Tracing добавлен
        expect(result.error.context!.service).toBe('PriceService');
        expect(result.error.context!.op).toBe('validate');
        expect((result.error.context as any).expectedCurrency).toBe('USD');

        // Оригинальные данные сохранены
        expect(result.error.context!.source).toBe('rule_validation');
        expect((result.error.context as any).currency).toBe('EUR');
      }
    });
  });

  describe('rewrap edge cases', () => {
    it('обрабатывает ошибку с undefined context', () => {
      const error = new InvalidPriceError('Test error');
      // Явно устанавливаем context в undefined через any cast
      (error as any).context = undefined;

      const rewrapped = rewrap('PriceService', 'validate', { value: 1.5 }, error, InvalidPriceError);

      expect(rewrapped.context).toBeDefined();
      expect(rewrapped.context!.service).toBe('PriceService');
      expect(rewrapped.context!.op).toBe('validate');
      expect((rewrapped.context as any).value).toBe(1.5);
    });

    it('не дублирует opChain когда lastOp === fullOp', () => {
      const error1 = new InvalidPriceError('Error 1', {
        context: {
          service: 'PriceService',
          op: 'create',
          opChain: ['PriceService.create']
        }
      });

      // Повторный rewrap с теми же service/op
      const error2 = rewrap('PriceService', 'create', {}, error1, InvalidPriceError);

      expect((error2.context as any).opChain).toEqual(['PriceService.create']);
      // НЕ должно быть ['PriceService.create', 'PriceService.create']
    });

    it('защищает trace-поля от подмены через ctx (anti-spoof)', () => {
      // Попытка подменить trace-поля через ctx
      const error = new InvalidPriceError('Original error', {
        code: InvalidPriceError.code,
        context: {
          value: 100
        }
      });

      // Устанавливаем timestamp на ошибке для trace
      (error as any).timestamp = new Date('2024-01-01T10:00:00Z');

      // Пытаемся подменить trace-поля через ctx
      const maliciousCtx = {
        orderId: 'order-123',
        firstTradingErrorTimestamp: '2025-12-31T23:59:59Z', // Попытка спуфинга
        firstTradingErrorStack: 'Fake stack trace',         // Попытка спуфинга
        originalName: 'FakeError',                           // Попытка спуфинга
        originalCode: 'FAKE_CODE'                            // Попытка спуфинга
      };

      const rewrapped = rewrap('PriceService', 'validate', maliciousCtx, error, InvalidPriceError);

      // Trace-поля должны быть установлены из error, НЕ из ctx
      expect(rewrapped.context!.firstTradingErrorTimestamp).toBe('2024-01-01T10:00:00.000Z');
      expect(rewrapped.context!.firstTradingErrorStack).toBeDefined();
      expect(rewrapped.context!.firstTradingErrorStack).not.toBe('Fake stack trace');
      expect(rewrapped.context!.originalName).toBe('InvalidPriceError');
      expect(rewrapped.context!.originalName).not.toBe('FakeError');
      expect(rewrapped.context!.originalCode).toBeDefined();
      expect(rewrapped.context!.originalCode).not.toBe('FAKE_CODE');

      // Но обычные поля из ctx должны пройти
      expect((rewrapped.context as any).orderId).toBe('order-123');
    });

    it('защищает originalError* поля от подмены через ctx (anti-spoof)', () => {
      // Создаём ошибку с оригинальными данными (используем InvalidMoneyError как foreign error)
      const originalError = new InvalidMoneyError('Invalid currency', {
        code: InvalidMoneyError.code,
        context: { currency: 'INVALID', amount: 100 }
      });

      // wrapOp устанавливает originalError* только при foreign TradingError
      // Эмулируем это поведение:
      const internalCtx = {
        originalErrorName: 'InvalidMoneyError',
        originalErrorCode: 'INVALID_MONEY',
        originalErrorContext: { currency: 'INVALID', amount: 100 }
      };

      // Создаём unexpectedError для rewrap
      const wrapped = rewrap('PriceService', 'validate', internalCtx, originalError, InvalidPriceError);

      // Проверяем что поля установлены из internalCtx (через wrapOp)
      expect((wrapped.context as any).originalErrorName).toBe('InvalidMoneyError');
      expect((wrapped.context as any).originalErrorCode).toBe('INVALID_MONEY');
      expect((wrapped.context as any).originalErrorContext).toEqual({ currency: 'INVALID', amount: 100 });

      // Теперь ЗЛОУМЫШЛЕННИК пытается подменить через ctx
      const maliciousCtx = {
        orderId: 'order-456',
        originalErrorName: 'FakeError',      // Spoof attempt
        originalErrorCode: 'FAKE_CODE',      // Spoof attempt
        originalErrorContext: { fake: true } // Spoof attempt
      };

      const rewrapped = rewrap('OrderService', 'process', maliciousCtx, wrapped, InvalidPriceError);

      // originalError* поля НЕ должны быть переписаны из maliciousCtx
      expect((rewrapped.context as any).originalErrorName).toBe('InvalidMoneyError');
      expect((rewrapped.context as any).originalErrorName).not.toBe('FakeError');
      expect((rewrapped.context as any).originalErrorCode).toBe('INVALID_MONEY');
      expect((rewrapped.context as any).originalErrorCode).not.toBe('FAKE_CODE');
      expect((rewrapped.context as any).originalErrorContext).toEqual({ currency: 'INVALID', amount: 100 });
      expect((rewrapped.context as any).originalErrorContext).not.toEqual({ fake: true });

      // Но обычные поля из ctx должны пройти
      expect((rewrapped.context as any).orderId).toBe('order-456');
    });
  });

  describe('isCoreInvariantViolation edge cases', () => {
    it('возвращает false когда reason не строка', () => {
      const fakeError = new Error('Test');
      (fakeError as any).reason = 123; // number вместо string

      expect(isCoreInvariantViolation(fakeError)).toBe(false);
    });

    it('возвращает false когда reason это объект', () => {
      const fakeError = new Error('Test');
      (fakeError as any).reason = { code: 'INVALID' };

      expect(isCoreInvariantViolation(fakeError)).toBe(false);
    });

    it('возвращает true когда reason это строка и есть kind маркер', () => {
      const error = new Error('Test');
      (error as any).reason = 'OUT_OF_RANGE';
      (error as any).kind = 'INVARIANT_VIOLATION';

      expect(isCoreInvariantViolation(error)).toBe(true);
    });
  });

});
