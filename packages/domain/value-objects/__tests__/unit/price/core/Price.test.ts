import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { Price, PriceInvariantViolation } from '../../../../src/price/core/Price.js';

describe('Price constructor', () => {
  describe('invariants', () => {
    it('должен бросить PriceInvariantViolation для значения ниже минимума', () => {
      expect(() => Price.of(new Decimal(0.00001))).toThrow(PriceInvariantViolation);
      expect(() => Price.of(new Decimal(0.00001))).toThrow('below minimum');
    });

    it('должен бросить PriceInvariantViolation для значения выше максимума', () => {
      expect(() => Price.of(new Decimal(1.0))).toThrow(PriceInvariantViolation);
      expect(() => Price.of(new Decimal(1.0))).toThrow('exceeds maximum');
    });

    it('должен бросить PriceInvariantViolation для Infinity', () => {
      expect(() => Price.of(new Decimal(Infinity))).toThrow(PriceInvariantViolation);
      expect(() => Price.of(new Decimal(Infinity))).toThrow('must be finite');
    });

    it('должен бросить PriceInvariantViolation для NaN', () => {
      expect(() => Price.of(new Decimal(NaN))).toThrow(PriceInvariantViolation);
      expect(() => Price.of(new Decimal(NaN))).toThrow('cannot be NaN');
    });

    it('должен бросить PriceInvariantViolation для -Infinity', () => {
      expect(() => Price.of(new Decimal(-Infinity))).toThrow(PriceInvariantViolation);
    });

    it('должен принять минимальное значение 0.0001', () => {
      expect(() => Price.of(new Decimal(0.0001))).not.toThrow();
    });

    it('должен принять максимальное значение 0.9999', () => {
      expect(() => Price.of(new Decimal(0.9999))).not.toThrow();
    });

    it('должен принять значение в середине диапазона', () => {
      expect(() => Price.of(new Decimal(0.5))).not.toThrow();
    });
  });
});

describe('Price.of()', () => {
  it('должен создать Price из number', () => {
    const price = Price.of(new Decimal(0.5));
    expect(price).toBeInstanceOf(Price);
    expect(price.toNumber()).toBe(0.5);
  });

  it('должен создать Price из string', () => {
    const price = Price.of(new Decimal("0.5"));
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

describe('Price.MIN', () => {
  it('должен вернуть Price с минимальным значением', () => {
    const price = Price.MIN;
    expect(price).toBeInstanceOf(Price);
    expect(price.toNumber()).toBe(0.0001);
  });

  it('должен вернуть тот же экземпляр при каждом обращении (singleton)', () => {
    const price1 = Price.MIN;
    const price2 = Price.MIN;
    expect(price1).toBe(price2);
    expect(price1.equals(price2)).toBe(true);
  });
});

describe('Price.MAX', () => {
  it('должен вернуть Price с максимальным значением', () => {
    const price = Price.MAX;
    expect(price).toBeInstanceOf(Price);
    expect(price.toNumber()).toBe(0.9999);
  });

  it('должен вернуть тот же экземпляр при каждом обращении (singleton)', () => {
    const price1 = Price.MAX;
    const price2 = Price.MAX;
    expect(price1).toBe(price2);
    expect(price1.equals(price2)).toBe(true);
  });
});

describe('Price.HALF', () => {
  it('должен вернуть Price со значением 0.5', () => {
    const price = Price.HALF;
    expect(price).toBeInstanceOf(Price);
    expect(price.toNumber()).toBe(0.5);
  });

  it('должен вернуть тот же экземпляр при каждом обращении (singleton)', () => {
    const price1 = Price.HALF;
    const price2 = Price.HALF;
    expect(price1).toBe(price2);
    expect(price1.equals(price2)).toBe(true);
  });
});

describe('Price.MIN.value()', () => {
  it('должен вернуть Decimal константу минимального значения', () => {
    const minValue = Price.MIN.value();
    expect(minValue).toBeInstanceOf(Decimal);
    expect(minValue.toNumber()).toBe(0.0001);
  });

  it('должен возвращать тот же Decimal объект (shared константа)', () => {
    const minValue1 = Price.MIN.value();
    const minValue2 = Price.MIN.value();
    expect(minValue1).toBe(minValue2);
  });
});

describe('Price.MAX.value()', () => {
  it('должен вернуть Decimal константу максимального значения', () => {
    const maxValue = Price.MAX.value();
    expect(maxValue).toBeInstanceOf(Decimal);
    expect(maxValue.toNumber()).toBe(0.9999);
  });

  it('должен возвращать тот же Decimal объект (shared константа)', () => {
    const maxValue1 = Price.MAX.value();
    const maxValue2 = Price.MAX.value();
    expect(maxValue1).toBe(maxValue2);
  });
});

describe('Price.value()', () => {
  it('должен вернуть Decimal значение', () => {
    const price = Price.of(new Decimal(0.5));
    const value = price.value();
    expect(value).toBeInstanceOf(Decimal);
    expect(value.toNumber()).toBe(0.5);
  });
});

describe('Price.toNumber()', () => {
  it('должен вернуть number значение', () => {
    const price = Price.of(new Decimal(0.5));
    expect(price.toNumber()).toBe(0.5);
  });

  it('должен работать с минимальным значением', () => {
    const price = Price.MIN;
    expect(price.toNumber()).toBe(0.0001);
  });

  it('должен работать с максимальным значением', () => {
    const price = Price.MAX;
    expect(price.toNumber()).toBe(0.9999);
  });
});

describe('Price.equals()', () => {
  it('должен вернуть true для равных значений', () => {
    const price1 = Price.of(new Decimal(0.5));
    const price2 = Price.of(new Decimal(0.5));
    expect(price1.equals(price2)).toBe(true);
  });

  it('должен вернуть false для разных значений', () => {
    const price1 = Price.of(new Decimal(0.5));
    const price2 = Price.of(new Decimal(0.6));
    expect(price1.equals(price2)).toBe(false);
  });

  it('должен вернуть true для того же экземпляра', () => {
    const price = Price.of(new Decimal(0.5));
    expect(price.equals(price)).toBe(true);
  });

  it('должен использовать строгое равенство Decimal', () => {
    const price1 = Price.of(new Decimal("0.5"));
    const price2 = Price.of(new Decimal("0.50"));
    expect(price1.equals(price2)).toBe(true);
  });
});

describe('Price.isZero()', () => {
  it('должен вернуть false для любой цены (Price не может быть 0)', () => {
    const price1 = Price.MIN;
    expect(price1.isZero()).toBe(false);

    const price2 = Price.of(new Decimal(0.5));
    expect(price2.isZero()).toBe(false);

    const price3 = Price.MAX;
    expect(price3.isZero()).toBe(false);
  });
});

describe('Price.isMin()', () => {
  it('должен вернуть true для минимального значения', () => {
    const price = Price.MIN;
    expect(price.isMin()).toBe(true);
  });

  it('должен вернуть true для значения равного минимуму', () => {
    const price = Price.of(new Decimal(0.0001));
    expect(price.isMin()).toBe(true);
  });

  it('должен вернуть false для не-минимального значения', () => {
    const price = Price.of(new Decimal(0.5));
    expect(price.isMin()).toBe(false);
  });
});

describe('Price.isMax()', () => {
  it('должен вернуть true для максимального значения', () => {
    const price = Price.MAX;
    expect(price.isMax()).toBe(true);
  });

  it('должен вернуть true для значения равного максимуму', () => {
    const price = Price.of(new Decimal(0.9999));
    expect(price.isMax()).toBe(true);
  });

  it('должен вернуть false для не-максимального значения', () => {
    const price = Price.of(new Decimal(0.5));
    expect(price.isMax()).toBe(false);
  });
});

describe('Price comparison methods', () => {
  describe('isLessThan()', () => {
    it('должен вернуть true если this < other', () => {
      const p1 = Price.of(new Decimal(0.5));
      const p2 = Price.of(new Decimal(0.6));
      expect(p1.isLessThan(p2)).toBe(true);
      expect(p2.isLessThan(p1)).toBe(false);
    });
  });

  describe('isLessThanOrEqual()', () => {
    it('должен вернуть true если this <= other', () => {
      const p1 = Price.of(new Decimal(0.5));
      const p2 = Price.of(new Decimal(0.5));
      expect(p1.isLessThanOrEqual(p2)).toBe(true);
    });
  });

  describe('isGreaterThan()', () => {
    it('должен вернуть true если this > other', () => {
      const p1 = Price.of(new Decimal(0.6));
      const p2 = Price.of(new Decimal(0.5));
      expect(p1.isGreaterThan(p2)).toBe(true);
      expect(p2.isGreaterThan(p1)).toBe(false);
    });
  });

  describe('isGreaterThanOrEqual()', () => {
    it('должен вернуть true если this >= other', () => {
      const p1 = Price.of(new Decimal(0.5));
      const p2 = Price.of(new Decimal(0.5));
      expect(p1.isGreaterThanOrEqual(p2)).toBe(true);
    });
  });
});
