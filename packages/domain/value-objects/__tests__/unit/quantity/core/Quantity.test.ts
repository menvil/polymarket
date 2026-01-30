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

  it('должен создать Quantity из Decimal без повторного парсинга', () => {
    const decimal = new Decimal(20);
    const qty = Quantity.of(decimal);
    expect(qty).toBeInstanceOf(Quantity);
    expect(qty.value().toNumber()).toBe(20);
    // Проверяем что используется тот же объект (zero-copy оптимизация)
    expect(qty.value()).toBe(decimal);
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

describe('Quantity constants', () => {
  describe('ZERO', () => {
    it('должен быть Quantity с значением 0', () => {
      expect(Quantity.ZERO).toBeInstanceOf(Quantity);
      expect(Quantity.ZERO.value().toNumber()).toBe(0);
      expect(Quantity.ZERO.isZero()).toBe(true);
    });

    it('должен быть тот же объект при каждом обращении', () => {
      expect(Quantity.ZERO).toBe(Quantity.ZERO);
    });
  });

  describe('ONE', () => {
    it('должен быть Quantity с значением 1', () => {
      expect(Quantity.ONE).toBeInstanceOf(Quantity);
      expect(Quantity.ONE.value().toNumber()).toBe(1);
      expect(Quantity.ONE.isPositive()).toBe(true);
    });

    it('должен быть тот же объект при каждом обращении', () => {
      expect(Quantity.ONE).toBe(Quantity.ONE);
    });
  });
});

describe('Quantity.value()', () => {
  it('должен вернуть Decimal', () => {
    const qty = Quantity.of(10);
    const decimal = qty.value();
    expect(decimal).toBeInstanceOf(Decimal);
    expect(decimal.toNumber()).toBe(10);
  });

  it('должен вернуть тот же Decimal объект', () => {
    const decimal = new Decimal(10);
    const qty = Quantity.fromDecimal(decimal);
    expect(qty.value()).toBe(decimal);
  });
});

describe('Quantity.toNumber()', () => {
  it('должен вернуть number', () => {
    const qty = Quantity.of(10);
    const num = qty.toNumber();
    expect(typeof num).toBe('number');
    expect(num).toBe(10);
  });

  it('должен вернуть number для decimal значения', () => {
    const qty = Quantity.of(10.5);
    expect(qty.toNumber()).toBe(10.5);
  });

  it('может потерять точность для больших чисел', () => {
    const bigNum = "12345678901234567890.123456789";
    const qty = Quantity.of(bigNum);
    const num = qty.toNumber();
    const decimal = qty.value();

    // Decimal сохраняет точность
    expect(decimal.toString()).toBe(bigNum);

    // number может потерять точность (это ожидаемо)
    // Просто проверяем что преобразование работает
    expect(typeof num).toBe('number');
  });
});

describe('Quantity.equals()', () => {
  it('должен вернуть true для равных значений', () => {
    const qty1 = Quantity.of(10);
    const qty2 = Quantity.of(10);
    expect(qty1.equals(qty2)).toBe(true);
  });

  it('должен вернуть false для разных значений', () => {
    const qty1 = Quantity.of(10);
    const qty2 = Quantity.of(11);
    expect(qty1.equals(qty2)).toBe(false);
  });

  it('должен использовать точное сравнение (без epsilon)', () => {
    const qty1 = Quantity.of(10);
    const qty2 = Quantity.of(10.0000001);
    expect(qty1.equals(qty2)).toBe(false);
  });

  it('должен работать с константами', () => {
    const zero = Quantity.ZERO;
    const anotherZero = Quantity.of(0);
    expect(zero.equals(anotherZero)).toBe(true);
  });
});

describe('Quantity.isZero()', () => {
  it('должен вернуть true для нуля', () => {
    expect(Quantity.ZERO.isZero()).toBe(true);
    expect(Quantity.of(0).isZero()).toBe(true);
  });

  it('должен вернуть false для ненулевых значений', () => {
    expect(Quantity.of(1).isZero()).toBe(false);
    expect(Quantity.of(0.0001).isZero()).toBe(false);
  });
});

describe('Quantity.isPositive()', () => {
  it('должен вернуть true для положительных чисел', () => {
    expect(Quantity.of(10).isPositive()).toBe(true);
    expect(Quantity.of(0.0001).isPositive()).toBe(true);
    expect(Quantity.ONE.isPositive()).toBe(true);
  });

  it('должен вернуть false для нуля', () => {
    expect(Quantity.of(0).isPositive()).toBe(false);
    expect(Quantity.ZERO.isPositive()).toBe(false);
  });
});

describe('Quantity.isLessThan()', () => {
  it('должен вернуть true если this < other', () => {
    const qty1 = Quantity.of(5);
    const qty2 = Quantity.of(10);
    expect(qty1.isLessThan(qty2)).toBe(true);
  });

  it('должен вернуть false если this > other', () => {
    const qty1 = Quantity.of(10);
    const qty2 = Quantity.of(5);
    expect(qty1.isLessThan(qty2)).toBe(false);
  });

  it('должен вернуть false для равных значений', () => {
    const qty1 = Quantity.of(10);
    const qty2 = Quantity.of(10);
    expect(qty1.isLessThan(qty2)).toBe(false);
  });

  it('должен работать с константами', () => {
    expect(Quantity.ZERO.isLessThan(Quantity.ONE)).toBe(true);
    expect(Quantity.ONE.isLessThan(Quantity.ZERO)).toBe(false);
  });

  it('должен работать с decimal значениями', () => {
    const qty1 = Quantity.of("10.5");
    const qty2 = Quantity.of("10.6");
    expect(qty1.isLessThan(qty2)).toBe(true);
  });
});

describe('Quantity.isLessThanOrEqual()', () => {
  it('должен вернуть true если this < other', () => {
    const qty1 = Quantity.of(5);
    const qty2 = Quantity.of(10);
    expect(qty1.isLessThanOrEqual(qty2)).toBe(true);
  });

  it('должен вернуть false если this > other', () => {
    const qty1 = Quantity.of(10);
    const qty2 = Quantity.of(5);
    expect(qty1.isLessThanOrEqual(qty2)).toBe(false);
  });

  it('должен вернуть true для равных значений', () => {
    const qty1 = Quantity.of(10);
    const qty2 = Quantity.of(10);
    expect(qty1.isLessThanOrEqual(qty2)).toBe(true);
  });

  it('должен работать с константами', () => {
    expect(Quantity.ZERO.isLessThanOrEqual(Quantity.ONE)).toBe(true);
    expect(Quantity.ZERO.isLessThanOrEqual(Quantity.ZERO)).toBe(true);
    expect(Quantity.ONE.isLessThanOrEqual(Quantity.ZERO)).toBe(false);
  });
});

describe('Quantity.isGreaterThan()', () => {
  it('должен вернуть true если this > other', () => {
    const qty1 = Quantity.of(10);
    const qty2 = Quantity.of(5);
    expect(qty1.isGreaterThan(qty2)).toBe(true);
  });

  it('должен вернуть false если this < other', () => {
    const qty1 = Quantity.of(5);
    const qty2 = Quantity.of(10);
    expect(qty1.isGreaterThan(qty2)).toBe(false);
  });

  it('должен вернуть false для равных значений', () => {
    const qty1 = Quantity.of(10);
    const qty2 = Quantity.of(10);
    expect(qty1.isGreaterThan(qty2)).toBe(false);
  });

  it('должен работать с константами', () => {
    expect(Quantity.ONE.isGreaterThan(Quantity.ZERO)).toBe(true);
    expect(Quantity.ZERO.isGreaterThan(Quantity.ONE)).toBe(false);
  });

  it('должен работать с decimal значениями', () => {
    const qty1 = Quantity.of("10.6");
    const qty2 = Quantity.of("10.5");
    expect(qty1.isGreaterThan(qty2)).toBe(true);
  });
});

describe('Quantity.isGreaterThanOrEqual()', () => {
  it('должен вернуть true если this > other', () => {
    const qty1 = Quantity.of(10);
    const qty2 = Quantity.of(5);
    expect(qty1.isGreaterThanOrEqual(qty2)).toBe(true);
  });

  it('должен вернуть false если this < other', () => {
    const qty1 = Quantity.of(5);
    const qty2 = Quantity.of(10);
    expect(qty1.isGreaterThanOrEqual(qty2)).toBe(false);
  });

  it('должен вернуть true для равных значений', () => {
    const qty1 = Quantity.of(10);
    const qty2 = Quantity.of(10);
    expect(qty1.isGreaterThanOrEqual(qty2)).toBe(true);
  });

  it('должен работать с константами', () => {
    expect(Quantity.ONE.isGreaterThanOrEqual(Quantity.ZERO)).toBe(true);
    expect(Quantity.ONE.isGreaterThanOrEqual(Quantity.ONE)).toBe(true);
    expect(Quantity.ZERO.isGreaterThanOrEqual(Quantity.ONE)).toBe(false);
  });
});
