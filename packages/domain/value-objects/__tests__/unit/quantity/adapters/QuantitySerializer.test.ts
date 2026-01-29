import { describe, it, expect } from '@jest/globals';
import { QuantitySerializer, QuantityLossySerializer } from '../../../../src/quantity/adapters/QuantitySerializer.js';
import { Quantity } from '../../../../src/quantity/core/Quantity.js';

describe('QuantitySerializer', () => {
  describe('toJSON()', () => {
    it('должен сериализовать Quantity в string', () => {
      const qty = Quantity.of(10);
      const json = QuantitySerializer.toJSON(qty);

      expect(json).toEqual({ value: '10' });
    });

    it('должен сохранить точность для decimal значений', () => {
      const qty = Quantity.of("10.123456789");
      const json = QuantitySerializer.toJSON(qty);

      expect(json.value).toBe("10.123456789");
    });

    it('должен сохранить точность для больших чисел', () => {
      const bigNum = "12345678901234567890.123456789";
      const qty = Quantity.of(bigNum);
      const json = QuantitySerializer.toJSON(qty);

      expect(json.value).toBe(bigNum);
    });
  });

  describe('fromJSON()', () => {
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

    it('должен вернуть Err для invalid string', () => {
      const result = QuantitySerializer.fromJSON({ value: "not a number" });

      expect(result.ok).toBe(false);
    });
  });

  describe('round-trip', () => {
    it('должен сохранить точность при round-trip', () => {
      const original = Quantity.of("12345678901234567890.123456789");
      const json = QuantitySerializer.toJSON(original);
      const result = QuantitySerializer.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toString()).toBe(original.value().toString());
      }
    });
  });
});

describe('QuantityLossySerializer', () => {
  describe('toJSON()', () => {
    it('должен сериализовать Quantity в number', () => {
      const qty = Quantity.of(10);
      const json = QuantityLossySerializer.toJSON(qty);

      expect(json).toEqual({ value: 10 });
      expect(typeof json.value).toBe('number');
    });

    it('должен сериализовать decimal значения', () => {
      const qty = Quantity.of(10.5);
      const json = QuantityLossySerializer.toJSON(qty);

      expect(json.value).toBe(10.5);
    });

    it('может потерять точность для больших чисел (ожидаемо)', () => {
      const bigNum = "12345678901234567890.123456789";
      const qty = Quantity.of(bigNum);
      const json = QuantityLossySerializer.toJSON(qty);

      // Проверяем что это number (может быть неточным)
      expect(typeof json.value).toBe('number');
      // НЕ проверяем точность, это lossy serializer
    });
  });

  describe('fromJSON()', () => {
    it('должен десериализовать из number', () => {
      const result = QuantityLossySerializer.fromJSON({ value: 10 });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(10);
      }
    });

    it('должен десериализовать decimal значения', () => {
      const result = QuantityLossySerializer.fromJSON({ value: 10.5 });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(10.5);
      }
    });
  });

  describe('round-trip', () => {
    it('должен работать для small numbers', () => {
      const original = Quantity.of(10.5);
      const json = QuantityLossySerializer.toJSON(original);
      const result = QuantityLossySerializer.fromJSON(json);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(10.5);
      }
    });

    it('НЕ требуем точности для больших чисел (lossy)', () => {
      // Просто проверяем что round-trip не падает
      const bigNum = "12345678901234567890";
      const original = Quantity.of(bigNum);
      const json = QuantityLossySerializer.toJSON(original);
      const result = QuantityLossySerializer.fromJSON(json);

      expect(result.ok).toBe(true);
      // НЕ проверяем точность
    });
  });
});
