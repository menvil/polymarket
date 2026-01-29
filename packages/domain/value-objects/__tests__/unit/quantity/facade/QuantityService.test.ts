import { describe, it, expect } from '@jest/globals';
import { QuantityService } from '../../../../src/quantity/facade/QuantityService.js';
import { Quantity } from '../../../../src/quantity/core/Quantity.js';
import { InvalidQuantityError } from '@polymarket/errors';
import Decimal from 'decimal.js';

describe('QuantityService', () => {
  describe('create()', () => {
    it('должен создать Quantity из number', () => {
      const result = QuantityService.create(10);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeInstanceOf(Quantity);
        expect(result.value.value().toNumber()).toBe(10);
      }
    });

    it('должен создать Quantity из string', () => {
      const result = QuantityService.create("15.5");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toString()).toBe("15.5");
      }
    });

    it('должен создать Quantity из Decimal (оптимизация, без повторного парсинга)', () => {
      const decimal = new Decimal(20);
      const result = QuantityService.create(decimal);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Проверяем что использовался fromDecimal (тот же объект)
        expect(result.value.value()).toBe(decimal);
      }
    });

    it('должен вернуть Err для negative', () => {
      const result = QuantityService.create(-1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidQuantityError);
      }
    });

    it('должен вернуть Err для NaN', () => {
      const result = QuantityService.create(NaN);
      expect(result.ok).toBe(false);
    });

    it('должен вернуть Err для Infinity', () => {
      const result = QuantityService.create(Infinity);
      expect(result.ok).toBe(false);
    });

    describe('Facade Error Contract', () => {
      it('error должен содержать context.op = "create"', () => {
        expect.assertions(1);
        const result = QuantityService.create(-1);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('create');
        }
      });

      it('error должен содержать context.value', () => {
        expect.assertions(1);
        const result = QuantityService.create(-1);
        if (!result.ok) {
          expect(result.error.context?.value).toBe('-1');
        }
      });

      it('error должен содержать context.reason (от QuantityInvariantViolation)', () => {
        expect.assertions(1);
        const result = QuantityService.create(-1);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe('NEGATIVE');
        }
      });

      it('error для Infinity должен иметь reason = NON_FINITE', () => {
        expect.assertions(1);
        const result = QuantityService.create(Infinity);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe('NON_FINITE');
        }
      });
    });
  });
});
