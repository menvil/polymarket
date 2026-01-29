import { describe, it, expect } from '@jest/globals';
import { Quantity, QuantityInvariantViolation } from '../../../../src/quantity/core/Quantity.js';

describe('Quantity constructor', () => {
  describe('invariants', () => {
    it('должен бросить QuantityInvariantViolation для negative значения', () => {
      // Используем of() для доступа к конструктору
      expect(() => Quantity.of(-1)).toThrow(QuantityInvariantViolation);
      expect(() => Quantity.of(-1)).toThrow('cannot be negative');

      try {
        Quantity.of(-1);
      } catch (e) {
        expect(e).toBeInstanceOf(QuantityInvariantViolation);
        expect((e as QuantityInvariantViolation).reason).toBe('NEGATIVE');
      }
    });

    it('должен бросить QuantityInvariantViolation для Infinity', () => {
      expect(() => Quantity.of(Infinity)).toThrow(QuantityInvariantViolation);
      expect(() => Quantity.of(Infinity)).toThrow('must be finite');

      try {
        Quantity.of(Infinity);
      } catch (e) {
        expect(e).toBeInstanceOf(QuantityInvariantViolation);
        expect((e as QuantityInvariantViolation).reason).toBe('NON_FINITE');
      }
    });

    it('должен бросить QuantityInvariantViolation для NaN', () => {
      expect(() => Quantity.of(NaN)).toThrow(QuantityInvariantViolation);
      expect(() => Quantity.of(NaN)).toThrow('must be finite');

      try {
        Quantity.of(NaN);
      } catch (e) {
        expect(e).toBeInstanceOf(QuantityInvariantViolation);
        expect((e as QuantityInvariantViolation).reason).toBe('NON_FINITE');
      }
    });

    it('должен бросить QuantityInvariantViolation для -Infinity', () => {
      expect(() => Quantity.of(-Infinity)).toThrow(QuantityInvariantViolation);
    });

    it('должен принять 0', () => {
      expect(() => Quantity.of(0)).not.toThrow();
    });

    it('должен принять положительное число', () => {
      expect(() => Quantity.of(10)).not.toThrow();
      expect(() => Quantity.of(10.5)).not.toThrow();
    });
  });
});
