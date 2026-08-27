import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { OutcomePrice } from '../../../../src/outcome-price/core/OutcomePrice.js';
import { OutcomePriceInvariantViolation } from '../../../../src/outcome-price/core/OutcomePriceInvariantViolation.js';

describe('OutcomePrice constructor', () => {
  describe('invariants', () => {
    it('должен бросить OutcomePriceInvariantViolation для значения ниже минимума', () => {
      const belowMin = new Decimal(0.00001);
      expect(() => OutcomePrice.of(belowMin)).toThrow(OutcomePriceInvariantViolation);
      expect(() => OutcomePrice.of(belowMin)).toThrow('below minimum');
    });

    it('должен бросить OutcomePriceInvariantViolation для значения выше максимума', () => {
      const aboveMax = new Decimal(1.0);
      expect(() => OutcomePrice.of(aboveMax)).toThrow(OutcomePriceInvariantViolation);
      expect(() => OutcomePrice.of(aboveMax)).toThrow('exceeds maximum');
    });

    it('должен бросить OutcomePriceInvariantViolation для Infinity', () => {
      const inf = new Decimal(Infinity);
      expect(() => OutcomePrice.of(inf)).toThrow(OutcomePriceInvariantViolation);
      expect(() => OutcomePrice.of(inf)).toThrow('must be finite');
    });

    it('должен бросить OutcomePriceInvariantViolation для NaN', () => {
      const nan = new Decimal(NaN);
      expect(() => OutcomePrice.of(nan)).toThrow(OutcomePriceInvariantViolation);
      expect(() => OutcomePrice.of(nan)).toThrow('cannot be NaN');
    });

    it('должен бросить OutcomePriceInvariantViolation для -Infinity', () => {
      expect(() => OutcomePrice.of(new Decimal(-Infinity))).toThrow(OutcomePriceInvariantViolation);
    });

    it('должен принять минимальное значение 0.0001', () => {
      expect(() => OutcomePrice.of(new Decimal(0.0001))).not.toThrow();
    });

    it('должен принять максимальное значение 0.9999', () => {
      expect(() => OutcomePrice.of(new Decimal(0.9999))).not.toThrow();
    });

    it('должен принять значение в середине диапазона', () => {
      expect(() => OutcomePrice.of(new Decimal(0.5))).not.toThrow();
    });
  });
});

describe('OutcomePrice.of()', () => {
  it('должен создать OutcomePrice из Decimal (числовое значение)', () => {
    const price = OutcomePrice.of(new Decimal(0.5));
    expect(price).toBeInstanceOf(OutcomePrice);
    expect(price.toNumber()).toBe(0.5);
  });

  it('должен создать OutcomePrice из Decimal (строковое значение)', () => {
    const price = OutcomePrice.of(new Decimal("0.5"));
    expect(price).toBeInstanceOf(OutcomePrice);
    expect(price.value().toString()).toBe("0.5");
  });

  it('должен создать OutcomePrice из Decimal без повторного парсинга', () => {
    const decimal = new Decimal(0.5);
    const price = OutcomePrice.of(decimal);
    expect(price).toBeInstanceOf(OutcomePrice);
    expect(price.toNumber()).toBe(0.5);
    // Проверяем что значение совпадает
    expect(price.value().equals(decimal)).toBe(true);
  });
});

describe('OutcomePrice.MIN', () => {
  it('должен вернуть OutcomePrice с минимальным значением', () => {
    const price = OutcomePrice.MIN;
    expect(price).toBeInstanceOf(OutcomePrice);
    expect(price.toNumber()).toBe(0.0001);
  });

  it('должен вернуть тот же экземпляр при каждом обращении (singleton)', () => {
    const price1 = OutcomePrice.MIN;
    const price2 = OutcomePrice.MIN;
    expect(price1).toBe(price2);
    expect(price1.equals(price2)).toBe(true);
  });
});

describe('OutcomePrice.MAX', () => {
  it('должен вернуть OutcomePrice с максимальным значением', () => {
    const price = OutcomePrice.MAX;
    expect(price).toBeInstanceOf(OutcomePrice);
    expect(price.toNumber()).toBe(0.9999);
  });

  it('должен вернуть тот же экземпляр при каждом обращении (singleton)', () => {
    const price1 = OutcomePrice.MAX;
    const price2 = OutcomePrice.MAX;
    expect(price1).toBe(price2);
    expect(price1.equals(price2)).toBe(true);
  });
});

describe('OutcomePrice.HALF', () => {
  it('должен вернуть OutcomePrice со значением 0.5', () => {
    const price = OutcomePrice.HALF;
    expect(price).toBeInstanceOf(OutcomePrice);
    expect(price.toNumber()).toBe(0.5);
  });

  it('должен вернуть тот же экземпляр при каждом обращении (singleton)', () => {
    const price1 = OutcomePrice.HALF;
    const price2 = OutcomePrice.HALF;
    expect(price1).toBe(price2);
    expect(price1.equals(price2)).toBe(true);
  });
});

describe('OutcomePrice.MIN.value()', () => {
  it('должен вернуть Decimal константу минимального значения', () => {
    const minValue = OutcomePrice.MIN.value();
    expect(minValue).toBeInstanceOf(Decimal);
    expect(minValue.toNumber()).toBe(0.0001);
  });

  it('должен возвращать тот же Decimal объект (shared константа)', () => {
    const minValue1 = OutcomePrice.MIN.value();
    const minValue2 = OutcomePrice.MIN.value();
    expect(minValue1).toBe(minValue2);
  });
});

describe('OutcomePrice.MAX.value()', () => {
  it('должен вернуть Decimal константу максимального значения', () => {
    const maxValue = OutcomePrice.MAX.value();
    expect(maxValue).toBeInstanceOf(Decimal);
    expect(maxValue.toNumber()).toBe(0.9999);
  });

  it('должен возвращать тот же Decimal объект (shared константа)', () => {
    const maxValue1 = OutcomePrice.MAX.value();
    const maxValue2 = OutcomePrice.MAX.value();
    expect(maxValue1).toBe(maxValue2);
  });
});

describe('OutcomePrice.value()', () => {
  it('должен вернуть Decimal значение', () => {
    const price = OutcomePrice.of(new Decimal(0.5));
    const value = price.value();
    expect(value).toBeInstanceOf(Decimal);
    expect(value.toNumber()).toBe(0.5);
  });
});

describe('OutcomePrice.toNumber()', () => {
  it('должен вернуть number значение', () => {
    const price = OutcomePrice.of(new Decimal(0.5));
    expect(price.toNumber()).toBe(0.5);
  });

  it('должен работать с минимальным значением', () => {
    const price = OutcomePrice.MIN;
    expect(price.toNumber()).toBe(0.0001);
  });

  it('должен работать с максимальным значением', () => {
    const price = OutcomePrice.MAX;
    expect(price.toNumber()).toBe(0.9999);
  });
});

describe('OutcomePrice.equals()', () => {
  it('должен вернуть true для равных значений', () => {
    const price1 = OutcomePrice.of(new Decimal(0.5));
    const price2 = OutcomePrice.of(new Decimal(0.5));
    expect(price1.equals(price2)).toBe(true);
  });

  it('должен вернуть false для разных значений', () => {
    const price1 = OutcomePrice.of(new Decimal(0.5));
    const price2 = OutcomePrice.of(new Decimal(0.6));
    expect(price1.equals(price2)).toBe(false);
  });

  it('должен вернуть true для того же экземпляра', () => {
    const price = OutcomePrice.of(new Decimal(0.5));
    expect(price.equals(price)).toBe(true);
  });

  it('должен использовать строгое равенство Decimal', () => {
    const price1 = OutcomePrice.of(new Decimal("0.5"));
    const price2 = OutcomePrice.of(new Decimal("0.50"));
    expect(price1.equals(price2)).toBe(true);
  });
});

describe('OutcomePrice.isZero()', () => {
  it('должен вернуть false для любой цены (OutcomePrice не может быть 0)', () => {
    const price1 = OutcomePrice.MIN;
    expect(price1.isZero()).toBe(false);

    const price2 = OutcomePrice.of(new Decimal(0.5));
    expect(price2.isZero()).toBe(false);

    const price3 = OutcomePrice.MAX;
    expect(price3.isZero()).toBe(false);
  });
});

describe('OutcomePrice.isMin()', () => {
  it('должен вернуть true для минимального значения', () => {
    const price = OutcomePrice.MIN;
    expect(price.isMin()).toBe(true);
  });

  it('должен вернуть true для значения равного минимуму', () => {
    const price = OutcomePrice.of(new Decimal(0.0001));
    expect(price.isMin()).toBe(true);
  });

  it('должен вернуть false для не-минимального значения', () => {
    const price = OutcomePrice.of(new Decimal(0.5));
    expect(price.isMin()).toBe(false);
  });
});

describe('OutcomePrice.isMax()', () => {
  it('должен вернуть true для максимального значения', () => {
    const price = OutcomePrice.MAX;
    expect(price.isMax()).toBe(true);
  });

  it('должен вернуть true для значения равного максимуму', () => {
    const price = OutcomePrice.of(new Decimal(0.9999));
    expect(price.isMax()).toBe(true);
  });

  it('должен вернуть false для не-максимального значения', () => {
    const price = OutcomePrice.of(new Decimal(0.5));
    expect(price.isMax()).toBe(false);
  });
});

describe('OutcomePrice comparison methods', () => {
  describe('isLessThan()', () => {
    it('должен вернуть true если this < other', () => {
      const p1 = OutcomePrice.of(new Decimal(0.5));
      const p2 = OutcomePrice.of(new Decimal(0.6));
      expect(p1.isLessThan(p2)).toBe(true);
      expect(p2.isLessThan(p1)).toBe(false);
    });
  });

  describe('isLessThanOrEqual()', () => {
    it('должен вернуть true если this <= other', () => {
      const p1 = OutcomePrice.of(new Decimal(0.5));
      const p2 = OutcomePrice.of(new Decimal(0.5));
      expect(p1.isLessThanOrEqual(p2)).toBe(true);
    });

    it('должен вернуть true если this < other (строгое)', () => {
      const p1 = OutcomePrice.of(new Decimal(0.4));
      const p2 = OutcomePrice.of(new Decimal(0.5));
      expect(p1.isLessThanOrEqual(p2)).toBe(true);
    });

    it('должен вернуть false если this > other', () => {
      const p1 = OutcomePrice.of(new Decimal(0.6));
      const p2 = OutcomePrice.of(new Decimal(0.5));
      expect(p1.isLessThanOrEqual(p2)).toBe(false);
    });
  });

  describe('isGreaterThan()', () => {
    it('должен вернуть true если this > other', () => {
      const p1 = OutcomePrice.of(new Decimal(0.6));
      const p2 = OutcomePrice.of(new Decimal(0.5));
      expect(p1.isGreaterThan(p2)).toBe(true);
      expect(p2.isGreaterThan(p1)).toBe(false);
    });
  });

  describe('isGreaterThanOrEqual()', () => {
    it('должен вернуть true если this >= other', () => {
      const p1 = OutcomePrice.of(new Decimal(0.5));
      const p2 = OutcomePrice.of(new Decimal(0.5));
      expect(p1.isGreaterThanOrEqual(p2)).toBe(true);
    });

    it('должен вернуть true если this > other (строгое)', () => {
      const p1 = OutcomePrice.of(new Decimal(0.6));
      const p2 = OutcomePrice.of(new Decimal(0.5));
      expect(p1.isGreaterThanOrEqual(p2)).toBe(true);
    });

    it('должен вернуть false если this < other', () => {
      const p1 = OutcomePrice.of(new Decimal(0.4));
      const p2 = OutcomePrice.of(new Decimal(0.5));
      expect(p1.isGreaterThanOrEqual(p2)).toBe(false);
    });
  });
});
