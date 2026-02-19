import { describe, it, expect } from '@jest/globals';
import Decimal from 'decimal.js';
import { SpreadService } from '../../../../src/spread/facade/SpreadService.js';
import { Price } from '../../../../src/price/core/Price.js';
import { Ratio } from '../../../../src/ratio/core/Ratio.js';
import { SpreadErrorReason } from '../../../../src/spread/errors/SpreadErrorReason.js';
import { Spread } from '../../../../src/spread/core/Spread.js';

describe('SpreadService Ratio Operations', () => {
  // Helper: создать Spread из чисел
  const createSpread = (bid: number, ask: number): Spread => {
    return Spread.of(Price.of(new Decimal(bid)), Price.of(new Decimal(ask)));
  };

  describe('getSpreadWidth()', () => {
    it('вычисляет width для нормального spread', () => {
      const spread = createSpread(0.48, 0.52);
      const result = SpreadService.getSpreadWidth(spread);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toString()).toBe('0.04');
      }
    });

    it('возвращает 0 для zero spread (bid = ask)', () => {
      const spread = createSpread(0.5, 0.5);
      const result = SpreadService.getSpreadWidth(spread);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toString()).toBe('0');
      }
    });

    it('работает с очень малым spread', () => {
      const spread = createSpread(0.4999, 0.5001);
      const result = SpreadService.getSpreadWidth(spread);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toString()).toBe('0.0002');
      }
    });

    it('никогда не бросает исключения', () => {
      const spread = createSpread(0.48, 0.52);
      expect(() => SpreadService.getSpreadWidth(spread)).not.toThrow();
    });
  });

  describe('getSpreadRatio()', () => {
    it('вычисляет spread ratio для нормального spread', () => {
      const spread = createSpread(0.48, 0.52);
      const result = SpreadService.getSpreadRatio(spread);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // width = 0.04, mid = 0.5, ratio = 0.04 / 0.5 = 0.08 (8%)
        expect(result.value.toDecimal().toString()).toBe('0.08');
        expect(result.value.toDecimal().times(100).toNumber()).toBe(8);
      }
    });

    it('вычисляет spread ratio для узкого spread', () => {
      const spread = createSpread(0.49, 0.51);
      const result = SpreadService.getSpreadRatio(spread);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // width = 0.02, mid = 0.5, ratio = 0.02 / 0.5 = 0.04 (4%)
        expect(result.value.toDecimal().toString()).toBe('0.04');
        expect(result.value.toDecimal().times(100).toNumber()).toBe(4);
      }
    });

    it('вычисляет spread ratio для широкого spread', () => {
      const spread = createSpread(0.3, 0.7);
      const result = SpreadService.getSpreadRatio(spread);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // width = 0.4, mid = 0.5, ratio = 0.4 / 0.5 = 0.8 (80%)
        expect(result.value.toDecimal().toString()).toBe('0.8');
        expect(result.value.toDecimal().times(100).toNumber()).toBe(80);
      }
    });

    it('возвращает 0 для zero spread', () => {
      const spread = createSpread(0.5, 0.5);
      const result = SpreadService.getSpreadRatio(spread);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.toDecimal().toString()).toBe('0');
      }
    });

    it('никогда не бросает исключения', () => {
      const spread = createSpread(0.48, 0.52);
      expect(() => SpreadService.getSpreadRatio(spread)).not.toThrow();
    });
  });

  describe('fromMidAndWidthRatio()', () => {
    it('создаёт spread от mid и widthRatio (Price и Ratio)', () => {
      const mid = Price.of(new Decimal(0.50));
      const widthRatio = Ratio.of(new Decimal(0.08)); // 8% width

      const result = SpreadService.fromMidAndWidthRatio(mid, widthRatio);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // widthAbs = 0.50 * 0.08 = 0.04
        // half = 0.04 / 2 = 0.02
        // bid = 0.50 - 0.02 = 0.48
        // ask = 0.50 + 0.02 = 0.52
        expect(result.value.bid().value().toString()).toBe('0.48');
        expect(result.value.ask().value().toString()).toBe('0.52');
        expect(result.value.width().toString()).toBe('0.04');
        expect(result.value.midpoint().toString()).toBe('0.5');
      }
    });

    it('создаёт spread от чисел', () => {
      const result = SpreadService.fromMidAndWidthRatio(0.50, 0.08);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bid().value().toString()).toBe('0.48');
        expect(result.value.ask().value().toString()).toBe('0.52');
      }
    });

    it('создаёт spread от Decimal', () => {
      const result = SpreadService.fromMidAndWidthRatio(
        new Decimal(0.50),
        new Decimal(0.08)
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bid().value().toString()).toBe('0.48');
        expect(result.value.ask().value().toString()).toBe('0.52');
      }
    });

    it('создаёт spread от строк', () => {
      const result = SpreadService.fromMidAndWidthRatio('0.50', '0.08');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bid().value().toString()).toBe('0.48');
        expect(result.value.ask().value().toString()).toBe('0.52');
      }
    });

    it('создаёт zero-width spread при widthRatio = 0', () => {
      const result = SpreadService.fromMidAndWidthRatio(0.50, 0);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bid().value().toString()).toBe('0.5');
        expect(result.value.ask().value().toString()).toBe('0.5');
        expect(result.value.width().toString()).toBe('0');
        expect(result.value.isZeroWidth()).toBe(true);
      }
    });

    it('работает с очень малым widthRatio', () => {
      const result = SpreadService.fromMidAndWidthRatio(0.50, 0.0001); // 0.01%

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.width().toString()).toBe('0.00005');
      }
    });

    it('фэйлится при отрицательном widthRatio', () => {
      const result = SpreadService.fromMidAndWidthRatio(0.50, -0.08);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(SpreadErrorReason.NEGATIVE_RATIO_NOT_ALLOWED);
        expect(result.error.message).toContain('non-negative');
      }
    });

    it('фэйлится когда bid выходит за MIN_PRICE', () => {
      // mid = 0.0002, widthRatio = 10 (1000% width)
      // widthAbs = 0.0002 * 10 = 0.002
      // half = 0.001
      // bid = 0.0002 - 0.001 = -0.0008 < MIN_PRICE (0.0001)
      const result = SpreadService.fromMidAndWidthRatio(0.0002, 10);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(SpreadErrorReason.RATIO_OUT_OF_BOUNDS);
      }
    });

    it('фэйлится когда ask выходит за MAX_PRICE', () => {
      // mid = 0.9998, widthRatio = 10 (1000% width)
      // widthAbs = 0.9998 * 10 = 9.998
      // half = 4.999
      // ask = 0.9998 + 4.999 > MAX_PRICE (0.9999)
      const result = SpreadService.fromMidAndWidthRatio(0.9998, 10);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(SpreadErrorReason.RATIO_OUT_OF_BOUNDS);
      }
    });

    it('фэйлится при невалидном mid', () => {
      const result = SpreadService.fromMidAndWidthRatio(1.5, 0.08); // mid > MAX_PRICE

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(SpreadErrorReason.INVALID_FORMAT);
      }
    });

    it('фэйлится при невалидном widthRatio', () => {
      const result = SpreadService.fromMidAndWidthRatio(0.50, NaN);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(SpreadErrorReason.INVALID_RATIO);
      }
    });

    it('никогда не бросает исключения', () => {
      expect(() => SpreadService.fromMidAndWidthRatio(0.50, 0.08)).not.toThrow();
      expect(() => SpreadService.fromMidAndWidthRatio(0.50, -0.08)).not.toThrow();
      expect(() => SpreadService.fromMidAndWidthRatio(1.5, 0.08)).not.toThrow();
      expect(() => SpreadService.fromMidAndWidthRatio(0.50, NaN)).not.toThrow();
    });
  });

  describe('shiftByRatio()', () => {
    it('сдвигает spread вверх на 5% от mid', () => {
      const spread = createSpread(0.48, 0.52);
      const shiftRatio = Ratio.of(new Decimal(0.05)); // 5%

      const result = SpreadService.shiftByRatio(spread, shiftRatio);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // mid = 0.5, shift = 0.5 * 0.05 = 0.025
        expect(result.value.bid().value().toString()).toBe('0.505');
        expect(result.value.ask().value().toString()).toBe('0.545');
      }
    });

    it('сдвигает spread вниз на 2% от mid', () => {
      const spread = createSpread(0.48, 0.52);
      const shiftRatio = Ratio.of(new Decimal(-0.02)); // -2%

      const result = SpreadService.shiftByRatio(spread, shiftRatio);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // mid = 0.5, shift = 0.5 * -0.02 = -0.01
        expect(result.value.bid().value().toString()).toBe('0.47');
        expect(result.value.ask().value().toString()).toBe('0.51');
      }
    });

    it('работает с ratio = 0 (нет сдвига)', () => {
      const spread = createSpread(0.48, 0.52);
      const shiftRatio = Ratio.of(new Decimal(0));

      const result = SpreadService.shiftByRatio(spread, shiftRatio);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bid().value().toString()).toBe('0.48');
        expect(result.value.ask().value().toString()).toBe('0.52');
      }
    });

    it('фэйлится при выходе за границы Price (слишком большой сдвиг вверх)', () => {
      const spread = createSpread(0.8, 0.9);
      const shiftRatio = Ratio.of(new Decimal(0.5)); // 50% от mid = 0.85

      const result = SpreadService.shiftByRatio(spread, shiftRatio);

      // shift = 0.85 * 0.5 = 0.425, ask станет 0.9 + 0.425 = 1.325 > MAX_PRICE
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(SpreadErrorReason.RATIO_OUT_OF_BOUNDS);
      }
    });

    it('фэйлится при выходе за границы Price (слишком большой сдвиг вниз)', () => {
      const spread = createSpread(0.1, 0.2);
      const shiftRatio = Ratio.of(new Decimal(-0.8)); // -80% от mid = 0.15

      const result = SpreadService.shiftByRatio(spread, shiftRatio);

      // shift = 0.15 * -0.8 = -0.12, bid станет 0.1 - 0.12 = -0.02 < MIN_PRICE
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(SpreadErrorReason.RATIO_OUT_OF_BOUNDS);
      }
    });

    it('никогда не бросает исключения', () => {
      const spread = createSpread(0.48, 0.52);
      const ratio = Ratio.of(new Decimal(0.1));
      expect(() => SpreadService.shiftByRatio(spread, ratio)).not.toThrow();
    });
  });

  describe('widenByRatio()', () => {
    it('расширяет spread на 2% от mid', () => {
      const spread = createSpread(0.48, 0.52);
      const deltaRatio = Ratio.of(new Decimal(0.02)); // 2% от mid

      const result = SpreadService.widenByRatio(spread, deltaRatio);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // mid = 0.5, deltaWidth = 0.5 * 0.02 = 0.01, amount = 0.005
        expect(result.value.bid().value().toString()).toBe('0.475');
        expect(result.value.ask().value().toString()).toBe('0.525');
      }
    });

    it('расширяет spread на 10% от mid', () => {
      const spread = createSpread(0.48, 0.52);
      const deltaRatio = Ratio.of(new Decimal(0.1)); // 10% от mid

      const result = SpreadService.widenByRatio(spread, deltaRatio);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // mid = 0.5, deltaWidth = 0.05, amount = 0.025
        expect(result.value.bid().value().toString()).toBe('0.455');
        expect(result.value.ask().value().toString()).toBe('0.545');
      }
    });

    it('работает с ratio = 0 (нет расширения)', () => {
      const spread = createSpread(0.48, 0.52);
      const deltaRatio = Ratio.of(new Decimal(0));

      const result = SpreadService.widenByRatio(spread, deltaRatio);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bid().value().toString()).toBe('0.48');
        expect(result.value.ask().value().toString()).toBe('0.52');
      }
    });

    it('фэйлится при отрицательном ratio', () => {
      const spread = createSpread(0.48, 0.52);
      const deltaRatio = Ratio.of(new Decimal(-0.01));

      const result = SpreadService.widenByRatio(spread, deltaRatio);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(SpreadErrorReason.NEGATIVE_RATIO_NOT_ALLOWED);
        expect(result.error.message).toContain('non-negative');
      }
    });

    it('фэйлится при слишком большом расширении (выход за границы)', () => {
      const spread = createSpread(0.48, 0.52);
      const deltaRatio = Ratio.of(new Decimal(2)); // 200% от mid = огромное расширение

      const result = SpreadService.widenByRatio(spread, deltaRatio);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(SpreadErrorReason.RATIO_OUT_OF_BOUNDS);
      }
    });

    it('никогда не бросает исключения', () => {
      const spread = createSpread(0.48, 0.52);
      const ratio = Ratio.of(new Decimal(0.02));
      expect(() => SpreadService.widenByRatio(spread, ratio)).not.toThrow();
    });
  });

  describe('tightenByRatio()', () => {
    it('сужает spread на 1% от mid', () => {
      const spread = createSpread(0.48, 0.52);
      const deltaRatio = Ratio.of(new Decimal(0.01)); // 1% от mid

      const result = SpreadService.tightenByRatio(spread, deltaRatio);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // mid = 0.5, deltaWidth = 0.005, amount = 0.0025
        expect(result.value.bid().value().toString()).toBe('0.4825');
        expect(result.value.ask().value().toString()).toBe('0.5175');
      }
    });

    it('сужает spread на 2% от mid', () => {
      const spread = createSpread(0.48, 0.52);
      const deltaRatio = Ratio.of(new Decimal(0.02)); // 2% от mid

      const result = SpreadService.tightenByRatio(spread, deltaRatio);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // mid = 0.5, deltaWidth = 0.01, amount = 0.005
        expect(result.value.bid().value().toString()).toBe('0.485');
        expect(result.value.ask().value().toString()).toBe('0.515');
      }
    });

    it('работает с ratio = 0 (нет сужения)', () => {
      const spread = createSpread(0.48, 0.52);
      const deltaRatio = Ratio.of(new Decimal(0));

      const result = SpreadService.tightenByRatio(spread, deltaRatio);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bid().value().toString()).toBe('0.48');
        expect(result.value.ask().value().toString()).toBe('0.52');
      }
    });

    it('фэйлится при отрицательном ratio', () => {
      const spread = createSpread(0.48, 0.52);
      const deltaRatio = Ratio.of(new Decimal(-0.01));

      const result = SpreadService.tightenByRatio(spread, deltaRatio);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(SpreadErrorReason.NEGATIVE_RATIO_NOT_ALLOWED);
        expect(result.error.message).toContain('non-negative');
      }
    });

    it('автоматически clamp к width/2 при слишком большом сужении', () => {
      const spread = createSpread(0.48, 0.52);
      const deltaRatio = Ratio.of(new Decimal(0.2)); // 20% от mid = огромное сужение

      const result = SpreadService.tightenByRatio(spread, deltaRatio);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Должен сжаться до минимума (bid = ask = mid)
        expect(result.value.bid().value().toString()).toBe('0.5');
        expect(result.value.ask().value().toString()).toBe('0.5');
      }
    });

    it('никогда не бросает исключения', () => {
      const spread = createSpread(0.48, 0.52);
      const ratio = Ratio.of(new Decimal(0.01));
      expect(() => SpreadService.tightenByRatio(spread, ratio)).not.toThrow();
    });
  });

  describe('skewByRatio()', () => {
    it('наклоняет spread симметрично (bid +2%, ask -1%)', () => {
      const spread = createSpread(0.48, 0.52);
      const bidRatio = Ratio.of(new Decimal(0.02)); // +2% от mid
      const askRatio = Ratio.of(new Decimal(-0.01)); // -1% от mid

      const result = SpreadService.skewByRatio(spread, bidRatio, askRatio);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // mid = 0.5, bidAdj = 0.01, askAdj = -0.005
        expect(result.value.bid().value().toString()).toBe('0.49');
        expect(result.value.ask().value().toString()).toBe('0.515');
      }
    });

    it('наклоняет spread асимметрично (bid +1%, ask +3%)', () => {
      const spread = createSpread(0.48, 0.52);
      const bidRatio = Ratio.of(new Decimal(0.01)); // +1% от mid
      const askRatio = Ratio.of(new Decimal(0.03)); // +3% от mid

      const result = SpreadService.skewByRatio(spread, bidRatio, askRatio);

      expect(result.ok).toBe(true);
      if (result.ok) {
        // mid = 0.5, bidAdj = 0.005, askAdj = 0.015
        expect(result.value.bid().value().toString()).toBe('0.485');
        expect(result.value.ask().value().toString()).toBe('0.535');
      }
    });

    it('работает с ratio = 0 для обоих (нет наклона)', () => {
      const spread = createSpread(0.48, 0.52);
      const bidRatio = Ratio.of(new Decimal(0));
      const askRatio = Ratio.of(new Decimal(0));

      const result = SpreadService.skewByRatio(spread, bidRatio, askRatio);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.bid().value().toString()).toBe('0.48');
        expect(result.value.ask().value().toString()).toBe('0.52');
      }
    });

    it('фэйлится если bid > ask после наклона', () => {
      const spread = createSpread(0.48, 0.52);
      const bidRatio = Ratio.of(new Decimal(0.2)); // +20% от mid
      const askRatio = Ratio.of(new Decimal(-0.2)); // -20% от mid

      const result = SpreadService.skewByRatio(spread, bidRatio, askRatio);

      // mid = 0.5, bidAdj = 0.1, askAdj = -0.1
      // newBid = 0.48 + 0.1 = 0.58, newAsk = 0.52 - 0.1 = 0.42
      // bid > ask → ошибка
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.context?.reason).toBe(SpreadErrorReason.RATIO_OUT_OF_BOUNDS);
      }
    });

    it('успешно сдвигает bid близко к нижней границе Price', () => {
      const spread = createSpread(0.1, 0.2);
      const bidRatio = Ratio.of(new Decimal(-0.5)); // -50% от mid
      const askRatio = Ratio.of(new Decimal(0));

      const result = SpreadService.skewByRatio(spread, bidRatio, askRatio);

      // mid = 0.15, bidAdj = -0.075
      // newBid = 0.1 - 0.075 = 0.025, which is > MIN_PRICE (0.0001), so this is OK.
      expect(result.ok).toBe(true);
    });

    it('никогда не бросает исключения', () => {
      const spread = createSpread(0.48, 0.52);
      const bidRatio = Ratio.of(new Decimal(0.02));
      const askRatio = Ratio.of(new Decimal(-0.01));
      expect(() => SpreadService.skewByRatio(spread, bidRatio, askRatio)).not.toThrow();
    });
  });

  describe('Integration scenarios', () => {
    it('качество котировки: вычисление spread ratio для сравнения рынков', () => {
      const liquidMarket = createSpread(0.49, 0.51); // tight spread
      const illiquidMarket = createSpread(0.4, 0.6); // wide spread

      const liquidRatio = SpreadService.getSpreadRatio(liquidMarket);
      const illiquidRatio = SpreadService.getSpreadRatio(illiquidMarket);

      expect(liquidRatio.ok && illiquidRatio.ok).toBe(true);
      if (liquidRatio.ok && illiquidRatio.ok) {
        // Liquid market имеет меньший spread ratio = лучше ликвидность
        expect(liquidRatio.value.toDecimal().lessThan(illiquidRatio.value.toDecimal())).toBe(true);
      }
    });

    it('market making: расширение spread при volatility', () => {
      const normalSpread = createSpread(0.48, 0.52);

      // При высокой volatility расширяем на 5%
      const result = SpreadService.widenByRatio(normalSpread, Ratio.of(new Decimal(0.05)));

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Spread стал шире для защиты от риска
        const newWidth = result.value.width();
        const oldWidth = normalSpread.width();
        expect(newWidth.greaterThan(oldWidth)).toBe(true);
      }
    });

    it('inventory adjustment: наклон spread при дисбалансе позиции', () => {
      const spread = createSpread(0.48, 0.52);

      // Если у нас слишком много long позиции, сдвигаем bid вверх, ask вниз
      const result = SpreadService.skewByRatio(
        spread,
        Ratio.of(new Decimal(0.02)), // bid +2%
        Ratio.of(new Decimal(-0.01))  // ask -1%
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        // Bid поднялся (меньше buyers), ask опустился (больше sellers)
        expect(result.value.bid().value().greaterThan(spread.bid().value())).toBe(true);
        expect(result.value.ask().value().lessThan(spread.ask().value())).toBe(true);
      }
    });
  });
});
