/**
 * Тесты для AccountIdDepthError и AccountIdValidationError
 */

import { describe, it, expect } from '@jest/globals';
import { AccountIdDepthError } from '../../../src/ids/AccountIdDepthError.js';
import { AccountIdValidationError } from '../../../src/ids/AccountIdValidationError.js';
import { TradingError } from '../../../src/base/index.js';
import { wrapOp } from '../../../src/utils/errorUtils.js';
import { Ok, Err } from '@polymarket/result';

// ─── AccountIdValidationError ───────────────────────────────────────────────

describe('AccountIdValidationError', () => {
  describe('создание экземпляра', () => {
    it('должен создавать ошибку со статическим сообщением', () => {
      const error = new AccountIdValidationError('Invalid userId', {
        context: { field: 'userId', value: '', reason: 'empty string' },
      });

      expect(error.message).toBe('Invalid userId');
      expect(error.severity).toBe('low');
      expect(error.context).toEqual({
        field: 'userId',
        value: '',
        reason: 'empty string',
      });
    });

    it('должен создавать ошибку с динамическим сообщением и domain-specific context', () => {
      const error = new AccountIdValidationError(
        (ctx) => `Invalid ${ctx.field}: ${ctx.reason} (value: "${ctx.value}")`,
        {
          code: AccountIdValidationError.code,
          context: {
            field: 'userId',
            value: 'user:invalid',
            reason: 'invalid format',
          },
        }
      );

      expect(error.message).toBe(
        'Invalid userId: invalid format (value: "user:invalid")'
      );
      expect(error.code).toBe('INVALID_ACCOUNT_ID');
      expect(error.context).toMatchObject({
        field: 'userId',
        value: 'user:invalid',
        reason: 'invalid format',
      });
    });

    it('должен корректно обрабатывать поле name субаккаунта', () => {
      const error = new AccountIdValidationError(
        (ctx) => `Invalid ${ctx.field}: ${ctx.reason} (value: "${ctx.value}")`,
        {
          code: AccountIdValidationError.code,
          context: {
            field: 'name',
            value: '',
            reason: 'empty string',
          },
        }
      );

      expect(error.message).toBe(
        'Invalid name: empty string (value: "")'
      );
      expect(error.context?.field).toBe('name');
      expect(error.context?.reason).toBe('empty string');
    });

    it('должен хранить reason "exceeds 256 characters"', () => {
      const longValue = 'x'.repeat(300);
      const error = new AccountIdValidationError(
        (ctx) => `Invalid ${ctx.field}: ${ctx.reason} (value: "${ctx.value}")`,
        {
          code: AccountIdValidationError.code,
          context: {
            field: 'userId',
            value: longValue,
            reason: 'exceeds 256 characters',
          },
        }
      );

      expect(error.context?.reason).toBe('exceeds 256 characters');
      expect(error.context?.value).toBe(longValue);
    });
  });

  describe('статический код', () => {
    it('должен иметь статический код INVALID_ACCOUNT_ID', () => {
      expect(AccountIdValidationError.code).toBe('INVALID_ACCOUNT_ID');
    });

    it('должен совпадать с кодом экземпляра', () => {
      const error = new AccountIdValidationError('Invalid userId', {
        code: AccountIdValidationError.code,
        context: { field: 'userId', value: '', reason: 'empty string' },
      });

      expect(error.code).toBe(AccountIdValidationError.code);
    });
  });

  describe('интеграция с wrapOp', () => {
    it('должен работать через Result и wrapOp', () => {
      const resultFn = (userId: string) => {
        if (!userId || userId.length === 0) {
          return Err(
            new AccountIdValidationError(
              (ctx) => `Invalid ${ctx.field}: ${ctx.reason}`,
              {
                code: AccountIdValidationError.code,
                context: { field: 'userId', value: userId, reason: 'empty string' },
              }
            )
          );
        }
        return Ok(userId);
      };

      const result = wrapOp(
        'AccountService',
        'createVenueAccount',
        { venueId: 'POLYMARKET' },
        () => resultFn(''),
        AccountIdValidationError
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(AccountIdValidationError);
        expect(result.error.context?.field).toBe('userId');
        expect(result.error.context?.reason).toBe('empty string');
        expect(result.error.context?.service).toBe('AccountService');
        expect(result.error.context?.op).toBe('createVenueAccount');
      }
    });
  });

  describe('type guard .is()', () => {
    it('должен корректно определять экземпляр AccountIdValidationError', () => {
      const error = new AccountIdValidationError('Invalid userId');

      expect(AccountIdValidationError.is(error)).toBe(true);
      expect(AccountIdValidationError.is(new TradingError('Other error'))).toBe(false);
      expect(AccountIdValidationError.is(new Error('Regular error'))).toBe(false);
      expect(AccountIdValidationError.is(null)).toBe(false);
      expect(AccountIdValidationError.is(undefined)).toBe(false);
    });

    it('не должен путать AccountIdValidationError и AccountIdDepthError', () => {
      const validationError = new AccountIdValidationError('Validation');
      const depthError = new AccountIdDepthError('Depth');

      expect(AccountIdValidationError.is(depthError)).toBe(false);
      expect(AccountIdDepthError.is(validationError)).toBe(false);
    });
  });
});

// ─── AccountIdDepthError ────────────────────────────────────────────────────

describe('AccountIdDepthError', () => {
  describe('создание экземпляра', () => {
    it('должен создавать ошибку со статическим сообщением', () => {
      const error = new AccountIdDepthError('Subaccount depth limit exceeded', {
        context: { currentDepth: 6, maxDepth: 5, operation: 'create' },
      });

      expect(error.message).toBe('Subaccount depth limit exceeded');
      expect(error.severity).toBe('medium');
      expect(error.context).toEqual({
        currentDepth: 6,
        maxDepth: 5,
        operation: 'create',
      });
    });

    it('должен создавать ошибку с динамическим сообщением и domain-specific context', () => {
      const error = new AccountIdDepthError(
        (ctx) =>
          `Subaccount depth limit exceeded during ${ctx.operation}: current=${ctx.currentDepth}, max=${ctx.maxDepth}`,
        {
          code: AccountIdDepthError.code,
          context: { currentDepth: 5, maxDepth: 5, operation: 'create' },
        }
      );

      expect(error.message).toBe(
        'Subaccount depth limit exceeded during create: current=5, max=5'
      );
      expect(error.code).toBe('ACCOUNT_ID_DEPTH_EXCEEDED');
      expect(error.context).toMatchObject({
        currentDepth: 5,
        maxDepth: 5,
        operation: 'create',
      });
    });

    it('должен корректно хранить разные значения currentDepth', () => {
      const error = new AccountIdDepthError(
        (ctx) => `Depth ${ctx.currentDepth} exceeds max ${ctx.maxDepth}`,
        {
          code: AccountIdDepthError.code,
          context: { currentDepth: 10, maxDepth: 5, operation: 'serialize' },
        }
      );

      expect(error.context?.currentDepth).toBe(10);
      expect(error.context?.maxDepth).toBe(5);
      expect(error.context?.operation).toBe('serialize');
      expect(error.message).toBe('Depth 10 exceeds max 5');
    });
  });

  describe('статический код', () => {
    it('должен иметь статический код ACCOUNT_ID_DEPTH_EXCEEDED', () => {
      expect(AccountIdDepthError.code).toBe('ACCOUNT_ID_DEPTH_EXCEEDED');
    });

    it('должен совпадать с кодом экземпляра', () => {
      const error = new AccountIdDepthError('Depth exceeded', {
        code: AccountIdDepthError.code,
        context: { currentDepth: 6, maxDepth: 5, operation: 'create' },
      });

      expect(error.code).toBe(AccountIdDepthError.code);
    });
  });

  describe('интеграция с wrapOp', () => {
    it('должен работать через Result и wrapOp', () => {
      const MAX_DEPTH = 5;

      const resultFn = (currentDepth: number) => {
        if (currentDepth >= MAX_DEPTH) {
          return Err(
            new AccountIdDepthError(
              (ctx) =>
                `Subaccount depth limit exceeded during ${ctx.operation}: current=${ctx.currentDepth}, max=${ctx.maxDepth}`,
              {
                code: AccountIdDepthError.code,
                context: { currentDepth, maxDepth: MAX_DEPTH, operation: 'create' },
              }
            )
          );
        }
        return Ok(currentDepth + 1);
      };

      const result = wrapOp(
        'AccountService',
        'createSubaccount',
        { name: 'tooDeep' },
        () => resultFn(5),
        AccountIdDepthError
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(AccountIdDepthError);
        expect(result.error.context?.currentDepth).toBe(5);
        expect(result.error.context?.maxDepth).toBe(5);
        expect(result.error.context?.service).toBe('AccountService');
        expect(result.error.context?.op).toBe('createSubaccount');
      }
    });
  });

  describe('type guard .is()', () => {
    it('должен корректно определять экземпляр AccountIdDepthError', () => {
      const error = new AccountIdDepthError('Depth exceeded');

      expect(AccountIdDepthError.is(error)).toBe(true);
      expect(AccountIdDepthError.is(new TradingError('Other error'))).toBe(false);
      expect(AccountIdDepthError.is(new Error('Regular error'))).toBe(false);
      expect(AccountIdDepthError.is(null)).toBe(false);
      expect(AccountIdDepthError.is(undefined)).toBe(false);
    });
  });

  describe('severity', () => {
    it('должен иметь severity medium (некорректное использование API)', () => {
      const error = new AccountIdDepthError('Depth exceeded');
      expect(error.severity).toBe('medium');
    });

    it('AccountIdValidationError должен иметь severity low (ошибка входных данных)', () => {
      const error = new AccountIdValidationError('Invalid field');
      expect(error.severity).toBe('low');
    });
  });
});
