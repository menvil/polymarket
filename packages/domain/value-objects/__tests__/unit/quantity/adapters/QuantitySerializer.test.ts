import Decimal from 'decimal.js';
import { describe, it, expect } from '@jest/globals';
import { QuantitySerializer } from '../../../../src/quantity/adapters/QuantitySerializer.js';
import { Quantity } from '../../../../src/quantity/core/Quantity.js';

describe('QuantitySerializer', () => {
  describe('toJSON()', () => {
    it('должен сериализовать Quantity в string', () => {
      const qty = Quantity.of(new Decimal(10));
      const json = QuantitySerializer.toJSON(qty);

      expect(json).toEqual({ value: '10' });
    });

    it('должен сохранить точность для decimal значений', () => {
      const qty = Quantity.of(new Decimal("10.123456789"));
      const json = QuantitySerializer.toJSON(qty);

      expect(json.value).toBe("10.123456789");
    });

    it('должен сохранить точность для больших чисел', () => {
      const bigNum = "12345678901234567890.123456789";
      const qty = Quantity.of(new Decimal(bigNum));
      const json = QuantitySerializer.toJSON(qty);

      expect(json.value).toBe(bigNum);
    });
  });

  describe('fromJSON()', () => {
    describe('валидные случаи', () => {
      it('должен десериализовать из string', () => {
        const result = QuantitySerializer.fromJSON({ value: "10" });

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.value().toString()).toBe("10");
        }
      });

      it('должен десериализовать decimal значения', () => {
        const result = QuantitySerializer.fromJSON({ value: "10.123456789" });

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.value().toString()).toBe("10.123456789");
        }
      });

      it('должен десериализовать большие числа без потери точности', () => {
        const bigNum = "12345678901234567890.123456789";
        const result = QuantitySerializer.fromJSON({ value: bigNum });

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.value().toString()).toBe(bigNum);
        }
      });
    });

    describe('структурные ошибки (граница системы)', () => {
      it('должен вернуть Err для null', () => {
        const result = QuantitySerializer.fromJSON(null);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(Error);
          expect(result.error.message).toContain('Expected object');
          expect(result.error.context?.kind).toBe('invalid_json');
          expect(result.error.context?.type).toBe('object');
        }
      });

      it('должен вернуть Err для undefined', () => {
        const result = QuantitySerializer.fromJSON(undefined);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(Error);
          expect(result.error.message).toContain('Expected object');
          expect(result.error.context?.kind).toBe('invalid_json');
          expect(result.error.context?.type).toBe('undefined');
        }
      });

      it('должен вернуть Err для примитивов (number)', () => {
        const result = QuantitySerializer.fromJSON(42);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(Error);
          expect(result.error.message).toContain('Expected object');
          expect(result.error.context?.kind).toBe('invalid_json');
          expect(result.error.context?.type).toBe('number');
        }
      });

      it('должен вернуть Err для примитивов (string)', () => {
        const result = QuantitySerializer.fromJSON("10");

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(Error);
          expect(result.error.message).toContain('Expected object');
          expect(result.error.context?.kind).toBe('invalid_json');
          expect(result.error.context?.type).toBe('string');
        }
      });

      it('должен вернуть Err для массива', () => {
        const result = QuantitySerializer.fromJSON([{ value: "10" }]);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(Error);
          expect(result.error.message).toContain('Expected object, got array');
          expect(result.error.context?.kind).toBe('invalid_json');
          expect(result.error.context?.type).toBe('array');
        }
      });

      it('должен вернуть Err для пустого объекта', () => {
        const result = QuantitySerializer.fromJSON({});

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(Error);
          expect(result.error.message).toContain("Missing required field 'value'");
          expect(result.error.context?.kind).toBe('invalid_json');
          expect(result.error.context?.type).toBe('missing_field');
        }
      });

      it('должен вернуть Err когда value это number', () => {
        const result = QuantitySerializer.fromJSON({ value: 10 });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(Error);
          expect(result.error.message).toContain("Field 'value' must be string");
          expect(result.error.context?.kind).toBe('invalid_json');
          expect(result.error.context?.type).toBe('number');
        }
      });

      it('должен вернуть Err когда value это object', () => {
        const result = QuantitySerializer.fromJSON({ value: { nested: "10" } });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(Error);
          expect(result.error.message).toContain("Field 'value' must be string");
          expect(result.error.context?.kind).toBe('invalid_json');
          expect(result.error.context?.type).toBe('object');
        }
      });

      it('должен вернуть Err когда value это null', () => {
        const result = QuantitySerializer.fromJSON({ value: null });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(Error);
          expect(result.error.message).toContain("Field 'value' must be string");
          expect(result.error.context?.kind).toBe('invalid_json');
          expect(result.error.context?.type).toBe('object');
        }
      });

      it('должен обработать циклические ссылки через safeStringify', () => {
        const circular: any = { value: 123 }; // number вместо string - вызовет ошибку
        circular.self = circular; // создаем циклическую ссылку

        const result = QuantitySerializer.fromJSON(circular);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          // Проверяем что error context содержит json с [Circular]
          expect(result.error.context?.json).toBeDefined();
          expect(result.error.context?.json).toContain('[Circular]');
        }
      });
    });

    describe('бизнес-ошибки (делегированы QuantityService)', () => {
      it('должен вернуть Err для invalid string', () => {
        const result = QuantitySerializer.fromJSON({ value: "not a number" });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(Error);
          expect(result.error.message).toBeTruthy();
          // Проверяем что ошибка содержит информацию о проблеме
          expect(
            result.error.message.toLowerCase().includes('invalid') ||
            result.error.message.toLowerCase().includes('number')
          ).toBe(true);
        }
      });

      it('должен вернуть Err для отрицательных значений', () => {
        const result = QuantitySerializer.fromJSON({ value: "-10" });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toBeInstanceOf(Error);
        }
      });
    });
  });

  describe('round-trip', () => {
    it('должен сохранить точность при round-trip', () => {
      const original = Quantity.of(new Decimal("12345678901234567890.123456789"));
      const json = QuantitySerializer.toJSON(original);
      const result = QuantitySerializer.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toString()).toBe(original.value().toString());
      }
    });
  });
});
