import Decimal from 'decimal.js';
import { describe, it, expect } from '@jest/globals';
import { MoneyService } from '../../../../src/money/facade/MoneyService.js';
import { InvalidMoneyError } from '@polymarket/errors';

describe('MoneyService.create()', () => {
  describe('success', () => {
    it('из number', () => {
      const result = MoneyService.create(100);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(100);
      }
    });

    it('из string', () => {
      const result = MoneyService.create('42.50');
      expect(result.ok).toBe(true);
      if (result.ok) {
        // ✅ Сравниваем через Decimal.equals вместо string
        expect(result.value.value().equals(new Decimal('42.5'))).toBe(true);
      }
    });

    it('из Decimal', () => {
      const decimal = new Decimal('999.999');
      const result = MoneyService.create(decimal);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // ✅ ИСПРАВЛЕНО: .equals() вместо toBe()
        expect(result.value.value().equals(decimal)).toBe(true);
      }
    });
  });

  describe('маппинг', () => {
    it('INVALID_FORMAT', () => {
      const result = MoneyService.create('abc');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidMoneyError);
        expect(result.error.context?.reason).toBe('INVALID_FORMAT');
        expect(result.error.context?.op).toBe('create');
        expect(result.error.context?.raw).toEqual({ field: 'value', value: 'abc' });
      }
    });

    it('NAN', () => {
      const result = MoneyService.create(NaN);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe('NAN');
        expect(result.error.context?.op).toBe('create');
        // raw может отсутствовать для NaN (toDecimal не всегда добавляет raw)
      }
    });

    it('NON_FINITE', () => {
      const result = MoneyService.create(Infinity);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe('NON_FINITE');
        expect(result.error.context?.op).toBe('create');
        // raw может отсутствовать для Infinity
      }
    });

    it('EXCEEDS_MAX_AMOUNT', () => {
      const result = MoneyService.create('1e16');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe('EXCEEDS_MAX_AMOUNT');
        expect(result.error.context?.op).toBe('create');
        // raw может отсутствовать для EXCEEDS_MAX_AMOUNT (это проверка из Money.of, не из toDecimal)
      }
    });

    it('UNSUPPORTED_CURRENCY', () => {
      // Runtime: 'EUR' будет отклонено Money.fromDecimal() как UNSUPPORTED_CURRENCY
      const result = MoneyService.create(100, 'EUR' as any);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe('UNSUPPORTED_CURRENCY');
        expect(result.error.context?.op).toBe('create');
        // raw может отсутствовать для UNSUPPORTED_CURRENCY (это проверка из Money.of, не из toDecimal)
      }
    });
  });
});
