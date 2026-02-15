import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { Ratio } from '../../../../src/ratio/core/Ratio.js';
import { ValidateDeltaForIncreaseBy } from '../../../../src/money/rules/ValidateDeltaForIncreaseBy.js';
import { MoneyErrorReason } from '../../../../src/money/errors/MoneyErrorReason.js';

describe('ValidateDeltaForIncreaseBy', () => {
  describe('check()', () => {
    it('принимает положительный delta', () => {
      const delta = Ratio.of(new Decimal(0.5)); // +50%
      const result = ValidateDeltaForIncreaseBy.check(delta);

      expect(result.ok).toBe(true);
    });

    it('принимает нулевой delta', () => {
      const delta = Ratio.of(new Decimal(0)); // 0%
      const result = ValidateDeltaForIncreaseBy.check(delta);

      expect(result.ok).toBe(true);
    });

    it('принимает отрицательный delta > -1', () => {
      const delta = Ratio.of(new Decimal(-0.5)); // -50%
      const result = ValidateDeltaForIncreaseBy.check(delta);

      expect(result.ok).toBe(true);
    });

    it('принимает delta = -1 (граничное значение)', () => {
      const delta = Ratio.of(new Decimal(-1)); // -100%
      const result = ValidateDeltaForIncreaseBy.check(delta);

      expect(result.ok).toBe(true);
    });

    it('отклоняет delta < -1', () => {
      const delta = Ratio.of(new Decimal(-1.5)); // -150%
      const result = ValidateDeltaForIncreaseBy.check(delta);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(MoneyErrorReason.DELTA_LESS_THAN_MINUS_ONE);
        expect(result.error.message).toContain('Delta must be >= -1');
        expect(result.error.context?.delta).toBe('-1.5');
      }
    });

    it('отклоняет очень большой отрицательный delta', () => {
      const delta = Ratio.of(new Decimal(-10)); // -1000%
      const result = ValidateDeltaForIncreaseBy.check(delta);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(MoneyErrorReason.DELTA_LESS_THAN_MINUS_ONE);
      }
    });

    it('принимает большой положительный delta', () => {
      const delta = Ratio.of(new Decimal(10)); // +1000%
      const result = ValidateDeltaForIncreaseBy.check(delta);

      expect(result.ok).toBe(true);
    });
  });
});
