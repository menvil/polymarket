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

    it('возвращает ошибку для большой разницы', () => {
      const reserved = Quantity.of(new Decimal(10));
      const releaseQty = Quantity.of(new Decimal(1000000));

      const result = ValidateReleaseAmount.check(releaseQty, reserved);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(TokenBalanceErrorReason.INSUFFICIENT_RESERVED);
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
      }
    });

    // ПРИМЕЧАНИЕ: Тест для отрицательного releaseQty невозможен,
    // так как Quantity.of(new Decimal(-100)) бросает исключение
    // до того, как ValidateReleaseAmount сможет его проверить.
    // Валидация происходит на уровне Quantity, не TokenBalance.
  });

  describe('ошибка NON_FINITE', () => {
    // ПРИМЕЧАНИЕ: Тест невозможен, так как Quantity.of(new Decimal(Infinity)) бросает исключение
    // до того, как ValidateReleaseAmount сможет его проверить.
    // Валидация происходит на уровне Quantity, не TokenBalance.
  });
});
