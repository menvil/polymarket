import { describe, it, expect } from '@jest/globals';
import { Quantity } from '../../../src/quantity/core/Quantity.js';
import { QuantityService } from '../../../src/quantity/facade/QuantityService.js';
import { QuantitySerializer, QuantityLossySerializer } from '../../../src/quantity/adapters/QuantitySerializer.js';
import { PositionQuantityPolicy } from '../../../src/quantity/policy/PositionQuantityPolicy.js';
import Decimal from 'decimal.js';

describe('Quantity Integration Workflow', () => {
  describe('Scenario 1: createForOrder + minSize validation', () => {
    it('должен создать Quantity с valid minSize', () => {
      const result = QuantityService.createForOrder(10, new Decimal(1));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeInstanceOf(Quantity);
        expect(result.value.value().toNumber()).toBe(10);
      }
    });

    it('должен вернуть Err для quantity < minSize', () => {
      const result = QuantityService.createForOrder(0.5, new Decimal(1));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('minimum size');
        expect(result.error.context?.op).toBe('createForOrder');
      }
    });
  });

  describe('Scenario 2: add + subtract + non-negative', () => {
    it('должен сложить два Quantity', () => {
      const qty1 = Quantity.of(10);
      const qty2 = Quantity.of(5);
      const result = QuantityService.add(qty1, qty2);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(15);
      }
    });

    it('должен вычесть где qty1 > qty2', () => {
      const qty1 = Quantity.of(10);
      const qty2 = Quantity.of(5);
      const result = QuantityService.subtract(qty1, qty2);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(5);
      }
    });

    it('должен вернуть Err для negative result где qty1 < qty2', () => {
      const qty1 = Quantity.of(5);
      const qty2 = Quantity.of(10);
      const result = QuantityService.subtract(qty1, qty2);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('cannot be negative');
        expect(result.error.context?.op).toBe('subtract');
      }
    });
  });

  describe('Scenario 3: multiply + divide + round', () => {
    it('должен умножить с valid factor', () => {
      const qty = Quantity.of(10);
      const result = QuantityService.multiply(qty, 2);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(20);
      }
    });

    it('должен вернуть Err для negative factor', () => {
      const qty = Quantity.of(10);
      const result = QuantityService.multiply(qty, -1);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('cannot be negative');
      }
    });

    it('должен разделить с valid divisor', () => {
      const qty = Quantity.of(10);
      const result = QuantityService.divide(qty, 2);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(5);
      }
    });

    it('должен вернуть Err для zero divisor', () => {
      const qty = Quantity.of(10);
      const result = QuantityService.divide(qty, 0);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Может быть от rule или от DivisionByZeroError
        expect(result.error.context?.op).toBe('divide');
      }
    });

    it('должен округлить с valid tickSize', () => {
      const qty = Quantity.of(10.567);
      const result = QuantityService.roundToTick(qty, new Decimal(0.01));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(10.57);
      }
    });
  });

  describe('Scenario 4: position validate + partial close', () => {
    it('должен вернуть Ok для qty > 0', () => {
      const qty = Quantity.of(10);
      const result = QuantityService.validateForPosition(qty);

      expect(result.ok).toBe(true);
    });

    it('должен вернуть Ok для qty = 0 (allow zero)', () => {
      const result = QuantityService.validateForPosition(Quantity.ZERO);

      expect(result.ok).toBe(true);
    });

    it('QuantityService.create(-1) должен вернуть Err (NEGATIVE)', () => {
      const result = QuantityService.create(-1);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe('NEGATIVE');
      }
    });

    // Примечание: Тест на validateForPosition с negative Decimal удалён,
    // так как метод теперь принимает Quantity (который гарантирует positive/finite
    // через Core инварианты). Нельзя создать Quantity с negative значением.

    it('должен вернуть Ok для validatePartialClose где closeQuantity <= currentQuantity', () => {
      const result = PositionQuantityPolicy.validatePartialClose(
        new Decimal(10),
        new Decimal(5)
      );

      expect(result.ok).toBe(true);
    });

    it('должен вернуть Err для validatePartialClose где closeQuantity > currentQuantity', () => {
      const result = PositionQuantityPolicy.validatePartialClose(
        new Decimal(10),
        new Decimal(15)
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Cannot close');
      }
    });
  });

  describe('Scenario 5: serialize + deserialize', () => {
    it('QuantitySerializer (string) round-trip без потери точности', () => {
      const bigNum = "12345678901234567890.123456789";
      const original = Quantity.of(bigNum);

      // Сериализация
      const json = QuantitySerializer.toJSON(original);
      expect(json.value).toBe(bigNum);

      // Десериализация
      const result = QuantitySerializer.fromJSON(json);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toString()).toBe(bigNum);
      }
    });

    it('QuantityLossySerializer (number) round-trip (не требуем точности)', () => {
      const qty = Quantity.of(10.5);

      // Сериализация
      const jsonResult = QuantityLossySerializer.toJSON(qty);
      expect(jsonResult.ok).toBe(true);
      if (!jsonResult.ok) return;

      const json = jsonResult.value;
      expect(typeof json.value).toBe('number');

      // Десериализация
      const result = QuantityLossySerializer.fromJSON(json);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toNumber()).toBe(10.5);
      }
    });

    it('String serializer сохраняет точность для больших чисел (сравнение через строки)', () => {
      const bigNum = "99999999999999999999.99999999999999999";
      const original = Quantity.of(bigNum);

      const json = QuantitySerializer.toJSON(original);
      const result = QuantitySerializer.fromJSON(json);

      // Явная проверка успеха десериализации
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Сравниваем через строки, не через number
        expect(result.value.value().toString()).toBe(original.value().toString());
      }
    });
  });
});
