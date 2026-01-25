/**
 * Тесты для Percentage value object
 */

import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { unwrap } from '@polymarket/result';
import { Percentage } from '../../src/Percentage';
import {
  InvalidPercentageError,
  DivisionByZeroError,
} from '@polymarket/errors';

describe('Percentage', () => {
  describe('Фабричные методы', () => {
    describe('fromValue', () => {
      it('должен создать Percentage из положительного числа', () => {
        const result = Percentage.fromValue(25.5);

        expect(result.ok).toBe(true);
        if (result.ok) {
          const pct = result.value;
          expect(pct.getValue()).toBe(25.5);
        }
      });

      it('должен создать Percentage из нуля', () => {
        const result = Percentage.fromValue(0);

        expect(result.ok).toBe(true);
        if (result.ok) {
          const pct = result.value;
          expect(pct.isZero()).toBe(true);
        }
      });

      it('должен создать Percentage из отрицательного числа', () => {
        const result = Percentage.fromValue(-10);

        expect(result.ok).toBe(true);
        if (result.ok) {
          const pct = result.value;
          expect(pct.getValue()).toBe(-10);
          expect(pct.isNegative()).toBe(true);
        }
      });

      it('должен отклонить NaN', () => {
        const result = Percentage.fromValue(NaN);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidPercentageError);
        }
      });

      it('должен отклонить Infinity', () => {
        const result = Percentage.fromValue(Infinity);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidPercentageError);
        }
      });
    });

    describe('fromDecimal', () => {
      it('должен создать из десятичной дроби', () => {
        const result = Percentage.fromDecimal(0.5);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.getValue()).toBe(50);
        }
      });

      it('должен создать из малой дроби', () => {
        const result = Percentage.fromDecimal(0.025);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.getValue()).toBe(2.5);
        }
      });
    });

    describe('ZERO и ONE_HUNDRED', () => {
      it('ZERO должен быть нулевым процентом', () => {
        expect(Percentage.ZERO.getValue()).toBe(0);
        expect(Percentage.ZERO.isZero()).toBe(true);
      });

      it('ONE_HUNDRED должен быть 100%', () => {
        expect(Percentage.ONE_HUNDRED.getValue()).toBe(100);
      });
    });

    describe('fromBasisPoints', () => {
      it('должен создать процент из 100 базисных пунктов (1%)', () => {
        const result = Percentage.fromBasisPoints(100);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.getValue()).toBe(1);
        }
      });

      it('должен создать процент из 250 базисных пунктов (2.5%)', () => {
        const result = Percentage.fromBasisPoints(250);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.getValue()).toBe(2.5);
        }
      });

      it('должен создать процент из 10000 базисных пунктов (100%)', () => {
        const result = Percentage.fromBasisPoints(10000);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.getValue()).toBe(100);
        }
      });

      it('должен создать процент из 0 базисных пунктов (0%)', () => {
        const result = Percentage.fromBasisPoints(0);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.getValue()).toBe(0);
          expect(result.value.isZero()).toBe(true);
        }
      });

      it('должен создать процент из 50 базисных пунктов (0.5%)', () => {
        const result = Percentage.fromBasisPoints(50);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.getValue()).toBe(0.5);
        }
      });

      it('должен отклонить NaN', () => {
        const result = Percentage.fromBasisPoints(NaN);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidPercentageError);
        }
      });

      it('должен отклонить Infinity', () => {
        const result = Percentage.fromBasisPoints(Infinity);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(InvalidPercentageError);
        }
      });
    });

    describe('toBasisPoints', () => {
      it('должен вернуть 0 для ZERO', () => {
        const bps = Percentage.ZERO.toBasisPoints();

        expect(bps.toNumber()).toBe(0);
      });

      it('должен вернуть 10000 для ONE_HUNDRED', () => {
        const bps = Percentage.ONE_HUNDRED.toBasisPoints();

        expect(bps.toNumber()).toBe(10000);
      });

      it('должен вернуть 100 для 1%', () => {
        const pct = unwrap(Percentage.fromValue(1));
        const bps = pct.toBasisPoints();

        expect(bps.toNumber()).toBe(100);
      });

      it('должен вернуть 250 для 2.5%', () => {
        const pct = unwrap(Percentage.fromValue(2.5));
        const bps = pct.toBasisPoints();

        expect(bps.toNumber()).toBe(250);
      });

      it('должен вернуть 50 для 0.5%', () => {
        const pct = unwrap(Percentage.fromValue(0.5));
        const bps = pct.toBasisPoints();

        expect(bps.toNumber()).toBe(50);
      });
    });

    describe('toDecimalFraction', () => {
      it('должен вернуть 0 для ZERO', () => {
        const decimal = Percentage.ZERO.toDecimalFraction();

        expect(decimal.toNumber()).toBe(0);
      });

      it('должен вернуть 1 для ONE_HUNDRED', () => {
        const decimal = Percentage.ONE_HUNDRED.toDecimalFraction();

        expect(decimal.toNumber()).toBe(1);
      });

      it('должен вернуть 0.01 для 1%', () => {
        const pct = unwrap(Percentage.fromValue(1));
        const decimal = pct.toDecimalFraction();

        expect(decimal.toNumber()).toBe(0.01);
      });

      it('должен вернуть 0.025 для 2.5%', () => {
        const pct = unwrap(Percentage.fromValue(2.5));
        const decimal = pct.toDecimalFraction();

        expect(decimal.toNumber()).toBe(0.025);
      });

      it('должен вернуть 0.005 для 0.5%', () => {
        const pct = unwrap(Percentage.fromValue(0.5));
        const decimal = pct.toDecimalFraction();

        expect(decimal.toNumber()).toBe(0.005);
      });

      it('должен вернуть 0.5 для 50%', () => {
        const pct = unwrap(Percentage.fromValue(50));
        const decimal = pct.toDecimalFraction();

        expect(decimal.toNumber()).toBe(0.5);
      });
    });

    describe('Round-trip: fromBasisPoints -> toBasisPoints', () => {
      it('должен сохранить значение при преобразовании 100 bps', () => {
        const original = 100;
        const pct = unwrap(Percentage.fromBasisPoints(original));
        const roundtrip = pct.toBasisPoints().toNumber();

        expect(roundtrip).toBe(original);
      });

      it('должен сохранить значение при преобразовании 250 bps', () => {
        const original = 250;
        const pct = unwrap(Percentage.fromBasisPoints(original));
        const roundtrip = pct.toBasisPoints().toNumber();

        expect(roundtrip).toBe(original);
      });

      it('должен сохранить значение при преобразовании 10000 bps', () => {
        const original = 10000;
        const pct = unwrap(Percentage.fromBasisPoints(original));
        const roundtrip = pct.toBasisPoints().toNumber();

        expect(roundtrip).toBe(original);
      });

      it('должен сохранить значение при преобразовании 0 bps', () => {
        const original = 0;
        const pct = unwrap(Percentage.fromBasisPoints(original));
        const roundtrip = pct.toBasisPoints().toNumber();

        expect(roundtrip).toBe(original);
      });
    });

    describe('Взаимосвязь fromBasisPoints и toDecimalFraction', () => {
      it('100 bps (1%) должны дать 0.01 в decimal fraction', () => {
        const pct = unwrap(Percentage.fromBasisPoints(100));
        const decimal = pct.toDecimalFraction();

        expect(decimal.toNumber()).toBe(0.01);
      });

      it('250 bps (2.5%) должны дать 0.025 в decimal fraction', () => {
        const pct = unwrap(Percentage.fromBasisPoints(250));
        const decimal = pct.toDecimalFraction();

        expect(decimal.toNumber()).toBe(0.025);
      });

      it('10000 bps (100%) должны дать 1.0 в decimal fraction', () => {
        const pct = unwrap(Percentage.fromBasisPoints(10000));
        const decimal = pct.toDecimalFraction();

        expect(decimal.toNumber()).toBe(1.0);
      });

      it('0 bps (0%) должны дать 0.0 в decimal fraction', () => {
        const pct = unwrap(Percentage.fromBasisPoints(0));
        const decimal = pct.toDecimalFraction();

        expect(decimal.toNumber()).toBe(0);
      });

      it('50 bps (0.5%) должны дать 0.005 в decimal fraction', () => {
        const pct = unwrap(Percentage.fromBasisPoints(50));
        const decimal = pct.toDecimalFraction();

        expect(decimal.toNumber()).toBe(0.005);
      });
    });
  });

  describe('Математические операции', () => {
    describe('add', () => {
      it('должен сложить два процента', () => {
        const p1 = unwrap(Percentage.fromValue(10));
        const p2 = unwrap(Percentage.fromValue(5));

        const result = p1.add(p2);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.getValue()).toBe(15);
        }
      });
    });

    describe('subtract', () => {
      it('должен вычесть два процента', () => {
        const p1 = unwrap(Percentage.fromValue(10));
        const p2 = unwrap(Percentage.fromValue(3));

        const result = p1.subtract(p2);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.getValue()).toBe(7);
        }
      });
    });

    describe('multiply', () => {
      it('должен умножать на число', () => {
        const pct = unwrap(Percentage.fromValue(10));

        const result = pct.multiply(2);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.getValue()).toBe(20);
        }
      });
    });

    describe('divide', () => {
      it('должен делить на число', () => {
        const pct = unwrap(Percentage.fromValue(10));

        const result = pct.divide(2);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.getValue()).toBe(5);
        }
      });

      it('должен отклонять деление на ноль', () => {
        const pct = unwrap(Percentage.fromValue(10));

        const result = pct.divide(0);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(DivisionByZeroError);
        }
      });

      it('должен отклонять деление на NaN', () => {
        const pct = unwrap(Percentage.fromValue(10));

        const result = pct.divide(NaN);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(DivisionByZeroError);
          expect(result.error.message).toContain('must be a finite number');
        }
      });

      it('должен отклонять деление на Infinity', () => {
        const pct = unwrap(Percentage.fromValue(10));

        const result = pct.divide(Infinity);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(DivisionByZeroError);
          expect(result.error.message).toContain('must be a finite number');
        }
      });

      it('должен отклонять деление на -Infinity', () => {
        const pct = unwrap(Percentage.fromValue(10));

        const result = pct.divide(-Infinity);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(DivisionByZeroError);
          expect(result.error.message).toContain('must be a finite number');
        }
      });

      it('должен отклонять деление на Decimal NaN', () => {
        const pct = unwrap(Percentage.fromValue(10));

        const result = pct.divide(new Decimal(NaN));

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(DivisionByZeroError);
          expect(result.error.message).toContain('must be a finite number');
        }
      });
    });

    describe('of', () => {
      it('должен вычислять процент от значения', () => {
        const pct = unwrap(Percentage.fromValue(10));

        const result = pct.of(1000);

        expect(Number(result)).toBe(100);
      });
    });
  });

  describe('Утилиты', () => {
    describe('isZero', () => {
      it('должен возвращать true для нуля', () => {
        expect(Percentage.ZERO.isZero()).toBe(true);
      });

      it('должен возвращать false для ненулевого', () => {
        const pct = unwrap(Percentage.fromValue(10));
        expect(pct.isZero()).toBe(false);
      });
    });

    describe('isPositive', () => {
      it('должен возвращать true для положительного', () => {
        const pct = unwrap(Percentage.fromValue(10));
        expect(pct.isPositive()).toBe(true);
      });

      it('должен возвращать false для нуля', () => {
        expect(Percentage.ZERO.isPositive()).toBe(false);
      });
    });

    describe('isNegative', () => {
      it('должен возвращать true для отрицательного', () => {
        const pct = unwrap(Percentage.fromValue(-10));
        expect(pct.isNegative()).toBe(true);
      });

      it('должен возвращать false для нуля', () => {
        expect(Percentage.ZERO.isNegative()).toBe(false);
      });
    });

    describe('toString', () => {
      it('должен форматировать с символом %', () => {
        const pct = unwrap(Percentage.fromValue(25.5));
        expect(pct.toString()).toContain('25.5');
        expect(pct.toString()).toContain('%');
      });
    });
  });

  describe('Сериализация', () => {
    describe('toJSON', () => {
      it('должен сериализовать процент в JSON', () => {
        const pct = unwrap(Percentage.fromValue(50));
        const json = pct.toJSON();

        expect(json).toEqual({ value: 50 });
      });
    });

    describe('fromJSON', () => {
      it('должен десериализовать валидный процент из JSON', () => {
        const json = { value: 50 };
        const result = Percentage.fromJSON(json);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.getValue()).toBe(50);
        }
      });
    });
  });
});
