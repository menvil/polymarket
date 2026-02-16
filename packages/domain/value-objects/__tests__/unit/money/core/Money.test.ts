import Decimal from 'decimal.js';
import { Money } from '../../../../src/money/core/Money';
import { MoneyInvariantViolation } from '../../../../src/money/core/MoneyInvariantViolation';

describe('Money core', () => {
  describe('parse errors', () => {
    it('бросает ошибку Decimal для невалидного формата', () => {
      // Decimal.js бросит свою ошибку для невалидного формата
      expect(() => Money.of(new Decimal('abc'))).toThrow();

      try {
        Money.of(new Decimal('abc'));
      } catch (e) {
        // Проверяем что это ошибка от Decimal (содержит сообщение о невалидном аргументе)
        expect((e as Error).message).toContain('Invalid argument');
      }
    });
  });

  describe('инварианты', () => {
    it('UNSUPPORTED_CURRENCY', () => {
      // Runtime: 'EUR' будет отклонено Money.create() как UNSUPPORTED_CURRENCY
      expect(() => Money.of(new Decimal(100), 'EUR' as any)).toThrow(MoneyInvariantViolation);

      try {
        // Runtime: бросит MoneyInvariantViolation
        Money.of(new Decimal(100), 'EUR' as any);
      } catch (e) {
        expect(e).toBeInstanceOf(MoneyInvariantViolation);
        expect((e as MoneyInvariantViolation).reason).toBe('UNSUPPORTED_CURRENCY');
      }
    });

    it('NAN', () => {
      expect(() => Money.of(new Decimal(NaN))).toThrow(MoneyInvariantViolation);

      try {
        Money.of(new Decimal(NaN));
      } catch (e) {
        expect((e as MoneyInvariantViolation).reason).toBe('NAN');
      }
    });

    it('NON_FINITE - Infinity', () => {
      expect(() => Money.of(new Decimal(Infinity))).toThrow(MoneyInvariantViolation);

      try {
        Money.of(new Decimal(Infinity));
      } catch (e) {
        expect((e as MoneyInvariantViolation).reason).toBe('NON_FINITE');
      }
    });

    it('NON_FINITE - -Infinity', () => {
      expect(() => Money.of(new Decimal(-Infinity))).toThrow(MoneyInvariantViolation);
    });

    it('EXCEEDS_MAX_AMOUNT - positive', () => {
      expect(() => Money.of(new Decimal('1e16'))).toThrow(MoneyInvariantViolation);

      try {
        Money.of(new Decimal('1e16'));
      } catch (e) {
        expect((e as MoneyInvariantViolation).reason).toBe('EXCEEDS_MAX_AMOUNT');
      }
    });

    it('EXCEEDS_MAX_AMOUNT - negative', () => {
      expect(() => Money.of(new Decimal('-1e16'))).toThrow(MoneyInvariantViolation);
    });

    it('граница MAX_AMOUNT допустима', () => {
      expect(() => Money.of(new Decimal('1e15'))).not.toThrow();
    });
  });

  describe('Money.of() success', () => {
    it('создаёт из number', () => {
      const money = Money.of(new Decimal(100));
      expect(money).toBeInstanceOf(Money);
    });

    it('создаёт из string', () => {
      const money = Money.of(new Decimal('42.50'));
      expect(money).toBeInstanceOf(Money);
    });

    it('создаёт отрицательное', () => {
      const money = Money.of(new Decimal(-100));
      expect(money).toBeInstanceOf(Money);
    });

    it('создаёт ноль', () => {
      const money = Money.of(new Decimal(0));
      expect(money).toBeInstanceOf(Money);
    });
  });

  describe('Money.ZERO singleton', () => {
    it('создаёт ноль через singleton', () => {
      const money = Money.ZERO.USDC;
      expect(money.value().toNumber()).toBe(0);
      expect(money.value().isZero()).toBe(true);
    });

    it('валюта USDC', () => {
      expect(Money.ZERO.USDC.currency()).toBe('USDC');
    });

    it('singleton - всегда один и тот же экземпляр', () => {
      const z1 = Money.ZERO.USDC;
      const z2 = Money.ZERO.USDC;
      // Singleton - один экземпляр
      expect(z1).toBe(z2);
      expect(z1.value().equals(z2.value())).toBe(true);
      expect(z1.hasSameCurrency(z2)).toBe(true);
    });
  });

  describe('hasSameCurrency()', () => {
    it('true для одного объекта', () => {
      const m = Money.of(new Decimal(100));
      expect(m.hasSameCurrency(m)).toBe(true);
    });
    it('true для USDC', () => {
      const m1 = Money.of(new Decimal(100), 'USDC');
      const m2 = Money.of(new Decimal(200), 'USDC');
      expect(m1.hasSameCurrency(m2)).toBe(true);
    });

    it('true даже для разных сумм', () => {
      const m1 = Money.of(new Decimal(100), 'USDC');
      const m2 = Money.of(new Decimal(999), 'USDC');
      expect(m1.hasSameCurrency(m2)).toBe(true);
    });
  });

  describe('isZero()', () => {
    it('должен вернуть true для нулевой суммы', () => {
      expect(Money.ZERO.USDC.isZero()).toBe(true);
      expect(Money.of(new Decimal(0)).isZero()).toBe(true);
    });

    it('должен вернуть false для ненулевой суммы', () => {
      expect(Money.of(new Decimal(100)).isZero()).toBe(false);
      expect(Money.of(new Decimal(-100)).isZero()).toBe(false);
    });
  });

  describe('isPositive()', () => {
    it('должен вернуть true для положительной суммы', () => {
      expect(Money.of(new Decimal(100)).isPositive()).toBe(true);
      expect(Money.of(new Decimal(0.01)).isPositive()).toBe(true);
    });

    it('должен вернуть false для нулевой суммы', () => {
      expect(Money.ZERO.USDC.isPositive()).toBe(false);
      expect(Money.of(new Decimal(0)).isPositive()).toBe(false);
    });

    it('должен вернуть false для отрицательной суммы', () => {
      expect(Money.of(new Decimal(-100)).isPositive()).toBe(false);
      expect(Money.of(new Decimal(-0.01)).isPositive()).toBe(false);
    });
  });

  describe('isNegative()', () => {
    it('должен вернуть true для отрицательной суммы', () => {
      expect(Money.of(new Decimal(-100)).isNegative()).toBe(true);
      expect(Money.of(new Decimal(-0.01)).isNegative()).toBe(true);
    });

    it('должен вернуть false для положительной суммы', () => {
      expect(Money.of(new Decimal(100)).isNegative()).toBe(false);
      expect(Money.of(new Decimal(0.01)).isNegative()).toBe(false);
    });

    it('должен вернуть false для нулевой суммы', () => {
      expect(Money.ZERO.USDC.isNegative()).toBe(false);
      expect(Money.of(new Decimal(0)).isNegative()).toBe(false);
    });
  });
});
