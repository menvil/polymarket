import Decimal from 'decimal.js';
import { describe, it, expect } from '@jest/globals';
import { ValidateReserveAmount } from '../../../../src/token-balance/rules/ValidateReserveAmount.js';
import { Quantity } from '../../../../src/quantity/core/Quantity.js';
import { TokenBalanceErrorReason } from '../../../../src/token-balance/errors/TokenBalanceErrorReason.js';

describe('ValidateReserveAmount', () => {
  describe('успешная валидация', () => {
    it('проходит если reserveQty <= available', () => {
      const available = Quantity.of(new Decimal(10000));
      const reserveQty = Quantity.of(new Decimal(5000));

      const result = ValidateReserveAmount.check(reserveQty, available);

      expect(result.ok).toBe(true);
    });

    it('проходит если reserveQty === available', () => {
      const available = Quantity.of(new Decimal(10000));
      const reserveQty = Quantity.of(new Decimal(10000));

      const result = ValidateReserveAmount.check(reserveQty, available);

      expect(result.ok).toBe(true);
    });

    it('проходит для минимального количества (0.01)', () => {
      const available = Quantity.of(new Decimal(10000));
      const reserveQty = Quantity.of(new Decimal(0.01));

      const result = ValidateReserveAmount.check(reserveQty, available);

      expect(result.ok).toBe(true);
    });

    it('проходит для дробных количеств', () => {
      const available = Quantity.of(new Decimal(100.5));
      const reserveQty = Quantity.of(new Decimal(50.25));

      const result = ValidateReserveAmount.check(reserveQty, available);

      expect(result.ok).toBe(true);
    });
  });

  describe('ошибка INSUFFICIENT_AVAILABLE', () => {
    it('возвращает ошибку если reserveQty > available', () => {
      const available = Quantity.of(new Decimal(10000));
      const reserveQty = Quantity.of(new Decimal(15000));

      const result = ValidateReserveAmount.check(reserveQty, available);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INSUFFICIENT_AVAILABLE);
        expect(result.error.context?.requested).toBe(15000);
        expect(result.error.context?.available).toBe(10000);
      }
    });

    it('содержит читаемое сообщение об ошибке', () => {
      const available = Quantity.of(new Decimal(500));
      const reserveQty = Quantity.of(new Decimal(1000));

      const result = ValidateReserveAmount.check(reserveQty, available);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Cannot reserve 1000');
        expect(result.error.message).toContain('only 500 available');
      }
    });
  });

  describe('ошибка INVALID_FORMAT', () => {
    it('возвращает ошибку если reserveQty <= 0', () => {
      const available = Quantity.of(new Decimal(10000));
      const reserveQty = Quantity.of(new Decimal(0));

      const result = ValidateReserveAmount.check(reserveQty, available);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_FORMAT);
        expect(result.error.message).toContain('must be positive');
      }
    });

    // ПРИМЕЧАНИЕ: Тесты для отрицательных и non-finite значений невозможны,
    // так как Quantity.of() бросает исключение до того, как ValidateReserveAmount
    // сможет их проверить. Валидация происходит на уровне Quantity, не TokenBalance.
  });
});
