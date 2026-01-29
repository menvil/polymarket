import { describe, it, expect } from '@jest/globals';
import { OrderQuantityPolicy } from '../../../../src/quantity/policy/OrderQuantityPolicy.js';
import { InvalidQuantityError } from '@polymarket/errors';
import Decimal from 'decimal.js';

describe('OrderQuantityPolicy', () => {
  describe('validateForOrder()', () => {
    it('должен вернуть Ok для valid quantity', () => {
      const result = OrderQuantityPolicy.validateForOrder(
        new Decimal(10),
        new Decimal(1)
      );
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Ok для quantity == orderMinSize', () => {
      const result = OrderQuantityPolicy.validateForOrder(
        new Decimal(1),
        new Decimal(1)
      );
      expect(result.ok).toBe(true);
    });

    it('должен вернуть Err для quantity < orderMinSize', () => {
      const result = OrderQuantityPolicy.validateForOrder(
        new Decimal(0.5),
        new Decimal(1)
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidQuantityError);
      }
    });

    it('должен проверять context.minSize вместо текста ошибки', () => {
      // Проверяем стабильные свойства ошибки
      const result = OrderQuantityPolicy.validateForOrder(
        new Decimal(0.5),
        new Decimal(1)
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context).toHaveProperty('minSize');
        expect(result.error.context?.minSize).toBe('1');
      }
    });

    // Примечание: OrderQuantityPolicy работает с Decimal значениями и предполагает
    // что они уже валидированы. Проверка finite/non-finite значений происходит
    // при создании Quantity через QuantityService.create(), а не в Policy.
    // Policy проверяет только бизнес-правила (например, minSize).

    // Примечание: Валидация orderMinSize не является обязанностью OrderQuantityPolicy.
    // Проверка что orderMinSize валиден (positive, finite) должна быть на уровне
    // Market aggregate или конфигурации рынка, а не в Quantity Policy.
  });
});
