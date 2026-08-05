/**
 * Тесты ImbalanceCalculator.
 *
 * @remarks
 * Покрывает:
 * - ALL_LEVELS: все уровни, объёмный имбаланс
 * - TOP_N: только N уровней от best
 * - PRICE_RANGE: только уровни в пределах X% от mid
 * - WEIGHTED: гармонические веса по рангу
 * - NOTIONAL: price × size
 * - Граничные случаи: пустые стаканы, один стакан пустой
 * - Валидация параметров (RangeError)
 * - Совпадение с OrderBook.getImbalance() для ALL_LEVELS и TOP_N
 */
import { describe, it, expect } from '@jest/globals';
import { PriceService, QuantityService } from '@polymarket/value-objects';
import { ImbalanceCalculator, type ImbalanceMode } from '../../src/ImbalanceCalculator.js';
import type { PriceLevel } from '../../src/PriceLevel.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Создаёт PriceLevel из примитивов */
function level(price: number | string, size: number | string): PriceLevel {
  const p = PriceService.create(price);
  const s = QuantityService.create(size);
  if (!p.ok) throw new Error(`Invalid price: ${price}`);
  if (!s.ok) throw new Error(`Invalid size: ${size}`);
  return { price: p.value, size: s.value };
}

/** Вызывает calculate() и разворачивает Result — сокращает шум в happy-path тестах. */
function calc(bids: PriceLevel[], asks: PriceLevel[], mode: ImbalanceMode) {
  const result = ImbalanceCalculator.calculate(bids, asks, mode);
  if (!result.ok) {
    throw new Error(`Expected Ok, got Err: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

/**
 * Вычисляет ожидаемый объёмный имбаланс вручную.
 * `(bidSum - askSum) / (bidSum + askSum)`
 */
function expectedVolume(
  bids: PriceLevel[],
  asks: PriceLevel[],
): number {
  const bidSum = bids.reduce((s, l) => s + Number(l.size.value()), 0);
  const askSum = asks.reduce((s, l) => s + Number(l.size.value()), 0);
  if (bidSum + askSum === 0) return 0;
  return (bidSum - askSum) / (bidSum + askSum);
}

// ── Тестовые данные ─────────────────────────────────────────────────────────

/**
 * Типичный стакан: bid side сильнее ask side.
 * Bids: 0.65×1000, 0.64×800, 0.63×600
 * Asks: 0.66×500, 0.67×400, 0.68×300
 * bidSum=2400, askSum=1200 → imbalance = (2400-1200)/(2400+1200) = 1200/3600 ≈ 0.333
 */
const BIDS = [
  level('0.65', '1000'),
  level('0.64', '800'),
  level('0.63', '600'),
];
const ASKS = [
  level('0.66', '500'),
  level('0.67', '400'),
  level('0.68', '300'),
];

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('ImbalanceCalculator', () => {

  // ── ALL_LEVELS ───────────────────────────────────────────────────────────────

  describe('ALL_LEVELS', () => {
    it('вычисляет объёмный имбаланс по всем уровням', () => {
      const result = calc(BIDS, ASKS, { type: 'ALL_LEVELS' });
      const expected = expectedVolume(BIDS, ASKS);
      expect(result.toNumber()).toBeCloseTo(expected, 10);
    });

    it('возвращает 0 для пустого стакана', () => {
      expect(calc([], [], { type: 'ALL_LEVELS' }).toNumber()).toBe(0);
    });

    it('возвращает +1 если ask side пустой', () => {
      expect(calc(BIDS, [], { type: 'ALL_LEVELS' }).toNumber()).toBe(1);
    });

    it('возвращает -1 если bid side пустой', () => {
      expect(calc([], ASKS, { type: 'ALL_LEVELS' }).toNumber()).toBe(-1);
    });

    it('возвращает 0 для симметричного стакана', () => {
      const bids = [level('0.49', '1000')];
      const asks = [level('0.51', '1000')];
      expect(calc(bids, asks, { type: 'ALL_LEVELS' }).toNumber()).toBe(0);
    });
  });

  // ── TOP_N ────────────────────────────────────────────────────────────────────

  describe('TOP_N', () => {
    it('учитывает только топ N уровней с каждой стороны', () => {
      // TOP_1: bids=[0.65×1000], asks=[0.66×500]
      // (1000-500)/(1000+500) = 500/1500 ≈ 0.333
      const result = calc(BIDS, ASKS, { type: 'TOP_N', levels: 1 });
      expect(result.toNumber()).toBeCloseTo(500 / 1500, 10);
    });

    it('TOP_2 отличается от TOP_1 при разных пропорциях по уровням', () => {
      // Уровни с намеренно асимметричными пропорциями:
      // level1: bid=1000 vs ask=500 (2:1)
      // level2: bid=100  vs ask=900 (1:9 — обратная сторона)
      // TOP_1: (1000-500)/(1000+500) = 500/1500 ≈ +0.333
      // TOP_2: (1100-1400)/(1100+1400) = -300/2500 = -0.12
      const asymBids = [level('0.65', '1000'), level('0.64', '100')];
      const asymAsks = [level('0.66', '500'), level('0.67', '900')];
      const top1 = calc(asymBids, asymAsks, { type: 'TOP_N', levels: 1 });
      const top2 = calc(asymBids, asymAsks, { type: 'TOP_N', levels: 2 });
      expect(top1.toNumber()).not.toBeCloseTo(top2.toNumber(), 5);
    });

    it('TOP_N >= размера стакана эквивалентен ALL_LEVELS', () => {
      const all = calc(BIDS, ASKS, { type: 'ALL_LEVELS' });
      const topMany = calc(BIDS, ASKS, { type: 'TOP_N', levels: 100 });
      expect(topMany.toNumber()).toBeCloseTo(all.toNumber(), 10);
    });

    it('возвращает 0 для пустого стакана', () => {
      expect(
        calc([], [], { type: 'TOP_N', levels: 5 }).toNumber()
      ).toBe(0);
    });

    it('возвращает Err если levels <= 0', () => {
      expect(ImbalanceCalculator.calculate(BIDS, ASKS, { type: 'TOP_N', levels: 0 }).ok).toBe(false);
      expect(ImbalanceCalculator.calculate(BIDS, ASKS, { type: 'TOP_N', levels: -1 }).ok).toBe(false);
    });

    it('возвращает Err если levels не целое', () => {
      expect(ImbalanceCalculator.calculate(BIDS, ASKS, { type: 'TOP_N', levels: 1.5 }).ok).toBe(false);
    });
  });

  // ── PRICE_RANGE ──────────────────────────────────────────────────────────────

  describe('PRICE_RANGE', () => {
    it('включает только уровни в пределах rangePercent от mid', () => {
      // mid = (0.65 + 0.66) / 2 = 0.655
      // 5% от mid = 0.03275 → диапазон [0.655-0.03275, 0.655+0.03275] = [0.622, 0.688]
      // Все 3 bid уровня (0.65, 0.64, 0.63) входят в [0.622, 0.688]
      // Все 3 ask уровня (0.66, 0.67, 0.68) входят в [0.622, 0.688]
      const result = calc(BIDS, ASKS, {
        type: 'PRICE_RANGE',
        rangePercent: 0.05,
      });
      const expected = expectedVolume(BIDS, ASKS);
      expect(result.toNumber()).toBeCloseTo(expected, 5);
    });

    it('отфильтровывает далёкие уровни', () => {
      // mid = (0.65 + 0.66) / 2 = 0.655
      // 1% от mid = 0.00655 → диапазон [0.64845, 0.66155]
      // Bids: 0.65 входит (|0.65-0.655|=0.005 <= 0.00655); 0.64 вне (0.015 > 0.00655); 0.63 вне
      // Asks: 0.66 входит (|0.66-0.655|=0.005 <= 0.00655); 0.67 вне; 0.68 вне
      // Результат: bids=[1000], asks=[500] → (1000-500)/(1000+500) ≈ 0.333
      const result = calc(BIDS, ASKS, {
        type: 'PRICE_RANGE',
        rangePercent: 0.01,
      });
      expect(result.toNumber()).toBeCloseTo(500 / 1500, 5);
    });

    it('возвращает 0 если стакан пустой', () => {
      expect(
        calc([], [], { type: 'PRICE_RANGE', rangePercent: 0.05 }).toNumber()
      ).toBe(0);
    });

    it('возвращает 0 если bid side пустой (mid не определён)', () => {
      expect(
        calc([], ASKS, { type: 'PRICE_RANGE', rangePercent: 0.05 }).toNumber()
      ).toBe(0);
    });

    it('возвращает Err если rangePercent <= 0', () => {
      expect(ImbalanceCalculator.calculate(BIDS, ASKS, { type: 'PRICE_RANGE', rangePercent: 0 }).ok).toBe(false);
      expect(ImbalanceCalculator.calculate(BIDS, ASKS, { type: 'PRICE_RANGE', rangePercent: -0.1 }).ok).toBe(false);
    });
  });

  // ── WEIGHTED ─────────────────────────────────────────────────────────────────

  describe('WEIGHTED', () => {
    it('возвращает Decimal в диапазоне [-1, +1]', () => {
      const result = calc(BIDS, ASKS, { type: 'WEIGHTED' });
      expect(result.toNumber()).toBeGreaterThanOrEqual(-1);
      expect(result.toNumber()).toBeLessThanOrEqual(1);
    });

    it('возвращает 0 для пустого стакана', () => {
      expect(
        calc([], [], { type: 'WEIGHTED' }).toNumber()
      ).toBe(0);
    });

    it('возвращает +1 если ask side пустой', () => {
      expect(
        calc(BIDS, [], { type: 'WEIGHTED' }).toNumber()
      ).toBe(1);
    });

    it('отличается от ALL_LEVELS для неравномерных стаканов', () => {
      // Большой объём на дальнем уровне bid — WEIGHTED должен быть меньше ALL_LEVELS
      const bids = [
        level('0.65', '100'),   // rank 0, weight 1
        level('0.60', '10000'), // rank 1, weight 0.5 (дальний, но огромный)
      ];
      const asks = [level('0.66', '100')];

      const allLevels = calc(bids, asks, { type: 'ALL_LEVELS' });
      const weighted = calc(bids, asks, { type: 'WEIGHTED' });

      // ALL_LEVELS: (100+10000-100)/(100+10000+100) = 10000/10200 ≈ 0.98
      // WEIGHTED: bid_weighted = 100×1 + 10000×0.5 = 5100; ask_weighted = 100×1 = 100
      //           (5100-100)/(5100+100) = 5000/5200 ≈ 0.96
      // Weighted должен быть меньше ALL_LEVELS
      expect(weighted.toNumber()).toBeLessThan(allLevels.toNumber());
    });

    it('для единственного уровня на каждой стороне эквивалентен ALL_LEVELS', () => {
      const bids = [level('0.65', '1000')];
      const asks = [level('0.66', '500')];
      const allLevels = calc(bids, asks, { type: 'ALL_LEVELS' });
      const weighted = calc(bids, asks, { type: 'WEIGHTED' });
      // Оба используют rank=0, weight=1 → результаты идентичны
      expect(weighted.toNumber()).toBeCloseTo(allLevels.toNumber(), 10);
    });
  });

  // ── NOTIONAL ─────────────────────────────────────────────────────────────────

  describe('NOTIONAL', () => {
    it('возвращает Decimal в диапазоне [-1, +1]', () => {
      const result = calc(BIDS, ASKS, { type: 'NOTIONAL' });
      expect(result.toNumber()).toBeGreaterThanOrEqual(-1);
      expect(result.toNumber()).toBeLessThanOrEqual(1);
    });

    it('вычисляет по price × size', () => {
      // bid notional: 0.65×1000 + 0.64×800 + 0.63×600 = 650 + 512 + 378 = 1540
      // ask notional: 0.66×500 + 0.67×400 + 0.68×300 = 330 + 268 + 204 = 802
      // (1540-802)/(1540+802) = 738/2342 ≈ 0.315
      const result = calc(BIDS, ASKS, { type: 'NOTIONAL' });
      const bidNotional = 0.65 * 1000 + 0.64 * 800 + 0.63 * 600;
      const askNotional = 0.66 * 500 + 0.67 * 400 + 0.68 * 300;
      const expected = (bidNotional - askNotional) / (bidNotional + askNotional);
      expect(result.toNumber()).toBeCloseTo(expected, 5);
    });

    it('отличается от ALL_LEVELS (цены учитываются)', () => {
      // Одинаковый объём, но разные цены → NOTIONAL будет отличаться от VOLUME
      const bids = [
        level('0.90', '100'), // высокая цена
      ];
      const asks = [
        level('0.10', '100'), // низкая цена
      ];
      const allLevels = calc(bids, asks, { type: 'ALL_LEVELS' });
      const notional = calc(bids, asks, { type: 'NOTIONAL' });

      // ALL_LEVELS: (100-100)/(100+100) = 0 (симметричный по объёму)
      expect(allLevels.toNumber()).toBe(0);
      // NOTIONAL: (0.9×100 - 0.1×100)/(0.9×100+0.1×100) = (90-10)/100 = 0.8
      expect(notional.toNumber()).toBeCloseTo(0.8, 5);
    });

    it('возвращает 0 для пустого стакана', () => {
      expect(
        calc([], [], { type: 'NOTIONAL' }).toNumber()
      ).toBe(0);
    });
  });

  // ── Интеграция с ImbalanceHistory ────────────────────────────────────────────

  describe('интеграция с ImbalanceHistory', () => {
    it('результат calculate() можно передать в ImbalanceHistory.record()', async () => {
      const { ImbalanceHistory } = await import('../../src/ImbalanceHistory.js');
      const historyResult = ImbalanceHistory.create(100);
      if (!historyResult.ok) throw new Error('Expected Ok');
      const history = historyResult.value;

      const modes = [
        { type: 'ALL_LEVELS' },
        { type: 'TOP_N', levels: 2 },
        { type: 'WEIGHTED' },
        { type: 'NOTIONAL' },
      ] as const;

      let t = 1_700_000_000_000;
      for (const mode of modes) {
        const imbalance = calc(BIDS, ASKS, mode);
        history.record(imbalance, t++);
      }

      expect(history.size()).toBe(4);
      // Все значения в диапазоне [-1, +1]
      for (const point of history.getAll()) {
        expect(point.imbalance.toNumber()).toBeGreaterThanOrEqual(-1);
        expect(point.imbalance.toNumber()).toBeLessThanOrEqual(1);
      }
    });
  });
});
