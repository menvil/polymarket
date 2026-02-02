import { Money } from '../../../../src/money/core/Money';
import { MoneyFormatter } from '../../../../src/money/adapters/MoneyFormatter';

describe('MoneyFormatter', () => {
  describe('toFixed', () => {
    it('форматирует с дефолтными 2 знаками', () => {
      const money = Money.of(100.50);
      expect(MoneyFormatter.toFixed(money)).toBe('100.50');
    });

    it('форматирует с 0 знаками', () => {
      const money = Money.of(100.50);
      expect(MoneyFormatter.toFixed(money, 0)).toBe('101');
    });

    it('форматирует с 4 знаками', () => {
      const money = Money.of(100.5);
      expect(MoneyFormatter.toFixed(money, 4)).toBe('100.5000');
    });

    it('округляет корректно', () => {
      const money = Money.of(99.9999);
      expect(MoneyFormatter.toFixed(money, 2)).toBe('100.00');
    });

    it('форматирует отрицательные числа', () => {
      const money = Money.of(-100.50);
      expect(MoneyFormatter.toFixed(money, 2)).toBe('-100.50');
    });

    it('форматирует ноль', () => {
      const money = Money.zero();
      expect(MoneyFormatter.toFixed(money, 2)).toBe('0.00');
    });

    it('бросает RangeError для отрицательных decimals', () => {
      const money = Money.of(100);
      expect(() => MoneyFormatter.toFixed(money, -1)).toThrow(RangeError);
    });

    it('бросает RangeError для нецелых decimals', () => {
      const money = Money.of(100);
      expect(() => MoneyFormatter.toFixed(money, 1.5)).toThrow(RangeError);
    });
  });

  describe('toCurrency', () => {
    it('форматирует с символом валюты по умолчанию', () => {
      const money = Money.of(100.50);
      expect(MoneyFormatter.toCurrency(money)).toBe('$100.50 USDC');
    });

    it('форматирует без символа валюты', () => {
      const money = Money.of(100.50);
      expect(MoneyFormatter.toCurrency(money, false)).toBe('$100.50');
    });

    it('форматирует с 0 знаками', () => {
      const money = Money.of(100.50);
      expect(MoneyFormatter.toCurrency(money, true, 0)).toBe('$101 USDC');
    });

    it('форматирует с 4 знаками', () => {
      const money = Money.of(1234.5678);
      expect(MoneyFormatter.toCurrency(money, true, 4)).toBe('$1234.5678 USDC');
    });

    it('форматирует большие числа', () => {
      const money = Money.of(1234567.89);
      expect(MoneyFormatter.toCurrency(money)).toBe('$1234567.89 USDC');
    });

    it('форматирует отрицательные числа', () => {
      const money = Money.of(-100.50);
      expect(MoneyFormatter.toCurrency(money)).toBe('-$100.50 USDC');
    });

    it('форматирует ноль', () => {
      const money = Money.zero();
      expect(MoneyFormatter.toCurrency(money)).toBe('$0.00 USDC');
    });
  });

  describe('toCompact', () => {
    it('форматирует числа < 1000 без суффикса', () => {
      const money = Money.of(999);
      expect(MoneyFormatter.toCompact(money)).toBe('$999.0');
    });

    it('форматирует тысячи с K', () => {
      const money = Money.of(1500);
      expect(MoneyFormatter.toCompact(money)).toBe('$1.5K');
    });

    it('форматирует миллионы с M', () => {
      const money = Money.of(2300000);
      expect(MoneyFormatter.toCompact(money)).toBe('$2.3M');
    });

    it('форматирует миллиарды с B', () => {
      const money = Money.of(1000000000);
      expect(MoneyFormatter.toCompact(money)).toBe('$1.0B');
    });

    it('форматирует с заданным количеством знаков', () => {
      const money = Money.of(1234);
      expect(MoneyFormatter.toCompact(money, 2)).toBe('$1.23K');
    });

    it('форматирует отрицательные числа', () => {
      const money = Money.of(-1500);
      expect(MoneyFormatter.toCompact(money)).toBe('-$1.5K');
    });

    it('форматирует ноль', () => {
      const money = Money.zero();
      expect(MoneyFormatter.toCompact(money)).toBe('$0.0');
    });

    it('форматирует граничные значения', () => {
      expect(MoneyFormatter.toCompact(Money.of(1000))).toBe('$1.0K');
      expect(MoneyFormatter.toCompact(Money.of(1000000))).toBe('$1.0M');
      expect(MoneyFormatter.toCompact(Money.of(1000000000))).toBe('$1.0B');
    });

    it('бросает RangeError для отрицательных decimals', () => {
      const money = Money.of(1000);
      expect(() => MoneyFormatter.toCompact(money, -1)).toThrow(RangeError);
    });

    it('бросает RangeError для нецелых decimals', () => {
      const money = Money.of(1000);
      expect(() => MoneyFormatter.toCompact(money, 1.5)).toThrow(RangeError);
    });
  });
});
