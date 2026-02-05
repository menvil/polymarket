import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { Ratio } from '../../../../src/ratio/core/Ratio';
import { RatioErrorReason } from '../../../../src/ratio/errors/RatioErrorReason';
import { RatioService } from '../../../../src/ratio/facade/RatioService';
import { isErr } from '@polymarket/result';

describe('Ratio core', () => {
  describe('инварианты (через RatioService)', () => {
    it('NAN - возвращает Err с NAN reason', () => {
      const result = RatioService.fromDecimal(NaN);
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.context?.reason).toBe(RatioErrorReason.NAN);
      }
    });

    it('NON_FINITE (Infinity) - возвращает Err с NON_FINITE reason', () => {
      const result = RatioService.fromDecimal(Infinity);
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.context?.reason).toBe(RatioErrorReason.NON_FINITE);
      }
    });

    it('NON_FINITE (-Infinity) - возвращает Err с NON_FINITE reason', () => {
      const result = RatioService.fromDecimal(-Infinity);
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.context?.reason).toBe(RatioErrorReason.NON_FINITE);
      }
    });
  });

  describe('создание через RatioService', () => {
    it('создает из положительного значения', () => {
      const result = RatioService.fromDecimal(0.02);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeInstanceOf(Ratio);
        expect(result.value.toDecimal().toString()).toBe('0.02');
      }
    });

    it('создает из отрицательного значения', () => {
      const result = RatioService.fromDecimal(-0.1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeInstanceOf(Ratio);
        expect(result.value.toDecimal().toString()).toBe('-0.1');
      }
    });

    it('создает нулевой Ratio', () => {
      const result = RatioService.fromDecimal(0);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeInstanceOf(Ratio);
        expect(result.value.toDecimal().toString()).toBe('0');
      }
    });

    it('создает из дроби 0.5 (50%)', () => {
      const result = RatioService.fromDecimal(0.5);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toDecimal().toString()).toBe('0.5');
      }
    });

    it('создает из дроби 1.0 (100%)', () => {
      const result = RatioService.fromDecimal(1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toDecimal().toString()).toBe('1');
      }
    });
  });

  describe('методы доступа', () => {
    it('toDecimal() возвращает Decimal', () => {
      const result = RatioService.fromDecimal(0.02);
      if (result.ok) {
        const decimal = result.value.toDecimal();
        expect(decimal).toBeInstanceOf(Decimal);
        expect(decimal.toString()).toBe('0.02');
      }
    });

    it('toNumber() возвращает number', () => {
      const result = RatioService.fromDecimal(0.02);
      if (result.ok) {
        const num = result.value.toNumber();
        expect(typeof num).toBe('number');
        expect(num).toBe(0.02);
      }
    });

    it('onePlus() возвращает (1 + ratio)', () => {
      const result = RatioService.fromPercent(10); // 10%
      if (result.ok) {
        const onePlus = result.value.onePlus();
        expect(onePlus).toBeInstanceOf(Decimal);
        expect(onePlus.toString()).toBe('1.1');
      }
    });

    it('onePlus() для отрицательного ratio', () => {
      const result = RatioService.fromPercent(-20); // -20%
      if (result.ok) {
        const onePlus = result.value.onePlus();
        expect(onePlus.toString()).toBe('0.8');
      }
    });

    it('onePlus() для нулевого ratio', () => {
      const result = RatioService.fromDecimal(0);
      if (result.ok) {
        const onePlus = result.value.onePlus();
        expect(onePlus.toString()).toBe('1');
      }
    });

    it('oneMinus() возвращает (1 - ratio)', () => {
      const result = RatioService.fromPercent(2); // 2% fee
      if (result.ok) {
        const oneMinus = result.value.oneMinus();
        expect(oneMinus).toBeInstanceOf(Decimal);
        expect(oneMinus.toString()).toBe('0.98');
      }
    });

    it('oneMinus() для отрицательного ratio', () => {
      const result = RatioService.fromPercent(-15); // -15% (negative discount)
      if (result.ok) {
        const oneMinus = result.value.oneMinus();
        expect(oneMinus.toString()).toBe('1.15');
      }
    });

    it('oneMinus() для нулевого ratio', () => {
      const result = RatioService.fromDecimal(0);
      if (result.ok) {
        const oneMinus = result.value.oneMinus();
        expect(oneMinus.toString()).toBe('1');
      }
    });

    it('oneMinus() для 50%', () => {
      const result = RatioService.fromPercent(50); // 50%
      if (result.ok) {
        const oneMinus = result.value.oneMinus();
        expect(oneMinus.toString()).toBe('0.5');
      }
    });
  });

  describe('сравнение', () => {
    it('equals() корректно сравнивает равные Ratio', () => {
      const r1Result = RatioService.fromDecimal(0.02);
      const r2Result = RatioService.fromDecimal(0.02);
      if (r1Result.ok && r2Result.ok) {
        expect(r1Result.value.equals(r2Result.value)).toBe(true);
      }
    });

    it('equals() корректно сравнивает разные Ratio', () => {
      const r1Result = RatioService.fromDecimal(0.02);
      const r2Result = RatioService.fromDecimal(0.03);
      if (r1Result.ok && r2Result.ok) {
        expect(r1Result.value.equals(r2Result.value)).toBe(false);
      }
    });

    it('equals() для отрицательных значений', () => {
      const r1Result = RatioService.fromDecimal(-0.1);
      const r2Result = RatioService.fromDecimal(-0.1);
      if (r1Result.ok && r2Result.ok) {
        expect(r1Result.value.equals(r2Result.value)).toBe(true);
      }
    });

    it('isZero() определяет нулевое значение', () => {
      const zeroResult = RatioService.fromDecimal(0);
      const nonZeroResult = RatioService.fromDecimal(0.01);

      if (zeroResult.ok) {
        expect(zeroResult.value.isZero()).toBe(true);
      }

      if (nonZeroResult.ok) {
        expect(nonZeroResult.value.isZero()).toBe(false);
      }
    });

    it('isPositive() определяет положительное значение', () => {
      const positiveResult = RatioService.fromDecimal(0.1);
      const zeroResult = RatioService.fromDecimal(0);
      const negativeResult = RatioService.fromDecimal(-0.1);

      if (positiveResult.ok) {
        expect(positiveResult.value.isPositive()).toBe(true);
      }

      if (zeroResult.ok) {
        expect(zeroResult.value.isPositive()).toBe(false);
      }

      if (negativeResult.ok) {
        expect(negativeResult.value.isPositive()).toBe(false);
      }
    });

    it('isNegative() определяет отрицательное значение', () => {
      const negativeResult = RatioService.fromDecimal(-0.1);
      const zeroResult = RatioService.fromDecimal(0);
      const positiveResult = RatioService.fromDecimal(0.1);

      if (negativeResult.ok) {
        expect(negativeResult.value.isNegative()).toBe(true);
      }

      if (zeroResult.ok) {
        expect(zeroResult.value.isNegative()).toBe(false);
      }

      if (positiveResult.ok) {
        expect(positiveResult.value.isNegative()).toBe(false);
      }
    });
  });

  describe('константы', () => {
    it('ZERO равен 0', () => {
      expect(Ratio.ZERO.toDecimal().toString()).toBe('0');
      expect(Ratio.ZERO.isZero()).toBe(true);
    });

    it('ONE равен 1', () => {
      expect(Ratio.ONE.toDecimal().toString()).toBe('1');
      expect(Ratio.ONE.toNumber()).toBe(1);
    });

    it('константы неизменяемы (singleton)', () => {
      const zero1 = Ratio.ZERO;
      const zero2 = Ratio.ZERO;
      expect(zero1).toBe(zero2); // Same reference
    });
  });
});
