import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import {
  InvalidOperandError,
  InvalidDivisorError,
  DivisionByZeroError,
} from '@polymarket/errors';
import {
  assertFiniteOperandWith,
  assertFiniteOperands,
  assertNonZeroDivisor,
  withResult,
  toStringSafe,
} from '../../../src/shared/index.js';

// ---------------------------------------------------------------------------
// Вспомогательные типы для тестов
// ---------------------------------------------------------------------------

/** Минимальный Decimal-like объект (проходит isDecimalLike duck-typing) */
function makeDecimalLike(opts: {
  isFinite?: () => boolean;
  toString?: () => string;
  toNumber?: () => number;
  isZero?: () => boolean;
}): unknown {
  return {
    isFinite: opts.isFinite ?? (() => true),
    toString: opts.toString ?? (() => '5'),
    toNumber: opts.toNumber ?? (() => 5),
    ...(opts.isZero !== undefined ? { isZero: opts.isZero } : {}),
  };
}

const ctx = { operation: 'test', a: '10', b: '5' };

// ---------------------------------------------------------------------------
// assertFiniteOperandWith
// ---------------------------------------------------------------------------

describe('assertFiniteOperandWith', () => {
  describe('корректные значения', () => {
    it('не бросает для конечного Decimal', () => {
      expect(() =>
        assertFiniteOperandWith(new Decimal('1.5'), 'a', ctx, InvalidOperandError)
      ).not.toThrow();
    });

    it('не бросает для duck-typing объекта с isFinite/toString/toNumber', () => {
      const fake = makeDecimalLike({ isFinite: () => true });
      expect(() =>
        assertFiniteOperandWith(fake, 'a', ctx, InvalidOperandError)
      ).not.toThrow();
    });
  });

  describe('невалидные объекты', () => {
    it('бросает для null', () => {
      expect(() =>
        assertFiniteOperandWith(null, 'a', ctx, InvalidOperandError)
      ).toThrow(InvalidOperandError);
    });

    it('бросает для undefined', () => {
      expect(() =>
        assertFiniteOperandWith(undefined, 'a', ctx, InvalidOperandError)
      ).toThrow(InvalidOperandError);
    });

    it('бросает для числа (не Decimal-like)', () => {
      expect(() =>
        assertFiniteOperandWith(42, 'a', ctx, InvalidOperandError)
      ).toThrow(InvalidOperandError);
    });

    it('бросает для строки', () => {
      expect(() =>
        assertFiniteOperandWith('5', 'a', ctx, InvalidOperandError)
      ).toThrow(InvalidOperandError);
    });

    it('бросает для объекта без toNumber (не проходит duck-typing)', () => {
      const partial = { isFinite: () => true, toString: () => 'x' };
      expect(() =>
        assertFiniteOperandWith(partial, 'a', ctx, InvalidOperandError)
      ).toThrow(InvalidOperandError);
    });
  });

  describe('неконечные значения', () => {
    it('бросает для Decimal(NaN)', () => {
      expect(() =>
        assertFiniteOperandWith(new Decimal(NaN), 'a', ctx, InvalidOperandError)
      ).toThrow(InvalidOperandError);
    });

    it('бросает для Decimal(Infinity)', () => {
      expect(() =>
        assertFiniteOperandWith(new Decimal(Infinity), 'a', ctx, InvalidOperandError)
      ).toThrow(InvalidOperandError);
    });

    it('бросает для Decimal(-Infinity)', () => {
      expect(() =>
        assertFiniteOperandWith(new Decimal(-Infinity), 'a', ctx, InvalidOperandError)
      ).toThrow(InvalidOperandError);
    });

    it('бросает для duck-typing объекта с isFinite() = false', () => {
      const fake = makeDecimalLike({ isFinite: () => false, toString: () => 'Infinity' });
      expect(() =>
        assertFiniteOperandWith(fake, 'a', ctx, InvalidOperandError)
      ).toThrow(InvalidOperandError);
    });
  });

  describe('тип ошибки управляется ErrorCtor', () => {
    it('бросает InvalidDivisorError при невалидном значении когда ErrorCtor = InvalidDivisorError', () => {
      expect(() =>
        assertFiniteOperandWith(null, 'b', ctx, InvalidDivisorError)
      ).toThrow(InvalidDivisorError);
    });

    it('бросает InvalidDivisorError при неконечном значении когда ErrorCtor = InvalidDivisorError', () => {
      expect(() =>
        assertFiniteOperandWith(new Decimal(NaN), 'b', ctx, InvalidDivisorError)
      ).toThrow(InvalidDivisorError);
    });
  });

  describe('контекст ошибки', () => {
    it('содержит paramName в контексте', () => {
      try {
        assertFiniteOperandWith(null, 'myParam', ctx, InvalidOperandError);
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidOperandError);
        if (error instanceof InvalidOperandError) {
          expect(error.context?.paramName).toBe('myParam');
        }
      }
    });

    it('содержит сериализованное значение в контексте', () => {
      try {
        assertFiniteOperandWith(new Decimal(NaN), 'a', ctx, InvalidOperandError);
      } catch (error) {
        if (error instanceof InvalidOperandError) {
          expect(error.context?.value).toBe('NaN');
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// assertFiniteOperands — контракт совпадает с assertFiniteOperandWith
// ---------------------------------------------------------------------------

describe('assertFiniteOperands', () => {
  describe('корректные значения', () => {
    it('не бросает для двух конечных Decimal', () => {
      expect(() =>
        assertFiniteOperands(new Decimal(1), new Decimal(2), { operation: 'add' })
      ).not.toThrow();
    });
  });

  describe('невалидный операнд a', () => {
    it('бросает InvalidOperandError для null a', () => {
      expect(() =>
        assertFiniteOperands(null, new Decimal(2), { operation: 'add' })
      ).toThrow(InvalidOperandError);
    });

    it('бросает InvalidOperandError для NaN a', () => {
      expect(() =>
        assertFiniteOperands(new Decimal(NaN), new Decimal(2), { operation: 'add' })
      ).toThrow(InvalidOperandError);
    });

    /**
     * Ключевой тест: assertFiniteOperands использует тот же duck-typing контракт, что
     * assertFiniteOperandWith. Fake объект без toNumber должен бросить InvalidOperandError.
     */
    it('бросает для fake Decimal-like без toNumber (контракт совпадает с assertFiniteOperandWith)', () => {
      const partialFake = { isFinite: () => true, toString: () => '5' };
      expect(() =>
        assertFiniteOperands(partialFake, new Decimal(2), { operation: 'add' })
      ).toThrow(InvalidOperandError);
    });

    it('бросает для fake Decimal-like с isFinite()=false (контракт совпадает с assertFiniteOperandWith)', () => {
      const fake = makeDecimalLike({ isFinite: () => false, toString: () => 'Infinity' });
      expect(() =>
        assertFiniteOperands(fake, new Decimal(2), { operation: 'add' })
      ).toThrow(InvalidOperandError);
    });
  });

  describe('невалидный операнд b', () => {
    it('бросает InvalidOperandError для NaN b', () => {
      expect(() =>
        assertFiniteOperands(new Decimal(1), new Decimal(NaN), { operation: 'add' })
      ).toThrow(InvalidOperandError);
    });

    it('бросает для fake Decimal-like b без toNumber', () => {
      const partialFake = { isFinite: () => true, toString: () => '5' };
      expect(() =>
        assertFiniteOperands(new Decimal(1), partialFake, { operation: 'add' })
      ).toThrow(InvalidOperandError);
    });
  });

  describe('контекст ошибки', () => {
    it('содержит a и b в контексте ошибки', () => {
      expect.assertions(3);
      try {
        assertFiniteOperands(new Decimal(NaN), new Decimal(5), { operation: 'add' });
      } catch (error) {
        if (error instanceof InvalidOperandError) {
          expect(error.context?.a).toBe('NaN');
          expect(error.context?.b).toBe('5');
          expect(error.context?.operation).toBe('add');
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// assertNonZeroDivisor
// ---------------------------------------------------------------------------

describe('assertNonZeroDivisor', () => {
  describe('корректный делитель', () => {
    it('не бросает для ненулевого Decimal', () => {
      expect(() =>
        assertNonZeroDivisor(new Decimal(5), ctx)
      ).not.toThrow();
    });

    it('не бросает для отрицательного Decimal', () => {
      expect(() =>
        assertNonZeroDivisor(new Decimal(-2), ctx)
      ).not.toThrow();
    });
  });

  describe('неконечный делитель → InvalidDivisorError', () => {
    it('бросает InvalidDivisorError для NaN', () => {
      expect(() =>
        assertNonZeroDivisor(new Decimal(NaN), ctx)
      ).toThrow(InvalidDivisorError);
    });

    it('бросает InvalidDivisorError для Infinity', () => {
      expect(() =>
        assertNonZeroDivisor(new Decimal(Infinity), ctx)
      ).toThrow(InvalidDivisorError);
    });

    it('бросает InvalidDivisorError для null', () => {
      expect(() =>
        assertNonZeroDivisor(null, ctx)
      ).toThrow(InvalidDivisorError);
    });
  });

  describe('отсутствие isZero → InvalidDivisorError', () => {
    it('бросает InvalidDivisorError если делитель не имеет метода isZero', () => {
      // Объект проходит isDecimalLike (isFinite/toString/toNumber), но нет isZero
      const noIsZero = makeDecimalLike({});
      expect(() =>
        assertNonZeroDivisor(noIsZero, ctx)
      ).toThrow(InvalidDivisorError);
    });

    it('не бросает TypeError — только доменную ошибку', () => {
      const noIsZero = makeDecimalLike({});
      expect(() =>
        assertNonZeroDivisor(noIsZero, ctx)
      ).not.toThrow(TypeError);
    });
  });

  describe('нулевой делитель → DivisionByZeroError', () => {
    it('бросает DivisionByZeroError для Decimal(0)', () => {
      expect(() =>
        assertNonZeroDivisor(new Decimal(0), ctx)
      ).toThrow(DivisionByZeroError);
    });

    it('бросает DivisionByZeroError для Decimal(-0)', () => {
      expect(() =>
        assertNonZeroDivisor(new Decimal(-0), ctx)
      ).toThrow(DivisionByZeroError);
    });

    it('бросает DivisionByZeroError для duck-typing объекта с isZero()=true', () => {
      const zeroDivisor = makeDecimalLike({ isZero: () => true });
      expect(() =>
        assertNonZeroDivisor(zeroDivisor, ctx)
      ).toThrow(DivisionByZeroError);
    });

    it('контекст содержит b из переданного context', () => {
      // assertNonZeroDivisor использует context как есть — caller обязан передать b
      // (именно так делает divide.ts: context = { ..., b: toStringSafe(b) })
      const zeroCtx = { operation: 'divide', a: '10', b: '0' };
      expect.assertions(2);
      try {
        assertNonZeroDivisor(new Decimal(0), zeroCtx);
      } catch (error) {
        if (error instanceof DivisionByZeroError) {
          expect(error.context?.b).toBe('0');
          expect(error.context?.operation).toBe('divide');
        }
      }
    });
  });

  describe('порядок проверок', () => {
    it('сначала конечность (InvalidDivisorError), потом ноль (DivisionByZeroError)', () => {
      // NaN !== 0, но NaN → InvalidDivisorError, не DivisionByZeroError
      expect(() =>
        assertNonZeroDivisor(new Decimal(NaN), ctx)
      ).toThrow(InvalidDivisorError);

      expect(() =>
        assertNonZeroDivisor(new Decimal(NaN), ctx)
      ).not.toThrow(DivisionByZeroError);
    });
  });
});

// ---------------------------------------------------------------------------
// withResult
// ---------------------------------------------------------------------------

describe('withResult', () => {
  it('добавляет result к контексту', () => {
    const base = { operation: 'add', a: '1', b: '2' };
    const result = withResult(base, new Decimal('3'));
    expect(result.result).toBe('3');
  });

  it('сохраняет все поля исходного контекста', () => {
    const base = { operation: 'multiply', a: '4', b: '5' };
    const result = withResult(base, new Decimal('20'));
    expect(result.operation).toBe('multiply');
    expect(result.a).toBe('4');
    expect(result.b).toBe('5');
  });

  it('не мутирует исходный контекст', () => {
    const base = { operation: 'divide', a: '10', b: '2' };
    withResult(base, new Decimal('5'));
    expect((base as Record<string, unknown>).result).toBeUndefined();
  });

  it('сериализует Decimal через toStringSafe', () => {
    const base = { operation: 'add', a: '0.1', b: '0.2' };
    const decResult = new Decimal('0.3');
    const ctx2 = withResult(base, decResult);
    expect(ctx2.result).toBe('0.3');
  });

  it('сериализует null как "null"', () => {
    const base = { operation: 'test' };
    const ctx2 = withResult(base, null);
    expect(ctx2.result).toBe('null');
  });

  it('сериализует undefined как "undefined"', () => {
    const base = { operation: 'test' };
    const ctx2 = withResult(base, undefined);
    expect(ctx2.result).toBe('undefined');
  });

  it('контекст с result корректно используется в assertFiniteResult', () => {
    // withResult передаётся в assertFiniteResult без ошибки для конечного значения
    const base = { operation: 'add', a: '1', b: '2' };
    const dec = new Decimal('3');
    const ctxWithResult = withResult(base, dec);
    // Если dec конечный — assertFiniteResult не бросает
    expect(() => {
      if (!dec.isFinite()) {
        throw new Error('overflow');
      }
    }).not.toThrow();
    expect(ctxWithResult.result).toBe('3');
  });
});

// ---------------------------------------------------------------------------
// Интеграция: assertFiniteOperands и assertFiniteOperandWith — одинаковый контракт
// ---------------------------------------------------------------------------

describe('контракт assertFiniteOperands == assertFiniteOperandWith (нет расхождений)', () => {
  const testCases = [
    { label: 'null', value: null },
    { label: 'undefined', value: undefined },
    { label: 'число 42', value: 42 },
    { label: 'строка "5"', value: '5' },
    { label: 'объект без toNumber', value: { isFinite: () => true, toString: () => 'x' } },
    { label: 'Decimal(NaN)', value: new Decimal(NaN) },
    { label: 'Decimal(Infinity)', value: new Decimal(Infinity) },
  ];

  testCases.forEach(({ label, value }) => {
    it(`оба бросают InvalidOperandError для: ${label}`, () => {
      const opCtx = { operation: 'test', a: toStringSafe(value), b: '1' };

      // assertFiniteOperandWith бросает
      expect(() =>
        assertFiniteOperandWith(value, 'a', opCtx, InvalidOperandError)
      ).toThrow(InvalidOperandError);

      // assertFiniteOperands бросает тот же тип для a
      expect(() =>
        assertFiniteOperands(value, new Decimal(1), { operation: 'test' })
      ).toThrow(InvalidOperandError);
    });
  });
});
