import Decimal from 'decimal.js';
import { describe, it, expect } from '@jest/globals';
import { ValidateCurrencyMatch } from '../../../../src/balance/rules/ValidateCurrencyMatch.js';
import { Money } from '../../../../src/money/core/Money.js';
import { BalanceErrorReason } from '../../../../src/balance/errors/BalanceErrorReason.js';
import type { SupportedCurrency } from '@polymarket/ids';

describe('ValidateCurrencyMatch', () => {
  describe('успешная валидация', () => {
    it('проходит если валюты совпадают', () => {
      const amount = Money.of(new Decimal(1000));
      const balanceCurrency = 'USDC';

      const result = ValidateCurrencyMatch.check(amount, balanceCurrency);

      expect(result.ok).toBe(true);
    });

    // ПРИМЕЧАНИЕ: Тесты с BTC/ETH невозможны, так как Money поддерживает только USDC.
    // Если добавятся другие валюты, раскомментировать:
    // it('проходит для BTC валюты', () => {
    //   const amount = Money.of(1, 'BTC' as any);
    //   const balanceCurrency = 'BTC' as any;
    //
    //   const result = ValidateCurrencyMatch.check(amount, balanceCurrency);
    //
    //   expect(result.ok).toBe(true);
    // });
  });

  describe('ошибка CURRENCY_MISMATCH', () => {
    it('возвращает ошибку если валюты не совпадают', () => {
      // Используем type assertion для тестирования ветки mismatch
      // В реальном коде Money поддерживает только USDC, но для теста
      // мы создаем мок-объект с другой валютой
      const amount = Money.of(new Decimal(1000));
      const mockAmount = {
        ...amount,
        currency: () => 'EUR' as SupportedCurrency
      } as Money;

      const balanceCurrency: SupportedCurrency = 'USDC';

      const result = ValidateCurrencyMatch.check(mockAmount, balanceCurrency);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(BalanceErrorReason.CURRENCY_MISMATCH);
        expect(result.error.context?.expected).toBe('USDC');
        expect(result.error.context?.actual).toBe('EUR');
      }
    });

    it('содержит читаемое сообщение об ошибке', () => {
      // Мок-объект Money с другой валютой для тестирования
      const amount = Money.of(new Decimal(1000));
      const mockAmount = {
        ...amount,
        currency: () => 'BTC' as SupportedCurrency
      } as Money;

      const balanceCurrency: SupportedCurrency = 'USDC';

      const result = ValidateCurrencyMatch.check(mockAmount, balanceCurrency);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Currency mismatch');
        expect(result.error.message).toContain('expected USDC');
        expect(result.error.message).toContain('got BTC');
      }
    });
  });
});
