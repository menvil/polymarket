import Decimal from 'decimal.js';
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

      it('должен использовать safeStringify для циклических ссылок в ошибках', () => {
        // Создаём объект с циклической ссылкой И невалидным value (чтобы вызвать ошибку)
        const circular: any = { value: [1, 2, 3] }; // array вместо number/string
        circular.self = circular;

        const result = PriceSerializer.fromJSON(circular);

        // Должен вернуть Err из-за невалидного типа value
        expect(result.ok).toBe(false);
        if (!result.ok) {
          // safeStringify должен заменить циклическую ссылку на '[Circular]'
          expect(result.error.context?.json).toContain('[Circular]');
          expect(result.error.context?.kind).toBe('invalid_json');
        }
      });

      it('должен использовать [Unstringifiable] fallback в safeStringify при непредвиденной ошибке', () => {
        // Создаём объект который вызовет ошибку при stringify через getter
        const unstringifiable: any = { value: {} }; // object вместо number/string - вызовет ошибку

        // Добавляем getter который бросает исключение при попытке stringify
        Object.defineProperty(unstringifiable, 'badProperty', {
          enumerable: true,
          get() {
            throw new Error('Getter throws');
          }
        });

        const result = PriceSerializer.fromJSON(unstringifiable);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          // safeStringify должен обработать ошибку и вернуть '[Unstringifiable]'
          expect(result.error.context?.json).toBe('[Unstringifiable]');
        }
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
      const price = Price.of(new Decimal(0.5));
      const json = PriceSerializer.toJSON(price);
      expect(json).toEqual({ value: '0.5' });
    });

    it('должен использовать string для сохранения точности', () => {
      const price = Price.of(new Decimal(0.1234));
      const json = PriceSerializer.toJSON(price);
      expect(typeof json.value).toBe('string');
      expect(json.value).toBe('0.1234');
    });

    it('должен работать с минимальным значением', () => {
      const price = Price.MIN;
      const json = PriceSerializer.toJSON(price);
      expect(json.value).toBe('0.0001');
    });

    it('должен работать с максимальным значением', () => {
      const price = Price.MAX;
      const json = PriceSerializer.toJSON(price);
      expect(json.value).toBe('0.9999');
    });
  });

  describe('round-trip', () => {
    it('должен корректно десериализовать сериализованный Price', () => {
      const original = Price.of(new Decimal(0.5));
      const json = PriceSerializer.toJSON(original);
      const result = PriceSerializer.fromJSON(json);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.equals(original)).toBe(true);
      }
    });
  });
});
