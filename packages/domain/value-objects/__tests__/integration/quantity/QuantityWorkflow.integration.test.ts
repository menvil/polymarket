import { describe, it, expect } from '@jest/globals';
import { Quantity } from '../../../src/quantity/core/Quantity.js';
import { QuantityService } from '../../../src/quantity/facade/QuantityService.js';
import { QuantitySerializer } from '../../../src/quantity/adapters/QuantitySerializer.js';
import { Ratio } from '../../../src/ratio/core/Ratio.js';
import Decimal from 'decimal.js';

describe('Quantity Integration Workflow', () => {
  describe('Scenario 1: add + subtract + non-negative', () => {
    it('должен сложить два Quantity', () => {
      const qty1 = Quantity.of(new Decimal(10));
      const qty2 = Quantity.of(new Decimal(5));
      const result = QuantityService.add(qty1, qty2);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(15);
      }
    });

    it('должен вычесть где qty1 > qty2', () => {
      const qty1 = Quantity.of(new Decimal(10));
      const qty2 = Quantity.of(new Decimal(5));
      const result = QuantityService.subtract(qty1, qty2);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(5);
      }
    });

    it('должен вернуть Err для negative result где qty1 < qty2', () => {
      const qty1 = Quantity.of(new Decimal(5));
      const qty2 = Quantity.of(new Decimal(10));
      const result = QuantityService.subtract(qty1, qty2);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('cannot be negative');
        expect(result.error.context?.op).toBe('subtract');
      }
    });
  });

  describe('Scenario 2: multiply + divide + round', () => {
    it('должен умножить с valid factor', () => {
      const qty = Quantity.of(new Decimal(10));
      const result = QuantityService.multiply(qty, 2);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(20);
      }
    });

    it('должен вернуть Err для negative factor', () => {
      const qty = Quantity.of(new Decimal(10));
      const result = QuantityService.multiply(qty, -1);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('cannot be negative');
      }
    });

    it('должен разделить с valid divisor', () => {
      const qty = Quantity.of(new Decimal(10));
      const result = QuantityService.divide(qty, 2);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(5);
      }
    });

    it('должен вернуть Err для zero divisor', () => {
      const qty = Quantity.of(new Decimal(10));
      const result = QuantityService.divide(qty, 0);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Может быть от rule или от DivisionByZeroError
        expect(result.error.context?.op).toBe('divide');
      }
    });

    it('должен округлить с valid stepSize', () => {
      const qty = Quantity.of(new Decimal(10.567));
      const result = QuantityService.roundToStep(qty, new Decimal(0.01));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toNumber()).toBe(10.57);
      }
    });
  });

  describe('Scenario 3: serialize + deserialize', () => {
    it('QuantitySerializer (string) round-trip без потери точности', () => {
      const bigNum = "12345678901234567890.123456789";
      const original = Quantity.of(new Decimal(bigNum));

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

    it('String serializer сохраняет точность для больших чисел (сравнение через строки)', () => {
      const bigNum = "99999999999999999999.99999999999999999";
      const original = Quantity.of(new Decimal(bigNum));

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

  describe('Scenario 4: portion - вычисление комиссии', () => {
    it('должен вычислить комиссию и вычесть из суммы ордера', () => {
      // Размер ордера
      const orderSize = Quantity.of(new Decimal(100000));
      // Комиссия 0.2%
      const feeRate = Ratio.of(new Decimal(0.002));

      // Вычисляем комиссию
      const feeResult = QuantityService.portion(orderSize, feeRate);
      expect(feeResult.ok).toBe(true);
      if (!feeResult.ok) return;
      expect(feeResult.value.toNumber()).toBe(200); // 0.2% от 100000

      // Вычитаем комиссию из суммы ордера
      const netAmountResult = QuantityService.subtract(orderSize, feeResult.value);
      expect(netAmountResult.ok).toBe(true);
      if (!netAmountResult.ok) return;
      expect(netAmountResult.value.toNumber()).toBe(99800); // 100000 - 200
    });

    it('должен работать в цепочке: portion → multiply → roundToStep', () => {
      // Начальное количество
      const qty = Quantity.of(new Decimal(1000));
      // Берем 50% от количества
      const halfRate = Ratio.of(new Decimal(0.5));

      const halfResult = QuantityService.portion(qty, halfRate);
      expect(halfResult.ok).toBe(true);
      if (!halfResult.ok) return;
      expect(halfResult.value.toNumber()).toBe(500);

      // Умножаем на 1.1
      const multipliedResult = QuantityService.multiply(halfResult.value, 1.1);
      expect(multipliedResult.ok).toBe(true);
      if (!multipliedResult.ok) return;
      expect(multipliedResult.value.toNumber()).toBe(550);

      // Округляем к шагу 10
      const roundedResult = QuantityService.roundToStep(multipliedResult.value, 10);
      expect(roundedResult.ok).toBe(true);
      if (!roundedResult.ok) return;
      expect(roundedResult.value.toNumber()).toBe(550);
    });

    it('portion с малым rate должен сохранять точность', () => {
      const largeQty = Quantity.of(new Decimal('1000000000'));
      const tinyRate = Ratio.of(new Decimal('0.000001')); // 0.0001%

      const result = QuantityService.portion(largeQty, tinyRate);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.value().toString()).toBe('1000'); // точный результат без потери precision
    });
  });

  describe('Scenario 5: increaseBy - DCA стратегия', () => {
    it('должен увеличивать размер ордера на 10% каждый раз (DCA)', () => {
      const baseSize = Quantity.of(new Decimal(100));
      const increment = Ratio.of(new Decimal(0.10)); // +10%
      const stepSize = 1;

      // Первый ордер - базовый размер
      expect(baseSize.toNumber()).toBe(100);

      // Второй ордер - +10%
      const order2Result = QuantityService.increaseBy(baseSize, increment, stepSize);
      expect(order2Result.ok).toBe(true);
      if (!order2Result.ok) return;
      expect(order2Result.value.toNumber()).toBe(110);

      // Третий ордер - еще +10% от второго
      const order3Result = QuantityService.increaseBy(order2Result.value, increment, stepSize);
      expect(order3Result.ok).toBe(true);
      if (!order3Result.ok) return;
      expect(order3Result.value.toNumber()).toBe(121); // 110 * 1.10 = 121

      // Четвертый ордер
      const order4Result = QuantityService.increaseBy(order3Result.value, increment, stepSize);
      expect(order4Result.ok).toBe(true);
      if (!order4Result.ok) return;
      // 121 * 1.10 = 133.1 → round to 133
      expect(order4Result.value.toNumber()).toBe(133);
    });

    it('должен уменьшать размер (negative delta) с сохранением non-negative', () => {
      const qty = Quantity.of(new Decimal(100));
      const decrease = Ratio.of(new Decimal(-0.5)); // -50%
      const stepSize = 1;

      const result = QuantityService.increaseBy(qty, decrease, stepSize);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.toNumber()).toBe(50); // 100 * 0.5 = 50
    });

    it('должен работать в цепочке: increaseBy → subtract → roundToStep', () => {
      const initialQty = Quantity.of(new Decimal(95));
      const delta = Ratio.of(new Decimal(0.10)); // +10%

      // Увеличиваем на 10%
      const increasedResult = QuantityService.increaseBy(initialQty, delta, 1);
      expect(increasedResult.ok).toBe(true);
      if (!increasedResult.ok) return;
      expect(increasedResult.value.toNumber()).toBe(105); // 95 * 1.10 = 104.5 → 105

      // Вычитаем фиксированную величину
      const adjustment = Quantity.of(new Decimal(5));
      const adjustedResult = QuantityService.subtract(increasedResult.value, adjustment);
      expect(adjustedResult.ok).toBe(true);
      if (!adjustedResult.ok) return;
      expect(adjustedResult.value.toNumber()).toBe(100);

      // Округляем к шагу 10
      const finalResult = QuantityService.roundToStep(adjustedResult.value, 10);
      expect(finalResult.ok).toBe(true);
      if (!finalResult.ok) return;
      expect(finalResult.value.toNumber()).toBe(100);
    });
  });

  describe('Scenario 6: portion/increaseBy round-trip через serialization', () => {
    it('portion result должен сохранять точность при round-trip serialization', () => {
      const qty = Quantity.of(new Decimal('123456789.123456789'));
      const rate = Ratio.of(new Decimal('0.333'));

      // Вычисляем portion
      const portionResult = QuantityService.portion(qty, rate);
      expect(portionResult.ok).toBe(true);
      if (!portionResult.ok) return;

      const portion = portionResult.value;
      const originalValue = portion.value().toString();

      // Сериализуем
      const json = QuantitySerializer.toJSON(portion);
      expect(json.value).toBe(originalValue);

      // Десериализуем
      const deserializedResult = QuantitySerializer.fromJSON(json);
      expect(deserializedResult.ok).toBe(true);
      if (!deserializedResult.ok) return;

      // Проверяем что значение не изменилось
      expect(deserializedResult.value.value().toString()).toBe(originalValue);
    });

    it('increaseBy result должен сохранять точность при round-trip serialization', () => {
      const qty = Quantity.of(new Decimal('999999.999999'));
      const delta = Ratio.of(new Decimal('0.123'));
      const stepSize = new Decimal('0.01');

      // Увеличиваем
      const increasedResult = QuantityService.increaseBy(qty, delta, stepSize);
      expect(increasedResult.ok).toBe(true);
      if (!increasedResult.ok) return;

      const increased = increasedResult.value;
      const originalValue = increased.value().toString();

      // Сериализуем
      const json = QuantitySerializer.toJSON(increased);
      expect(json.value).toBe(originalValue);

      // Десериализуем
      const deserializedResult = QuantitySerializer.fromJSON(json);
      expect(deserializedResult.ok).toBe(true);
      if (!deserializedResult.ok) return;

      // Проверяем что значение не изменилось
      expect(deserializedResult.value.value().toString()).toBe(originalValue);
    });
  });
});
