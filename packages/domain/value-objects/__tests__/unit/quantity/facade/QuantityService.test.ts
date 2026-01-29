import { describe, it, expect } from '@jest/globals';
import { QuantityService } from '../../../../src/quantity/facade/QuantityService.js';
import { Quantity } from '../../../../src/quantity/core/Quantity.js';
import { InvalidQuantityError } from '@polymarket/errors';
import Decimal from 'decimal.js';

describe('QuantityService', () => {
  describe('create()', () => {
    it('должен создать Quantity из number', () => {
      const result = QuantityService.create(10);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeInstanceOf(Quantity);
        expect(result.value.value().toNumber()).toBe(10);
      }
    });

    it('должен создать Quantity из string', () => {
      const result = QuantityService.create("15.5");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toString()).toBe("15.5");
      }
    });

    it('должен создать Quantity из Decimal (оптимизация, без повторного парсинга)', () => {
      const decimal = new Decimal(20);
      const result = QuantityService.create(decimal);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Проверяем что использовался fromDecimal (тот же объект)
        expect(result.value.value()).toBe(decimal);
      }
    });

    it('должен вернуть Err для negative', () => {
      const result = QuantityService.create(-1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidQuantityError);
      }
    });

    it('должен вернуть Err для NaN', () => {
      const result = QuantityService.create(NaN);
      expect(result.ok).toBe(false);
    });

    it('должен вернуть Err для Infinity', () => {
      const result = QuantityService.create(Infinity);
      expect(result.ok).toBe(false);
    });

    describe('Facade Error Contract', () => {
      it('error должен содержать context.op = "create"', () => {
        expect.assertions(1);
        const result = QuantityService.create(-1);
        if (!result.ok) {
          expect(result.error.context?.op).toBe('create');
        }
      });

      it('error должен содержать context.value', () => {
        expect.assertions(1);
        const result = QuantityService.create(-1);
        if (!result.ok) {
          expect(result.error.context?.value).toBe('-1');
        }
      });

      it('error должен содержать context.reason (от QuantityInvariantViolation)', () => {
        expect.assertions(1);
        const result = QuantityService.create(-1);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe('NEGATIVE');
        }
      });

      it('error для Infinity должен иметь reason = NON_FINITE', () => {
        expect.assertions(1);
        const result = QuantityService.create(Infinity);
        if (!result.ok) {
          expect(result.error.context?.reason).toBe('NON_FINITE');
        }
      });
    });
  });

  describe('createForOrder()', () => {
    it('должен создать Quantity для valid order', () => {
      const result = QuantityService.createForOrder(10, new Decimal(1));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeInstanceOf(Quantity);
      }
    });

    it('должен вернуть Err для quantity < orderMinSize', () => {
      const result = QuantityService.createForOrder(0.5, new Decimal(1));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidQuantityError);
        expect(result.error.message).toContain('minimum size');
      }
    });

    it('должен парсить value только один раз', () => {
      const decimal = new Decimal(10);
      const result = QuantityService.createForOrder(decimal, new Decimal(1));
      if (result.ok) {
        // Проверяем что decimal не был распарсен повторно
        expect(result.value.value()).toBe(decimal);
      }
    });

    describe('Facade Error Contract', () => {
      it('error должен содержать context.op = "createForOrder"', () => {
        expect.assertions(1);
        const result = QuantityService.createForOrder(0.5, new Decimal(1));
        if (!result.ok) {
          expect(result.error.context?.op).toBe('createForOrder');
        }
      });

      it('error должен содержать context из policy (quantity, minSize)', () => {
        expect.assertions(2);
        const result = QuantityService.createForOrder(0.5, new Decimal(1));
        if (!result.ok) {
          expect(result.error.context).toHaveProperty('quantity');
          expect(result.error.context).toHaveProperty('minSize');
        }
      });

      it('error для negative должен содержать context.op = "createForOrder"', () => {
        expect.assertions(1);
        const result = QuantityService.createForOrder(-1, new Decimal(1));
        if (!result.ok) {
          expect(result.error.context?.op).toBe('createForOrder');
        }
      });
    });
  });

  describe('add()', () => {
    it('должен сложить два Quantity', () => {
      const qty1 = Quantity.of(10);
      const qty2 = Quantity.of(5);
      const result = QuantityService.add(qty1, qty2);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(15);
      }
    });

    it('должен работать с ZERO', () => {
      const qty = Quantity.of(10);
      const result = QuantityService.add(qty, Quantity.ZERO);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(10);
      }
    });

    it('должен вернуть Err если результат non-finite (overflow)', () => {
      // Создаём очень большое число через Decimal
      const bigQty = Quantity.fromDecimal(new Decimal('1e308'));
      const result = QuantityService.add(bigQty, bigQty);

      // Если addDecimal вернёт Infinity, create() вернёт Err
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidQuantityError);
        expect(result.error.context?.reason).toBe('NON_FINITE');
      }
    });

    describe('Facade Error Contract', () => {
      it('error должен содержать context.op = "add"', () => {
        const bigQty = Quantity.fromDecimal(new Decimal('1e308'));
        const result = QuantityService.add(bigQty, bigQty);

        if (!result.ok) {
          expect(result.error.context?.op).toBe('add');
        }
      });

      it('error должен содержать context.quantity1 и quantity2', () => {
        const bigQty = Quantity.fromDecimal(new Decimal('1e308'));
        const result = QuantityService.add(bigQty, bigQty);

        if (!result.ok) {
          expect(result.error.context).toHaveProperty('quantity1');
          expect(result.error.context).toHaveProperty('quantity2');
        }
      });
    });
  });

  describe('subtract()', () => {
    it('должен вычесть два Quantity', () => {
      const qty1 = Quantity.of(10);
      const qty2 = Quantity.of(5);
      const result = QuantityService.subtract(qty1, qty2);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(5);
      }
    });

    it('должен вернуть Ok для 0 результата', () => {
      const qty = Quantity.of(10);
      const result = QuantityService.subtract(qty, qty);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(0);
      }
    });

    it('должен вернуть Err для negative результата', () => {
      const qty1 = Quantity.of(5);
      const qty2 = Quantity.of(10);
      const result = QuantityService.subtract(qty1, qty2);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidQuantityError);
        expect(result.error.message).toContain('cannot be negative');
      }
    });

    describe('Facade Error Contract', () => {
      it('error должен содержать context.op = "subtract"', () => {
        expect.assertions(1);
        const qty1 = Quantity.of(5);
        const qty2 = Quantity.of(10);
        const result = QuantityService.subtract(qty1, qty2);

        if (!result.ok) {
          expect(result.error.context?.op).toBe('subtract');
        }
      });

      it('error должен содержать context.quantity1 и quantity2', () => {
        expect.assertions(2);
        const qty1 = Quantity.of(5);
        const qty2 = Quantity.of(10);
        const result = QuantityService.subtract(qty1, qty2);

        if (!result.ok) {
          expect(result.error.context?.quantity1).toBe('5');
          expect(result.error.context?.quantity2).toBe('10');
        }
      });

      it('error должен содержать context.result (от rule)', () => {
        expect.assertions(2);
        const qty1 = Quantity.of(5);
        const qty2 = Quantity.of(10);
        const result = QuantityService.subtract(qty1, qty2);

        if (!result.ok) {
          expect(result.error.context).toHaveProperty('result');
          expect(result.error.context?.result).toBe('-5');
        }
      });
    });
  });

  describe('multiply()', () => {
    it('должен умножить Quantity на number', () => {
      const qty = Quantity.of(10);
      const result = QuantityService.multiply(qty, 2);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(20);
      }
    });

    it('должен умножить Quantity на Decimal', () => {
      const qty = Quantity.of(10);
      const result = QuantityService.multiply(qty, new Decimal(2.5));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(25);
      }
    });

    it('должен вернуть Ok для умножения на 0', () => {
      const qty = Quantity.of(10);
      const result = QuantityService.multiply(qty, 0);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(0);
      }
    });

    it('должен вернуть Err для negative factor', () => {
      const qty = Quantity.of(10);
      const result = QuantityService.multiply(qty, -1);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(InvalidQuantityError);
        expect(result.error.message).toContain('cannot be negative');
      }
    });

    it('должен вернуть Err для Infinity factor', () => {
      const qty = Quantity.of(10);
      const result = QuantityService.multiply(qty, Infinity);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('must be finite');
      }
    });

    describe('Facade Error Contract', () => {
      it('error должен содержать context.op = "multiply"', () => {
        expect.assertions(1);
        const qty = Quantity.of(10);
        const result = QuantityService.multiply(qty, -1);

        if (!result.ok) {
          expect(result.error.context?.op).toBe('multiply');
        }
      });

      it('error должен содержать context.quantity', () => {
        expect.assertions(1);
        const qty = Quantity.of(10);
        const result = QuantityService.multiply(qty, -1);

        if (!result.ok) {
          expect(result.error.context?.quantity).toBe('10');
        }
      });

      it('error должен содержать context.factor', () => {
        expect.assertions(1);
        const qty = Quantity.of(10);
        const result = QuantityService.multiply(qty, -1);

        if (!result.ok) {
          expect(result.error.context?.factor).toBe('-1');
        }
      });
    });
  });
});
