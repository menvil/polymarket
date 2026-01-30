import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { Price, PriceInvariantViolation } from '../../../../src/price/core/Price.js';

describe('Price constructor', () => {
  describe('invariants', () => {
    it('должен бросить PriceInvariantViolation для значения ниже минимума', () => {
      expect(() => Price.of(0.00001)).toThrow(PriceInvariantViolation);
      expect(() => Price.of(0.00001)).toThrow('below minimum');
    });

    it('должен бросить PriceInvariantViolation для значения выше максимума', () => {
      expect(() => Price.of(1.0)).toThrow(PriceInvariantViolation);
      expect(() => Price.of(1.0)).toThrow('exceeds maximum');
    });

    it('должен бросить PriceInvariantViolation для Infinity', () => {
      expect(() => Price.of(Infinity)).toThrow(PriceInvariantViolation);
      expect(() => Price.of(Infinity)).toThrow('must be finite');
    });

    it('должен бросить PriceInvariantViolation для NaN', () => {
      expect(() => Price.of(NaN)).toThrow(PriceInvariantViolation);
      expect(() => Price.of(NaN)).toThrow('cannot be NaN');
    });

    it('должен бросить PriceInvariantViolation для -Infinity', () => {
      expect(() => Price.of(-Infinity)).toThrow(PriceInvariantViolation);
    });

    it('должен принять минимальное значение 0.0001', () => {
      expect(() => Price.of(0.0001)).not.toThrow();
    });

    it('должен принять максимальное значение 0.9999', () => {
      expect(() => Price.of(0.9999)).not.toThrow();
    });

    it('должен принять значение в середине диапазона', () => {
      expect(() => Price.of(0.5)).not.toThrow();
    });
  });
});

describe('Price.of()', () => {
  it('должен создать Price из number', () => {
    const price = Price.of(0.5);
    expect(price).toBeInstanceOf(Price);
    expect(price.toNumber()).toBe(0.5);
  });

  it('должен создать Price из string', () => {
    const price = Price.of("0.5");
    expect(price).toBeInstanceOf(Price);
    expect(price.value().toString()).toBe("0.5");
  });

  it('должен создать Price из Decimal без повторного парсинга', () => {
    const decimal = new Decimal(0.5);
    const price = Price.of(decimal);
    expect(price).toBeInstanceOf(Price);
    expect(price.toNumber()).toBe(0.5);
    // Проверяем что используется тот же объект (zero-copy оптимизация)
    expect(price.value()).toBe(decimal);
  });
});

describe('Price.min()', () => {
  it('должен вернуть Price с минимальным значением', () => {
    const price = Price.min();
    expect(price).toBeInstanceOf(Price);
    expect(price.toNumber()).toBe(0.0001);
  });

  it('должен вернуть новый экземпляр при каждом вызове', () => {
    const price1 = Price.min();
    const price2 = Price.min();
    expect(price1).not.toBe(price2);
    expect(price1.equals(price2)).toBe(true);
  });
});

describe('Price.max()', () => {
  it('должен вернуть Price с максимальным значением', () => {
    const price = Price.max();
    expect(price).toBeInstanceOf(Price);
    expect(price.toNumber()).toBe(0.9999);
  });

  it('должен вернуть новый экземпляр при каждом вызове', () => {
    const price1 = Price.max();
    const price2 = Price.max();
    expect(price1).not.toBe(price2);
    expect(price1.equals(price2)).toBe(true);
  });
});

describe('Price.half()', () => {
  it('должен вернуть Price со значением 0.5', () => {
    const price = Price.half();
    expect(price).toBeInstanceOf(Price);
    expect(price.toNumber()).toBe(0.5);
  });

  it('должен вернуть новый экземпляр при каждом вызове', () => {
    const price1 = Price.half();
    const price2 = Price.half();
    expect(price1).not.toBe(price2);
    expect(price1.equals(price2)).toBe(true);
  });
});

describe('Price.minValue()', () => {
  it('должен вернуть Decimal константу минимального значения', () => {
    const minValue = Price.minValue();
    expect(minValue).toBeInstanceOf(Decimal);
    expect(minValue.toNumber()).toBe(0.0001);
  });

  it('должен возвращать тот же Decimal объект (shared константа)', () => {
    const minValue1 = Price.minValue();
    const minValue2 = Price.minValue();
    expect(minValue1).toBe(minValue2);
  });
});

describe('Price.maxValue()', () => {
  it('должен вернуть Decimal константу максимального значения', () => {
    const maxValue = Price.maxValue();
    expect(maxValue).toBeInstanceOf(Decimal);
    expect(maxValue.toNumber()).toBe(0.9999);
  });

  it('должен возвращать тот же Decimal объект (shared константа)', () => {
    const maxValue1 = Price.maxValue();
    const maxValue2 = Price.maxValue();
    expect(maxValue1).toBe(maxValue2);
  });
});

describe('Price.value()', () => {
  it('должен вернуть Decimal значение', () => {
    const price = Price.of(0.5);
    const value = price.value();
    expect(value).toBeInstanceOf(Decimal);
    expect(value.toNumber()).toBe(0.5);
  });
});

describe('Price.toNumber()', () => {
  it('должен вернуть number значение', () => {
    const price = Price.of(0.5);
    expect(price.toNumber()).toBe(0.5);
  });

  it('должен работать с минимальным значением', () => {
    const price = Price.min();
    expect(price.toNumber()).toBe(0.0001);
  });

  it('должен работать с максимальным значением', () => {
    const price = Price.max();
    expect(price.toNumber()).toBe(0.9999);
  });
});

describe('Price.equals()', () => {
  it('должен вернуть true для равных значений', () => {
    const price1 = Price.of(0.5);
    const price2 = Price.of(0.5);
    expect(price1.equals(price2)).toBe(true);
  });

  it('должен вернуть false для разных значений', () => {
    const price1 = Price.of(0.5);
    const price2 = Price.of(0.6);
    expect(price1.equals(price2)).toBe(false);
  });

  it('должен вернуть true для того же экземпляра', () => {
    const price = Price.of(0.5);
    expect(price.equals(price)).toBe(true);
  });

  it('должен использовать строгое равенство Decimal', () => {
    const price1 = Price.of("0.5");
    const price2 = Price.of("0.50");
    expect(price1.equals(price2)).toBe(true);
  });
});

describe('Price.isMin()', () => {
  it('должен вернуть true для минимального значения', () => {
    const price = Price.min();
    expect(price.isMin()).toBe(true);
  });

  it('должен вернуть true для значения равного минимуму', () => {
    const price = Price.of(0.0001);
    expect(price.isMin()).toBe(true);
  });

  it('должен вернуть false для не-минимального значения', () => {
    const price = Price.of(0.5);
    expect(price.isMin()).toBe(false);
  });
});

describe('Price.isMax()', () => {
  it('должен вернуть true для максимального значения', () => {
    const price = Price.max();
    expect(price.isMax()).toBe(true);
  });

  it('должен вернуть true для значения равного максимуму', () => {
    const price = Price.of(0.9999);
    expect(price.isMax()).toBe(true);
  });

  it('должен вернуть false для не-максимального значения', () => {
    const price = Price.of(0.5);
    expect(price.isMax()).toBe(false);
  });
});

describe('Price.isLessThan()', () => {
  it('должен вернуть true если this < other', () => {
    const price1 = Price.of(0.3);
    const price2 = Price.of(0.5);
    expect(price1.isLessThan(price2)).toBe(true);
  });

  it('должен вернуть false если this > other', () => {
    const price1 = Price.of(0.7);
    const price2 = Price.of(0.3);
    expect(price1.isLessThan(price2)).toBe(false);
  });

  it('должен вернуть false для равных значений', () => {
    const price1 = Price.of(0.5);
    const price2 = Price.of(0.5);
    expect(price1.isLessThan(price2)).toBe(false);
  });

  it('должен работать с min и max', () => {
    expect(Price.min().isLessThan(Price.max())).toBe(true);
    expect(Price.max().isLessThan(Price.min())).toBe(false);
  });

  it('должен работать с decimal значениями', () => {
    const price1 = Price.of('0.1234');
    const price2 = Price.of('0.1235');
    expect(price1.isLessThan(price2)).toBe(true);
  });
});

describe('Price.isLessThanOrEqual()', () => {
  it('должен вернуть true если this < other', () => {
    const price1 = Price.of(0.3);
    const price2 = Price.of(0.5);
    expect(price1.isLessThanOrEqual(price2)).toBe(true);
  });

  it('должен вернуть false если this > other', () => {
    const price1 = Price.of(0.7);
    const price2 = Price.of(0.3);
    expect(price1.isLessThanOrEqual(price2)).toBe(false);
  });

  it('должен вернуть true для равных значений', () => {
    const price1 = Price.of(0.5);
    const price2 = Price.of(0.5);
    expect(price1.isLessThanOrEqual(price2)).toBe(true);
  });

  it('должен работать с min и max', () => {
    expect(Price.min().isLessThanOrEqual(Price.max())).toBe(true);
    expect(Price.min().isLessThanOrEqual(Price.min())).toBe(true);
    expect(Price.max().isLessThanOrEqual(Price.min())).toBe(false);
  });
});

describe('Price.isGreaterThan()', () => {
  it('должен вернуть true если this > other', () => {
    const price1 = Price.of(0.7);
    const price2 = Price.of(0.3);
    expect(price1.isGreaterThan(price2)).toBe(true);
  });

  it('должен вернуть false если this < other', () => {
    const price1 = Price.of(0.3);
    const price2 = Price.of(0.7);
    expect(price1.isGreaterThan(price2)).toBe(false);
  });

  it('должен вернуть false для равных значений', () => {
    const price1 = Price.of(0.5);
    const price2 = Price.of(0.5);
    expect(price1.isGreaterThan(price2)).toBe(false);
  });

  it('должен работать с min и max', () => {
    expect(Price.max().isGreaterThan(Price.min())).toBe(true);
    expect(Price.min().isGreaterThan(Price.max())).toBe(false);
  });

  it('должен работать с decimal значениями', () => {
    const price1 = Price.of('0.5678');
    const price2 = Price.of('0.5677');
    expect(price1.isGreaterThan(price2)).toBe(true);
  });
});

describe('Price.isGreaterThanOrEqual()', () => {
  it('должен вернуть true если this > other', () => {
    const price1 = Price.of(0.7);
    const price2 = Price.of(0.3);
    expect(price1.isGreaterThanOrEqual(price2)).toBe(true);
  });

  it('должен вернуть false если this < other', () => {
    const price1 = Price.of(0.3);
    const price2 = Price.of(0.7);
    expect(price1.isGreaterThanOrEqual(price2)).toBe(false);
  });

  it('должен вернуть true для равных значений', () => {
    const price1 = Price.of(0.5);
    const price2 = Price.of(0.5);
    expect(price1.isGreaterThanOrEqual(price2)).toBe(true);
  });

  it('должен работать с min и max', () => {
    expect(Price.max().isGreaterThanOrEqual(Price.min())).toBe(true);
    expect(Price.max().isGreaterThanOrEqual(Price.max())).toBe(true);
    expect(Price.min().isGreaterThanOrEqual(Price.max())).toBe(false);
  });
});
