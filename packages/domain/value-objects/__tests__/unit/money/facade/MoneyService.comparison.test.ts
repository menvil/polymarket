import { MoneyService } from '../../../../src/money/facade/MoneyService';
import { Money } from '../../../../src/money/core/Money';

describe('MoneyService comparison methods', () => {
  describe('isLessThan()', () => {
    it('должен вернуть Ok(true) если a < b', () => {
      const m1 = Money.of(100);
      const m2 = Money.of(200);
      const result = MoneyService.isLessThan(m1, m2);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(true);
      }
    });

    it('должен вернуть Ok(false) если a >= b', () => {
      const m1 = Money.of(200);
      const m2 = Money.of(100);
      const result = MoneyService.isLessThan(m1, m2);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(false);
      }
    });
  });

  describe('isGreaterThan()', () => {
    it('должен вернуть Ok(true) если a > b', () => {
      const m1 = Money.of(200);
      const m2 = Money.of(100);
      const result = MoneyService.isGreaterThan(m1, m2);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(true);
      }
    });
  });

  describe('equals()', () => {
    it('должен вернуть Ok(true) для равных сумм', () => {
      const m1 = Money.of(100);
      const m2 = Money.of(100);
      const result = MoneyService.equals(m1, m2);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(true);
      }
    });

    it('должен вернуть Ok(false) для разных сумм', () => {
      const m1 = Money.of(100);
      const m2 = Money.of(200);
      const result = MoneyService.equals(m1, m2);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(false);
      }
    });
  });

  describe('isZero()', () => {
    it('должен вернуть true для нулевой суммы', () => {
      expect(MoneyService.isZero(Money.ZERO.USDC)).toBe(true);
      expect(MoneyService.isZero(Money.of(0))).toBe(true);
    });

    it('должен вернуть false для ненулевой суммы', () => {
      expect(MoneyService.isZero(Money.of(100))).toBe(false);
    });
  });

  describe('isPositive()', () => {
    it('должен вернуть true для положительной суммы', () => {
      expect(MoneyService.isPositive(Money.of(100))).toBe(true);
    });

    it('должен вернуть false для нулевой суммы', () => {
      expect(MoneyService.isPositive(Money.ZERO.USDC)).toBe(false);
    });

    it('должен вернуть false для отрицательной суммы', () => {
      expect(MoneyService.isPositive(Money.of(-100))).toBe(false);
    });
  });

  describe('isNegative()', () => {
    it('должен вернуть true для отрицательной суммы', () => {
      expect(MoneyService.isNegative(Money.of(-100))).toBe(true);
    });

    it('должен вернуть false для положительной суммы', () => {
      expect(MoneyService.isNegative(Money.of(100))).toBe(false);
    });

    it('должен вернуть false для нулевой суммы', () => {
      expect(MoneyService.isNegative(Money.ZERO.USDC)).toBe(false);
    });
  });
});
