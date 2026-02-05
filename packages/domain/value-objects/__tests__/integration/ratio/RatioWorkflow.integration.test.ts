import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { RatioService } from '../../../src/ratio/facade/RatioService';
import { RatioFormatter } from '../../../src/ratio/adapters/RatioFormatter';
import { RatioSerializer } from '../../../src/ratio/adapters/RatioSerializer';
import { Ratio } from '../../../src/ratio/core/Ratio';

describe('Ratio Integration Workflow', () => {
  describe('создание через разные форматы приводит к одинаковым значениям', () => {
    it('2% = 0.02 = 200 bps', () => {
      const fromPercent = RatioService.fromPercent(2);
      const fromDecimal = RatioService.fromDecimal(0.02);
      const fromBps = RatioService.fromBps(200);

      expect(fromPercent.ok).toBe(true);
      expect(fromDecimal.ok).toBe(true);
      expect(fromBps.ok).toBe(true);

      if (fromPercent.ok && fromDecimal.ok && fromBps.ok) {
        expect(fromPercent.value.equals(fromDecimal.value)).toBe(true);
        expect(fromDecimal.value.equals(fromBps.value)).toBe(true);
        expect(fromBps.value.equals(fromPercent.value)).toBe(true);
      }
    });

    it('100% = 1.0 = 10000 bps', () => {
      const fromPercent = RatioService.fromPercent(100);
      const fromDecimal = RatioService.fromDecimal(1);
      const fromBps = RatioService.fromBps(10000);

      if (fromPercent.ok && fromDecimal.ok && fromBps.ok) {
        expect(fromPercent.value.equals(fromDecimal.value)).toBe(true);
        expect(fromDecimal.value.equals(fromBps.value)).toBe(true);
      }
    });
  });

  describe('полный workflow: создание → форматирование → парсинг', () => {
    it('decimal format round-trip', () => {
      const original = RatioService.fromPercent(2.5);
      expect(original.ok).toBe(true);

      if (original.ok) {
        const formatted = RatioFormatter.toDecimal(original.value, 4);
        expect(formatted.ok).toBe(true);

        if (formatted.ok) {
          const parsed = RatioFormatter.parse(formatted.value);
          expect(parsed.ok).toBe(true);

          if (parsed.ok) {
            expect(original.value.equals(parsed.value)).toBe(true);
          }
        }
      }
    });

    it('percent format round-trip', () => {
      const original = RatioService.fromDecimal(0.025);
      expect(original.ok).toBe(true);

      if (original.ok) {
        const formatted = RatioFormatter.toPercent(original.value, 1);
        expect(formatted.ok).toBe(true);
        expect(formatted.ok && formatted.value).toBe('2.5%');

        if (formatted.ok) {
          const parsed = RatioFormatter.parse(formatted.value);
          expect(parsed.ok).toBe(true);

          if (parsed.ok) {
            expect(original.value.equals(parsed.value)).toBe(true);
          }
        }
      }
    });

    it('bps format round-trip', () => {
      const original = RatioService.fromPercent(2.5);
      expect(original.ok).toBe(true);

      if (original.ok) {
        const formatted = RatioFormatter.toBps(original.value, 0);
        expect(formatted.ok).toBe(true);
        expect(formatted.ok && formatted.value).toBe('250 bps');

        if (formatted.ok) {
          const parsed = RatioFormatter.parse(formatted.value);
          expect(parsed.ok).toBe(true);

          if (parsed.ok) {
            expect(original.value.equals(parsed.value)).toBe(true);
          }
        }
      }
    });
  });

  describe('полный workflow: создание → сериализация → десериализация', () => {
    it('JSON round-trip сохраняет значение', () => {
      const original = RatioService.fromPercent(2.5);
      expect(original.ok).toBe(true);

      if (original.ok) {
        const json = RatioSerializer.toJSON(original.value);
        expect(json).toEqual({ ratio: '0.025' });

        const deserialized = RatioSerializer.fromJSON(json);
        expect(deserialized.ok).toBe(true);

        if (deserialized.ok) {
          expect(original.value.equals(deserialized.value)).toBe(true);
        }
      }
    });

    it('JSON.stringify → JSON.parse round-trip', () => {
      const original = RatioService.fromBps(250);
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

  describe('использование в расчетах', () => {
    it('amount * (1 + ratio) для markup', () => {
      const amount = new Decimal(100);
      const markupResult = RatioService.fromPercent(10); // 10% markup

      if (markupResult.ok) {
        const markup = markupResult.value;
        const multiplier = markup.onePlus(); // 1.1
        const newAmount = amount.mul(multiplier);

        expect(newAmount.toString()).toBe('110');
      }
    });

    it('amount * (1 + ratio) для discount', () => {
      const amount = new Decimal(100);
      const discountResult = RatioService.fromPercent(-20); // -20% discount

      if (discountResult.ok) {
        const discount = discountResult.value;
        const multiplier = discount.onePlus(); // 0.8
        const newAmount = amount.mul(multiplier);

        expect(newAmount.toString()).toBe('80');
      }
    });

    it('amount * ratio для fee calculation', () => {
      const amount = new Decimal(1000);
      const feeResult = RatioService.fromPercent(2); // 2% fee

      if (feeResult.ok) {
        const fee = feeResult.value;
        const feeAmount = amount.mul(fee.toDecimal());

        expect(feeAmount.toString()).toBe('20');
      }
    });

    it('сложный расчет с несколькими операциями', () => {
      const baseAmount = new Decimal(1000);

      // Применить 10% markup
      const markupResult = RatioService.fromPercent(10);
      if (!markupResult.ok) throw new Error('Markup creation failed');
      const afterMarkup = baseAmount.mul(markupResult.value.onePlus());
      expect(afterMarkup.toString()).toBe('1100');

      // Вычесть 5% discount
      const discountResult = RatioService.fromPercent(-5);
      if (!discountResult.ok) throw new Error('Discount creation failed');
      const afterDiscount = afterMarkup.mul(discountResult.value.onePlus());
      expect(afterDiscount.toString()).toBe('1045');

      // Добавить 2% fee
      const feeResult = RatioService.fromPercent(2);
      if (!feeResult.ok) throw new Error('Fee creation failed');
      const fee = afterDiscount.mul(feeResult.value.toDecimal());
      const finalAmount = afterDiscount.plus(fee);
      expect(finalAmount.toString()).toBe('1065.9');
    });
  });

  describe('валидация ensureGteMinusOne в реальных сценариях', () => {
    it('принимает корректный discount для amount * (1 + ratio)', () => {
      const amount = new Decimal(100);
      const discountResult = RatioService.fromPercent(-50, { ensureGteMinusOne: true });

      expect(discountResult.ok).toBe(true);
      if (discountResult.ok) {
        const newAmount = amount.mul(discountResult.value.onePlus());
        expect(newAmount.toString()).toBe('50');
        expect(newAmount.gte(0)).toBe(true); // Non-negative result
      }
    });

    it('отклоняет некорректный discount приводящий к отрицательному результату', () => {
      const discountResult = RatioService.fromPercent(-150, { ensureGteMinusOne: true });

      expect(discountResult.ok).toBe(false);
      // Этот discount привел бы к отрицательному результату: 100 * (1 + (-1.5)) = 100 * (-0.5) = -50
    });

    it('граничный случай: -100% discount', () => {
      const amount = new Decimal(100);
      const discountResult = RatioService.fromPercent(-100, { ensureGteMinusOne: true });

      expect(discountResult.ok).toBe(true);
      if (discountResult.ok) {
        const newAmount = amount.mul(discountResult.value.onePlus());
        expect(newAmount.toString()).toBe('0'); // 100 * (1 + (-1)) = 100 * 0 = 0
      }
    });
  });

  describe('работа с константами', () => {
    it('Ratio.ZERO используется в расчетах', () => {
      const amount = new Decimal(100);
      const result = amount.mul(Ratio.ZERO.onePlus()); // 100 * (1 + 0) = 100
      expect(result.toString()).toBe('100');
    });

    it('Ratio.ONE используется в расчетах', () => {
      const amount = new Decimal(100);
      const result = amount.mul(Ratio.ONE.onePlus()); // 100 * (1 + 1) = 200
      expect(result.toString()).toBe('200');
    });
  });

  describe('cross-layer consistency', () => {
    it('Core.of() === Service.fromDecimal()', () => {
      const coreRatio = Ratio.of(new Decimal(0.02));
      const serviceResult = RatioService.fromDecimal(0.02);

      expect(serviceResult.ok).toBe(true);
      if (serviceResult.ok) {
        expect(coreRatio.equals(serviceResult.value)).toBe(true);
      }
    });

    it('все слои работают согласованно', () => {
      // Core
      const coreRatio = Ratio.of(new Decimal(0.025));

      // Facade
      const serviceResult = RatioService.fromPercent(2.5);
      expect(serviceResult.ok && serviceResult.value.equals(coreRatio)).toBe(true);

      // Adapters - Format
      const formatted = RatioFormatter.toPercent(coreRatio, 1);
      expect(formatted.ok && formatted.value).toBe('2.5%');

      // Adapters - Serialize
      const json = RatioSerializer.toJSON(coreRatio);
      expect(json.ratio).toBe('0.025');

      const deserialized = RatioSerializer.fromJSON(json);
      expect(deserialized.ok && deserialized.value.equals(coreRatio)).toBe(true);
    });
  });
});
