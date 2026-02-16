import { describe, it, expect } from '@jest/globals';
import { roundToPrecision } from '../../../src/rounding/roundToPrecision.js';
import {
  InvalidDecimalPlacesError,
  InvalidOperandError,
  InvalidRoundingModeError,
} from '@polymarket/errors';
import Decimal from 'decimal.js';

describe('roundToPrecision', () => {
  describe('normal operations', () => {
    it('должен округлять до 2 десятичных знаков', () => {
      const result = roundToPrecision(
        new Decimal('10.567'),
        2,
        Decimal.ROUND_HALF_UP
      );
      expect(result.toString()).toBe('10.57');
    });

    it('должен округлять до 1 десятичного знака', () => {
      const result = roundToPrecision(
        new Decimal('10.567'),
        1,
        Decimal.ROUND_HALF_UP
      );
      expect(result.toString()).toBe('10.6');
    });

    it('должен округлять до целого числа', () => {
      const result = roundToPrecision(
        new Decimal('10.5'),
        0,
        Decimal.ROUND_HALF_UP
      );
      expect(result.toString()).toBe('11');
    });

    it('должен работать с отрицательными числами', () => {
      const result = roundToPrecision(
        new Decimal('-10.567'),
        2,
        Decimal.ROUND_HALF_UP
      );
      expect(result.toString()).toBe('-10.57');
    });

    it('должен работать с большими числами', () => {
      const result = roundToPrecision(
        new Decimal('999999999999.567'),
        2,
        Decimal.ROUND_HALF_UP
      );
      expect(result.toString()).toBe('999999999999.57');
    });

    it('должен работать с очень маленькими числами', () => {
      const result = roundToPrecision(
        new Decimal('0.00567'),
        3,
        Decimal.ROUND_HALF_UP
      );
      expect(result.toString()).toBe('0.006');
    });

    it('должен не изменять уже округлённые значения', () => {
      const result = roundToPrecision(
        new Decimal('10.50'),
        2,
        Decimal.ROUND_HALF_UP
      );
      expect(result.toString()).toBe('10.5');
    });
  });

  describe('rounding modes', () => {
    it('ROUND_HALF_UP: должен округлять .5 вверх', () => {
      const result = roundToPrecision(
        new Decimal('10.565'),
        2,
        Decimal.ROUND_HALF_UP
      );
      expect(result.toString()).toBe('10.57');
    });

    it('ROUND_DOWN: должен округлять к нулю', () => {
      const result = roundToPrecision(
        new Decimal('10.567'),
        2,
        Decimal.ROUND_DOWN
      );
      expect(result.toString()).toBe('10.56');
    });

    it('ROUND_DOWN: должен округлять к нулю для отрицательных', () => {
      const result = roundToPrecision(
        new Decimal('-10.567'),
        2,
        Decimal.ROUND_DOWN
      );
      expect(result.toString()).toBe('-10.56'); // К нулю
    });

    it('ROUND_UP: должен округлять от нуля', () => {
      const result = roundToPrecision(
        new Decimal('10.561'),
        2,
        Decimal.ROUND_UP
      );
      expect(result.toString()).toBe('10.57');
    });

    it('ROUND_UP: должен округлять от нуля для отрицательных', () => {
      const result = roundToPrecision(
        new Decimal('-10.561'),
        2,
        Decimal.ROUND_UP
      );
      expect(result.toString()).toBe('-10.57'); // От нуля
    });

    it('ROUND_FLOOR: должен округлять к -Infinity', () => {
      const result = roundToPrecision(
        new Decimal('-10.561'),
        2,
        Decimal.ROUND_FLOOR
      );
      expect(result.toString()).toBe('-10.57'); // К -Infinity
    });

    it('ROUND_CEIL: должен округлять к +Infinity', () => {
      const result = roundToPrecision(
        new Decimal('-10.567'),
        2,
        Decimal.ROUND_CEIL
      );
      expect(result.toString()).toBe('-10.56'); // К +Infinity
    });
  });

  describe('edge cases', () => {
    it('должен работать с нулевым значением', () => {
      const result = roundToPrecision(new Decimal(0), 2, Decimal.ROUND_HALF_UP);
      expect(result.toString()).toBe('0');
    });

    it('должен работать с большим количеством знаков', () => {
      const result = roundToPrecision(
        new Decimal('10.123456789'),
        8,
        Decimal.ROUND_HALF_UP
      );
      expect(result.toString()).toBe('10.12345679');
    });
  });

  describe('валидация value', () => {
    it('должен throw InvalidOperandError на value = NaN', () => {
      expect(() =>
        roundToPrecision(new Decimal(NaN), 2, Decimal.ROUND_HALF_UP)
      ).toThrow(InvalidOperandError);
    });

    it('должен throw InvalidOperandError на value = Infinity', () => {
      expect(() =>
        roundToPrecision(new Decimal(Infinity), 2, Decimal.ROUND_HALF_UP)
      ).toThrow(InvalidOperandError);
    });

    it('должен throw InvalidOperandError на value = -Infinity', () => {
      expect(() =>
        roundToPrecision(new Decimal(-Infinity), 2, Decimal.ROUND_HALF_UP)
      ).toThrow(InvalidOperandError);
    });

    it('должен содержать контекст в InvalidOperandError', () => {
      expect(() =>
        roundToPrecision(new Decimal(NaN), 2, Decimal.ROUND_HALF_UP)
      ).toThrow(InvalidOperandError);

      try {
        roundToPrecision(new Decimal(NaN), 2, Decimal.ROUND_HALF_UP);
      } catch (error) {
        if (error instanceof InvalidOperandError) {
          expect(error.context).toBeDefined();
          expect(error.context?.value).toBe('NaN');
          expect(error.context?.decimalPlaces).toBe('2');
          expect(error.context?.operation).toBe('roundToPrecision');
        }
      }
    });

    it('должен throw InvalidOperandError (не TypeError) при value = undefined', () => {
      // Проверяем, что ранняя валидация decimalPlaces/roundingMode
      // предотвращает вызов value.toString() на undefined
      expect(() =>
        roundToPrecision(
          undefined as unknown as Decimal,
          2,
          Decimal.ROUND_HALF_UP
        )
      ).toThrow(InvalidOperandError);
    });

    it('должен throw InvalidOperandError (не TypeError) при value = null', () => {
      expect(() =>
        roundToPrecision(null as unknown as Decimal, 2, Decimal.ROUND_HALF_UP)
      ).toThrow(InvalidOperandError);
    });
  });

  describe('валидация decimalPlaces', () => {
    it('должен throw InvalidDecimalPlacesError на decimalPlaces < 0', () => {
      expect(() =>
        roundToPrecision(new Decimal('10.567'), -1, Decimal.ROUND_HALF_UP)
      ).toThrow(InvalidDecimalPlacesError);
    });

    it('должен throw InvalidDecimalPlacesError на decimalPlaces = Infinity', () => {
      expect(() =>
        roundToPrecision(new Decimal('10.567'), Infinity, Decimal.ROUND_HALF_UP)
      ).toThrow(InvalidDecimalPlacesError);
    });

    it('должен throw InvalidDecimalPlacesError на decimalPlaces = NaN', () => {
      expect(() =>
        roundToPrecision(new Decimal('10.567'), NaN, Decimal.ROUND_HALF_UP)
      ).toThrow(InvalidDecimalPlacesError);
    });

    it('должен throw InvalidDecimalPlacesError на decimalPlaces = 1.5 (не integer)', () => {
      expect(() =>
        roundToPrecision(new Decimal('10.567'), 1.5, Decimal.ROUND_HALF_UP)
      ).toThrow(InvalidDecimalPlacesError);
    });

    it('должен содержать контекст в InvalidDecimalPlacesError', () => {
      expect(() =>
        roundToPrecision(new Decimal('10.567'), -1, Decimal.ROUND_HALF_UP)
      ).toThrow(InvalidDecimalPlacesError);

      try {
        roundToPrecision(new Decimal('10.567'), -1, Decimal.ROUND_HALF_UP);
      } catch (error) {
        if (error instanceof InvalidDecimalPlacesError) {
          expect(error.context).toBeDefined();
          expect(error.context?.decimalPlaces).toBe('-1');
          expect(error.context?.value).toBe('10.567');
          expect(error.context?.operation).toBe('roundToPrecision');
        }
      }
    });

    it('должен работать с очень высокой точностью', () => {
      const result = roundToPrecision(
        new Decimal('1.123456789012345'),
        15,
        Decimal.ROUND_HALF_UP
      );
      expect(result.toString()).toBe('1.123456789012345');
    });

    it('должен throw InvalidDecimalPlacesError на decimalPlaces > 1e9', () => {
      expect(() =>
        roundToPrecision(new Decimal('10.567'), 1e9 + 1, Decimal.ROUND_HALF_UP)
      ).toThrow(InvalidDecimalPlacesError);
    });

    it('должен throw InvalidDecimalPlacesError на очень большое decimalPlaces', () => {
      expect(() =>
        roundToPrecision(new Decimal('10.567'), 1e10, Decimal.ROUND_HALF_UP)
      ).toThrow(InvalidDecimalPlacesError);
    });

    it('должен содержать контекст в InvalidDecimalPlacesError при превышении максимума', () => {
      try {
        roundToPrecision(new Decimal('10.567'), 1e9 + 1, Decimal.ROUND_HALF_UP);
      } catch (error) {
        if (error instanceof InvalidDecimalPlacesError) {
          expect(error.context).toBeDefined();
          expect(error.context?.decimalPlaces).toBe((1e9 + 1).toString());
          expect(error.context?.max).toBe('1000000000');
          expect(error.context?.value).toBe('10.567');
          expect(error.context?.operation).toBe('roundToPrecision');
        }
      }
    });

    it('должен работать с максимально допустимым decimalPlaces = 1e9', () => {
      const result = roundToPrecision(
        new Decimal('10.567'),
        1e9,
        Decimal.ROUND_HALF_UP
      );
      expect(result.toString()).toBe('10.567');
    });
  });

  describe('precision', () => {
    it('должен сохранять точность для больших чисел', () => {
      const value = new Decimal('123456789.123456789');
      const result = roundToPrecision(value, 5, Decimal.ROUND_HALF_UP);
      expect(result.toString()).toBe('123456789.12346');
    });
  });

  describe('валидация roundingMode', () => {
    it('должен работать с валидными roundingMode 0-8', () => {
      const value = new Decimal('10.567');

      // Все валидные режимы должны работать
      expect(() => roundToPrecision(value, 2, 0)).not.toThrow(); // ROUND_UP
      expect(() => roundToPrecision(value, 2, 1)).not.toThrow(); // ROUND_DOWN
      expect(() => roundToPrecision(value, 2, 2)).not.toThrow(); // ROUND_CEIL
      expect(() => roundToPrecision(value, 2, 3)).not.toThrow(); // ROUND_FLOOR
      expect(() => roundToPrecision(value, 2, 4)).not.toThrow(); // ROUND_HALF_UP
      expect(() => roundToPrecision(value, 2, 5)).not.toThrow(); // ROUND_HALF_DOWN
      expect(() => roundToPrecision(value, 2, 6)).not.toThrow(); // ROUND_HALF_EVEN
      expect(() => roundToPrecision(value, 2, 7)).not.toThrow(); // ROUND_HALF_CEIL
      expect(() => roundToPrecision(value, 2, 8)).not.toThrow(); // ROUND_HALF_FLOOR
    });

    it('должен throw InvalidRoundingModeError на roundingMode < 0', () => {
      const value = new Decimal('10.567');

      expect(() => roundToPrecision(value, 2, -1 as any)).toThrow(
        InvalidRoundingModeError
      );
    });

    it('должен throw InvalidRoundingModeError на roundingMode > 8', () => {
      const value = new Decimal('10.567');

      expect(() => roundToPrecision(value, 2, 9 as any)).toThrow(
        InvalidRoundingModeError
      );
      expect(() => roundToPrecision(value, 2, 100 as any)).toThrow(
        InvalidRoundingModeError
      );
    });

    it('должен throw InvalidRoundingModeError на не-integer roundingMode', () => {
      const value = new Decimal('10.567');

      expect(() => roundToPrecision(value, 2, 1.5 as any)).toThrow(
        InvalidRoundingModeError
      );
      expect(() => roundToPrecision(value, 2, NaN as any)).toThrow(
        InvalidRoundingModeError
      );
    });

    it('должен содержать контекст в InvalidRoundingModeError для out of range', () => {
      const value = new Decimal('10.567');

      try {
        roundToPrecision(value, 2, 9 as any);
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidRoundingModeError);
        if (error instanceof InvalidRoundingModeError) {
          expect(error.context).toBeDefined();
          expect(error.context?.roundingMode).toBe('9');
          expect(error.context?.min).toBe('0');
          expect(error.context?.max).toBe('8');
          expect(error.context?.value).toBe('10.567');
          expect(error.context?.decimalPlaces).toBe('2');
          expect(error.context?.operation).toBe('roundToPrecision');
        }
      }
    });

    it('должен содержать контекст в InvalidRoundingModeError для не-integer', () => {
      const value = new Decimal('10.567');

      try {
        roundToPrecision(value, 2, 1.5 as any);
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidRoundingModeError);
        if (error instanceof InvalidRoundingModeError) {
          expect(error.context).toBeDefined();
          expect(error.context?.roundingMode).toBe('1.5');
          expect(error.context?.operation).toBe('roundToPrecision');
        }
      }
    });
  });

  describe('runtime входы и граничные случаи', () => {
    it('должен корректно обрабатывать очень большие decimalPlaces', () => {
      const value = new Decimal('10.123456789012345678901234567890');
      const result = roundToPrecision(value, 50, Decimal.ROUND_HALF_UP);
      // Результат сохранит максимальную доступную точность
      expect(result.toString()).toContain('10.12345678901234567890');
    });

    it('должен корректно обрабатывать decimalPlaces = 0', () => {
      const value = new Decimal('10.567');
      const result = roundToPrecision(value, 0, Decimal.ROUND_HALF_UP);
      expect(result.toString()).toBe('11');
    });

    it('должен обрабатывать строковое число для decimalPlaces через number coercion', () => {
      const value = new Decimal('10.567');
      // JavaScript coercion: '2' становится 2
      const result = roundToPrecision(value, Number('2'), Decimal.ROUND_HALF_UP);
      expect(result.toString()).toBe('10.57');
    });
  });
});
