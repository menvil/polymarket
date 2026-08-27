import Decimal from 'decimal.js';
import { ValidateTickSizeMultipleOfBaseTick } from '../../../../src/shared/price/ValidateTickSizeMultipleOfBaseTick.js';
import { ValidateAligned } from '../../../../src/shared/price/ValidateAligned.js';
import { PriceRuleReason } from '../../../../src/shared/price/priceRuleTypes.js';
import { AssetPriceService } from '../../../../src/asset-price/facade/AssetPriceService.js';
import { InvalidAssetPriceError } from '@polymarket/errors';

/**
 * Базовый тик долгое время принимался на веру: правило валидировало только
 * `tickSize`, а `baseTick` шёл прямо в деление. Отрицательное значение
 * проходило насквозь — `0.01 / -0.00000001 = -1000000`, целое, значит Ok, —
 * хотя шаг сетки цен отрицательным быть не может физически.
 *
 * Дыра стала достижимой снаружи, когда `AssetPriceService` начал принимать
 * `baseTick` публичным параметром: у Binance/OKX шаг зависит от инструмента
 * и приходит из market info, то есть из ВНЕШНИХ данных.
 *
 * Существующие тесты её не ловили: был случай «отрицательный tickSize», но
 * не было «валидный tickSize + негодный baseTick».
 */
describe('валидация baseTick как шага сетки', () => {
  const VALID_TICK = new Decimal('0.01');

  describe('ValidateTickSizeMultipleOfBaseTick', () => {
    it.each([
      ['ноль', '0'],
      ['отрицательный', '-0.00000001'],
      ['отрицательный крупный', '-0.01'],
    ])('должен отвергнуть baseTick: %s', (_label, raw) => {
      const result = ValidateTickSizeMultipleOfBaseTick.check(VALID_TICK, new Decimal(raw));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Именно not_positive, а НЕ not_multiple_of_base_tick: проблема в
        // самом шаге, а не в кратности. Ноль раньше приходил со второй
        // причиной, и потребитель искал бы несуществующий «кратный тик»
        expect(result.error.context?.reason).toBe(PriceRuleReason.NOT_POSITIVE);
        expect(result.error.context?.baseTick).toBe(new Decimal(raw).toString());
      }
    });

    it.each([
      ['NaN', NaN, PriceRuleReason.IS_NAN],
      ['Infinity', Infinity, PriceRuleReason.NOT_FINITE],
      ['-Infinity', -Infinity, PriceRuleReason.NOT_FINITE],
    ])('должен отвергнуть baseTick: %s', (_label, raw, reason) => {
      // Прямой вызывающий правила НЕ защищён parseOperand фасада —
      // проверка обязана быть в самом правиле
      const result = ValidateTickSizeMultipleOfBaseTick.check(VALID_TICK, new Decimal(raw));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(reason);
      }
    });

    it('должен принять валидный baseTick', () => {
      const result = ValidateTickSizeMultipleOfBaseTick.check(VALID_TICK, new Decimal('0.0001'));

      expect(result.ok).toBe(true);
    });
  });

  describe('ValidateAligned доверял тому же baseTick', () => {
    it('должен отвергнуть отрицательный baseTick', () => {
      const price = AssetPriceService.create('78468.5');
      expect(price.ok).toBe(true);
      if (!price.ok) return;

      const result = ValidateAligned.check(
        price.value,
        VALID_TICK,
        InvalidAssetPriceError,
        new Decimal('-0.00000001'),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(PriceRuleReason.NOT_POSITIVE);
      }
    });
  });

  describe('через публичный CEX-ориентированный фасад', () => {
    const price = () => AssetPriceService.create('78468.5');

    it.each([
      ['ноль', '0'],
      ['отрицательный', '-0.00000001'],
      ['NaN', 'NaN'],
      ['Infinity', 'Infinity'],
    ])('roundToTick должен вернуть Err для baseTick: %s', (_label, baseTick) => {
      const p = price();
      expect(p.ok).toBe(true);
      if (!p.ok) return;

      const result = AssetPriceService.roundToTick(p.value, '0.01', baseTick);

      expect(result.ok).toBe(false);
    });

    it.each([
      ['ноль', '0'],
      ['отрицательный', '-0.00000001'],
      ['NaN', 'NaN'],
      ['Infinity', 'Infinity'],
    ])('ensureAlignedToTick должен вернуть Err для baseTick: %s', (_label, baseTick) => {
      const p = price();
      expect(p.ok).toBe(true);
      if (!p.ok) return;

      const result = AssetPriceService.ensureAlignedToTick(p.value, '0.01', baseTick);

      expect(result.ok).toBe(false);
    });

    it('должен по-прежнему работать с шагом реального инструмента', () => {
      const p = price();
      expect(p.ok).toBe(true);
      if (!p.ok) return;

      // BTC/USDT на Binance: tickSize 0.01, baseTick тот же
      const result = AssetPriceService.roundToTick(p.value, '0.01', '0.01');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.value().toString()).toBe('78468.5');
      }
    });
  });
});
