import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { Quantity, QuantityInvariantViolation } from '../../../../src/quantity/core/Quantity.js';

describe('Quantity constructor', () => {
  describe('invariants', () => {
    it('должен бросить QuantityInvariantViolation для negative значения', () => {
      // Используем of() для доступа к конструктору
      expect(() => Quantity.of(-1)).toThrow(QuantityInvariantViolation);
      expect(() => Quantity.of(-1)).toThrow('cannot be negative');

      try {
        Quantity.of(-1);
      } catch (e) {
        expect(e).toBeInstanceOf(QuantityInvariantViolation);
        expect((e as QuantityInvariantViolation).reason).toBe('NEGATIVE');
      }
    });

    it('должен бросить QuantityInvariantViolation для Infinity', () => {
      expect(() => Quantity.of(Infinity)).toThrow(QuantityInvariantViolation);
      expect(() => Quantity.of(Infinity)).toThrow('must be finite');

      try {
        Quantity.of(Infinity);
      } catch (e) {
        expect(e).toBeInstanceOf(QuantityInvariantViolation);
        expect((e as QuantityInvariantViolation).reason).toBe('NON_FINITE');
      }
    });

    it('должен бросить QuantityInvariantViolation для NaN', () => {
      expect(() => Quantity.of(NaN)).toThrow(QuantityInvariantViolation);
      expect(() => Quantity.of(NaN)).toThrow('must be finite');

      try {
        Quantity.of(NaN);
      } catch (e) {
        expect(e).toBeInstanceOf(QuantityInvariantViolation);
        expect((e as QuantityInvariantViolation).reason).toBe('NON_FINITE');
      }
    });

    it('должен бросить QuantityInvariantViolation для -Infinity', () => {
      expect(() => Quantity.of(-Infinity)).toThrow(QuantityInvariantViolation);
    });

    it('должен принять 0', () => {
      expect(() => Quantity.of(0)).not.toThrow();
    });

    it('должен принять положительное число', () => {
      expect(() => Quantity.of(10)).not.toThrow();
      expect(() => Quantity.of(10.5)).not.toThrow();
    });
  });
});

describe('Quantity.of()', () => {
  it('должен создать Quantity из number', () => {
    const qty = Quantity.of(10);
    expect(qty).toBeInstanceOf(Quantity);
    expect(qty.value().toNumber()).toBe(10);
  });

  it('должен создать Quantity из string', () => {
    const qty = Quantity.of("15.5");
    expect(qty).toBeInstanceOf(Quantity);
    expect(qty.value().toString()).toBe("15.5");
  });

  it('должен создать Quantity из Decimal', () => {
    const decimal = new Decimal(20);
    const qty = Quantity.of(decimal);
    expect(qty).toBeInstanceOf(Quantity);
    expect(qty.value().toNumber()).toBe(20);
  });

  it('должен создать Quantity из большого числа в строке', () => {
    const qty = Quantity.of("12345678901234567890.123456789");
    expect(qty).toBeInstanceOf(Quantity);
    expect(qty.value().toString()).toBe("12345678901234567890.123456789");
  });

  it('должен бросить для invalid string', () => {
    expect(() => Quantity.of("not a number")).toThrow();
  });
});

describe('Quantity.fromDecimal()', () => {
  it('должен создать Quantity из Decimal', () => {
    const decimal = new Decimal(10);
    const qty = Quantity.fromDecimal(decimal);
    expect(qty).toBeInstanceOf(Quantity);
    expect(qty.value().toNumber()).toBe(10);
  });

  it('не должен клонировать Decimal (использует как есть)', () => {
    const decimal = new Decimal(10);
    const qty = Quantity.fromDecimal(decimal);
    // Проверяем что это тот же объект (ссылка)
    expect(qty.value()).toBe(decimal);
  });

  it('должен бросить для negative Decimal', () => {
    const decimal = new Decimal(-1);
    expect(() => Quantity.fromDecimal(decimal)).toThrow(QuantityInvariantViolation);
  });

  it('должен бросить для non-finite Decimal', () => {
    const decimal = new Decimal(Infinity);
    expect(() => Quantity.fromDecimal(decimal)).toThrow(QuantityInvariantViolation);
  });

  it('должен работать с результатом math операций', () => {
    const d1 = new Decimal(10);
    const d2 = new Decimal(5);
    const sum = d1.plus(d2); // Decimal math
    const qty = Quantity.fromDecimal(sum);
    expect(qty.value().toNumber()).toBe(15);
  });
});
