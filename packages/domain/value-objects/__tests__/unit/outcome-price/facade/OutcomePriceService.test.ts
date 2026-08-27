import { describe, it, expect, jest } from '@jest/globals';
import Decimal from 'decimal.js';
import { OutcomePriceService } from '../../../../src/outcome-price/facade/OutcomePriceService.js';
import { OutcomePrice } from '../../../../src/outcome-price/core/OutcomePrice.js';
import { InvalidOutcomePriceError } from '@polymarket/errors';
import * as math from '@polymarket/math';
import { ValidateAligned } from '../../../../src/outcome-price/rules/ValidateAligned.js';
import { RatioService } from '../../../../src/ratio/facade/RatioService.js';
import { Result } from '@polymarket/result';
import { OutcomePriceErrorReason } from '../../../../src/outcome-price/errors/OutcomePriceErrorReason.js';

/**
 * Helper для unwrap Result в тестах
 */
function expectOk<T, E>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`Expected Ok but got Err: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

describe('OutcomePriceService', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('Facade Error Contract - Comprehensive', () => {
    describe('Parse fail → context.op и context.raw обязательны', () => {
      it('multiply: parse fail должен содержать op, raw, factor', () => {
        const price = OutcomePrice.of(new Decimal(0.5));
        const result = OutcomePriceService.multiply(price, 'invalid' as any);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('multiply');
          expect(result.error.context?.raw).toBeDefined(); // toDecimal добавляет raw
          expect(result.error.context?.factor).toBe('invalid'); // контракт требует factor
          expect(result.error.context?.price).toBeDefined(); // операционный контекст
          expect(result.error.context?.cause).toBeDefined(); // parse error cause
        }
      });

      it('divide: parse fail должен содержать op, raw, divisor', () => {
        const price = OutcomePrice.of(new Decimal(0.5));
        const result = OutcomePriceService.divide(price, 'invalid' as any);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('divide');
          expect(result.error.context?.raw).toBeDefined(); // toDecimal добавляет raw
          expect(result.error.context?.divisor).toBe('invalid'); // контракт требует divisor
          expect(result.error.context?.price).toBeDefined(); // операционный контекст
          expect(result.error.context?.cause).toBeDefined(); // parse error cause
        }
      });
    });

    describe('Rule fail → op и операционные поля обязательны', () => {
      it('multiply: rule fail должен содержать op и операционные поля', () => {
        const price = OutcomePrice.of(new Decimal(0.5));
        const result = OutcomePriceService.multiply(price, NaN);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('multiply');
          expect(result.error.context?.price).toBeDefined();
          expect(result.error.context?.factor).toBeDefined();
        }
      });

      it('divide: rule fail должен содержать op и операционные поля', () => {
        const price = OutcomePrice.of(new Decimal(0.5));
        const result = OutcomePriceService.divide(price, 0);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('divide');
          expect(result.error.context?.price).toBeDefined();
          expect(result.error.context?.divisor).toBeDefined();
        }
      });

      it('create: invariant fail должен содержать op, reason, cause', () => {
        const result = OutcomePriceService.create(1.5); // выше максимума
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('create');
          // raw не сохраняется для invariant violations (rewrap strips caller ctx raw)
          expect(result.error.context?.reason).toBe('OUT_OF_RANGE_HIGH');
          // coreInvariantError добавляет cause (OutcomePriceInvariantViolation info)
          expect(result.error.context?.cause).toBeDefined();
          // value убран как дублирование raw.value
          expect(result.error.context?.value).toBeUndefined();
        }
      });
    });

    describe('Math throw → cause.name и cause.message обязательны', () => {
      it('multiply: math exception должен содержать cause.name и cause.message', () => {
        jest.spyOn(math, 'multiplyDecimal').mockImplementation(() => {
          throw new Error('overflow');
        });

        const price = OutcomePrice.of(new Decimal(0.5));
        const result = OutcomePriceService.multiply(price, 2);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('multiply');
          expect(result.error.context?.cause).toBeDefined();
          const cause = result.error.context?.cause as { name: string; message: string };
          expect(cause.name).toBeDefined();
          expect(cause.message).toBeDefined();
        }
      });

      it('unexpected error: должен содержать cause даже для non-Error', () => {
        jest.spyOn(math, 'divideDecimal').mockImplementation(() => {
          throw 'string error'; // не Error объект
        });

        const price = OutcomePrice.of(new Decimal(0.5));
        const result = OutcomePriceService.divide(price, 2);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.cause).toBeDefined();
          const cause = result.error.context?.cause as { name: string; message: string };
          expect(cause.name).toBe('UnknownError');
          expect(cause.message).toBe('string error');
        }
      });
    });

    describe('Контракт "Never Throw" - никогда не бросает исключения', () => {
      it('create: всегда возвращает Result, никогда не throw', () => {
        expect(() => OutcomePriceService.create(NaN)).not.toThrow();
        expect(() => OutcomePriceService.create(Infinity)).not.toThrow();
        expect(() => OutcomePriceService.create(-1)).not.toThrow();
        expect(() => OutcomePriceService.create('invalid' as any)).not.toThrow();
      });

      it('операции: всегда возвращают Result, никогда не throw', () => {
        const price = OutcomePrice.of(new Decimal(0.5));
        expect(() => OutcomePriceService.multiply(price, 'invalid' as any)).not.toThrow();
        expect(() => OutcomePriceService.divide(price, 0)).not.toThrow();
        expect(() => OutcomePriceService.roundToMarketTick(price, -1)).not.toThrow();
      });
    });
  });

  describe('create()', () => {
    it('должен создать OutcomePrice из number', () => {
      const result = OutcomePriceService.create(0.5);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.5);
      }
    });

    it('должен создать OutcomePrice из string', () => {
      const result = OutcomePriceService.create('0.5');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.5);
      }
    });

    it('должен создать OutcomePrice из Decimal', () => {
      const result = OutcomePriceService.create(new Decimal(0.5));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.5);
      }
    });

    it('должен вернуть Err для значения ниже минимума', () => {
      const result = OutcomePriceService.create(0.00001);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.op).toBe('create');
        expect(result.error.context?.reason).toBe('OUT_OF_RANGE_LOW');
      }
    });

    it('должен вернуть Err для значения выше максимума', () => {
      const result = OutcomePriceService.create(1.5);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.op).toBe('create');
        expect(result.error.context?.reason).toBe('OUT_OF_RANGE_HIGH');
      }
    });

    it('должен вернуть Err для NaN', () => {
      const result = OutcomePriceService.create(NaN);
      expect(result.ok).toBe(false);
    });

    it('должен никогда не бросать исключения', () => {
      expect(() => OutcomePriceService.create(NaN)).not.toThrow();
      expect(() => OutcomePriceService.create(Infinity)).not.toThrow();
      expect(() => OutcomePriceService.create('invalid')).not.toThrow();
    });
  });

  describe('complement()', () => {
    it('должен вычислить дополнение до 1', () => {
      const price = OutcomePrice.of(new Decimal(0.3));
      const result = OutcomePriceService.complement(price);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBeCloseTo(0.7, 10);
      }
    });

    it('должен вернуть 0.5 для 0.5', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = OutcomePriceService.complement(price);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.5);
      }
    });

    it('должен вернуть Ok если результат в диапазоне', () => {
      const price = OutcomePrice.of(new Decimal(0.9999));
      const result = OutcomePriceService.complement(price);
      // 1 - 0.9999 = 0.0001, что валидно
      expect(result.ok).toBe(true);
    });
  });

  describe('average()', () => {
    it('должен вычислить среднее двух цен', () => {
      const p1 = OutcomePrice.of(new Decimal(0.2));
      const p2 = OutcomePrice.of(new Decimal(0.8));
      const result = OutcomePriceService.average(p1, p2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.5);
      }
    });

    it('должен вернуть ту же цену для двух одинаковых', () => {
      const p1 = OutcomePrice.of(new Decimal(0.5));
      const p2 = OutcomePrice.of(new Decimal(0.5));
      const result = OutcomePriceService.average(p1, p2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.5);
      }
    });

    it('должен работать с крайними значениями', () => {
      const p1 = OutcomePrice.MIN;
      const p2 = OutcomePrice.MAX;
      const result = OutcomePriceService.average(p1, p2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBeCloseTo(0.5, 4);
      }
    });
  });

  describe('multiply()', () => {
    it('должен умножить price на number', () => {
      const price = OutcomePrice.of(new Decimal(0.3));
      const result = OutcomePriceService.multiply(price, 2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBeCloseTo(0.6, 10);
      }
    });

    it('должен умножить price на Decimal', () => {
      const price = OutcomePrice.of(new Decimal(0.3));
      const result = OutcomePriceService.multiply(price, new Decimal(2));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBeCloseTo(0.6, 10);
      }
    });

    it('должен вернуть InvalidOutcomePriceError для невалидного factor (parse fail)', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = OutcomePriceService.multiply(price, 'invalid');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidOutcomePriceError);
        expect(result.error.context?.op).toBe('multiply');
        expect(result.error.context?.raw).toBeDefined(); // toDecimal добавляет raw
        expect(result.error.context?.factor).toBe('invalid'); // контракт требует factor
        expect(result.error.context?.price).toBeDefined();
      }
    });

    it('должен вернуть InvalidOutcomePriceError для NaN factor (rule fail)', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = OutcomePriceService.multiply(price, NaN);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidOutcomePriceError);
        expect(result.error.context?.op).toBe('multiply');
        expect(result.error.context?.factor).toBeDefined();
        expect(result.error.context?.price).toBeDefined();
      }
    });

    it('должен вернуть InvalidOutcomePriceError для Infinity factor (rule fail)', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = OutcomePriceService.multiply(price, Infinity);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidOutcomePriceError);
        expect(result.error.context?.op).toBe('multiply');
        expect(result.error.context?.factor).toBeDefined();
        expect(result.error.context?.price).toBeDefined();
      }
    });

    it('должен вернуть InvalidOutcomePriceError для negative factor (rule fail)', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = OutcomePriceService.multiply(price, -2);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidOutcomePriceError);
        expect(result.error.context?.op).toBe('multiply');
        expect(result.error.context?.factor).toBe('-2');
        expect(result.error.context?.price).toBe('0.5');
        expect(result.error.context?.reason).toBe('is_negative');
      }
    });

    it('должен вернуть Err если результат выходит за диапазон', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = OutcomePriceService.multiply(price, 2);
      // 0.5 * 2 = 1.0, что выше максимума 0.9999
      expect(result.ok).toBe(false);
    });

    it('должен работать с дробными множителями', () => {
      const price = OutcomePrice.of(new Decimal(0.6));
      const result = OutcomePriceService.multiply(price, 0.5);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.3);
      }
    });
  });

  describe('divide()', () => {
    it('должен разделить price на number', () => {
      const price = OutcomePrice.of(new Decimal(0.6));
      const result = OutcomePriceService.divide(price, 2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.3);
      }
    });

    it('должен разделить price на Decimal', () => {
      const price = OutcomePrice.of(new Decimal(0.6));
      const result = OutcomePriceService.divide(price, new Decimal(2));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.3);
      }
    });

    it('должен вернуть InvalidOutcomePriceError для нулевого делителя (rule fail)', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = OutcomePriceService.divide(price, 0);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidOutcomePriceError);
        expect(result.error.context?.op).toBe('divide');
        expect(result.error.context?.divisor).toBeDefined();
        expect(result.error.context?.price).toBeDefined();
      }
    });

    it('должен вернуть InvalidOutcomePriceError для невалидного divisor (parse fail)', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = OutcomePriceService.divide(price, 'invalid');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidOutcomePriceError);
        expect(result.error.context?.op).toBe('divide');
        expect(result.error.context?.raw).toBeDefined(); // toDecimal добавляет raw
        expect(result.error.context?.divisor).toBe('invalid'); // контракт требует divisor
        expect(result.error.context?.price).toBeDefined();
      }
    });

    it('должен вернуть InvalidOutcomePriceError для NaN divisor (rule fail)', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = OutcomePriceService.divide(price, NaN);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidOutcomePriceError);
        expect(result.error.context?.op).toBe('divide');
        expect(result.error.context?.divisor).toBeDefined();
        expect(result.error.context?.price).toBeDefined();
      }
    });

    it('должен вернуть InvalidOutcomePriceError для negative divisor (rule fail)', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = OutcomePriceService.divide(price, -2);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidOutcomePriceError);
        expect(result.error.context?.op).toBe('divide');
        expect(result.error.context?.divisor).toBe('-2');
        expect(result.error.context?.price).toBe('0.5');
        expect(result.error.context?.reason).toBe('is_negative');
      }
    });

    it('должен вернуть InvalidOutcomePriceError для Infinity divisor (rule fail)', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = OutcomePriceService.divide(price, Infinity);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidOutcomePriceError);
        expect(result.error.context?.op).toBe('divide');
        expect(result.error.context?.divisor).toBeDefined();
        expect(result.error.context?.price).toBeDefined();
      }
    });

    it('должен вернуть Err если результат выходит за диапазон', () => {
      const price = OutcomePrice.MIN; // 0.0001
      const result = OutcomePriceService.divide(price, 2);
      // 0.0001 / 2 = 0.00005, что ниже минимума
      expect(result.ok).toBe(false);
    });

    it('должен обернуть неожиданные ошибки в Result', () => {
      jest.spyOn(math, 'divideDecimal').mockImplementation(() => {
        throw new Error('unexpected error');
      });

      const price = OutcomePrice.of(new Decimal(0.5));
      const result = OutcomePriceService.divide(price, 1);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe('Unexpected error: unexpected error');
        expect(result.error.context?.op).toBe('divide');
        expect(result.error.context?.cause).toBeDefined();
        const cause = result.error.context?.cause as { name: string; message: string };
        expect(cause.name).toBe('Error');
        expect(cause.message).toBe('unexpected error');
      }

      jest.restoreAllMocks();
    });
  });

  describe('roundToMarketTick()', () => {
    it('должен округлить к ближайшему тику (nearest)', () => {
      const price = OutcomePrice.of(new Decimal(0.12345));
      const result = OutcomePriceService.roundToMarketTick(price, 0.001);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBeCloseTo(0.123, 10);
      }
    });

    it('должен округлить вниз (floor)', () => {
      const price = OutcomePrice.of(new Decimal(0.12349));
      const result = OutcomePriceService.roundToMarketTick(price, 0.001, 'floor');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBeCloseTo(0.123, 10);
      }
    });

    it('должен округлить вверх (ceil)', () => {
      const price = OutcomePrice.of(new Decimal(0.12301));
      const result = OutcomePriceService.roundToMarketTick(price, 0.001, 'ceil');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBeCloseTo(0.124, 10);
      }
    });

    it('должен вернуть Err для невалидного tickSize', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = OutcomePriceService.roundToMarketTick(price, -0.01);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.field).toBe('tickSize');
      }
    });

    it('должен работать с price не aligned к tickSize', () => {
      const price = OutcomePrice.of(new Decimal(0.5555));
      const result = OutcomePriceService.roundToMarketTick(price, 0.01);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBeCloseTo(0.56, 10);
      }
    });

    it('должен работать если price уже aligned', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = OutcomePriceService.roundToMarketTick(price, 0.1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.5);
      }
    });

    it('должен вернуть Err для невалидного tickSize (parse fail)', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = OutcomePriceService.roundToMarketTick(price, 'invalid' as any);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.op).toBe('roundToMarketTick');
        expect(result.error.context?.tickSize).toBe('invalid');
        expect(result.error.context?.raw).toBeDefined();
      }
    });

    it('должен вернуть Err для tickSize = 0', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = OutcomePriceService.roundToMarketTick(price, 0);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.field).toBe('tickSize');
        expect(result.error.context?.reason).toBe('not_positive');
      }
    });

    it('должен вернуть Err для tickSize = NaN', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = OutcomePriceService.roundToMarketTick(price, NaN);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // toDecimal перехватывает NaN до ValidateTickSize — parse fail path
        expect(result.error.context?.op).toBe('roundToMarketTick');
        expect(result.error.context?.raw).toBeDefined(); // raw присутствует при parse fail
        expect(result.error.context?.reason).toBe(OutcomePriceErrorReason.INVALID_FORMAT);
      }
    });

    it('должен вернуть Err для tickSize = Infinity', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = OutcomePriceService.roundToMarketTick(price, Infinity);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        // toDecimal перехватывает Infinity до ValidateTickSize — parse fail path
        expect(result.error.context?.op).toBe('roundToMarketTick');
        expect(result.error.context?.raw).toBeDefined(); // raw присутствует при parse fail
        expect(result.error.context?.reason).toBe(OutcomePriceErrorReason.INVALID_FORMAT);
      }
    });

    it('должен вернуть Err для tickSize не кратного базовому тику', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = OutcomePriceService.roundToMarketTick(price, 0.00015);  // НЕ кратен 0.0001
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.field).toBe('tickSize');
        expect(result.error.context?.reason).toBe('not_multiple_of_base_tick');
        expect(result.error.context?.tickSize).toBe('0.00015');
      }
    });

    it('должен принять tickSize кратный базовому тику', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const validTickSizes = [0.0001, 0.0002, 0.001, 0.01, 0.1];

      validTickSizes.forEach(tickSize => {
        const result = OutcomePriceService.roundToMarketTick(price, tickSize);
        expect(result.ok).toBe(true);
      });
    });

    it('должен обернуть неожиданные ошибки в Result', () => {
      jest.spyOn(Decimal.prototype, 'toDecimalPlaces').mockImplementation(() => {
        throw new Error('unexpected rounding error');
      });

      const price = OutcomePrice.of(new Decimal(0.5));
      const result = OutcomePriceService.roundToMarketTick(price, 0.01);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe('Unexpected error: unexpected rounding error');
        expect(result.error.context?.op).toBe('roundToMarketTick');
        expect(result.error.context?.cause).toBeDefined();
        const cause = result.error.context?.cause as { name: string; message: string };
        expect(cause.name).toBe('Error');
        expect(cause.message).toBe('unexpected rounding error');
      }

      jest.restoreAllMocks();
    });
  });

  describe('ensureAlignedToMarketTick()', () => {
    it('должен вернуть Err для невалидного tickSize (parse fail)', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = OutcomePriceService.ensureAlignedToMarketTick(price, 'invalid' as any);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.op).toBe('ensureAlignedToMarketTick');
        expect(result.error.context?.tickSize).toBe('invalid');
        expect(result.error.context?.raw).toBeDefined();
      }
    });

    it('должен вернуть Err для tickSize не кратного базовому тику (rule fail)', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = OutcomePriceService.ensureAlignedToMarketTick(price, 0.00015);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.op).toBe('ensureAlignedToMarketTick');
        expect(result.error.context?.tickSize).toBe('0.00015');
        expect(result.error.context?.reason).toBe('not_multiple_of_base_tick');
      }
    });

    it('должен вернуть Ok если price aligned', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = OutcomePriceService.ensureAlignedToMarketTick(price, 0.1);
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Err если price не aligned', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const result = OutcomePriceService.ensureAlignedToMarketTick(price, 0.3);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.field).toBe('price');
        expect(result.error.context?.reason).toBe('not_aligned');
      }
    });

    it('должен делегировать ValidateAligned', () => {
      const spy = jest.spyOn(ValidateAligned, 'check');
      const price = OutcomePrice.of(new Decimal(0.1235));
      const result = OutcomePriceService.ensureAlignedToMarketTick(price, 0.01);
      expect(result.ok).toBe(false);
      expect(spy).toHaveBeenCalledWith(price, expect.any(Decimal));
      spy.mockRestore();
    });
  });

  describe('applyRelativeChange()', () => {
    const tickSize = new Decimal(0.01);

    describe('happy path', () => {
      it('должен применить положительный markup (+2%)', () => {
        const price = OutcomePrice.of(new Decimal(0.50));
        const markup = expectOk(RatioService.fromPercent(2));

        const result = OutcomePriceService.applyRelativeChange(price, markup, tickSize);

        if (!result.ok) throw new Error(`Expected Ok but got Err: ${result.error.message}`);
        expect(result.ok).toBe(true);

        // 0.50 * 1.02 = 0.51
        expect(result.value.toNumber()).toBe(0.51);
      });

      it('должен применить отрицательный markdown (-5%)', () => {
        const price = OutcomePrice.of(new Decimal(0.50));
        const markdown = expectOk(RatioService.fromPercent(-5));

        const result = OutcomePriceService.applyRelativeChange(price, markdown, tickSize);

        if (!result.ok) throw new Error(`Expected Ok but got Err: ${result.error.message}`);
        expect(result.ok).toBe(true);

        // 0.50 * 0.95 = 0.475 → round to 0.48
        expect(result.value.toNumber()).toBe(0.48);
      });

      it('должен обработать нулевой markup (без изменений)', () => {
        const price = OutcomePrice.of(new Decimal(0.50));
        const zero = expectOk(RatioService.fromDecimal(0));

        const result = OutcomePriceService.applyRelativeChange(price, zero, tickSize);

        if (!result.ok) throw new Error(`Expected Ok but got Err: ${result.error.message}`);
        expect(result.ok).toBe(true);

        expect(result.value.toNumber()).toBe(0.50);
      });
    });

    describe('режимы округления', () => {
      it('должен округлять к ближайшему тику по умолчанию', () => {
        const price = OutcomePrice.of(new Decimal(0.50));
        const markup = expectOk(RatioService.fromPercent(2.3));

        const result = OutcomePriceService.applyRelativeChange(price, markup, tickSize);

        if (!result.ok) throw new Error(`Expected Ok but got Err: ${result.error.message}`);
        expect(result.ok).toBe(true);

        // 0.50 * 1.023 = 0.5115 → round to 0.51
        expect(result.value.toNumber()).toBe(0.51);
      });

      it('должен округлять вниз с режимом floor', () => {
        const price = OutcomePrice.of(new Decimal(0.50));
        const markup = expectOk(RatioService.fromPercent(2.9));

        const result = OutcomePriceService.applyRelativeChange(
          price, markup, tickSize, { roundingMode: 'floor' }
        );

        if (!result.ok) throw new Error(`Expected Ok but got Err: ${result.error.message}`);
        expect(result.ok).toBe(true);

        // 0.50 * 1.029 = 0.5145 → floor to 0.51
        expect(result.value.toNumber()).toBe(0.51);
      });

      it('должен округлять вверх с режимом ceil', () => {
        const price = OutcomePrice.of(new Decimal(0.50));
        const markup = expectOk(RatioService.fromPercent(2.1));

        const result = OutcomePriceService.applyRelativeChange(
          price, markup, tickSize, { roundingMode: 'ceil' }
        );

        if (!result.ok) throw new Error(`Expected Ok but got Err: ${result.error.message}`);
        expect(result.ok).toBe(true);

        // 0.50 * 1.021 = 0.5105 → ceil to 0.52
        expect(result.value.toNumber()).toBe(0.52);
      });

      it('должен использовать nearest при отсутствии опции', () => {
        const price = OutcomePrice.of(new Decimal(0.50));
        const markup = expectOk(RatioService.fromPercent(2.5));

        const result = OutcomePriceService.applyRelativeChange(price, markup, tickSize, {});

        if (!result.ok) throw new Error(`Expected Ok but got Err: ${result.error.message}`);
        expect(result.ok).toBe(true);

        // 0.50 * 1.025 = 0.5125 → nearest to 0.51
        expect(result.value.toNumber()).toBe(0.51);
      });
    });

    describe('edge cases - границы', () => {
      it('должен отклонить если результат превышает MAX_PRICE', () => {
        const price = OutcomePrice.of(new Decimal(0.95));
        const markup = expectOk(RatioService.fromPercent(10));

        const result = OutcomePriceService.applyRelativeChange(price, markup, tickSize);

        expect(result.ok).toBe(false);
        if (result.ok) return;

        // 0.95 * 1.10 = 1.045 > MAX_PRICE (0.9999)
        expect(result.error.context?.reason).toBe(OutcomePriceErrorReason.OUT_OF_RANGE_HIGH);
      });

      it('должен отклонить если результат ниже MIN_PRICE', () => {
        const price = OutcomePrice.of(new Decimal(0.001));
        const markdown = expectOk(RatioService.fromPercent(-90));

        const result = OutcomePriceService.applyRelativeChange(price, markdown, tickSize);

        expect(result.ok).toBe(false);
        if (result.ok) return;

        // 0.001 * 0.10 = 0.0001 → может округлиться к 0 или ниже MIN_PRICE
        expect(result.error.context?.reason).toBe(OutcomePriceErrorReason.OUT_OF_RANGE_LOW);
      });

      it('должен обработать результат близкий к MAX_PRICE после округления', () => {
        const price = OutcomePrice.of(new Decimal(0.9899));
        const markup = expectOk(RatioService.fromPercent(1));

        const result = OutcomePriceService.applyRelativeChange(price, markup, tickSize);

        // 0.9899 * 1.01 = 0.999899 может превысить MAX_PRICE при округлении
        // В этом случае допустим как Ok (если округлилось к 0.9998), так и Err
        if (result.ok) {
          expect(result.value.toNumber()).toBeLessThanOrEqual(0.9999);
          expect(result.value.toNumber()).toBeGreaterThanOrEqual(0.9997);
        } else {
          // Если результат превысил MAX_PRICE - это тоже валидный исход
          expect(result.error.context?.reason).toBe(OutcomePriceErrorReason.OUT_OF_RANGE_HIGH);
        }
      });

      it('должен обработать результат близкий к MIN_PRICE после округления', () => {
        const price = OutcomePrice.of(new Decimal(0.0002));
        const markdown = expectOk(RatioService.fromPercent(-50));

        const result = OutcomePriceService.applyRelativeChange(price, markdown, new Decimal(0.0001));

        // 0.0002 * 0.50 = 0.0001 (MIN_PRICE)
        if (!result.ok) throw new Error(`Expected Ok but got Err: ${result.error.message}`);
        expect(result.value.toNumber()).toBeGreaterThanOrEqual(0.0001);
      });
    });

    describe('ошибки валидации', () => {
      it('должен отклонить невалидный tickSize', () => {
        const price = OutcomePrice.of(new Decimal(0.50));
        const markup = expectOk(RatioService.fromPercent(2));

        const result = OutcomePriceService.applyRelativeChange(price, markup, 'invalid' as any);

        expect(result.ok).toBe(false);
        if (result.ok) return;

        expect(result.error.context?.op).toBe('applyRelativeChange');
      });

      it('должен отклонить tickSize не кратный базовому тику', () => {
        const price = OutcomePrice.of(new Decimal(0.50));
        const markup = expectOk(RatioService.fromPercent(2));

        const result = OutcomePriceService.applyRelativeChange(price, markup, 0.00015);

        expect(result.ok).toBe(false);
        if (result.ok) return;

        expect(result.error.context?.reason).toBe('not_multiple_of_base_tick');
      });
    });

    describe('большие изменения', () => {
      it('должен обработать большой положительный markup', () => {
        const price = OutcomePrice.of(new Decimal(0.10));
        const markup = expectOk(RatioService.fromPercent(50));

        const result = OutcomePriceService.applyRelativeChange(price, markup, tickSize);

        if (!result.ok) throw new Error(`Expected Ok but got Err: ${result.error.message}`);
        expect(result.ok).toBe(true);

        // 0.10 * 1.50 = 0.15
        expect(result.value.toNumber()).toBe(0.15);
      });

      it('должен обработать большой отрицательный markdown', () => {
        const price = OutcomePrice.of(new Decimal(0.90));
        const markdown = expectOk(RatioService.fromPercent(-50));

        const result = OutcomePriceService.applyRelativeChange(price, markdown, tickSize);

        if (!result.ok) throw new Error(`Expected Ok but got Err: ${result.error.message}`);
        expect(result.ok).toBe(true);

        // 0.90 * 0.50 = 0.45
        expect(result.value.toNumber()).toBe(0.45);
      });
    });

    describe('Facade Error Contract', () => {
      it('должен включать op, price, ratio, tickSize, roundingMode в контекст', () => {
        const price = OutcomePrice.of(new Decimal(0.50));
        const markup = expectOk(RatioService.fromPercent(2));

        const result = OutcomePriceService.applyRelativeChange(price, markup, 'invalid' as any);

        expect(result.ok).toBe(false);
        if (result.ok) return;

        expect(result.error.context?.op).toBe('applyRelativeChange');
        expect(result.error.context?.price).toBe('0.5');
        expect(result.error.context?.ratio).toBe('0.02');
        expect(result.error.context?.tickSize).toBe('invalid');
        expect(result.error.context?.roundingMode).toBe('nearest');
      });

      it('должен сохранить кастомный roundingMode в контексте', () => {
        const price = OutcomePrice.of(new Decimal(0.50));
        const markup = expectOk(RatioService.fromPercent(2));

        const result = OutcomePriceService.applyRelativeChange(
          price, markup, 'invalid' as any, { roundingMode: 'floor' }
        );

        expect(result.ok).toBe(false);
        if (result.ok) return;

        expect(result.error.context?.roundingMode).toBe('floor');
      });
    });
  });
});
