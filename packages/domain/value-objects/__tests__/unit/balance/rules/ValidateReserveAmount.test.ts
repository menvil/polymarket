import Decimal from 'decimal.js';
import { describe, it, expect } from '@jest/globals';
import { ValidateReserveAmount } from '../../../../src/balance/rules/ValidateReserveAmount.js';
import { Money } from '../../../../src/money/core/Money.js';
import { BalanceErrorReason } from '../../../../src/balance/errors/BalanceErrorReason.js';

describe('ValidateReserveAmount', () => {
  describe('успешная валидация', () => {
    it('проходит если reserveAmount <= available', () => {
      const available = Money.of(new Decimal(10000));
      const reserveAmount = Money.of(new Decimal(5000));

      const result = ValidateReserveAmount.check(reserveAmount, available);

      expect(result.ok).toBe(true);
    });

    it('проходит если reserveAmount === available', () => {
      const available = Money.of(new Decimal(10000));
      const reserveAmount = Money.of(new Decimal(10000));

      const result = ValidateReserveAmount.check(reserveAmount, available);

      expect(result.ok).toBe(true);
    });

    it('проходит для минимальной суммы (0.01)', () => {
      const available = Money.of(new Decimal(10000));
      const reserveAmount = Money.of(new Decimal(0.01));

      const result = ValidateReserveAmount.check(reserveAmount, available);

      expect(result.ok).toBe(true);
    });
  });

  describe('ошибка INSUFFICIENT_FUNDS', () => {
    it('возвращает ошибку если reserveAmount > available', () => {
      const available = Money.of(new Decimal(10000));
      const reserveAmount = Money.of(new Decimal(15000));

      const result = ValidateReserveAmount.check(reserveAmount, available);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(BalanceErrorReason.INSUFFICIENT_FUNDS);
        expect(result.error.context?.amount).toBe('15000');
        expect(result.error.context?.available).toBe('10000');
      }
    });

    it('содержит читаемое сообщение об ошибке', () => {
      const available = Money.of(new Decimal(500));
      const reserveAmount = Money.of(new Decimal(1000));

      const result = ValidateReserveAmount.check(reserveAmount, available);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Cannot reserve 1000');
        expect(result.error.message).toContain('only 500 available');
      }
    });
  });

  describe('ошибка INVALID_FORMAT', () => {
    // ПРИМЕЧАНИЕ: Тест невозможен, так как Money.of(new Decimal(Infinity)) бросает исключение
    // до того, как ValidateReserveAmount сможет его проверить
    // it('возвращает ошибку если reserveAmount не finite', () => {
    //   const available = Money.of(new Decimal(10000));
    //   const reserveAmount = Money.of(new Decimal(Infinity), 'USDC');
    //
    //   const result = ValidateReserveAmount.check(reserveAmount, available);
    //
    //   expect(result.ok).toBe(false);
    //   if (!result.ok) {
    //     expect(result.error.context?.reason).toBe(BalanceErrorReason.INVALID_FORMAT);
    //   }
    // });

    it('возвращает ошибку если reserveAmount <= 0', () => {
      const available = Money.of(new Decimal(10000));
      const reserveAmount = Money.of(new Decimal(0));

      const result = ValidateReserveAmount.check(reserveAmount, available);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(BalanceErrorReason.INVALID_FORMAT);
        expect(result.error.message).toContain('must be positive');
        expect(result.error.context?.amount).toBe(reserveAmount.value().toString());
        expect(result.error.context?.available).toBe(available.value().toString());
      }
    });

    it('возвращает ошибку для отрицательного reserveAmount', () => {
      const available = Money.of(new Decimal(10000));
      const reserveAmount = Money.of(new Decimal(-100), 'USDC');

      const result = ValidateReserveAmount.check(reserveAmount, available);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(BalanceErrorReason.INVALID_FORMAT);
      }
    });
  });
});
