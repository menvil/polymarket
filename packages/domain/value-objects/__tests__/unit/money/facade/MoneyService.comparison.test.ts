import Decimal from 'decimal.js';
import { MoneyService } from '../../../../src/money/facade/MoneyService';
import { Money } from '../../../../src/money/core/Money';

describe('MoneyService comparison methods', () => {
  describe('isLessThan()', () => {
    it('должен вернуть Ok(true) если a < b', () => {
      const m1 = Money.of(new Decimal(100));
      const m2 = Money.of(new Decimal(200));
      const result = MoneyService.isLessThan(m1, m2);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(true);
      }
    });

    it('должен вернуть Ok(false) если a >= b', () => {
      const m1 = Money.of(new Decimal(200));
      const m2 = Money.of(new Decimal(100));
      const result = MoneyService.isLessThan(m1, m2);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(false);
      }
    });
  });

  describe('isGreaterThan()', () => {
    it('должен вернуть Ok(true) если a > b', () => {
      const m1 = Money.of(new Decimal(200));
      const m2 = Money.of(new Decimal(100));
      const result = MoneyService.isGreaterThan(m1, m2);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(true);
      }
    });
  });

  describe('equals()', () => {
    it('должен вернуть Ok(true) для равных сумм', () => {
      const m1 = Money.of(new Decimal(100));
      const m2 = Money.of(new Decimal(100));
      const result = MoneyService.equals(m1, m2);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(true);
      }
    });

    it('должен вернуть Ok(false) для разных сумм', () => {
      const m1 = Money.of(new Decimal(100));
      const m2 = Money.of(new Decimal(200));
      const result = MoneyService.equals(m1, m2);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(false);
      }
    });
  });

});
