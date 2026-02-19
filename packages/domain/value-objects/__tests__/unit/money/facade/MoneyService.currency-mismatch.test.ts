import Decimal from 'decimal.js';
import { Money } from '../../../../src/money/core/Money';
import { MoneyService } from '../../../../src/money/facade/MoneyService';
import { MoneyErrorReason } from '../../../../src/money/errors/MoneyErrorReason';

/**
 * Тесты для currency mismatch проверок
 *
 * @remarks
 * Эти тесты покрывают ветки кода которые проверяют совпадение валют.
 * В production системе сейчас только USDC, но код готов к нескольким валютам.
 *
 * Используем моки для создания Money-подобных объектов с разными валютами.
 * Это позволяет покрыть важные ветки кода без изменения SUPPORTED_CURRENCIES.
 */
describe('MoneyService currency mismatch', () => {
  // Helper для создания mock Money с фиктивной валютой для тестов
  const createMockMoneyWithCurrency = (amount: number, currency: string): Money => {
    const decimal = new Decimal(amount);
    // Создаём mock объект который выглядит как Money
    return {
      value: () => decimal,
      currency: () => currency as any,
      toNumber: () => decimal.toNumber(),
      hasSameCurrency: (other: Money) => other.currency() === currency,
      isZero: () => decimal.isZero(),
      isPositive: () => decimal.greaterThan(0),
      isNegative: () => decimal.lessThan(0),
    } as unknown as Money;
  };

  describe('add()', () => {
    it('должен вернуть Err при разных валютах', () => {
      const usd = Money.of(new Decimal(100), 'USDC');
      const eur = createMockMoneyWithCurrency(100, 'EUR');

      const result = MoneyService.add(usd, eur);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(MoneyErrorReason.CURRENCY_MISMATCH);
        expect(result.error.context?.expected).toBe('USDC');
        expect(result.error.context?.actual).toBe('EUR');
      }
    });
  });

  describe('subtract()', () => {
    it('должен вернуть Err при разных валютах', () => {
      const usd = Money.of(new Decimal(100), 'USDC');
      const eur = createMockMoneyWithCurrency(50, 'EUR');

      const result = MoneyService.subtract(usd, eur);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(MoneyErrorReason.CURRENCY_MISMATCH);
        expect(result.error.context?.expected).toBe('USDC');
        expect(result.error.context?.actual).toBe('EUR');
      }
    });
  });

  describe('equals()', () => {
    it('должен вернуть Err при разных валютах', () => {
      const usd = Money.of(new Decimal(100), 'USDC');
      const eur = createMockMoneyWithCurrency(100, 'EUR');

      const result = MoneyService.equals(usd, eur);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(MoneyErrorReason.CURRENCY_MISMATCH);
      }
    });
  });

  describe('isLessThan()', () => {
    it('должен вернуть Err при разных валютах', () => {
      const usd = Money.of(new Decimal(100), 'USDC');
      const eur = createMockMoneyWithCurrency(200, 'EUR');

      const result = MoneyService.isLessThan(usd, eur);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(MoneyErrorReason.CURRENCY_MISMATCH);
      }
    });
  });

  describe('isLessThanOrEqual()', () => {
    it('должен вернуть Err при разных валютах', () => {
      const usd = Money.of(new Decimal(100), 'USDC');
      const eur = createMockMoneyWithCurrency(100, 'EUR');

      const result = MoneyService.isLessThanOrEqual(usd, eur);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(MoneyErrorReason.CURRENCY_MISMATCH);
      }
    });
  });

  describe('isGreaterThan()', () => {
    it('должен вернуть Err при разных валютах', () => {
      const usd = Money.of(new Decimal(200), 'USDC');
      const eur = createMockMoneyWithCurrency(100, 'EUR');

      const result = MoneyService.isGreaterThan(usd, eur);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(MoneyErrorReason.CURRENCY_MISMATCH);
      }
    });
  });

  describe('isGreaterThanOrEqual()', () => {
    it('должен вернуть Err при разных валютах', () => {
      const usd = Money.of(new Decimal(100), 'USDC');
      const eur = createMockMoneyWithCurrency(100, 'EUR');

      const result = MoneyService.isGreaterThanOrEqual(usd, eur);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(MoneyErrorReason.CURRENCY_MISMATCH);
      }
    });
  });
});
