import { SignedQuantitySerializer } from '../../../src/signed-quantity/adapters/SignedQuantitySerializer.js';
import { SignedQuantityService } from '../../../src/signed-quantity/facade/SignedQuantityService.js';
import { isErr } from '@polymarket/result';

describe('SignedQuantitySerializer', () => {
  describe('toJSON', () => {
    it('should serialize positive SignedQuantity', () => {
      const qtyResult = SignedQuantityService.create(10.5);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const json = SignedQuantitySerializer.toJSON(qtyResult.value);
        expect(json).toEqual({ value: '10.5' });
      }
    });

    it('should serialize negative SignedQuantity', () => {
      const qtyResult = SignedQuantityService.create(-10.5);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const json = SignedQuantitySerializer.toJSON(qtyResult.value);
        expect(json).toEqual({ value: '-10.5' });
      }
    });

    it('should serialize zero', () => {
      const qtyResult = SignedQuantityService.create(0);
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const json = SignedQuantitySerializer.toJSON(qtyResult.value);
        expect(json).toEqual({ value: '0' });
      }
    });

    it('should preserve precision in string', () => {
      const qtyResult = SignedQuantityService.create('-123.456789012345');
      expect(qtyResult.ok).toBe(true);
      if (qtyResult.ok) {
        const json = SignedQuantitySerializer.toJSON(qtyResult.value);
        expect(json.value).toBe('-123.456789012345');
      }
    });
  });

  describe('fromJSON', () => {
    describe('успешная десериализация', () => {
      it('should deserialize positive SignedQuantity', () => {
        const result = SignedQuantitySerializer.fromJSON({ value: '10.5' });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toNumber()).toBe(10.5);
        }
      });

      it('should deserialize negative SignedQuantity', () => {
        const result = SignedQuantitySerializer.fromJSON({ value: '-10.5' });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toNumber()).toBe(-10.5);
        }
      });

      it('should deserialize zero', () => {
        const result = SignedQuantitySerializer.fromJSON({ value: '0' });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.isZero()).toBe(true);
        }
      });

      it('should preserve precision', () => {
        const result = SignedQuantitySerializer.fromJSON({ value: '-123.456789012345' });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.value().toString()).toBe('-123.456789012345');
        }
      });
    });

    describe('структурные ошибки', () => {
      it('should fail on null', () => {
        const result = SignedQuantitySerializer.fromJSON(null);
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.message).toContain('Expected object');
        }
      });

      it('should fail on undefined', () => {
        const result = SignedQuantitySerializer.fromJSON(undefined);
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.message).toContain('Expected object');
        }
      });

      it('should fail on string', () => {
        const result = SignedQuantitySerializer.fromJSON('10.5');
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.message).toContain('Expected object');
        }
      });

      it('should fail on number', () => {
        const result = SignedQuantitySerializer.fromJSON(10.5);
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.message).toContain('Expected object');
        }
      });

      it('should fail on array', () => {
        const result = SignedQuantitySerializer.fromJSON(['10.5']);
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.message).toContain('Expected object, got array');
        }
      });

      it('should fail on missing value field', () => {
        const result = SignedQuantitySerializer.fromJSON({});
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.message).toContain("Missing required field 'value'");
        }
      });

      it('should fail on value as number', () => {
        const result = SignedQuantitySerializer.fromJSON({ value: 10.5 });
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.message).toContain("Field 'value' must be string");
        }
      });

      it('should fail on value as null', () => {
        const result = SignedQuantitySerializer.fromJSON({ value: null });
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.message).toContain("Field 'value' must be string");
        }
      });

      it('should handle circular object without value field', () => {
        const circular: any = {};
        circular.self = circular;

        const result = SignedQuantitySerializer.fromJSON(circular);
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.message).toContain("Missing required field 'value'");
          expect(result.error.context?.json).toContain('[Circular]');
        }
      });

      it('should handle unstringifiable value (BigInt)', () => {
        const bigIntObj = { value: BigInt(123) };

        const result = SignedQuantitySerializer.fromJSON(bigIntObj);
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.message).toContain("Field 'value' must be string");
          // BigInt вызывает ошибку при JSON.stringify, поэтому получим [Unstringifiable]
          expect(result.error.context?.json).toBe('[Unstringifiable]');
        }
      });
    });

    describe('бизнес-ошибки валидации', () => {
      it('should fail on invalid number string', () => {
        const result = SignedQuantitySerializer.fromJSON({ value: 'not-a-number' });
        expect(isErr(result)).toBe(true);
      });

      it('should fail on NaN string', () => {
        const result = SignedQuantitySerializer.fromJSON({ value: 'NaN' });
        expect(isErr(result)).toBe(true);
      });

      it('should fail on Infinity string', () => {
        const result = SignedQuantitySerializer.fromJSON({ value: 'Infinity' });
        expect(isErr(result)).toBe(true);
      });

      it('should fail on -Infinity string', () => {
        const result = SignedQuantitySerializer.fromJSON({ value: '-Infinity' });
        expect(isErr(result)).toBe(true);
      });
    });

    describe('round-trip serialization', () => {
      it('should round-trip positive', () => {
        const original = SignedQuantityService.create(10.5);
        expect(original.ok).toBe(true);
        if (original.ok) {
          const json = SignedQuantitySerializer.toJSON(original.value);
          const deserialized = SignedQuantitySerializer.fromJSON(json);
          expect(deserialized.ok).toBe(true);
          if (deserialized.ok) {
            expect(deserialized.value.equals(original.value)).toBe(true);
          }
        }
      });

      it('should round-trip negative', () => {
        const original = SignedQuantityService.create(-10.5);
        expect(original.ok).toBe(true);
        if (original.ok) {
          const json = SignedQuantitySerializer.toJSON(original.value);
          const deserialized = SignedQuantitySerializer.fromJSON(json);
          expect(deserialized.ok).toBe(true);
          if (deserialized.ok) {
            expect(deserialized.value.equals(original.value)).toBe(true);
          }
        }
      });

      it('should round-trip zero', () => {
        const original = SignedQuantityService.create(0);
        expect(original.ok).toBe(true);
        if (original.ok) {
          const json = SignedQuantitySerializer.toJSON(original.value);
          const deserialized = SignedQuantitySerializer.fromJSON(json);
          expect(deserialized.ok).toBe(true);
          if (deserialized.ok) {
            expect(deserialized.value.equals(original.value)).toBe(true);
          }
        }
      });

      it('should preserve precision in round-trip', () => {
        const original = SignedQuantityService.create('-123.456789012345');
        expect(original.ok).toBe(true);
        if (original.ok) {
          const json = SignedQuantitySerializer.toJSON(original.value);
          const deserialized = SignedQuantitySerializer.fromJSON(json);
          expect(deserialized.ok).toBe(true);
          if (deserialized.ok) {
            expect(deserialized.value.value().toString()).toBe('-123.456789012345');
          }
        }
      });
    });
  });
});
