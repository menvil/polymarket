import Decimal from 'decimal.js';
import { describe, it, expect } from '@jest/globals';
import { ValidateReleaseAmount } from '../../../../src/token-balance/rules/ValidateReleaseAmount.js';
import { Quantity } from '../../../../src/quantity/core/Quantity.js';
import { TokenBalanceErrorReason } from '../../../../src/token-balance/errors/TokenBalanceErrorReason.js';

describe('ValidateReleaseAmount', () => {
  describe('успешная валидация', () => {
    it('проходит если releaseQty <= reserved', () => {
      const reserved = Quantity.of(new Decimal(5000));
      const releaseQty = Quantity.of(new Decimal(2000));

      const result = ValidateReleaseAmount.check(releaseQty, reserved);

      expect(result.ok).toBe(true);
    });

    it('проходит если releaseQty === reserved', () => {
      const reserved = Quantity.of(new Decimal(5000));
      const releaseQty = Quantity.of(new Decimal(5000));

      const result = ValidateReleaseAmount.check(releaseQty, reserved);

      expect(result.ok).toBe(true);
    });

    it('проходит для минимального количества (0.01)', () => {
      const reserved = Quantity.of(new Decimal(5000));
      const releaseQty = Quantity.of(new Decimal(0.01));

      const result = ValidateReleaseAmount.check(releaseQty, reserved);

      expect(result.ok).toBe(true);
    });

    it('проходит для дробных количеств', () => {
      const reserved = Quantity.of(new Decimal(100.5));
      const releaseQty = Quantity.of(new Decimal(50.25));

      const result = ValidateReleaseAmount.check(releaseQty, reserved);

      expect(result.ok).toBe(true);
    });
  });

  describe('ошибка INSUFFICIENT_RESERVED', () => {
    it('возвращает ошибку если releaseQty > reserved', () => {
      const reserved = Quantity.of(new Decimal(5000));
      const releaseQty = Quantity.of(new Decimal(10000));

      const result = ValidateReleaseAmount.check(releaseQty, reserved);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INSUFFICIENT_RESERVED);
        expect(result.error.context?.requested).toBe(10000);
        expect(result.error.context?.reserved).toBe(5000);
      }
    });

    it('содержит читаемое сообщение об ошибке', () => {
      const reserved = Quantity.of(new Decimal(1000));
      const releaseQty = Quantity.of(new Decimal(2000));

      const result = ValidateReleaseAmount.check(releaseQty, reserved);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Cannot release 2000');
        expect(result.error.message).toContain('only 1000 reserved');
      }
    });
  });

  describe('ошибка INVALID_FORMAT', () => {
    it('возвращает ошибку если releaseQty <= 0', () => {
      const reserved = Quantity.of(new Decimal(5000));
      const releaseQty = Quantity.of(new Decimal(0));

      const result = ValidateReleaseAmount.check(releaseQty, reserved);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INVALID_FORMAT);
        expect(result.error.message).toContain('must be positive');
        expect(result.error.context?.releaseQty).toBe('0');
        expect(result.error.context?.reserved).toBe('5000');
      }
    });

    // ПРИМЕЧАНИЕ: Тесты для отрицательных и non-finite значений невозможны,
    // так как Quantity.of() бросает исключение до того, как ValidateReleaseAmount
    // сможет их проверить. Валидация происходит на уровне Quantity, не TokenBalance.
  });

  describe('граничные случаи', () => {
    it('возвращает ошибку если reserved = 0 но releaseQty > 0', () => {
      const reserved = Quantity.ZERO;
      const releaseQty = Quantity.of(new Decimal(100));

      const result = ValidateReleaseAmount.check(releaseQty, reserved);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INSUFFICIENT_RESERVED);
        expect(result.error.context?.requested).toBe(100);
        expect(result.error.context?.reserved).toBe(0);
      }
    });
  });
});
