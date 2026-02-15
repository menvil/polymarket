import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { isErr } from '@polymarket/result';
import { RatioService } from '../../../../src/ratio/facade/RatioService';
import { RatioErrorReason } from '../../../../src/ratio/errors/RatioErrorReason';

describe('RatioService', () => {
  describe('fromDecimal()', () => {
    it('создает Ratio из number', () => {
      const result = RatioService.fromDecimal(0.02);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toDecimal().toString()).toBe('0.02');
      }
    });

    it('создает Ratio из string', () => {
      const result = RatioService.fromDecimal('0.02');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toDecimal().toString()).toBe('0.02');
      }
    });

    it('создает Ratio из Decimal', () => {
      const result = RatioService.fromDecimal(new Decimal(0.02));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toDecimal().toString()).toBe('0.02');
      }
    });

    it('создает отрицательный Ratio', () => {
      const result = RatioService.fromDecimal(-0.1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toDecimal().toString()).toBe('-0.1');
      }
    });

    it('создает нулевой Ratio', () => {
      const result = RatioService.fromDecimal(0);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isZero()).toBe(true);
      }
    });

    it('возвращает Err при NaN', () => {
      const result = RatioService.fromDecimal(NaN);
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.context?.reason).toBe(RatioErrorReason.NAN);
      }
    });

    it('возвращает Err при Infinity', () => {
      const result = RatioService.fromDecimal(Infinity);
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.context?.reason).toBe(RatioErrorReason.NON_FINITE);
      }
    });

    it('возвращает Err при -Infinity', () => {
      const result = RatioService.fromDecimal(-Infinity);
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.context?.reason).toBe(RatioErrorReason.NON_FINITE);
      }
    });

    it('возвращает Err при некорректной строке', () => {
      const result = RatioService.fromDecimal('not a number');
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.context?.reason).toBe(RatioErrorReason.INVALID_FORMAT);
      }
    });

    describe('с ensureGteMinusOne', () => {
      it('принимает -1', () => {
        const result = RatioService.fromDecimal(-1, { ensureGteMinusOne: true });
        expect(result.ok).toBe(true);
      });

      it('принимает -0.5', () => {
        const result = RatioService.fromDecimal(-0.5, { ensureGteMinusOne: true });
        expect(result.ok).toBe(true);
      });

      it('принимает 0', () => {
        const result = RatioService.fromDecimal(0, { ensureGteMinusOne: true });
        expect(result.ok).toBe(true);
      });

      it('принимает положительные значения', () => {
        const result = RatioService.fromDecimal(0.1, { ensureGteMinusOne: true });
        expect(result.ok).toBe(true);
      });

      it('отклоняет -1.5', () => {
        const result = RatioService.fromDecimal(-1.5, { ensureGteMinusOne: true });
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.context?.reason).toBe(RatioErrorReason.LESS_THAN_MINUS_ONE);
        }
      });

      it('отклоняет -2', () => {
        const result = RatioService.fromDecimal(-2, { ensureGteMinusOne: true });
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.context?.reason).toBe(RatioErrorReason.LESS_THAN_MINUS_ONE);
        }
      });
    });

    describe('с ensureLteOne', () => {
      it('принимает 1', () => {
        const result = RatioService.fromDecimal(1, { ensureLteOne: true });
        expect(result.ok).toBe(true);
      });

      it('принимает 0.5', () => {
        const result = RatioService.fromDecimal(0.5, { ensureLteOne: true });
        expect(result.ok).toBe(true);
      });

      it('принимает 0', () => {
        const result = RatioService.fromDecimal(0, { ensureLteOne: true });
        expect(result.ok).toBe(true);
      });

      it('принимает отрицательные значения', () => {
        const result = RatioService.fromDecimal(-0.1, { ensureLteOne: true });
        expect(result.ok).toBe(true);
      });

      it('отклоняет 1.5', () => {
        const result = RatioService.fromDecimal(1.5, { ensureLteOne: true });
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.context?.reason).toBe(RatioErrorReason.GREATER_THAN_ONE);
        }
      });

      it('отклоняет 2', () => {
        const result = RatioService.fromDecimal(2, { ensureLteOne: true });
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.context?.reason).toBe(RatioErrorReason.GREATER_THAN_ONE);
        }
      });
    });

    describe('с обеими опциями ensureGteMinusOne и ensureLteOne', () => {
      it('принимает значения в диапазоне [-1, 1]', () => {
        const result = RatioService.fromDecimal(0.5, {
          ensureGteMinusOne: true,
          ensureLteOne: true
        });
        expect(result.ok).toBe(true);
      });

      it('принимает -1', () => {
        const result = RatioService.fromDecimal(-1, {
          ensureGteMinusOne: true,
          ensureLteOne: true
        });
        expect(result.ok).toBe(true);
      });

      it('принимает 1', () => {
        const result = RatioService.fromDecimal(1, {
          ensureGteMinusOne: true,
          ensureLteOne: true
        });
        expect(result.ok).toBe(true);
      });

      it('отклоняет значения < -1', () => {
        const result = RatioService.fromDecimal(-1.5, {
          ensureGteMinusOne: true,
          ensureLteOne: true
        });
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.context?.reason).toBe(RatioErrorReason.LESS_THAN_MINUS_ONE);
        }
      });

      it('отклоняет значения > 1', () => {
        const result = RatioService.fromDecimal(1.5, {
          ensureGteMinusOne: true,
          ensureLteOne: true
        });
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.context?.reason).toBe(RatioErrorReason.GREATER_THAN_ONE);
        }
      });
    });
  });

  describe('fromPercent()', () => {
    it('конвертирует 2% в 0.02', () => {
      const result = RatioService.fromPercent(2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toDecimal().toString()).toBe('0.02');
      }
    });

    it('конвертирует 100% в 1', () => {
      const result = RatioService.fromPercent(100);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toDecimal().toString()).toBe('1');
      }
    });

    it('конвертирует 50% в 0.5', () => {
      const result = RatioService.fromPercent(50);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toDecimal().toString()).toBe('0.5');
      }
    });

    it('конвертирует -10% в -0.1', () => {
      const result = RatioService.fromPercent(-10);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toDecimal().toString()).toBe('-0.1');
      }
    });

    it('конвертирует 0% в 0', () => {
      const result = RatioService.fromPercent(0);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isZero()).toBe(true);
      }
    });

    it('работает со строкой', () => {
      const result = RatioService.fromPercent('5.5');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toDecimal().toString()).toBe('0.055');
      }
    });

    it('работает с Decimal', () => {
      const result = RatioService.fromPercent(new Decimal(2));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toDecimal().toString()).toBe('0.02');
      }
    });

    it('конвертирует дробные проценты', () => {
      const result = RatioService.fromPercent(2.5);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toDecimal().toString()).toBe('0.025');
      }
    });

    describe('с ensureGteMinusOne', () => {
      it('принимает -100% (-1)', () => {
        const result = RatioService.fromPercent(-100, { ensureGteMinusOne: true });
        expect(result.ok).toBe(true);
      });

      it('отклоняет -150% (-1.5)', () => {
        const result = RatioService.fromPercent(-150, { ensureGteMinusOne: true });
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.context?.reason).toBe(RatioErrorReason.LESS_THAN_MINUS_ONE);
        }
      });
    });

    describe('с ensureLteOne', () => {
      it('принимает 100% (1)', () => {
        const result = RatioService.fromPercent(100, { ensureLteOne: true });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toDecimal().toString()).toBe('1');
        }
      });

      it('принимает 50% (0.5)', () => {
        const result = RatioService.fromPercent(50, { ensureLteOne: true });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toDecimal().toString()).toBe('0.5');
        }
      });

      it('отклоняет 150% (1.5)', () => {
        const result = RatioService.fromPercent(150, { ensureLteOne: true });
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.context?.reason).toBe(RatioErrorReason.GREATER_THAN_ONE);
        }
      });

      it('отклоняет 200% (2)', () => {
        const result = RatioService.fromPercent(200, { ensureLteOne: true });
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.context?.reason).toBe(RatioErrorReason.GREATER_THAN_ONE);
        }
      });
    });
  });

  describe('fromBps()', () => {
    it('конвертирует 200 bps в 0.02 (2%)', () => {
      const result = RatioService.fromBps(200);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toDecimal().toString()).toBe('0.02');
      }
    });

    it('конвертирует 100 bps в 0.01 (1%)', () => {
      const result = RatioService.fromBps(100);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toDecimal().toString()).toBe('0.01');
      }
    });

    it('конвертирует 10000 bps в 1 (100%)', () => {
      const result = RatioService.fromBps(10000);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toDecimal().toString()).toBe('1');
      }
    });

    it('конвертирует 50 bps в 0.005 (0.5%)', () => {
      const result = RatioService.fromBps(50);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toDecimal().toString()).toBe('0.005');
      }
    });

    it('конвертирует отрицательные bps', () => {
      const result = RatioService.fromBps(-200);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toDecimal().toString()).toBe('-0.02');
      }
    });

    it('работает со строкой', () => {
      const result = RatioService.fromBps('250');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toDecimal().toString()).toBe('0.025');
      }
    });

    it('работает с Decimal', () => {
      const result = RatioService.fromBps(new Decimal(200));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toDecimal().toString()).toBe('0.02');
      }
    });

    describe('с ensureGteMinusOne', () => {
      it('принимает -10000 bps (-100%, -1)', () => {
        const result = RatioService.fromBps(-10000, { ensureGteMinusOne: true });
        expect(result.ok).toBe(true);
      });

      it('отклоняет -15000 bps (-150%, -1.5)', () => {
        const result = RatioService.fromBps(-15000, { ensureGteMinusOne: true });
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.context?.reason).toBe(RatioErrorReason.LESS_THAN_MINUS_ONE);
        }
      });
    });

    describe('с ensureLteOne', () => {
      it('принимает 10000 bps (100%, 1)', () => {
        const result = RatioService.fromBps(10000, { ensureLteOne: true });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toDecimal().toString()).toBe('1');
        }
      });

      it('принимает 5000 bps (50%, 0.5)', () => {
        const result = RatioService.fromBps(5000, { ensureLteOne: true });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toDecimal().toString()).toBe('0.5');
        }
      });

      it('отклоняет 15000 bps (150%, 1.5)', () => {
        const result = RatioService.fromBps(15000, { ensureLteOne: true });
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.context?.reason).toBe(RatioErrorReason.GREATER_THAN_ONE);
        }
      });

      it('отклоняет 20000 bps (200%, 2)', () => {
        const result = RatioService.fromBps(20000, { ensureLteOne: true });
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.context?.reason).toBe(RatioErrorReason.GREATER_THAN_ONE);
        }
      });
    });
  });

  describe('equals()', () => {
    it('возвращает boolean напрямую', () => {
      const r1Result = RatioService.fromDecimal(0.02);
      const r2Result = RatioService.fromDecimal(0.02);
      
      if (r1Result.ok && r2Result.ok) {
        const isEqual = RatioService.equals(r1Result.value, r2Result.value);
        expect(typeof isEqual).toBe('boolean');
        expect(isEqual).toBe(true);
      }
    });

    it('возвращает true для равных Ratio', () => {
      const r1Result = RatioService.fromDecimal(0.02);
      const r2Result = RatioService.fromDecimal(0.02);
      
      if (r1Result.ok && r2Result.ok) {
        expect(RatioService.equals(r1Result.value, r2Result.value)).toBe(true);
      }
    });

    it('возвращает false для неравных Ratio', () => {
      const r1Result = RatioService.fromDecimal(0.02);
      const r2Result = RatioService.fromDecimal(0.03);
      
      if (r1Result.ok && r2Result.ok) {
        expect(RatioService.equals(r1Result.value, r2Result.value)).toBe(false);
      }
    });
  });

  describe('Never Throw Contract', () => {
    it('никогда не бросает исключения - все ошибки в Result', () => {
      expect(() => RatioService.fromDecimal(NaN)).not.toThrow();
      expect(() => RatioService.fromDecimal(Infinity)).not.toThrow();
      expect(() => RatioService.fromDecimal('invalid')).not.toThrow();
      expect(() => RatioService.fromPercent(NaN)).not.toThrow();
      expect(() => RatioService.fromBps(Infinity)).not.toThrow();
    });
  });
});
