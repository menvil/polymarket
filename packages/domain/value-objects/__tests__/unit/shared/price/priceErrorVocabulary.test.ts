import { OutcomePriceService } from '../../../../src/outcome-price/facade/OutcomePriceService.js';
import { OutcomePriceErrorReason } from '../../../../src/outcome-price/errors/OutcomePriceErrorReason.js';
import { AssetPriceService } from '../../../../src/asset-price/facade/AssetPriceService.js';
import { AssetPriceErrorReason } from '../../../../src/asset-price/errors/AssetPriceErrorReason.js';
import { PriceRuleReason } from '../../../../src/shared/price/priceRuleTypes.js';

/**
 * Словарь причин разделён по СЛОЮ, а не по домену: инварианты домена
 * говорят своим enum, общие правила — своим. Тесты фиксируют, что
 * сравнение с обоими работает — раньше сравнение с доменным enum для
 * отказов правил молча возвращало false.
 */
describe('словарь причин отказа', () => {
  const outcome = (): ReturnType<typeof OutcomePriceService.create> =>
    OutcomePriceService.create(0.1235);

  describe('отказы ОБЩИХ правил сравнимы с PriceRuleReason', () => {
    it('невыровненная цена', () => {
      const price = outcome();
      expect(price.ok).toBe(true);
      if (!price.ok) return;

      const result = OutcomePriceService.ensureAlignedToMarketTick(price.value, 0.01);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(PriceRuleReason.NOT_ALIGNED);
      }
    });

    it('деление на ноль', () => {
      const price = OutcomePriceService.create(0.5);
      expect(price.ok).toBe(true);
      if (!price.ok) return;

      const result = OutcomePriceService.divide(price.value, 0);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(PriceRuleReason.IS_ZERO);
      }
    });

    it('один словарь на оба ценовых домена', () => {
      const outcomePrice = OutcomePriceService.create(0.5);
      const assetPrice = AssetPriceService.create(78468.5);
      expect(outcomePrice.ok && assetPrice.ok).toBe(true);
      if (!outcomePrice.ok || !assetPrice.ok) return;

      const byOutcome = OutcomePriceService.divide(outcomePrice.value, 0);
      const byAsset = AssetPriceService.divide(assetPrice.value, 0);

      expect(byOutcome.ok || byAsset.ok).toBe(false);
      if (byOutcome.ok || byAsset.ok) return;
      expect(byOutcome.error.context?.reason).toBe(byAsset.error.context?.reason);
    });
  });

  describe('отказы ИНВАРИАНТОВ сравнимы с доменным enum', () => {
    it('доля исхода ограничена с обеих сторон', () => {
      const low = OutcomePriceService.create(-5);
      const high = OutcomePriceService.create(2);

      expect(low.ok || high.ok).toBe(false);
      if (low.ok || high.ok) return;
      expect(low.error.context?.reason).toBe(OutcomePriceErrorReason.OUT_OF_RANGE_LOW);
      expect(high.error.context?.reason).toBe(OutcomePriceErrorReason.OUT_OF_RANGE_HIGH);
    });

    it('цена актива ограничена только снизу и строго', () => {
      const negative = AssetPriceService.create(-5);
      const zero = AssetPriceService.create(0);

      expect(negative.ok || zero.ok).toBe(false);
      if (negative.ok || zero.ok) return;
      // NOT_POSITIVE, а не OUT_OF_RANGE_LOW: у (0, ∞) нет верхней границы,
      // и ноль исключён — это другой инвариант, не другое имя того же
      expect(negative.error.context?.reason).toBe(AssetPriceErrorReason.NOT_POSITIVE);
      expect(zero.error.context?.reason).toBe(AssetPriceErrorReason.NOT_POSITIVE);
    });
  });

  it('словари не пересекаются по значениям', () => {
    const domainValues = [
      ...Object.values(OutcomePriceErrorReason),
      ...Object.values(AssetPriceErrorReason),
    ];
    const ruleValues = Object.values(PriceRuleReason);

    // Регистр — полезный сигнал: SCREAMING значит инвариант домена,
    // lower_snake значит общее правило
    for (const value of ruleValues) {
      expect(domainValues).not.toContain(value);
    }
  });
});
