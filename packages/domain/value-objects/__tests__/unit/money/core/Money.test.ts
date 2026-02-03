import { Money } from '../../../../src/money/core/Money';
import { MoneyInvariantViolation } from '../../../../src/money/core/MoneyInvariantViolation';

describe('Money core', () => {
  describe('parse errors', () => {
    it('бросает ошибку Decimal для невалидного формата', () => {
      // Decimal.js бросит свою ошибку для невалидного формата
      expect(() => Money.of('abc')).toThrow();

      try {
        Money.of('abc');
      } catch (e) {
        // Проверяем что это ошибка от Decimal (содержит сообщение о невалидном аргументе)
        expect((e as Error).message).toContain('Invalid argument');
      }
    });
  });

  describe('инварианты', () => {
    it('UNSUPPORTED_CURRENCY', () => {
      // Runtime: 'EUR' будет отклонено Money.create() как UNSUPPORTED_CURRENCY
      expect(() => Money.of(100, 'EUR' as any)).toThrow(MoneyInvariantViolation);

      try {
        // Runtime: бросит MoneyInvariantViolation
        Money.of(100, 'EUR' as any);
      } catch (e) {
        expect(e).toBeInstanceOf(MoneyInvariantViolation);
        expect((e as MoneyInvariantViolation).reason).toBe('UNSUPPORTED_CURRENCY');
      }
    });

    it('NAN', () => {
      expect(() => Money.of(NaN)).toThrow(MoneyInvariantViolation);

      try {
        Money.of(NaN);
      } catch (e) {
        expect((e as MoneyInvariantViolation).reason).toBe('NAN');
      }
    });

    it('NON_FINITE - Infinity', () => {
      expect(() => Money.of(Infinity)).toThrow(MoneyInvariantViolation);

      try {
        Money.of(Infinity);
      } catch (e) {
        expect((e as MoneyInvariantViolation).reason).toBe('NON_FINITE');
      }
    });

    it('NON_FINITE - -Infinity', () => {
      expect(() => Money.of(-Infinity)).toThrow(MoneyInvariantViolation);
    });

    it('EXCEEDS_MAX_AMOUNT - positive', () => {
      expect(() => Money.of('1e16')).toThrow(MoneyInvariantViolation);

      try {
        Money.of('1e16');
      } catch (e) {
        expect((e as MoneyInvariantViolation).reason).toBe('EXCEEDS_MAX_AMOUNT');
      }
    });

    it('EXCEEDS_MAX_AMOUNT - negative', () => {
      expect(() => Money.of('-1e16')).toThrow(MoneyInvariantViolation);
    });

    it('граница MAX_AMOUNT допустима', () => {
      expect(() => Money.of('1e15')).not.toThrow();
    });
  });

  describe('Money.of() success', () => {
    it('создаёт из number', () => {
      const money = Money.of(100);
      expect(money).toBeInstanceOf(Money);
    });

    it('создаёт из string', () => {
      const money = Money.of('42.50');
      expect(money).toBeInstanceOf(Money);
    });

    it('создаёт отрицательное', () => {
      const money = Money.of(-100);
      expect(money).toBeInstanceOf(Money);
    });

    it('создаёт ноль', () => {
      const money = Money.of(0);
      expect(money).toBeInstanceOf(Money);
    });
  });

  describe('Money.zero()', () => {
    it('создаёт ноль', () => {
      const money = Money.zero();
      expect(money.value().toNumber()).toBe(0);
      expect(money.value().isZero()).toBe(true);
    });

    it('валюта по умолчанию', () => {
      expect(Money.zero().currency()).toBe('USDC');
    });

    it('возвращает singleton для USDC', () => {
      const z1 = Money.zero();
      const z2 = Money.zero();
      // Для USDC возвращается singleton ZERO_USDC
      expect(z1).toBe(z2);
      expect(z1).toBe(Money.ZERO.USDC);
      expect(z1.value().equals(z2.value())).toBe(true);
      expect(z1.hasSameCurrency(z2)).toBe(true);
    });
  });

  describe('hasSameCurrency()', () => {
    it('true для одной валюты', () => {
      const m1 = Money.of(100);
      const m2 = Money.of(200);
      expect(m1.hasSameCurrency(m2)).toBe(true);
    });

    it('true для одного объекта', () => {
      const m = Money.of(100);
      expect(m.hasSameCurrency(m)).toBe(true);
    });
  });

  describe('hasSameCurrency()', () => {
    it('true для USDC', () => {
      const m1 = Money.of(100, 'USDC');
      const m2 = Money.of(200, 'USDC');
      expect(m1.hasSameCurrency(m2)).toBe(true);
    });

    it('true даже для разных сумм', () => {
      const m1 = Money.of(100, 'USDC');
      const m2 = Money.of(999, 'USDC');
      expect(m1.hasSameCurrency(m2)).toBe(true);
    });
  });
});
