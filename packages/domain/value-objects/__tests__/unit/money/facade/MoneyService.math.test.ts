import Decimal from 'decimal.js';
import { Money } from '../../../../src/money/core/Money';
import { MoneyService } from '../../../../src/money/facade/MoneyService';
import { ArithmeticOverflowError, InvalidMoneyError, DivisionByZeroError } from '@polymarket/errors';

describe('MoneyService.add()', () => {
  describe('success', () => {
    it('складывает', () => {
      const m1 = Money.of(100);
      const m2 = Money.of(50);
      const result = MoneyService.add(m1, m2);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.amount().toNumber()).toBe(150);
      }
    });

    it('дробные', () => {
      const result = MoneyService.add(Money.of('100.5'), Money.of('50.25'));
      expect(result.ok).toBe(true);
      if (result.ok) {
        // ✅ Decimal сравнение вместо toNumber (lossy)
        expect(result.value.amount().equals(new Decimal('150.75'))).toBe(true);
      }
    });

    it('отрицательные', () => {
      const result = MoneyService.add(Money.of(-50), Money.of(100));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.amount().toNumber()).toBe(50);
      }
    });

    it('с нулём', () => {
      const result = MoneyService.add(Money.of(100), Money.ZERO_USDC);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.amount().toNumber()).toBe(100);
      }
    });
  });

  describe('overflow', () => {
    it('EXCEEDS_MAX_AMOUNT', () => {
      const m1 = Money.of('9e14');
      const m2 = Money.of('9e14');
      const result = MoneyService.add(m1, m2);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(ArithmeticOverflowError);
        expect(result.error.context!.reason).toBe('EXCEEDS_MAX_AMOUNT');

        // ✅ ИСПРАВЛЕНО: НЕ проверяем точную строку экспоненты
        // Проверяем что поле есть и парсится обратно
        expect(result.error.context!.a).toBeDefined();
        expect(result.error.context!.b).toBeDefined();
        expect(new Decimal(result.error.context!.a as string).equals(new Decimal('9e14'))).toBe(true);
      }
    });

    it('граница MAX допустима', () => {
      const m1 = Money.of('5e14');
      const m2 = Money.of('5e14');
      const result = MoneyService.add(m1, m2);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // ✅ ИСПРАВЛЕНО: проверяем через equals
        expect(result.value.amount().equals(new Decimal('1e15'))).toBe(true);
      }
    });
  });

  // ПРИМЕЧАНИЕ: CurrencyMismatchError тесты невозможны (только USDC)
});

describe('MoneyService.subtract()', () => {
  describe('success', () => {
    it('вычитает', () => {
      const m1 = Money.of(100);
      const m2 = Money.of(30);
      const result = MoneyService.subtract(m1, m2);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.amount().toNumber()).toBe(70);
      }
    });

    it('дробные', () => {
      const result = MoneyService.subtract(Money.of('100.5'), Money.of('50.25'));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.amount().equals(new Decimal('50.25'))).toBe(true);
      }
    });

    it('отрицательный результат', () => {
      const result = MoneyService.subtract(Money.of(50), Money.of(100));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.amount().toNumber()).toBe(-50);
      }
    });
  });

  describe('overflow', () => {
    it('EXCEEDS_MAX_AMOUNT', () => {
      const m1 = Money.of('1e15');
      const m2 = Money.of('-1e15');
      const result = MoneyService.subtract(m1, m2);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(ArithmeticOverflowError);
        expect(result.error.context!.reason).toBe('EXCEEDS_MAX_AMOUNT');
      }
    });
  });
});

describe('MoneyService.multiply()', () => {
  describe('success', () => {
    it('умножает на целое', () => {
      const result = MoneyService.multiply(Money.of(100), 2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.amount().toNumber()).toBe(200);
      }
    });

    it('умножает на дробное', () => {
      const result = MoneyService.multiply(Money.of(100), 1.5);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.amount().equals(new Decimal('150'))).toBe(true);
      }
    });

    it('умножает на ноль', () => {
      const result = MoneyService.multiply(Money.of(100), 0);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.amount().toNumber()).toBe(0);
      }
    });

    it('умножает на отрицательное', () => {
      const result = MoneyService.multiply(Money.of(100), -2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.amount().toNumber()).toBe(-200);
      }
    });
  });

  describe('validation', () => {
    it('INVALID_FORMAT', () => {
      const result = MoneyService.multiply(Money.of(100), 'abc');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidMoneyError);
        expect(result.error.context!.reason).toBe('INVALID_FORMAT');
      }
    });

    it('NAN', () => {
      const result = MoneyService.multiply(Money.of(100), NaN);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context!.reason).toBe('NAN');
      }
    });

    it('NON_FINITE', () => {
      const result = MoneyService.multiply(Money.of(100), Infinity);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context!.reason).toBe('NON_FINITE');
      }
    });
  });

  describe('overflow', () => {
    it('EXCEEDS_MAX_AMOUNT', () => {
      const result = MoneyService.multiply(Money.of('1e14'), '1e5');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(ArithmeticOverflowError);
        expect(result.error.context!.reason).toBe('EXCEEDS_MAX_AMOUNT');
      }
    });
  });
});

describe('MoneyService.divide()', () => {
  describe('success', () => {
    it('делит на целое', () => {
      const result = MoneyService.divide(Money.of(100), 2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.amount().toNumber()).toBe(50);
      }
    });

    it('делит на дробное', () => {
      const result = MoneyService.divide(Money.of(100), 4);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.amount().equals(new Decimal('25'))).toBe(true);
      }
    });

    it('делит на отрицательное', () => {
      const result = MoneyService.divide(Money.of(100), -2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.amount().toNumber()).toBe(-50);
      }
    });
  });

  describe('validation', () => {
    it('DIVISION_BY_ZERO', () => {
      const result = MoneyService.divide(Money.of(100), 0);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(DivisionByZeroError);
      }
    });

    it('INVALID_FORMAT', () => {
      const result = MoneyService.divide(Money.of(100), 'abc');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidMoneyError);
        expect(result.error.context!.reason).toBe('INVALID_FORMAT');
      }
    });

    it('NAN', () => {
      const result = MoneyService.divide(Money.of(100), NaN);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context!.reason).toBe('NAN');
      }
    });

    it('NON_FINITE', () => {
      const result = MoneyService.divide(Money.of(100), Infinity);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context!.reason).toBe('NON_FINITE');
      }
    });
  });
});
