import Decimal from 'decimal.js';
import { describe, it, expect } from '@jest/globals';
import { ValidateReleaseAmount } from '../../../../src/balance/rules/ValidateReleaseAmount.js';
import { Money } from '../../../../src/money/core/Money.js';
import { BalanceErrorReason } from '../../../../src/balance/errors/BalanceErrorReason.js';

describe('ValidateReleaseAmount', () => {
  describe('успешная валидация', () => {
    it('проходит если releaseAmount <= reserved', () => {
      const reserved = Money.of(new Decimal(5000));
      const releaseAmount = Money.of(new Decimal(2000));

      const result = ValidateReleaseAmount.check(releaseAmount, reserved);

      expect(result.ok).toBe(true);
    });

    it('проходит если releaseAmount === reserved', () => {
      const reserved = Money.of(new Decimal(5000));
      const releaseAmount = Money.of(new Decimal(5000));

      const result = ValidateReleaseAmount.check(releaseAmount, reserved);

      expect(result.ok).toBe(true);
    });

    it('проходит для минимальной суммы (0.01)', () => {
      const reserved = Money.of(new Decimal(5000));
      const releaseAmount = Money.of(new Decimal(0.01));

      const result = ValidateReleaseAmount.check(releaseAmount, reserved);

      expect(result.ok).toBe(true);
    });
  });

  describe('ошибка INSUFFICIENT_RESERVED', () => {
    it('возвращает ошибку если releaseAmount > reserved', () => {
      const reserved = Money.of(new Decimal(5000));
      const releaseAmount = Money.of(new Decimal(10000));

      const result = ValidateReleaseAmount.check(releaseAmount, reserved);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(BalanceErrorReason.INSUFFICIENT_RESERVED);
        expect(result.error.context?.amount).toBe('10000');
        expect(result.error.context?.reserved).toBe('5000');
      }
    });

    it('содержит читаемое сообщение об ошибке', () => {
      const reserved = Money.of(new Decimal(1000));
      const releaseAmount = Money.of(new Decimal(2000));

      const result = ValidateReleaseAmount.check(releaseAmount, reserved);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Cannot unfreeze/consume 2000');
        expect(result.error.message).toContain('only 1000 reserved');
      }
    });
  });

  describe('ошибка INVALID_FORMAT', () => {
    // ПРИМЕЧАНИЕ: Тест невозможен, так как Money.of(new Decimal(Infinity)) бросает исключение
    // до того, как ValidateReleaseAmount сможет его проверить
    // it('возвращает ошибку если releaseAmount не finite', () => {
    //   const reserved = Money.of(new Decimal(5000));
    //   const releaseAmount = Money.of(Infinity, 'USDC');
    //
    //   const result = ValidateReleaseAmount.check(releaseAmount, reserved);
    //
    //   expect(result.ok).toBe(false);
    //   if (!result.ok) {
    //     expect(result.error.context?.reason).toBe(BalanceErrorReason.INVALID_FORMAT);
    //   }
    // });

    it('возвращает ошибку если releaseAmount <= 0', () => {
      const reserved = Money.of(new Decimal(5000));
      const releaseAmount = Money.of(new Decimal(0));

      const result = ValidateReleaseAmount.check(releaseAmount, reserved);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(BalanceErrorReason.INVALID_FORMAT);
        expect(result.error.message).toContain('must be positive');
      }
    });

    it('возвращает ошибку для отрицательного releaseAmount', () => {
      const reserved = Money.of(new Decimal(5000));
      const releaseAmount = Money.of(new Decimal(-100), 'USDC');

      const result = ValidateReleaseAmount.check(releaseAmount, reserved);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(BalanceErrorReason.INVALID_FORMAT);
      }
    });
  });
});
