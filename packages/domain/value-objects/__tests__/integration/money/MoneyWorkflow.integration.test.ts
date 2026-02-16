import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { MoneyService } from '../../../src/money/facade/MoneyService';
import { MoneyFormatter } from '../../../src/money/adapters/MoneyFormatter';
import { MoneySerializer } from '../../../src/money/adapters/MoneySerializer';
import { Money } from '../../../src/money/core/Money';

describe('Money Integration Workflow', () => {
  describe('создание через разные форматы приводит к одинаковым значениям', () => {
    it('из number, string и Decimal дают одинаковый результат', () => {
      const fromNumber = MoneyService.create(100, 'USDC');
      const fromString = MoneyService.create('100', 'USDC');
      const fromDecimal = MoneyService.create(new Decimal(100), 'USDC');

      expect(fromNumber.ok).toBe(true);
      expect(fromString.ok).toBe(true);
      expect(fromDecimal.ok).toBe(true);

      if (fromNumber.ok && fromString.ok && fromDecimal.ok) {
        const eq1 = MoneyService.equals(fromNumber.value, fromString.value);
        const eq2 = MoneyService.equals(fromString.value, fromDecimal.value);
        const eq3 = MoneyService.equals(fromDecimal.value, fromNumber.value);

        expect(eq1.ok && eq1.value).toBe(true);
        expect(eq2.ok && eq2.value).toBe(true);
        expect(eq3.ok && eq3.value).toBe(true);
      }
    });

    it('разные суммы создают разные Money', () => {
      const m1 = MoneyService.create(100, 'USDC');
      const m2 = MoneyService.create(200, 'USDC');

      expect(m1.ok).toBe(true);
      expect(m2.ok).toBe(true);

      if (m1.ok && m2.ok) {
        expect(m1.value.currency()).toBe('USDC');
        expect(m2.value.currency()).toBe('USDC');

        // Они не равны, т.к. разные суммы
        const eq = MoneyService.equals(m1.value, m2.value);
        expect(eq.ok && eq.value).toBe(false);
      }
    });

    it('высокая точность сохраняется при создании', () => {
      const precise = MoneyService.create('123.456789012345', 'USDC');
      expect(precise.ok).toBe(true);

      if (precise.ok) {
        expect(precise.value.value().toString()).toBe('123.456789012345');
      }
    });
  });

  describe('полный workflow: создание → форматирование', () => {
    it('toFixed format', () => {
      const original = MoneyService.create(100.5, 'USDC');
      expect(original.ok).toBe(true);

      if (original.ok) {
        const formatted = MoneyFormatter.toFixed(original.value, 2);
        expect(formatted.ok).toBe(true);

        if (formatted.ok) {
          expect(formatted.value).toBe('100.50');
        }
      }
    });

    it('toCurrency format', () => {
      const original = MoneyService.create(100.5, 'USDC');
      expect(original.ok).toBe(true);

      if (original.ok) {
        const formatted = MoneyFormatter.toCurrency(original.value, true, 2);
        expect(formatted.ok).toBe(true);

        if (formatted.ok) {
          // Форматирование включает валюту
          expect(formatted.value).toContain('USDC');
          expect(formatted.value).toContain('100.50');
        }
      }
    });

    it('toCompact format', () => {
      const original = MoneyService.create(1234567.89, 'USDC');
      expect(original.ok).toBe(true);

      if (original.ok) {
        const formatted = MoneyFormatter.toCompact(original.value);
        expect(formatted.ok).toBe(true);

        if (formatted.ok) {
          // Compact format показывает укороченное значение
          expect(formatted.value).toMatch(/1\.\d+M/); // "1.23M"
        }
      }
    });
  });

  describe('полный workflow: создание → сериализация → десериализация', () => {
    it('JSON round-trip сохраняет значение', () => {
      const original = MoneyService.create(123.45, 'USDC');
      expect(original.ok).toBe(true);

      if (original.ok) {
        const json = MoneySerializer.toJSON(original.value);
        expect(json).toEqual({
          amount: '123.45',
          currency: 'USDC'
        });

        const deserialized = MoneySerializer.fromJSON(json);
        expect(deserialized.ok).toBe(true);

        if (deserialized.ok) {
          const eq = MoneyService.equals(original.value, deserialized.value);
          expect(eq.ok && eq.value).toBe(true);
          expect(original.value.currency()).toBe(deserialized.value.currency());
        }
      }
    });

    it('JSON.stringify → JSON.parse round-trip', () => {
      const original = MoneyService.create(99.99, 'USDC');
      expect(original.ok).toBe(true);

      if (original.ok) {
        const json = MoneySerializer.toJSON(original.value);
        const jsonString = JSON.stringify(json);
        const parsed = JSON.parse(jsonString);
        const deserialized = MoneySerializer.fromJSON(parsed);

        expect(deserialized.ok).toBe(true);
        if (deserialized.ok) {
          const eq = MoneyService.equals(original.value, deserialized.value);
          expect(eq.ok && eq.value).toBe(true);
        }
      }
    });

    it('высокая точность сохраняется через JSON round-trip', () => {
      const original = MoneyService.create('0.123456789012345', 'USDC');
      expect(original.ok).toBe(true);

      if (original.ok) {
        const json = MoneySerializer.toJSON(original.value);
        const deserialized = MoneySerializer.fromJSON(json);

        expect(deserialized.ok).toBe(true);
        if (deserialized.ok) {
          expect(original.value.value().toString()).toBe(deserialized.value.value().toString());
        }
      }
    });
  });

  describe('математические операции end-to-end', () => {
    it('add → subtract возвращает исходное значение', () => {
      const original = MoneyService.create(100, 'USDC');
      const toAdd = MoneyService.create(50, 'USDC');

      if (original.ok && toAdd.ok) {
        const added = MoneyService.add(original.value, toAdd.value);
        expect(added.ok).toBe(true);

        if (added.ok) {
          expect(added.value.value().toString()).toBe('150');

          const subtracted = MoneyService.subtract(added.value, toAdd.value);
          expect(subtracted.ok).toBe(true);

          if (subtracted.ok) {
            const eq = MoneyService.equals(original.value, subtracted.value);
            expect(eq.ok && eq.value).toBe(true);
          }
        }
      }
    });

    it('multiply → divide возвращает исходное значение', () => {
      const original = MoneyService.create(100, 'USDC');
      const factor = new Decimal(3);

      if (original.ok) {
        const multiplied = MoneyService.multiply(original.value, factor);
        expect(multiplied.ok).toBe(true);

        if (multiplied.ok) {
          expect(multiplied.value.value().toString()).toBe('300');

          const divided = MoneyService.divide(multiplied.value, factor);
          expect(divided.ok).toBe(true);

          if (divided.ok) {
            const eq = MoneyService.equals(original.value, divided.value);
            expect(eq.ok && eq.value).toBe(true);
          }
        }
      }
    });

    it('сложные вычисления с несколькими операциями', () => {
      const base = MoneyService.create(1000, 'USDC');
      const fee = MoneyService.create(20, 'USDC');
      const discount = MoneyService.create(50, 'USDC');

      if (!base.ok || !fee.ok || !discount.ok) {
        throw new Error('Failed to create test Money');
      }

      // Операция: (base - discount) + fee
      const afterDiscount = MoneyService.subtract(base.value, discount.value);
      expect(afterDiscount.ok).toBe(true);

      if (afterDiscount.ok) {
        expect(afterDiscount.value.value().toString()).toBe('950');

        const final = MoneyService.add(afterDiscount.value, fee.value);
        expect(final.ok).toBe(true);

        if (final.ok) {
          expect(final.value.value().toString()).toBe('970');
        }
      }
    });

    it('деление с remainder', () => {
      const amount = MoneyService.create(100, 'USDC');
      const divisor = new Decimal(3);

      if (amount.ok) {
        const result = MoneyService.divide(amount.value, divisor);
        expect(result.ok).toBe(true);

        if (result.ok) {
          // 100 / 3 = 33.333...
          expect(result.value.value().toDecimalPlaces(2).toString()).toBe('33.33');
        }
      }
    });
  });

  describe('операции с одинаковой валютой', () => {
    it('add работает с USDC', () => {
      const m1 = MoneyService.create(100, 'USDC');
      const m2 = MoneyService.create(50, 'USDC');

      expect(m1.ok).toBe(true);
      expect(m2.ok).toBe(true);

      if (m1.ok && m2.ok) {
        const result = MoneyService.add(m1.value, m2.value);
        expect(result.ok).toBe(true);

        if (result.ok) {
          expect(result.value.value().toString()).toBe('150');
          expect(result.value.currency()).toBe('USDC');
        }
      }
    });

    it('subtract работает с USDC', () => {
      const m1 = MoneyService.create(100, 'USDC');
      const m2 = MoneyService.create(50, 'USDC');

      expect(m1.ok).toBe(true);
      expect(m2.ok).toBe(true);

      if (m1.ok && m2.ok) {
        const result = MoneyService.subtract(m1.value, m2.value);
        expect(result.ok).toBe(true);

        if (result.ok) {
          expect(result.value.value().toString()).toBe('50');
          expect(result.value.currency()).toBe('USDC');
        }
      }
    });
  });

  describe('работа с константами', () => {
    it('Money.ZERO используется в расчетах', () => {
      const amount = MoneyService.create(100, 'USDC');

      expect(amount.ok).toBe(true);

      if (amount.ok) {
        const zeroUsdc = Money.of(new Decimal(0), 'USDC');
        const result = MoneyService.add(amount.value, zeroUsdc);

        expect(result.ok).toBe(true);
        if (result.ok) {
          const eq = MoneyService.equals(amount.value, result.value);
          expect(eq.ok && eq.value).toBe(true);
        }
      }
    });

    it('сравнение с нулевым Money', () => {
      const zero = Money.of(new Decimal(0), 'USDC');
      const amount = MoneyService.create(0, 'USDC');

      expect(amount.ok).toBe(true);

      if (amount.ok) {
        const eq = MoneyService.equals(amount.value, zero);
        expect(eq.ok && eq.value).toBe(true);
        expect(amount.value.isZero()).toBe(true);
      }
    });
  });

  describe('граничные случаи', () => {
    it('очень большие суммы', () => {
      const large = MoneyService.create('999999999999999.99', 'USDC');
      expect(large.ok).toBe(true);

      if (large.ok) {
        const json = MoneySerializer.toJSON(large.value);
        const deserialized = MoneySerializer.fromJSON(json);

        expect(deserialized.ok).toBe(true);
        if (deserialized.ok) {
          const eq = MoneyService.equals(large.value, deserialized.value);
          expect(eq.ok && eq.value).toBe(true);
        }
      }
    });

    it('очень малые суммы', () => {
      const tiny = MoneyService.create('0.000001', 'USDC');
      expect(tiny.ok).toBe(true);

      if (tiny.ok) {
        expect(tiny.value.value().toString()).toBe('0.000001');
        expect(tiny.value.isPositive()).toBe(true);
        expect(tiny.value.isZero()).toBe(false);
      }
    });

    it('subtract может привести к отрицательному результату в промежуточных вычислениях', () => {
      const small = MoneyService.create(10, 'USDC');
      const large = MoneyService.create(100, 'USDC');

      if (small.ok && large.ok) {
        const result = MoneyService.subtract(small.value, large.value);
        // MoneyService.subtract не валидирует на отрицательность
        // Это позволяет промежуточные отрицательные значения в расчетах
        expect(result.ok).toBe(true);

        if (result.ok) {
          expect(result.value.isNegative()).toBe(true);
          expect(result.value.value().toString()).toBe('-90');
        }
      }
    });
  });

  describe('cross-layer consistency', () => {
    it('все методы Service создают одинаковый Money', () => {
      const m1 = MoneyService.create(100, 'USDC');
      const m2 = MoneyService.create('100', 'USDC');
      const m3 = MoneyService.create(new Decimal('100'), 'USDC');

      expect(m1.ok).toBe(true);
      expect(m2.ok).toBe(true);
      expect(m3.ok).toBe(true);

      if (m1.ok && m2.ok && m3.ok) {
        const eq1 = MoneyService.equals(m1.value, m2.value);
        const eq2 = MoneyService.equals(m2.value, m3.value);

        expect(eq1.ok && eq1.value).toBe(true);
        expect(eq2.ok && eq2.value).toBe(true);
      }
    });

    it('все слои работают согласованно', () => {
      // Facade
      const serviceResult = MoneyService.create(123.45, 'USDC');
      expect(serviceResult.ok).toBe(true);

      if (serviceResult.ok) {
        const money = serviceResult.value;

        // Core
        expect(money.value().toString()).toBe('123.45');
        expect(money.currency()).toBe('USDC');

        // Adapters - Format
        const formatted = MoneyFormatter.toFixed(money, 2);
        expect(formatted.ok).toBe(true);

        // Adapters - Serialize
        const json = MoneySerializer.toJSON(money);
        expect(json.amount).toBe('123.45');
        expect(json.currency).toBe('USDC');

        const deserialized = MoneySerializer.fromJSON(json);
        if (deserialized.ok) {
          const eq = MoneyService.equals(deserialized.value, money);
          expect(eq.ok && eq.value).toBe(true);
        }
      }
    });

    it('математические операции сохраняют валюту', () => {
      const m1 = MoneyService.create(100, 'USDC');
      const m2 = MoneyService.create(50, 'USDC');

      if (m1.ok && m2.ok) {
        const sum = MoneyService.add(m1.value, m2.value);
        expect(sum.ok).toBe(true);

        if (sum.ok) {
          expect(sum.value.currency()).toBe('USDC');

          const diff = MoneyService.subtract(sum.value, m2.value);
          expect(diff.ok).toBe(true);

          if (diff.ok) {
            expect(diff.value.currency()).toBe('USDC');
            const eq = MoneyService.equals(diff.value, m1.value);
            expect(eq.ok && eq.value).toBe(true);
          }
        }
      }
    });
  });

  describe('сравнение Money', () => {
    it('equals сравнивает по сумме', () => {
      const m1 = MoneyService.create(100, 'USDC');
      const m2 = MoneyService.create(100, 'USDC');
      const m3 = MoneyService.create(200, 'USDC');

      if (m1.ok && m2.ok && m3.ok) {
        // Одинаковая сумма и валюта = равны
        const eq1 = MoneyService.equals(m1.value, m2.value);
        expect(eq1.ok && eq1.value).toBe(true);

        // Разная сумма = не равны
        const eq2 = MoneyService.equals(m1.value, m3.value);
        expect(eq2.ok && eq2.value).toBe(false);
      }
    });

    it('equals работает для одинаковой валюты', () => {
      const m1 = MoneyService.create(100, 'USDC');
      const m2 = MoneyService.create(100, 'USDC');

      if (m1.ok && m2.ok) {
        const eq = MoneyService.equals(m1.value, m2.value);
        expect(eq.ok && eq.value).toBe(true);
      }
    });

    it('isPositive, isNegative, isZero работают корректно', () => {
      const positive = MoneyService.create(100, 'USDC');
      const zero = MoneyService.create(0, 'USDC');

      if (positive.ok && zero.ok) {
        expect(positive.value.isPositive()).toBe(true);
        expect(positive.value.isZero()).toBe(false);
        expect(positive.value.isNegative()).toBe(false);

        expect(zero.value.isZero()).toBe(true);
        expect(zero.value.isPositive()).toBe(false);
        expect(zero.value.isNegative()).toBe(false);
      }
    });
  });
});
