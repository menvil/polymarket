import { describe, it, expect } from '@jest/globals';
import { isErr } from '@polymarket/result';
import { Decimal } from 'decimal.js';
import { RatioService } from '../../../../src/ratio/facade/RatioService';
import { RatioSerializer } from '../../../../src/ratio/adapters/RatioSerializer';
import { RatioErrorReason } from '../../../../src/ratio/errors/RatioErrorReason';

describe('RatioSerializer', () => {
  describe('toJSON()', () => {
    it('сериализует в JSON с ratio полем', () => {
      const ratioResult = RatioService.fromPercent(2);
      expect(ratioResult.ok).toBe(true);
      if (ratioResult.ok) {
        const json = RatioSerializer.toJSON(ratioResult.value);
        expect(json).toHaveProperty('ratio');
        expect(typeof json.ratio).toBe('string');
        expect(json.ratio).toBe('0.02');
      }
    });

    it('сохраняет точность как string', () => {
      const ratioResult = RatioService.fromDecimal(0.123456789);
      expect(ratioResult.ok).toBe(true);
      if (ratioResult.ok) {
        const json = RatioSerializer.toJSON(ratioResult.value);
        expect(json.ratio).toBe('0.123456789');
      }
    });

    it('сериализует отрицательное значение', () => {
      const ratioResult = RatioService.fromDecimal(-0.1);
      expect(ratioResult.ok).toBe(true);
      if (ratioResult.ok) {
        const json = RatioSerializer.toJSON(ratioResult.value);
        expect(json.ratio).toBe('-0.1');
      }
    });

    it('сериализует ноль', () => {
      const ratioResult = RatioService.fromDecimal(0);
      expect(ratioResult.ok).toBe(true);
      if (ratioResult.ok) {
        const json = RatioSerializer.toJSON(ratioResult.value);
        expect(json.ratio).toBe('0');
      }
    });
  });

  describe('fromJSON()', () => {
    it('десериализует корректный JSON', () => {
      const json = { ratio: '0.02' };
      const result = RatioSerializer.fromJSON(json);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toDecimal().toString()).toBe('0.02');
      }
    });

    it('десериализует отрицательное значение', () => {
      const json = { ratio: '-0.1' };
      const result = RatioSerializer.fromJSON(json);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toDecimal().toString()).toBe('-0.1');
      }
    });

    it('десериализует ноль', () => {
      const json = { ratio: '0' };
      const result = RatioSerializer.fromJSON(json);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isZero()).toBe(true);
      }
    });

    it('отклоняет null', () => {
      const result = RatioSerializer.fromJSON(null);
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.context?.reason).toBe(RatioErrorReason.INVALID_JSON_STRUCTURE);
      }
    });

    it('отклоняет undefined', () => {
      const result = RatioSerializer.fromJSON(undefined);
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.context?.reason).toBe(RatioErrorReason.INVALID_JSON_STRUCTURE);
      }
    });

    it('отклоняет строку', () => {
      const result = RatioSerializer.fromJSON('0.02');
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.context?.reason).toBe(RatioErrorReason.INVALID_JSON_STRUCTURE);
      }
    });

    it('отклоняет number', () => {
      const result = RatioSerializer.fromJSON(0.02);
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.context?.reason).toBe(RatioErrorReason.INVALID_JSON_STRUCTURE);
      }
    });

    it('отклоняет объект без ratio поля', () => {
      const result = RatioSerializer.fromJSON({ value: '0.02' });
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.context?.reason).toBe(RatioErrorReason.INVALID_JSON_STRUCTURE);
      }
    });

    it('отклоняет объект с ratio не-string', () => {
      const result = RatioSerializer.fromJSON({ ratio: 0.02 });
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.context?.reason).toBe(RatioErrorReason.INVALID_JSON_STRUCTURE);
      }
    });

    it('отклоняет некорректный decimal string', () => {
      const json = { ratio: 'not a number' };
      const result = RatioSerializer.fromJSON(json);
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.context?.reason).toBe(RatioErrorReason.INVALID_FORMAT);
      }
    });

    it('отклоняет пустую строку', () => {
      const json = { ratio: '' };
      const result = RatioSerializer.fromJSON(json);
      expect(isErr(result)).toBe(true);
    });

    // Проверяем что ratio: number (не string) отклоняется как INVALID_JSON_STRUCTURE
    it('отклоняет объект с ratio-числом вместо строки', () => {
      const result = RatioSerializer.fromJSON({ ratio: 123 });
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.context?.reason).toBe(RatioErrorReason.INVALID_JSON_STRUCTURE);
      }
    });
  });

  describe('round-trip сериализация', () => {
    it('serialize -> deserialize -> equals для 2%', () => {
      const original = RatioService.fromPercent(2);
      expect(original.ok).toBe(true);
      if (original.ok) {
        const json = RatioSerializer.toJSON(original.value);
        const deserialized = RatioSerializer.fromJSON(json);
        expect(deserialized.ok).toBe(true);
        if (deserialized.ok) {
          expect(original.value.equals(deserialized.value)).toBe(true);
        }
      }
    });

    it('serialize -> deserialize -> equals для отрицательного', () => {
      const original = RatioService.fromDecimal(-0.15);
      expect(original.ok).toBe(true);
      if (original.ok) {
        const json = RatioSerializer.toJSON(original.value);
        const deserialized = RatioSerializer.fromJSON(json);
        expect(deserialized.ok).toBe(true);
        if (deserialized.ok) {
          expect(original.value.equals(deserialized.value)).toBe(true);
        }
      }
    });

    it('serialize -> deserialize -> equals для нуля', () => {
      const original = RatioService.fromDecimal(0);
      expect(original.ok).toBe(true);
      if (original.ok) {
        const json = RatioSerializer.toJSON(original.value);
        const deserialized = RatioSerializer.fromJSON(json);
        expect(deserialized.ok).toBe(true);
        if (deserialized.ok) {
          expect(original.value.equals(deserialized.value)).toBe(true);
        }
      }
    });

    it('serialize -> deserialize -> equals для больших значений', () => {
      const original = RatioService.fromDecimal(1.5);
      expect(original.ok).toBe(true);
      if (original.ok) {
        const json = RatioSerializer.toJSON(original.value);
        const deserialized = RatioSerializer.fromJSON(json);
        expect(deserialized.ok).toBe(true);
        if (deserialized.ok) {
          expect(original.value.equals(deserialized.value)).toBe(true);
        }
      }
    });

    it('сохраняет точность после round-trip', () => {
      // Используем строку для создания Decimal с высокой точностью
      // Избегаем number literal с потерей точности (@typescript-eslint/no-loss-of-precision)
      const original = RatioService.fromDecimal(new Decimal('0.123456789123456789'));
      expect(original.ok).toBe(true);
      if (original.ok) {
        const json = RatioSerializer.toJSON(original.value);
        const deserialized = RatioSerializer.fromJSON(json);
        expect(deserialized.ok).toBe(true);
        if (deserialized.ok) {
          expect(original.value.toDecimal().equals(deserialized.value.toDecimal())).toBe(true);
        }
      }
    });
  });

  describe('JSON.stringify/JSON.parse совместимость', () => {
    it('работает с JSON.stringify', () => {
      const ratioResult = RatioService.fromPercent(2);
      expect(ratioResult.ok).toBe(true);
      if (ratioResult.ok) {
        const json = RatioSerializer.toJSON(ratioResult.value);
        const jsonString = JSON.stringify(json);
        expect(jsonString).toBe('{"ratio":"0.02"}');
      }
    });

    it('работает с JSON.parse', () => {
      const jsonString = '{"ratio":"0.02"}';
      const json = JSON.parse(jsonString);
      const result = RatioSerializer.fromJSON(json);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toDecimal().toString()).toBe('0.02');
      }
    });

    it('полный round-trip через JSON.stringify/parse', () => {
      const original = RatioService.fromPercent(5.5);
      expect(original.ok).toBe(true);
      if (original.ok) {
        const json = RatioSerializer.toJSON(original.value);
        const jsonString = JSON.stringify(json);
        const parsed = JSON.parse(jsonString);
        const deserialized = RatioSerializer.fromJSON(parsed);
        expect(deserialized.ok).toBe(true);
        if (deserialized.ok) {
          expect(original.value.equals(deserialized.value)).toBe(true);
        }
      }
    });
  });
});
