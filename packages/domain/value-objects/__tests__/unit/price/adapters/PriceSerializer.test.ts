import { describe, it, expect } from '@jest/globals';
import { PriceSerializer } from '../../../../src/price/adapters/PriceSerializer.js';
import { Price } from '../../../../src/price/core/Price.js';

describe('PriceSerializer', () => {
  describe('fromJSON()', () => {
    describe('валидные значения', () => {
      it('должен десериализовать валидный JSON с number', () => {
        const result = PriceSerializer.fromJSON({ value: 0.5 });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toNumber()).toBe(0.5);
        }
      });

      it('должен десериализовать валидный JSON с string', () => {
        const result = PriceSerializer.fromJSON({ value: '0.5' });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toNumber()).toBe(0.5);
        }
      });
    });

    describe('структурные ошибки (invalid_json)', () => {
      it('должен вернуть Err для null', () => {
        const result = PriceSerializer.fromJSON(null);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.kind).toBe('invalid_json');
          expect(result.error.context?.type).toBe('object');
        }
      });

      it('должен вернуть Err для number', () => {
        const result = PriceSerializer.fromJSON(0.5);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.kind).toBe('invalid_json');
          expect(result.error.context?.type).toBe('number');
        }
      });

      it('должен вернуть Err для string', () => {
        const result = PriceSerializer.fromJSON('0.5');
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.kind).toBe('invalid_json');
          expect(result.error.context?.type).toBe('string');
        }
      });

      it('должен вернуть Err для array', () => {
        const result = PriceSerializer.fromJSON([0.5]);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.kind).toBe('invalid_json');
        }
      });

      it('должен вернуть Err для объекта без поля value', () => {
        const result = PriceSerializer.fromJSON({});
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.kind).toBe('invalid_json');
          expect(result.error.context?.type).toBe('missing_field');
        }
      });

      it('должен вернуть Err для неправильного типа value (object)', () => {
        const result = PriceSerializer.fromJSON({ value: {} });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.kind).toBe('invalid_json');
          expect(result.error.context?.type).toBe('object');
        }
      });

      it('должен вернуть Err для неправильного типа value (array)', () => {
        const result = PriceSerializer.fromJSON({ value: [0.5] });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.kind).toBe('invalid_json');
          expect(result.error.context?.type).toBe('object');
        }
      });

      it('должен использовать safeStringify для циклических ссылок', () => {
        const circular: any = { value: 0.5 };
        circular.self = circular;
        const result = PriceSerializer.fromJSON(circular);
        // Должен успешно сериализовать с [Circular]
        expect(result.ok).toBe(true);
      });
    });

    describe('бизнес-ошибки (делегирование PriceService)', () => {
      it('должен вернуть Err для значения вне диапазона', () => {
        const result = PriceSerializer.fromJSON({ value: 1.5 });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.raw).toEqual({ field: 'value', value: '1.5' });
        }
      });

      it('должен вернуть Err для отрицательного значения', () => {
        const result = PriceSerializer.fromJSON({ value: -0.5 });
        expect(result.ok).toBe(false);
      });
    });
  });

  describe('toJSON()', () => {
    it('должен сериализовать Price в JSON', () => {
      const price = Price.of(0.5);
      const json = PriceSerializer.toJSON(price);
      expect(json).toEqual({ value: '0.5' });
    });

    it('должен использовать string для сохранения точности', () => {
      const price = Price.of(0.1234);
      const json = PriceSerializer.toJSON(price);
      expect(typeof json.value).toBe('string');
      expect(json.value).toBe('0.1234');
    });

    it('должен работать с минимальным значением', () => {
      const price = Price.min();
      const json = PriceSerializer.toJSON(price);
      expect(json.value).toBe('0.0001');
    });

    it('должен работать с максимальным значением', () => {
      const price = Price.max();
      const json = PriceSerializer.toJSON(price);
      expect(json.value).toBe('0.9999');
    });
  });

  describe('round-trip', () => {
    it('должен корректно десериализовать сериализованный Price', () => {
      const original = Price.of(0.5);
      const json = PriceSerializer.toJSON(original);
      const result = PriceSerializer.fromJSON(json);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.equals(original)).toBe(true);
      }
    });
  });
});
