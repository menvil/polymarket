/**
 * Тесты для InvalidRoundingModeError
 */

import { describe, it, expect } from '@jest/globals';
import { InvalidRoundingModeError } from '../../../src/math/InvalidRoundingModeError.js';
import { TradingError } from '../../../src/base/index.js';
import { wrapOp } from '../../../src/utils/errorUtils.js';
import { Ok, Err } from '@polymarket/result';
import Decimal from 'decimal.js';

describe('InvalidRoundingModeError', () => {
  describe('свойства класса', () => {
    it('должен иметь правильный severity = low', () => {
      const error = new InvalidRoundingModeError('Invalid rounding mode');
      expect(error.severity).toBe('low');
    });

    it('должен иметь статический код INVALID_ROUNDING_MODE', () => {
      expect(InvalidRoundingModeError.code).toBe('INVALID_ROUNDING_MODE');
    });

    it('должен быть экземпляром TradingError', () => {
      const error = new InvalidRoundingModeError('Invalid rounding mode');
      expect(error).toBeInstanceOf(TradingError);
      expect(error).toBeInstanceOf(InvalidRoundingModeError);
    });

    it('должен правильно устанавливать name', () => {
      const error = new InvalidRoundingModeError('Invalid rounding mode');
      expect(error.name).toBe('InvalidRoundingModeError');
    });

    it('должен сохранять code в экземпляре', () => {
      const error = new InvalidRoundingModeError('Invalid rounding mode', {
        code: InvalidRoundingModeError.code,
      });
      expect(error.code).toBe('INVALID_ROUNDING_MODE');
    });
  });

  describe('создание экземпляра', () => {
    it('должен создавать ошибку с простым сообщением', () => {
      const error = new InvalidRoundingModeError('Invalid rounding mode', {
        code: InvalidRoundingModeError.code,
        context: { roundingMode: 9 },
      });

      expect(error.message).toBe('Invalid rounding mode');
      expect(error.context).toEqual({ roundingMode: 9 });
    });

    it('должен создавать ошибку с динамическим сообщением', () => {
      const error = new InvalidRoundingModeError(
        (ctx) =>
          `Rounding mode must be an integer between 0 and 8, got ${ctx.roundingMode}`,
        {
          code: InvalidRoundingModeError.code,
          context: { roundingMode: 10, min: 0, max: 8 },
        }
      );

      expect(error.message).toBe('Rounding mode must be an integer between 0 and 8, got 10');
      expect(error.context).toEqual({ roundingMode: 10, min: 0, max: 8 });
    });

    it('должен включать полезный context для отладки', () => {
      const error = new InvalidRoundingModeError(
        (ctx) => `Invalid rounding mode ${ctx.roundingMode} for ${ctx.operation}`,
        {
          code: InvalidRoundingModeError.code,
          context: {
            roundingMode: 'NaN',
            operation: 'Price.round',
            value: '10.567',
            precision: 2,
          },
        }
      );

      expect(error.context).toMatchObject({
        roundingMode: 'NaN',
        operation: 'Price.round',
        value: '10.567',
        precision: 2,
      });
    });
  });

  describe('создание с различными типами значений', () => {
    it('должен сохранять context для невалидных режимов', () => {
      const error = new InvalidRoundingModeError(
        (ctx) => `Rounding mode must be between 0 and 8, got ${ctx.roundingMode}`,
        {
          code: InvalidRoundingModeError.code,
          context: { roundingMode: 9, min: 0, max: 8 },
        }
      );

      expect(error.message).toContain('Rounding mode must be between 0 and 8, got 9');
      expect(error.context?.roundingMode).toBe(9);
      expect(error.context?.min).toBe(0);
      expect(error.context?.max).toBe(8);
    });

    it('должен сохранять context для специальных значений', () => {
      const error = new InvalidRoundingModeError(
        'Rounding mode must be an integer',
        {
          code: InvalidRoundingModeError.code,
          context: { roundingMode: 4.5, reason: 'not an integer' },
        }
      );

      expect(error.context?.roundingMode).toBe(4.5);
      expect(error.context?.reason).toBe('not an integer');
    });
  });

  describe('интеграция с wrapOp', () => {
    it('должен быть в whitelist expected math errors', () => {
      // Создаём функцию которая выбрасывает InvalidRoundingModeError
      const fn = () => {
        throw new InvalidRoundingModeError('Invalid rounding mode', {
          code: InvalidRoundingModeError.code,
          context: { roundingMode: 9 },
        });
      };

      const result = wrapOp(
        'TestService',
        'roundPrice',
        { precision: 2 },
        fn,
        InvalidRoundingModeError
      );

      // Должен вернуть Err с той же ошибкой (не преобразованную)
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidRoundingModeError);
        // Должен сохранить оригинальный context
        expect(result.error.context?.roundingMode).toBe(9);
        // Должен добавить service/op информацию
        expect(result.error.context?.service).toBe('TestService');
        expect(result.error.context?.op).toBe('roundPrice');
      }
    });

    it('должен корректно работать в wrapOp с Result возвратом', () => {
      // Функция возвращает Result<number, InvalidRoundingModeError>
      const fn = (mode: number) => {
        if (mode < 0 || mode > 8 || !Number.isInteger(mode)) {
          return Err(
            new InvalidRoundingModeError(
              (ctx) => `Invalid rounding mode ${ctx.roundingMode}`,
              {
                code: InvalidRoundingModeError.code,
                context: { roundingMode: mode },
              }
            )
          );
        }
        return Ok(mode);
      };

      const result = wrapOp(
        'TestService',
        'validateRoundingMode',
        { input: 10 },
        () => fn(10),
        InvalidRoundingModeError
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidRoundingModeError);
        expect(result.error.context?.roundingMode).toBe(10);
      }
    });

    it('должен корректно работать с Decimal.js округлением', () => {
      const roundPrice = (value: string, decimals: number, mode: number) => {
        if (!Number.isInteger(mode) || mode < 0 || mode > 8) {
          return Err(
            new InvalidRoundingModeError(
              (ctx) => `Invalid rounding mode ${ctx.roundingMode} for ${ctx.operation}`,
              {
                code: InvalidRoundingModeError.code,
                context: { roundingMode: mode, operation: 'roundPrice', value, decimals },
              }
            )
          );
        }

        const decimal = new Decimal(value);
        return Ok(decimal.toDecimalPlaces(decimals, mode as any).toString());
      };

      // Валидный режим
      const validResult = wrapOp(
        'PriceService',
        'roundPrice',
        { value: '10.567', decimals: 2, mode: 4 },
        () => roundPrice('10.567', 2, 4),
        InvalidRoundingModeError
      );

      expect(validResult.ok).toBe(true);
      if (validResult.ok) {
        expect(validResult.value).toBe('10.57');
      }

      // Невалидный режим
      const invalidResult = wrapOp(
        'PriceService',
        'roundPrice',
        { value: '10.567', decimals: 2, mode: 9 },
        () => roundPrice('10.567', 2, 9),
        InvalidRoundingModeError
      );

      expect(invalidResult.ok).toBe(false);
      if (!invalidResult.ok) {
        expect(invalidResult.error).toBeInstanceOf(InvalidRoundingModeError);
        expect(invalidResult.error.context?.roundingMode).toBe(9);
        expect(invalidResult.error.context?.operation).toBe('roundPrice');
      }
    });
  });

  describe('type guard .is()', () => {
    it('должен корректно определять экземпляр InvalidRoundingModeError', () => {
      const error = new InvalidRoundingModeError('Invalid rounding mode');
      expect(InvalidRoundingModeError.is(error)).toBe(true);
    });

    it('должен возвращать false для других TradingError', () => {
      const error = new TradingError('Some other error');
      expect(InvalidRoundingModeError.is(error)).toBe(false);
    });

    it('должен возвращать false для обычной Error', () => {
      const error = new Error('Regular error');
      expect(InvalidRoundingModeError.is(error)).toBe(false);
    });

    it('должен возвращать false для не-Error значений', () => {
      expect(InvalidRoundingModeError.is(null)).toBe(false);
      expect(InvalidRoundingModeError.is(undefined)).toBe(false);
      expect(InvalidRoundingModeError.is('error')).toBe(false);
      expect(InvalidRoundingModeError.is(42)).toBe(false);
      expect(InvalidRoundingModeError.is({})).toBe(false);
    });
  });

  describe('toJSON сериализация', () => {
    it('должен сериализовать ошибку в JSON', () => {
      const error = new InvalidRoundingModeError(
        (ctx) => `Invalid rounding mode ${ctx.roundingMode}`,
        {
          code: InvalidRoundingModeError.code,
          context: { roundingMode: 9, precision: 2 },
        }
      );

      const json = error.toJSON();

      expect(json.name).toBe('InvalidRoundingModeError');
      expect(json.message).toBe('Invalid rounding mode 9');
      expect(json.code).toBe('INVALID_ROUNDING_MODE');
      expect(json.severity).toBe('low');
      expect(json.context).toEqual({ roundingMode: 9, precision: 2 });
      expect(json.timestamp).toBeDefined();
    });
  });

  describe('примеры использования из документации', () => {
    it('пример 1: базовое использование (throw)', () => {
      class Price {
        constructor(private readonly value: number) {}

        round(precision: number, roundingMode: number): Price {
          if (!Number.isInteger(roundingMode) || roundingMode < 0 || roundingMode > 8) {
            throw new InvalidRoundingModeError(
              (ctx) =>
                `Rounding mode must be an integer between 0 and 8, got ${ctx.roundingMode}`,
              {
                code: InvalidRoundingModeError.code,
                context: {
                  roundingMode,
                  value: this.value,
                  precision,
                  operation: 'Price.round',
                },
              }
            );
          }

          const multiplier = Math.pow(10, precision);
          const rounded = Math.round(this.value * multiplier) / multiplier;
          return new Price(rounded);
        }
      }

      const price = new Price(10.567);

      expect(() => price.round(2, 9)).toThrow(InvalidRoundingModeError);

      try {
        price.round(2, 9);
      } catch (error) {
        expect(InvalidRoundingModeError.is(error)).toBe(true);
        if (InvalidRoundingModeError.is(error)) {
          expect(error.context?.roundingMode).toBe(9);
          expect(error.context?.operation).toBe('Price.round');
        }
      }
    });

    it('пример 2: с Result<T,E>', () => {
      class Price {
        private constructor(private readonly value: Decimal) {}

        static fromDecimal(value: Decimal) {
          return Ok(new Price(value));
        }

        round(precision: number, roundingMode: number) {
          if (!Number.isInteger(roundingMode)) {
            return Err(
              new InvalidRoundingModeError(
                (ctx) => `Rounding mode must be an integer, got ${ctx.roundingMode}`,
                {
                  code: InvalidRoundingModeError.code,
                  context: {
                    roundingMode,
                    value: this.value.toString(),
                    precision,
                    reason: 'not an integer',
                  },
                }
              )
            );
          }

          if (roundingMode < 0 || roundingMode > 8) {
            return Err(
              new InvalidRoundingModeError(
                (ctx) => `Rounding mode must be between 0 and 8, got ${ctx.roundingMode}`,
                {
                  code: InvalidRoundingModeError.code,
                  context: {
                    roundingMode,
                    value: this.value.toString(),
                    precision,
                    min: 0,
                    max: 8,
                  },
                }
              )
            );
          }

          const rounded = this.value.toDecimalPlaces(precision, roundingMode as any);
          return Ok(new Price(rounded));
        }
      }

      const priceResult = Price.fromDecimal(new Decimal('10.567'));
      expect(priceResult.ok).toBe(true);
      if (!priceResult.ok) return;

      const price = priceResult.value;
      const result = price.round(2, 4);

      expect(result.ok).toBe(true);

      const invalidResult = price.round(2, 10);
      expect(invalidResult.ok).toBe(false);
      if (!invalidResult.ok) {
        expect(invalidResult.error.context?.roundingMode).toBe(10);
      }
    });
  });
});
