import { describe, it, expect, jest } from '@jest/globals';
import Decimal from 'decimal.js';
import { PriceService } from '../../../../src/price/facade/PriceService.js';
import { Price } from '../../../../src/price/core/Price.js';
import { InvalidPriceError } from '@polymarket/errors';
import * as math from '@polymarket/math';
import { ValidateAligned } from '../../../../src/price/rules/ValidateAligned.js';
import { RatioService } from '../../../../src/ratio/facade/RatioService.js';
import { Result } from '@polymarket/result';
import { PriceErrorReason } from '../../../../src/price/errors/PriceErrorReason.js';

/**
 * Helper для unwrap Result в тестах
 */
function expectOk<T, E>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`Expected Ok but got Err: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

describe('PriceService', () => {
  describe('Facade Error Contract - Comprehensive', () => {
    describe('Parse fail → context.op и context.raw обязательны', () => {
      it('multiply: parse fail должен содержать op, raw, factor', () => {
        const price = Price.of(new Decimal(0.5));
        const result = PriceService.multiply(price, 'invalid' as any);
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
        const price = Price.of(new Decimal(0.5));
        const result = PriceService.divide(price, 'invalid' as any);
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
        const price = Price.of(new Decimal(0.5));
        const result = PriceService.multiply(price, NaN);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('multiply');
          expect(result.error.context?.price).toBeDefined();
          expect(result.error.context?.factor).toBeDefined();
        }
      });

      it('divide: rule fail должен содержать op и операционные поля', () => {
        const price = Price.of(new Decimal(0.5));
        const result = PriceService.divide(price, 0);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('divide');
          expect(result.error.context?.price).toBeDefined();
          expect(result.error.context?.divisor).toBeDefined();
        }
      });

      it('create: invariant fail должен содержать op, raw, reason (БЕЗ cause и value)', () => {
        const result = PriceService.create(1.5); // выше максимума
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('create');
          expect(result.error.context?.raw).toEqual({ field: 'value', value: '1.5' }); // структурированный raw
          expect(result.error.context?.reason).toBe('OUT_OF_RANGE_HIGH');
          // ВАЖНО: НЕ должно быть cause для доменных инвариантов (stack мусорный)
          expect(result.error.context?.cause).toBeUndefined();
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

        const price = Price.of(new Decimal(0.5));
        const result = PriceService.multiply(price, 2);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('multiply');
          expect(result.error.context?.cause).toBeDefined();
          const cause = result.error.context?.cause as { name: string; message: string };
          expect(cause.name).toBeDefined();
          expect(cause.message).toBeDefined();
        }

        jest.restoreAllMocks();
      });

      it('unexpected error: должен содержать cause даже для non-Error', () => {
        jest.spyOn(math, 'divideDecimal').mockImplementation(() => {
          throw 'string error'; // не Error объект
        });

        const price = Price.of(new Decimal(0.5));
        const result = PriceService.divide(price, 2);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.cause).toBeDefined();
          const cause = result.error.context?.cause as { name: string; message: string };
          expect(cause.name).toBe('UnknownError');
          expect(cause.message).toBe('string error');
        }

        jest.restoreAllMocks();
      });
    });

    describe('Контракт "Never Throw" - никогда не бросает исключения', () => {
      it('create: всегда возвращает Result, никогда не throw', () => {
        expect(() => PriceService.create(NaN)).not.toThrow();
        expect(() => PriceService.create(Infinity)).not.toThrow();
        expect(() => PriceService.create(-1)).not.toThrow();
        expect(() => PriceService.create('invalid' as any)).not.toThrow();
      });

      it('операции: всегда возвращают Result, никогда не throw', () => {
        const price = Price.of(new Decimal(0.5));
        expect(() => PriceService.multiply(price, 'invalid' as any)).not.toThrow();
        expect(() => PriceService.divide(price, 0)).not.toThrow();
        expect(() => PriceService.roundToMarketTick(price, -1)).not.toThrow();
      });
    });
  });

  describe('create()', () => {
    it('должен создать Price из number', () => {
      const result = PriceService.create(0.5);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.5);
      }
    });

    it('должен создать Price из string', () => {
      const result = PriceService.create('0.5');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.5);
      }
    });

    it('должен создать Price из Decimal', () => {
      const result = PriceService.create(new Decimal(0.5));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.5);
      }
    });

    it('должен вернуть Err для значения ниже минимума', () => {
      const result = PriceService.create(0.00001);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.raw).toEqual({ field: 'value', value: '0.00001' });
      }
    });

    it('должен вернуть Err для значения выше максимума', () => {
      const result = PriceService.create(1.5);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.raw).toEqual({ field: 'value', value: '1.5' });
      }
    });

    it('должен вернуть Err для NaN', () => {
      const result = PriceService.create(NaN);
      expect(result.ok).toBe(false);
    });

    it('должен никогда не бросать исключения', () => {
      expect(() => PriceService.create(NaN)).not.toThrow();
      expect(() => PriceService.create(Infinity)).not.toThrow();
      expect(() => PriceService.create('invalid')).not.toThrow();
    });
  });

  describe('complement()', () => {
    it('должен вычислить дополнение до 1', () => {
      const price = Price.of(new Decimal(0.3));
      const result = PriceService.complement(price);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBeCloseTo(0.7, 10);
      }
    });

    it('должен вернуть 0.5 для 0.5', () => {
      const price = Price.of(new Decimal(0.5));
      const result = PriceService.complement(price);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.5);
      }
    });

    it('должен вернуть Ok если результат в диапазоне', () => {
      const price = Price.of(new Decimal(0.9999));
      const result = PriceService.complement(price);
      // 1 - 0.9999 = 0.0001, что валидно
      expect(result.ok).toBe(true);
    });
  });

  describe('average()', () => {
    it('должен вычислить среднее двух цен', () => {
      const p1 = Price.of(new Decimal(0.2));
      const p2 = Price.of(new Decimal(0.8));
      const result = PriceService.average(p1, p2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.5);
      }
    });

    it('должен вернуть ту же цену для двух одинаковых', () => {
      const p1 = Price.of(new Decimal(0.5));
      const p2 = Price.of(new Decimal(0.5));
      const result = PriceService.average(p1, p2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.5);
      }
    });

    it('должен работать с крайними значениями', () => {
      const p1 = Price.MIN;
      const p2 = Price.MAX;
      const result = PriceService.average(p1, p2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBeCloseTo(0.5, 4);
      }
    });
  });

  describe('multiply()', () => {
    it('должен умножить price на number', () => {
      const price = Price.of(new Decimal(0.3));
      const result = PriceService.multiply(price, 2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBeCloseTo(0.6, 10);
      }
    });

    it('должен умножить price на Decimal', () => {
      const price = Price.of(new Decimal(0.3));
      const result = PriceService.multiply(price, new Decimal(2));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBeCloseTo(0.6, 10);
      }
    });

    it('должен вернуть InvalidPriceError для невалидного factor (parse fail)', () => {
      const price = Price.of(new Decimal(0.5));
      const result = PriceService.multiply(price, 'invalid');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidPriceError);
        expect(result.error.context?.op).toBe('multiply');
        expect(result.error.context?.raw).toBeDefined(); // toDecimal добавляет raw
        expect(result.error.context?.factor).toBe('invalid'); // контракт требует factor
        expect(result.error.context?.price).toBeDefined();
      }
    });

    it('должен вернуть InvalidPriceError для NaN factor (rule fail)', () => {
      const price = Price.of(new Decimal(0.5));
      const result = PriceService.multiply(price, NaN);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidPriceError);
        expect(result.error.context?.op).toBe('multiply');
        expect(result.error.context?.factor).toBeDefined();
        expect(result.error.context?.price).toBeDefined();
      }
    });

    it('должен вернуть InvalidPriceError для Infinity factor (rule fail)', () => {
      const price = Price.of(new Decimal(0.5));
      const result = PriceService.multiply(price, Infinity);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidPriceError);
        expect(result.error.context?.op).toBe('multiply');
        expect(result.error.context?.factor).toBeDefined();
        expect(result.error.context?.price).toBeDefined();
      }
    });

    it('должен вернуть Err если результат выходит за диапазон', () => {
      const price = Price.of(new Decimal(0.5));
      const result = PriceService.multiply(price, 2);
      // 0.5 * 2 = 1.0, что выше максимума 0.9999
      expect(result.ok).toBe(false);
    });

    it('должен работать с дробными множителями', () => {
      const price = Price.of(new Decimal(0.6));
      const result = PriceService.multiply(price, 0.5);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.3);
      }
    });
  });

  describe('divide()', () => {
    it('должен разделить price на number', () => {
      const price = Price.of(new Decimal(0.6));
      const result = PriceService.divide(price, 2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.3);
      }
    });

    it('должен разделить price на Decimal', () => {
      const price = Price.of(new Decimal(0.6));
      const result = PriceService.divide(price, new Decimal(2));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.3);
      }
    });

    it('должен вернуть InvalidPriceError для нулевого делителя (rule fail)', () => {
      const price = Price.of(new Decimal(0.5));
      const result = PriceService.divide(price, 0);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidPriceError);
        expect(result.error.context?.op).toBe('divide');
        expect(result.error.context?.divisor).toBeDefined();
        expect(result.error.context?.price).toBeDefined();
      }
    });

    it('должен вернуть InvalidPriceError для невалидного divisor (parse fail)', () => {
      const price = Price.of(new Decimal(0.5));
      const result = PriceService.divide(price, 'invalid');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidPriceError);
        expect(result.error.context?.op).toBe('divide');
        expect(result.error.context?.raw).toBeDefined(); // toDecimal добавляет raw
        expect(result.error.context?.divisor).toBe('invalid'); // контракт требует divisor
        expect(result.error.context?.price).toBeDefined();
      }
    });

    it('должен вернуть InvalidPriceError для NaN divisor (rule fail)', () => {
      const price = Price.of(new Decimal(0.5));
      const result = PriceService.divide(price, NaN);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidPriceError);
        expect(result.error.context?.op).toBe('divide');
        expect(result.error.context?.divisor).toBeDefined();
        expect(result.error.context?.price).toBeDefined();
      }
    });

    it('должен вернуть InvalidPriceError для Infinity divisor (rule fail)', () => {
      const price = Price.of(new Decimal(0.5));
      const result = PriceService.divide(price, Infinity);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidPriceError);
        expect(result.error.context?.op).toBe('divide');
        expect(result.error.context?.divisor).toBeDefined();
        expect(result.error.context?.price).toBeDefined();
      }
    });

    it('должен вернуть Err если результат выходит за диапазон', () => {
      const price = Price.MIN; // 0.0001
      const result = PriceService.divide(price, 2);
      // 0.0001 / 2 = 0.00005, что ниже минимума
      expect(result.ok).toBe(false);
    });

    it('должен обернуть неожиданные ошибки в Result', () => {
      jest.spyOn(math, 'divideDecimal').mockImplementation(() => {
        throw new Error('unexpected error');
      });

      const price = Price.of(new Decimal(0.5));
      const result = PriceService.divide(price, 1);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe('Unexpected error during price divide');
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
      const price = Price.of(new Decimal(0.12345));
      const result = PriceService.roundToMarketTick(price, 0.001);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBeCloseTo(0.123, 10);
      }
    });

    it('должен округлить вниз (floor)', () => {
      const price = Price.of(new Decimal(0.12349));
      const result = PriceService.roundToMarketTick(price, 0.001, 'floor');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBeCloseTo(0.123, 10);
      }
    });

    it('должен округлить вверх (ceil)', () => {
      const price = Price.of(new Decimal(0.12301));
      const result = PriceService.roundToMarketTick(price, 0.001, 'ceil');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBeCloseTo(0.124, 10);
      }
    });

    it('должен вернуть Err для невалидного tickSize', () => {
      const price = Price.of(new Decimal(0.5));
      const result = PriceService.roundToMarketTick(price, -0.01);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.field).toBe('tickSize');
      }
    });

    it('должен работать с price не aligned к tickSize', () => {
      const price = Price.of(new Decimal(0.5555));
      const result = PriceService.roundToMarketTick(price, 0.01);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBeCloseTo(0.56, 10);
      }
    });

    it('должен работать если price уже aligned', () => {
      const price = Price.of(new Decimal(0.5));
      const result = PriceService.roundToMarketTick(price, 0.1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(0.5);
      }
    });

    it('должен вернуть Err для tickSize = 0', () => {
      const price = Price.of(new Decimal(0.5));
      const result = PriceService.roundToMarketTick(price, 0);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.field).toBe('tickSize');
        expect(result.error.context?.reason).toBe('not_positive');
      }
    });

    it('должен вернуть Err для tickSize = NaN', () => {
      const price = Price.of(new Decimal(0.5));
      const result = PriceService.roundToMarketTick(price, NaN);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.field).toBe('tickSize');
        expect(result.error.context?.reason).toBe('is_nan');
      }
    });

    it('должен вернуть Err для tickSize = Infinity', () => {
      const price = Price.of(new Decimal(0.5));
      const result = PriceService.roundToMarketTick(price, Infinity);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.field).toBe('tickSize');
        expect(result.error.context?.reason).toBe('not_finite');
      }
    });

    it('должен вернуть Err для tickSize не кратного базовому тику', () => {
      const price = Price.of(new Decimal(0.5));
      const result = PriceService.roundToMarketTick(price, 0.00015);  // НЕ кратен 0.0001
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.field).toBe('tickSize');
        expect(result.error.context?.reason).toBe('not_multiple_of_base_tick');
        expect(result.error.context?.tickSize).toBe('0.00015');
      }
    });

    it('должен принять tickSize кратный базовому тику', () => {
      const price = Price.of(new Decimal(0.5));
      const validTickSizes = [0.0001, 0.0002, 0.001, 0.01, 0.1];

      validTickSizes.forEach(tickSize => {
        const result = PriceService.roundToMarketTick(price, tickSize);
        expect(result.ok).toBe(true);
      });
    });

    it('должен обернуть неожиданные ошибки в Result', () => {
      jest.spyOn(Decimal.prototype, 'toDecimalPlaces').mockImplementation(() => {
        throw new Error('unexpected rounding error');
      });

      const price = Price.of(new Decimal(0.5));
      const result = PriceService.roundToMarketTick(price, 0.01);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe('Unexpected error during price roundToMarketTick');
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
    it('должен вернуть Ok если price aligned', () => {
      const price = Price.of(new Decimal(0.5));
      const result = PriceService.ensureAlignedToMarketTick(price, 0.1);
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Err если price не aligned', () => {
      const price = Price.of(new Decimal(0.5));
      const result = PriceService.ensureAlignedToMarketTick(price, 0.3);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.field).toBe('price');
        expect(result.error.context?.reason).toBe('not_aligned');
      }
    });

    it('должен делегировать ValidateAligned', () => {
      const spy = jest.spyOn(ValidateAligned, 'check');
      const price = Price.of(new Decimal(0.1235));
      const result = PriceService.ensureAlignedToMarketTick(price, 0.01);
      expect(result.ok).toBe(false);
      expect(spy).toHaveBeenCalledWith(price, expect.any(Decimal));
      spy.mockRestore();
    });
  });

  describe('applyRelativeChange()', () => {
    const tickSize = new Decimal(0.01);

    describe('happy path', () => {
      it('должен применить положительный markup (+2%)', () => {
        const price = Price.of(new Decimal(0.50));
        const markup = expectOk(RatioService.fromPercent(2));

        const result = PriceService.applyRelativeChange(price, markup, tickSize);

        if (!result.ok) fail(`Expected Ok but got Err: ${result.error.message}`);
        expect(result.ok).toBe(true);

        // 0.50 * 1.02 = 0.51
        expect(result.value.toNumber()).toBe(0.51);
      });

      it('должен применить отрицательный markdown (-5%)', () => {
        const price = Price.of(new Decimal(0.50));
        const markdown = expectOk(RatioService.fromPercent(-5));

        const result = PriceService.applyRelativeChange(price, markdown, tickSize);

        if (!result.ok) fail(`Expected Ok but got Err: ${result.error.message}`);
        expect(result.ok).toBe(true);

        // 0.50 * 0.95 = 0.475 → round to 0.48
        expect(result.value.toNumber()).toBe(0.48);
      });

      it('должен обработать нулевой markup (без изменений)', () => {
        const price = Price.of(new Decimal(0.50));
        const zero = expectOk(RatioService.fromDecimal(0));

        const result = PriceService.applyRelativeChange(price, zero, tickSize);

        if (!result.ok) fail(`Expected Ok but got Err: ${result.error.message}`);
        expect(result.ok).toBe(true);

        expect(result.value.toNumber()).toBe(0.50);
      });
    });

    describe('режимы округления', () => {
      it('должен округлять к ближайшему тику по умолчанию', () => {
        const price = Price.of(new Decimal(0.50));
        const markup = expectOk(RatioService.fromPercent(2.3));

        const result = PriceService.applyRelativeChange(price, markup, tickSize);

        if (!result.ok) fail(`Expected Ok but got Err: ${result.error.message}`);
        expect(result.ok).toBe(true);

        // 0.50 * 1.023 = 0.5115 → round to 0.51
        expect(result.value.toNumber()).toBe(0.51);
      });

      it('должен округлять вниз с режимом floor', () => {
        const price = Price.of(new Decimal(0.50));
        const markup = expectOk(RatioService.fromPercent(2.9));

        const result = PriceService.applyRelativeChange(
          price, markup, tickSize, { roundingMode: 'floor' }
        );

        if (!result.ok) fail(`Expected Ok but got Err: ${result.error.message}`);
        expect(result.ok).toBe(true);

        // 0.50 * 1.029 = 0.5145 → floor to 0.51
        expect(result.value.toNumber()).toBe(0.51);
      });

      it('должен округлять вверх с режимом ceil', () => {
        const price = Price.of(new Decimal(0.50));
        const markup = expectOk(RatioService.fromPercent(2.1));

        const result = PriceService.applyRelativeChange(
          price, markup, tickSize, { roundingMode: 'ceil' }
        );

        if (!result.ok) fail(`Expected Ok but got Err: ${result.error.message}`);
        expect(result.ok).toBe(true);

        // 0.50 * 1.021 = 0.5105 → ceil to 0.52
        expect(result.value.toNumber()).toBe(0.52);
      });

      it('должен использовать nearest при отсутствии опции', () => {
        const price = Price.of(new Decimal(0.50));
        const markup = expectOk(RatioService.fromPercent(2.5));

        const result = PriceService.applyRelativeChange(price, markup, tickSize, {});

        if (!result.ok) fail(`Expected Ok but got Err: ${result.error.message}`);
        expect(result.ok).toBe(true);

        // 0.50 * 1.025 = 0.5125 → nearest to 0.51
        expect(result.value.toNumber()).toBe(0.51);
      });
    });

    describe('edge cases - границы', () => {
      it('должен отклонить если результат превышает MAX_PRICE', () => {
        const price = Price.of(new Decimal(0.95));
        const markup = expectOk(RatioService.fromPercent(10));

        const result = PriceService.applyRelativeChange(price, markup, tickSize);

        expect(result.ok).toBe(false);
        if (result.ok) return;

        // 0.95 * 1.10 = 1.045 > MAX_PRICE (0.9999)
        expect(result.error.context?.reason).toBe(PriceErrorReason.OUT_OF_RANGE_HIGH);
      });

      it('должен отклонить если результат ниже MIN_PRICE', () => {
        const price = Price.of(new Decimal(0.001));
        const markdown = expectOk(RatioService.fromPercent(-90));

        const result = PriceService.applyRelativeChange(price, markdown, tickSize);

        expect(result.ok).toBe(false);
        if (result.ok) return;

        // 0.001 * 0.10 = 0.0001 → может округлиться к 0 или ниже MIN_PRICE
        expect(result.error.context?.reason).toBe(PriceErrorReason.OUT_OF_RANGE_LOW);
      });

      it('должен обработать результат близкий к MAX_PRICE после округления', () => {
        const price = Price.of(new Decimal(0.9899));
        const markup = expectOk(RatioService.fromPercent(1));

        const result = PriceService.applyRelativeChange(price, markup, tickSize);

        // 0.9899 * 1.01 = 0.999799 → round to 0.9998 (близко к MAX но валидно)
        if (result.ok) {
          expect(result.value.toNumber()).toBeLessThanOrEqual(0.9999);
          expect(result.value.toNumber()).toBeGreaterThanOrEqual(0.9997);
        }
      });

      it('должен обработать результат близкий к MIN_PRICE после округления', () => {
        const price = Price.of(new Decimal(0.0002));
        const markdown = expectOk(RatioService.fromPercent(-50));

        const result = PriceService.applyRelativeChange(price, markdown, new Decimal(0.0001));

        // 0.0002 * 0.50 = 0.0001 (MIN_PRICE)
        if (result.ok) {
          expect(result.value.toNumber()).toBeGreaterThanOrEqual(0.0001);
        }
      });
    });

    describe('ошибки валидации', () => {
      it('должен отклонить невалидный tickSize', () => {
        const price = Price.of(new Decimal(0.50));
        const markup = expectOk(RatioService.fromPercent(2));

        const result = PriceService.applyRelativeChange(price, markup, 'invalid' as any);

        expect(result.ok).toBe(false);
        if (result.ok) return;

        expect(result.error.context?.op).toBe('applyRelativeChange');
      });

      it('должен отклонить tickSize не кратный базовому тику', () => {
        const price = Price.of(new Decimal(0.50));
        const markup = expectOk(RatioService.fromPercent(2));

        const result = PriceService.applyRelativeChange(price, markup, 0.00015);

        expect(result.ok).toBe(false);
        if (result.ok) return;

        expect(result.error.context?.reason).toBe('not_multiple_of_base_tick');
      });
    });

    describe('большие изменения', () => {
      it('должен обработать большой положительный markup', () => {
        const price = Price.of(new Decimal(0.10));
        const markup = expectOk(RatioService.fromPercent(50));

        const result = PriceService.applyRelativeChange(price, markup, tickSize);

        if (!result.ok) fail(`Expected Ok but got Err: ${result.error.message}`);
        expect(result.ok).toBe(true);

        // 0.10 * 1.50 = 0.15
        expect(result.value.toNumber()).toBe(0.15);
      });

      it('должен обработать большой отрицательный markdown', () => {
        const price = Price.of(new Decimal(0.90));
        const markdown = expectOk(RatioService.fromPercent(-50));

        const result = PriceService.applyRelativeChange(price, markdown, tickSize);

        if (!result.ok) fail(`Expected Ok but got Err: ${result.error.message}`);
        expect(result.ok).toBe(true);

        // 0.90 * 0.50 = 0.45
        expect(result.value.toNumber()).toBe(0.45);
      });
    });

    describe('Facade Error Contract', () => {
      it('должен включать op, price, ratio, tickSize, roundingMode в контекст', () => {
        const price = Price.of(new Decimal(0.50));
        const markup = expectOk(RatioService.fromPercent(2));

        const result = PriceService.applyRelativeChange(price, markup, 'invalid' as any);

        expect(result.ok).toBe(false);
        if (result.ok) return;

        expect(result.error.context?.op).toBe('applyRelativeChange');
        expect(result.error.context?.price).toBe('0.5');
        expect(result.error.context?.ratio).toBe('0.02');
        expect(result.error.context?.tickSize).toBe('invalid');
        expect(result.error.context?.roundingMode).toBe('nearest');
      });

      it('должен сохранить кастомный roundingMode в контексте', () => {
        const price = Price.of(new Decimal(0.50));
        const markup = expectOk(RatioService.fromPercent(2));

        const result = PriceService.applyRelativeChange(
          price, markup, 'invalid' as any, { roundingMode: 'floor' }
        );

        expect(result.ok).toBe(false);
        if (result.ok) return;

        expect(result.error.context?.roundingMode).toBe('floor');
      });
    });
  });
});
