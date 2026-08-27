import Decimal from 'decimal.js';
import { describe, it, expect } from '@jest/globals';
import { OutcomePriceSerializer } from '../../../../src/outcome-price/adapters/OutcomePriceSerializer.js';
import { OutcomePrice } from '../../../../src/outcome-price/core/OutcomePrice.js';

describe('OutcomePriceSerializer', () => {
  describe('fromJSON()', () => {
    describe('валидные значения', () => {
      it('должен десериализовать валидный JSON с number', () => {
        const result = OutcomePriceSerializer.fromJSON({ value: 0.5 });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toNumber()).toBe(0.5);
        }
      });

      it('должен десериализовать валидный JSON с string', () => {
        const result = OutcomePriceSerializer.fromJSON({ value: '0.5' });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.toNumber()).toBe(0.5);
        }
      });
    });

    describe('структурные ошибки (invalid_json)', () => {
      it('должен вернуть Err для null', () => {
        const result = OutcomePriceSerializer.fromJSON(null);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.kind).toBe('invalid_json');
          // 'null', а не 'object': typeof null === 'object' для диагностики
          // бесполезен, и Quantity уже давно сообщал именно 'null'
          expect(result.error.context?.type).toBe('null');
        }
      });

      it('должен вернуть Err для number', () => {
        const result = OutcomePriceSerializer.fromJSON(0.5);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.kind).toBe('invalid_json');
          expect(result.error.context?.type).toBe('number');
        }
      });

      it('должен вернуть Err для string', () => {
        const result = OutcomePriceSerializer.fromJSON('0.5');
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.kind).toBe('invalid_json');
          expect(result.error.context?.type).toBe('string');
        }
      });

      it('должен вернуть Err для array', () => {
        const result = OutcomePriceSerializer.fromJSON([0.5]);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.kind).toBe('invalid_json');
        }
      });

      it('должен вернуть Err для значения из цепочки прототипов', () => {
        const inherited = Object.create({ value: '0.5' }) as unknown;

        const result = OutcomePriceSerializer.fromJSON(inherited);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.type).toBe('missing_field');
        }
      });

      it('должен вернуть Err для объекта без поля value', () => {
        const result = OutcomePriceSerializer.fromJSON({});
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.kind).toBe('invalid_json');
          expect(result.error.context?.type).toBe('missing_field');
        }
      });

      it('должен вернуть Err для неправильного типа value (object)', () => {
        const result = OutcomePriceSerializer.fromJSON({ value: {} });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.kind).toBe('invalid_json');
          expect(result.error.context?.type).toBe('object');
        }
      });

      it('должен вернуть Err для неправильного типа value (array)', () => {
        const result = OutcomePriceSerializer.fromJSON({ value: [0.5] });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.kind).toBe('invalid_json');
          // 'array', а не 'object' — массив в поле отличим от объекта
          expect(result.error.context?.type).toBe('array');
        }
      });

      it('должен использовать safeStringify для циклических ссылок в ошибках', () => {
        // Создаём объект с циклической ссылкой И невалидным value (чтобы вызвать ошибку)
        const circular: any = { value: [1, 2, 3] }; // array вместо number/string
        circular.self = circular;

        const result = OutcomePriceSerializer.fromJSON(circular);

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

        const result = OutcomePriceSerializer.fromJSON(unstringifiable);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          // safeStringify должен обработать ошибку и вернуть '[Unstringifiable]'
          expect(result.error.context?.json).toBe('[Unstringifiable]');
        }
      });
    });

    describe('бизнес-ошибки (делегирование OutcomePriceService)', () => {
      it('должен вернуть Err для значения вне диапазона', () => {
        const result = OutcomePriceSerializer.fromJSON({ value: 1.5 });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          // Invariant violation (range check): raw не сохраняется (rewrap strips caller ctx raw)
          expect(result.error.context?.reason).toBe('OUT_OF_RANGE_HIGH');
        }
      });

      it('должен вернуть Err для отрицательного значения', () => {
        const result = OutcomePriceSerializer.fromJSON({ value: -0.5 });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe('OUT_OF_RANGE_LOW');
        }
      });
    });
  });

  describe('toJSON()', () => {
    it('должен сериализовать OutcomePrice в JSON', () => {
      const price = OutcomePrice.of(new Decimal(0.5));
      const json = OutcomePriceSerializer.toJSON(price);
      expect(json).toEqual({ value: '0.5' });
    });

    it('должен использовать string для сохранения точности', () => {
      const price = OutcomePrice.of(new Decimal(0.1234));
      const json = OutcomePriceSerializer.toJSON(price);
      expect(typeof json.value).toBe('string');
      expect(json.value).toBe('0.1234');
    });

    it('должен работать с минимальным значением', () => {
      const price = OutcomePrice.MIN;
      const json = OutcomePriceSerializer.toJSON(price);
      expect(json.value).toBe('0.0001');
    });

    it('должен работать с максимальным значением', () => {
      const price = OutcomePrice.MAX;
      const json = OutcomePriceSerializer.toJSON(price);
      expect(json.value).toBe('0.9999');
    });
  });

  describe('round-trip', () => {
    it('должен корректно десериализовать сериализованный OutcomePrice', () => {
      const original = OutcomePrice.of(new Decimal(0.5));
      const json = OutcomePriceSerializer.toJSON(original);
      const result = OutcomePriceSerializer.fromJSON(json);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.equals(original)).toBe(true);
      }
    });
  });
});
