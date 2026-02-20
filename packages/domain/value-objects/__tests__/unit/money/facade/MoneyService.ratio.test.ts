import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { Money } from '../../../../src/money/core/Money.js';
import { MoneyService } from '../../../../src/money/facade/MoneyService.js';
import { Ratio } from '../../../../src/ratio/core/Ratio.js';
import { MoneyErrorReason } from '../../../../src/money/errors/MoneyErrorReason.js';

describe('MoneyService Ratio Operations', () => {
  const money100 = Money.of(new Decimal(100), 'USDC');
  const money1000 = Money.of(new Decimal(1000), 'USDC');
  const money5000 = Money.of(new Decimal(5000), 'USDC');

  describe('portion()', () => {
    it('вычисляет 2% fee от $100', () => {
      const rate = Ratio.of(new Decimal(0.02)); // 2%
      const result = MoneyService.portion(money100, rate);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toString()).toBe('2');
        expect(result.value.currency()).toBe('USDC');
      }
    });

    it('вычисляет 2% fee от $1000', () => {
      const rate = Ratio.of(new Decimal(0.02)); // 2%
      const result = MoneyService.portion(money1000, rate);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toString()).toBe('20');
        expect(result.value.currency()).toBe('USDC');
      }
    });

    it('вычисляет 30% allocation от $5000', () => {
      const rate = Ratio.of(new Decimal(0.3)); // 30%
      const result = MoneyService.portion(money5000, rate);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toString()).toBe('1500');
        expect(result.value.currency()).toBe('USDC');
      }
    });

    it('возвращает zero для rate = 0', () => {
      const rate = Ratio.of(new Decimal(0));
      const result = MoneyService.portion(money100, rate);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toString()).toBe('0');
      }
    });

    it('вычисляет 100% (весь amount)', () => {
      const rate = Ratio.of(new Decimal(1)); // 100%
      const result = MoneyService.portion(money100, rate);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toString()).toBe('100');
      }
    });

    it('вычисляет 200% (удвоение)', () => {
      const rate = Ratio.of(new Decimal(2)); // 200%
      const result = MoneyService.portion(money100, rate);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toString()).toBe('200');
      }
    });

    it('отклоняет отрицательный rate (INVALID_RATIO)', () => {
      const rate = Ratio.of(new Decimal(-0.1)); // -10%
      const result = MoneyService.portion(money100, rate);

      // Отрицательный rate семантически некорректен для portion() - используй decreaseBy()
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(MoneyErrorReason.INVALID_RATIO);
        expect(result.error.message).toContain('non-negative');
      }
    });

    it('работает с очень малыми rates (basis points)', () => {
      const rate = Ratio.of(new Decimal(0.0001)); // 1 basis point
      const result = MoneyService.portion(money1000, rate);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toString()).toBe('0.1');
      }
    });

    it('никогда не бросает исключения', () => {
      const rate = Ratio.of(new Decimal(0.02));
      expect(() => {
        MoneyService.portion(money100, rate);
      }).not.toThrow();
    });
  });

  describe('increaseBy()', () => {
    it('увеличивает на 10%: $100 → $110', () => {
      const delta = Ratio.of(new Decimal(0.1)); // +10%
      const result = MoneyService.increaseBy(money100, delta);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toString()).toBe('110');
        expect(result.value.currency()).toBe('USDC');
      }
    });

    it('увеличивает на 50%: $100 → $150', () => {
      const delta = Ratio.of(new Decimal(0.5)); // +50%
      const result = MoneyService.increaseBy(money100, delta);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toString()).toBe('150');
      }
    });

    it('уменьшает на 20%: $100 → $80', () => {
      const delta = Ratio.of(new Decimal(-0.2)); // -20%
      const result = MoneyService.increaseBy(money100, delta);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toString()).toBe('80');
      }
    });

    it('уменьшает на 50%: $100 → $50', () => {
      const delta = Ratio.of(new Decimal(-0.5)); // -50%
      const result = MoneyService.increaseBy(money100, delta);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toString()).toBe('50');
      }
    });

    it('уменьшает на 100%: $100 → $0 (граничный случай)', () => {
      const delta = Ratio.of(new Decimal(-1)); // -100%
      const result = MoneyService.increaseBy(money100, delta);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toString()).toBe('0');
      }
    });

    it('не изменяет при delta = 0', () => {
      const delta = Ratio.of(new Decimal(0));
      const result = MoneyService.increaseBy(money100, delta);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toString()).toBe('100');
      }
    });

    it('удваивает при delta = 1 (+100%)', () => {
      const delta = Ratio.of(new Decimal(1)); // +100%
      const result = MoneyService.increaseBy(money100, delta);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toString()).toBe('200');
      }
    });

    it('утраивает при delta = 2 (+200%)', () => {
      const delta = Ratio.of(new Decimal(2)); // +200%
      const result = MoneyService.increaseBy(money100, delta);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toString()).toBe('300');
      }
    });

    it('фэйлится при delta < -1', () => {
      const delta = Ratio.of(new Decimal(-1.5)); // -150%
      const result = MoneyService.increaseBy(money100, delta);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(MoneyErrorReason.DELTA_LESS_THAN_MINUS_ONE);
        expect(result.error.message).toContain('Delta must be >= -1');
      }
    });

    it('фэйлится при delta = -2', () => {
      const delta = Ratio.of(new Decimal(-2)); // -200%
      const result = MoneyService.increaseBy(money100, delta);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(MoneyErrorReason.DELTA_LESS_THAN_MINUS_ONE);
      }
    });

    it('работает с очень малыми delta (basis points)', () => {
      const delta = Ratio.of(new Decimal(0.0001)); // +1 bp
      const result = MoneyService.increaseBy(money1000, delta);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toString()).toBe('1000.1');
      }
    });

    it('никогда не бросает исключения', () => {
      const delta = Ratio.of(new Decimal(0.1));
      expect(() => {
        MoneyService.increaseBy(money100, delta);
      }).not.toThrow();
    });
  });

  describe('decreaseBy()', () => {
    it('уменьшает на 20%: $100 → $80', () => {
      const delta = Ratio.of(new Decimal(0.2)); // 20%
      const result = MoneyService.decreaseBy(money100, delta);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toString()).toBe('80');
        expect(result.value.currency()).toBe('USDC');
      }
    });

    it('уменьшает на 50%: $100 → $50', () => {
      const delta = Ratio.of(new Decimal(0.5)); // 50%
      const result = MoneyService.decreaseBy(money100, delta);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toString()).toBe('50');
      }
    });

    it('уменьшает на 100%: $100 → $0 (граничный случай)', () => {
      const delta = Ratio.of(new Decimal(1)); // 100%
      const result = MoneyService.decreaseBy(money100, delta);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toString()).toBe('0');
      }
    });

    it('не изменяет при delta = 0', () => {
      const delta = Ratio.of(new Decimal(0));
      const result = MoneyService.decreaseBy(money100, delta);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toString()).toBe('100');
      }
    });

    it('фэйлится при delta > 1 (приведёт к negative)', () => {
      const delta = Ratio.of(new Decimal(1.5)); // 150%
      const result = MoneyService.decreaseBy(money100, delta);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(MoneyErrorReason.DELTA_LESS_THAN_MINUS_ONE);
      }
    });

    it('фэйлится при delta = 2', () => {
      const delta = Ratio.of(new Decimal(2)); // 200%
      const result = MoneyService.decreaseBy(money100, delta);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(MoneyErrorReason.DELTA_LESS_THAN_MINUS_ONE);
      }
    });

    it('контекст ошибки содержит оригинальный delta для debugging', () => {
      const delta = Ratio.of(new Decimal(1.5)); // 150%
      const result = MoneyService.decreaseBy(money100, delta);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Проверяем что в контексте оригинальный delta (1.5) для удобства debugging
        expect(result.error.context?.delta).toBe('1.5');
        // Проверяем правильный op, service и opChain
        expect(result.error.context?.op).toBe('decreaseBy');
        expect(result.error.context?.service).toBe('MoneyService');
        // opChain показывает стек вызовов: increaseBy (внутри) → decreaseBy (внешний)
        expect(result.error.context?.opChain).toContain('MoneyService.decreaseBy');
        expect(result.error.context?.opChain).toContain('MoneyService.increaseBy');
        // Проверяем что reason корректный
        expect(result.error.context?.reason).toBe(MoneyErrorReason.DELTA_LESS_THAN_MINUS_ONE);
      }
    });

    it('эквивалентно increaseBy с отрицательным delta', () => {
      const delta = Ratio.of(new Decimal(0.2)); // 20%

      const decreaseResult = MoneyService.decreaseBy(money100, delta);
      const increaseResult = MoneyService.increaseBy(money100, Ratio.of(new Decimal(-0.2)));

      expect(decreaseResult.ok).toBe(true);
      expect(increaseResult.ok).toBe(true);

      if (decreaseResult.ok && increaseResult.ok) {
        expect(decreaseResult.value.value().toString()).toBe(increaseResult.value.value().toString());
        expect(decreaseResult.value.value().toString()).toBe('80');
      }
    });

    it('работает с очень малыми delta (basis points)', () => {
      const delta = Ratio.of(new Decimal(0.0001)); // 1 bp
      const result = MoneyService.decreaseBy(money1000, delta);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toString()).toBe('999.9');
      }
    });

    it('никогда не бросает исключения', () => {
      const delta = Ratio.of(new Decimal(0.2));
      expect(() => {
        MoneyService.decreaseBy(money100, delta);
      }).not.toThrow();
    });
  });

  describe('Integration: Combined operations', () => {
    it('fee calculation + discount workflow', () => {
      // Начальная сумма: $1000
      const orderAmount = Money.of(new Decimal(1000), 'USDC');

      // 1. Вычисляем fee 2%: $20
      const feeRate = Ratio.of(new Decimal(0.02));
      const feeResult = MoneyService.portion(orderAmount, feeRate);
      expect(feeResult.ok).toBe(true);
      if (feeResult.ok) {
        expect(feeResult.value.value().toString()).toBe('20');
      }

      // 2. Применяем скидку 10% к сумме: $1000 → $900
      const discountRate = Ratio.of(new Decimal(0.1));
      const discountedResult = MoneyService.decreaseBy(orderAmount, discountRate);
      expect(discountedResult.ok).toBe(true);
      if (discountedResult.ok) {
        expect(discountedResult.value.value().toString()).toBe('900');
      }
    });

    it('compound markup workflow', () => {
      // Начальная цена: $100
      const baseCost = Money.of(new Decimal(100), 'USDC');

      // 1. Markup +20%: $100 → $120
      const markup1 = Ratio.of(new Decimal(0.2));
      const price1 = MoneyService.increaseBy(baseCost, markup1);
      expect(price1.ok).toBe(true);

      // 2. Дополнительный markup +10%: $120 → $132
      if (price1.ok) {
        const markup2 = Ratio.of(new Decimal(0.1));
        const finalPrice = MoneyService.increaseBy(price1.value, markup2);

        expect(finalPrice.ok).toBe(true);
        if (finalPrice.ok) {
          expect(finalPrice.value.value().toString()).toBe('132');
        }
      }
    });
  });
});
