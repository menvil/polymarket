/**
 * Тесты для InvalidRoundingModeError
 */

import { describe, it, expect } from '@jest/globals';
import { InvalidRoundingModeError } from '../../../src/math/InvalidRoundingModeError.js';
import { TradingError } from '../../../src/base/index.js';
import { wrapOp } from '../../../src/utils/errorUtils.js';
import { Ok, Err } from '@polymarket/result';

describe('InvalidRoundingModeError', () => {
  describe('создание экземпляра', () => {
    it('должен создавать ошибку со статическим и динамическим сообщением', () => {
      // Статическое сообщение
      const error1 = new InvalidRoundingModeError('Invalid rounding mode', {
        context: { roundingMode: 9 },
      });
      expect(error1.message).toBe('Invalid rounding mode');
      expect(error1.context).toEqual({ roundingMode: 9 });

      // Динамическое сообщение с полным context
      const error2 = new InvalidRoundingModeError(
        (ctx) => `Invalid rounding mode ${ctx.roundingMode} for ${ctx.operation}`,
        {
          context: {
            roundingMode: 'NaN',
            operation: 'OutcomePrice.round',
            value: '10.567',
            precision: 2,
          },
        }
      );
      expect(error2.message).toBe('Invalid rounding mode NaN for OutcomePrice.round');
      expect(error2.context).toMatchObject({
        roundingMode: 'NaN',
        operation: 'OutcomePrice.round',
        value: '10.567',
        precision: 2,
      });
    });
  });

  describe('интеграция с wrapOp', () => {
    it('должен быть в whitelist expected math errors и работать через throw/Result', () => {
      // Тест 1: throw InvalidRoundingModeError - должен rewrap с tracing
      const throwFn = () => {
        throw new InvalidRoundingModeError('Invalid rounding mode', {
          context: { roundingMode: 9 },
        });
      };

      const throwResult = wrapOp(
        'TestService',
        'roundPrice',
        { precision: 2 },
        throwFn,
        InvalidRoundingModeError
      );

      expect(throwResult.ok).toBe(false);
      if (!throwResult.ok) {
        expect(throwResult.error).toBeInstanceOf(InvalidRoundingModeError);
        expect(throwResult.error.context?.roundingMode).toBe(9);
        expect(throwResult.error.context?.service).toBe('TestService');
        expect(throwResult.error.context?.op).toBe('roundPrice');
      }

      // Тест 2: Result<T, E> - должен rewrap Err
      const resultFn = (mode: number) => {
        if (mode < 0 || mode > 8 || !Number.isInteger(mode)) {
          return Err(
            new InvalidRoundingModeError(
              (ctx) => `Invalid rounding mode ${ctx.roundingMode}`,
              { context: { roundingMode: mode } }
            )
          );
        }
        return Ok(mode);
      };

      const resultErr = wrapOp(
        'TestService',
        'validate',
        {},
        () => resultFn(10),
        InvalidRoundingModeError
      );

      expect(resultErr.ok).toBe(false);
      if (!resultErr.ok) {
        expect(resultErr.error.context?.roundingMode).toBe(10);
        expect(resultErr.error.context?.service).toBe('TestService');
      }
    });
  });

  describe('type guard .is()', () => {
    it('должен корректно определять экземпляр InvalidRoundingModeError', () => {
      const error = new InvalidRoundingModeError('Invalid rounding mode');
      expect(InvalidRoundingModeError.is(error)).toBe(true);
      expect(InvalidRoundingModeError.is(new TradingError('Other error'))).toBe(false);
      expect(InvalidRoundingModeError.is(new Error('Regular error'))).toBe(false);
      expect(InvalidRoundingModeError.is(null)).toBe(false);
    });
  });
});
