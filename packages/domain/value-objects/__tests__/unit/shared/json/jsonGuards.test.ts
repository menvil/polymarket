import { describeType, readField, readJsonObject } from '../../../../src/shared/json/jsonGuards.js';

describe('jsonGuards', () => {
  describe('describeType()', () => {
    it('должен отличать null и array от object', () => {
      expect(describeType(null)).toBe('null');
      expect(describeType([1, 2])).toBe('array');
      expect(describeType({})).toBe('object');
    });

    it('должен возвращать typeof для примитивов', () => {
      expect(describeType('x')).toBe('string');
      expect(describeType(1)).toBe('number');
      expect(describeType(undefined)).toBe('undefined');
    });
  });

  describe('readJsonObject()', () => {
    it('должен принять обычный объект', () => {
      const result = readJsonObject({ value: '1' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ value: '1' });
      }
    });

    it('должен отличать массив от «не объект»', () => {
      const asArray = readJsonObject([1, 2]);
      const asPrimitive = readJsonObject('x');

      expect(asArray.ok).toBe(false);
      if (!asArray.ok) {
        expect(asArray.error.kind).toBe('array');
      }
      expect(asPrimitive.ok).toBe(false);
      if (!asPrimitive.ok) {
        expect(asPrimitive.error).toEqual({ kind: 'not_object', type: 'string' });
      }
    });

    it('должен отвергнуть null и undefined с точным типом', () => {
      for (const [value, type] of [
        [null, 'null'],
        [undefined, 'undefined'],
      ] as const) {
        const result = readJsonObject(value);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toEqual({ kind: 'not_object', type });
        }
      }
    });
  });

  describe('readField()', () => {
    it('должен прочитать поле допустимого типа', () => {
      const result = readField({ value: '1' }, 'value', ['string', 'number']);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe('1');
      }
    });

    it('должен сообщить об отсутствии поля', () => {
      const result = readField({}, 'value', ['string']);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({ kind: 'missing_field', field: 'value' });
      }
    });

    it('должен сообщить о неподходящем типе поля', () => {
      const result = readField({ value: [] }, 'value', ['string']);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({ kind: 'bad_field_type', field: 'value', type: 'array' });
      }
    });

    it('должен считать null неподходящим типом, а не отсутствием поля', () => {
      const result = readField({ value: null }, 'value', ['string']);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({ kind: 'bad_field_type', field: 'value', type: 'null' });
      }
    });

    it('НЕ должен принимать значение из цепочки прототипов', () => {
      // Ради этого проверка идёт через Object.hasOwn, а не через `in`:
      // унаследованное значение данными этого объекта не является
      const inherited = Object.create({ value: '1' }) as Record<string, unknown>;

      expect('value' in inherited).toBe(true);

      const result = readField(inherited, 'value', ['string']);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toEqual({ kind: 'missing_field', field: 'value' });
      }
    });

    it('должен принять собственное поле, затеняющее прототип', () => {
      const shadowing = Object.create({ value: 'from-proto' }) as Record<string, unknown>;
      shadowing.value = 'own';

      const result = readField(shadowing, 'value', ['string']);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe('own');
      }
    });
  });
});
