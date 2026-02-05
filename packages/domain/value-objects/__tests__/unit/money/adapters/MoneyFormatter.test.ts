import Decimal from 'decimal.js';
import { Money } from '../../../../src/money/core/Money';
import { MoneyFormatter } from '../../../../src/money/adapters/MoneyFormatter';
import { unwrap } from '@polymarket/result';

describe('MoneyFormatter', () => {
  describe('toFixed', () => {
    it('форматирует с дефолтными 2 знаками', () => {
      const money = Money.of(new Decimal(100.50));
      expect(unwrap(MoneyFormatter.toFixed(money))).toBe('100.50');
    });

    it('форматирует с 0 знаками', () => {
      const money = Money.of(new Decimal(100.50));
      expect(unwrap(MoneyFormatter.toFixed(money, 0))).toBe('101');
    });

    it('форматирует с 4 знаками', () => {
      const money = Money.of(new Decimal(100.5));
      expect(unwrap(MoneyFormatter.toFixed(money, 4))).toBe('100.5000');
    });

    it('округляет корректно', () => {
      const money = Money.of(new Decimal(99.9999));
      expect(unwrap(MoneyFormatter.toFixed(money, 2))).toBe('100.00');
    });

    it('форматирует отрицательные числа', () => {
      const money = Money.of(new Decimal(-100.50));
      expect(unwrap(MoneyFormatter.toFixed(money, 2))).toBe('-100.50');
    });

    it('форматирует ноль', () => {
      const money = Money.ZERO.USDC;
      expect(unwrap(MoneyFormatter.toFixed(money, 2))).toBe('0.00');
    });

    it('возвращает Err для отрицательных decimals', () => {
      const money = Money.of(new Decimal(100));
      const result = MoneyFormatter.toFixed(money, -1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('decimals argument must be a non-negative integer');
      }
    });

    it('возвращает Err для нецелых decimals', () => {
      const money = Money.of(new Decimal(100));
      const result = MoneyFormatter.toFixed(money, 1.5);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('decimals argument must be a non-negative integer');
      }
    });
  });

  describe('toCurrency', () => {
    it('форматирует с символом валюты по умолчанию', () => {
      const money = Money.of(new Decimal(100.50));
      expect(unwrap(MoneyFormatter.toCurrency(money))).toBe('$100.50 USDC');
    });

    it('форматирует без символа валюты', () => {
      const money = Money.of(new Decimal(100.50));
      expect(unwrap(MoneyFormatter.toCurrency(money, false))).toBe('$100.50');
    });

    it('форматирует с 0 знаками', () => {
      const money = Money.of(new Decimal(100.50));
      expect(unwrap(MoneyFormatter.toCurrency(money, true, 0))).toBe('$101 USDC');
    });

    it('форматирует с 4 знаками', () => {
      const money = Money.of(new Decimal(1234.5678));
      expect(unwrap(MoneyFormatter.toCurrency(money, true, 4))).toBe('$1234.5678 USDC');
    });

    it('форматирует большие числа', () => {
      const money = Money.of(new Decimal(1234567.89));
      expect(unwrap(MoneyFormatter.toCurrency(money))).toBe('$1234567.89 USDC');
    });

    it('форматирует отрицательные числа', () => {
      const money = Money.of(new Decimal(-100.50));
      expect(unwrap(MoneyFormatter.toCurrency(money))).toBe('-$100.50 USDC');
    });

    it('форматирует ноль', () => {
      const money = Money.ZERO.USDC;
      expect(unwrap(MoneyFormatter.toCurrency(money))).toBe('$0.00 USDC');
    });

    it('возвращает Err для отрицательных decimals', () => {
      const money = Money.of(new Decimal(100));
      const result = MoneyFormatter.toCurrency(money, true, -1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('decimals argument must be a non-negative integer');
      }
    });

    it('возвращает Err для нецелых decimals', () => {
      const money = Money.of(new Decimal(100));
      const result = MoneyFormatter.toCurrency(money, true, 1.5);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('decimals argument must be a non-negative integer');
      }
    });
  });

  describe('toCompact', () => {
    it('форматирует числа < 1000 без суффикса', () => {
      const money = Money.of(new Decimal(999));
      expect(unwrap(MoneyFormatter.toCompact(money))).toBe('$999.0');
    });

    it('форматирует тысячи с K', () => {
      const money = Money.of(new Decimal(1500));
      expect(unwrap(MoneyFormatter.toCompact(money))).toBe('$1.5K');
    });

    it('форматирует миллионы с M', () => {
      const money = Money.of(new Decimal(2300000));
      expect(unwrap(MoneyFormatter.toCompact(money))).toBe('$2.3M');
    });

    it('форматирует миллиарды с B', () => {
      const money = Money.of(new Decimal(1000000000));
      expect(unwrap(MoneyFormatter.toCompact(money))).toBe('$1.0B');
    });

    it('форматирует с заданным количеством знаков', () => {
      const money = Money.of(new Decimal(1234));
      expect(unwrap(MoneyFormatter.toCompact(money, 2))).toBe('$1.23K');
    });

    it('форматирует отрицательные числа', () => {
      const money = Money.of(new Decimal(-1500));
      expect(unwrap(MoneyFormatter.toCompact(money))).toBe('-$1.5K');
    });

    it('форматирует ноль', () => {
      const money = Money.ZERO.USDC;
      expect(unwrap(MoneyFormatter.toCompact(money))).toBe('$0.0');
    });

    it('форматирует граничные значения', () => {
      expect(unwrap(MoneyFormatter.toCompact(Money.of(new Decimal(1000))))).toBe('$1.0K');
      expect(unwrap(MoneyFormatter.toCompact(Money.of(new Decimal(1000000))))).toBe('$1.0M');
      expect(unwrap(MoneyFormatter.toCompact(Money.of(new Decimal(1000000000))))).toBe('$1.0B');
    });

    it('возвращает Err для отрицательных decimals', () => {
      const money = Money.of(new Decimal(1000));
      const result = MoneyFormatter.toCompact(money, -1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('decimals argument must be a non-negative integer');
      }
    });

    it('возвращает Err для нецелых decimals', () => {
      const money = Money.of(new Decimal(1000));
      const result = MoneyFormatter.toCompact(money, 1.5);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('decimals argument must be a non-negative integer');
      }
    });
  });
});
