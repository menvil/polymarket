import { describe, it, expect } from '@jest/globals';
import { DepthAnalyzer } from '../src/DepthAnalyzer.js';
import { FeeCalculator } from '../src/FeeCalculator.js';
import { FEE_MODEL_CURRENT } from '../src/types.js';
import type { NumericLevel } from '../src/types.js';

const feeCalc = new FeeCalculator(FEE_MODEL_CURRENT);
const analyzer = new DepthAnalyzer(feeCalc);

const defaultOpts = { maxDepth: 5, easyIsTaker: true, hardIsMaker: true };

describe('DepthAnalyzer', () => {
  describe('analyze', () => {
    it('обнаруживает расхождение на уровне 1', () => {
      const hardBids: NumericLevel[] = [{ price: 0.55, size: 100 }];
      const easyAsks: NumericLevel[] = [{ price: 0.48, size: 100 }];

      const levels = analyzer.analyze(hardBids, easyAsks, defaultOpts);

      expect(levels).toHaveLength(1);
      expect(levels[0].depth).toBe(1);
      expect(levels[0].hardUpVwap).toBeCloseTo(0.55, 4);
      expect(levels[0].easyUpVwap).toBeCloseTo(0.48, 4);
      expect(levels[0].spread).toBeCloseTo(0.07, 4);
      expect(levels[0].execSize).toBe(100);
      // cost = 0.48 + (1 - 0.55) = 0.48 + 0.45 = 0.93
      expect(levels[0].costPerUnit).toBeCloseTo(0.93, 4);
      // pnl > 0 (1 - 0.93 - fee)
      expect(levels[0].pnlPerUnit).toBeGreaterThan(0);
    });

    it('расхождение выживает на нескольких уровнях', () => {
      const hardBids: NumericLevel[] = [
        { price: 0.55, size: 100 },
        { price: 0.54, size: 200 },
        { price: 0.53, size: 300 },
      ];
      const easyAsks: NumericLevel[] = [
        { price: 0.48, size: 150 },
        { price: 0.49, size: 250 },
        { price: 0.50, size: 350 },
      ];

      const levels = analyzer.analyze(hardBids, easyAsks, defaultOpts);

      expect(levels.length).toBeGreaterThanOrEqual(2);
      // VWAP ухудшается на каждом уровне
      for (let i = 1; i < levels.length; i++) {
        expect(levels[i].hardUpVwap).toBeLessThanOrEqual(levels[i - 1].hardUpVwap);
        expect(levels[i].easyUpVwap).toBeGreaterThanOrEqual(levels[i - 1].easyUpVwap);
      }
      // Exec size растёт
      for (let i = 1; i < levels.length; i++) {
        expect(levels[i].execSize).toBeGreaterThanOrEqual(levels[i - 1].execSize);
      }
    });

    it('останавливается когда spread уходит в ноль', () => {
      const hardBids: NumericLevel[] = [
        { price: 0.52, size: 100 },
        { price: 0.48, size: 100 },  // VWAP упадёт ниже easyVwap
      ];
      const easyAsks: NumericLevel[] = [
        { price: 0.51, size: 100 },
        { price: 0.52, size: 100 },
      ];

      const levels = analyzer.analyze(hardBids, easyAsks, defaultOpts);

      expect(levels).toHaveLength(1);
      expect(levels[0].spread).toBeCloseTo(0.01, 4);
    });

    it('возвращает пустой массив без расхождения', () => {
      const hardBids: NumericLevel[] = [{ price: 0.45, size: 100 }];
      const easyAsks: NumericLevel[] = [{ price: 0.48, size: 100 }];

      const levels = analyzer.analyze(hardBids, easyAsks, defaultOpts);

      expect(levels).toHaveLength(0);
    });

    it('возвращает пустой массив при пустых стаканах', () => {
      expect(analyzer.analyze([], [], defaultOpts)).toHaveLength(0);
      expect(analyzer.analyze([{ price: 0.5, size: 10 }], [], defaultOpts)).toHaveLength(0);
    });

    it('exec_size = min(cumHard, cumEasy)', () => {
      const hardBids: NumericLevel[] = [{ price: 0.55, size: 500 }];
      const easyAsks: NumericLevel[] = [{ price: 0.48, size: 200 }];

      const levels = analyzer.analyze(hardBids, easyAsks, defaultOpts);

      expect(levels[0].execSize).toBe(200); // min(500, 200)
    });

    it('respectует maxDepth', () => {
      const hardBids: NumericLevel[] = Array.from({ length: 10 }, (_, i) => ({
        price: 0.60 - i * 0.01,
        size: 100,
      }));
      const easyAsks: NumericLevel[] = Array.from({ length: 10 }, (_, i) => ({
        price: 0.45 + i * 0.01,
        size: 100,
      }));

      const levels = analyzer.analyze(hardBids, easyAsks, { ...defaultOpts, maxDepth: 3 });

      expect(levels.length).toBeLessThanOrEqual(3);
    });
  });

  describe('findOptimal', () => {
    it('находит уровень с максимальным totalPnl', () => {
      const hardBids: NumericLevel[] = [
        { price: 0.60, size: 50 },
        { price: 0.58, size: 500 },
        { price: 0.56, size: 1000 },
      ];
      const easyAsks: NumericLevel[] = [
        { price: 0.48, size: 50 },
        { price: 0.49, size: 500 },
        { price: 0.50, size: 1000 },
      ];

      const levels = analyzer.analyze(hardBids, easyAsks, defaultOpts);
      const optimal = analyzer.findOptimal(levels);

      expect(optimal).toBeDefined();
      // С глубиной totalPnl растёт (больше size, spread ещё положительный)
      expect(optimal!.depth).toBeGreaterThanOrEqual(1);
      // Optimal = max totalPnl
      for (const l of levels) {
        expect(optimal!.totalPnl).toBeGreaterThanOrEqual(l.totalPnl);
      }
    });

    it('возвращает undefined для пустого массива', () => {
      expect(analyzer.findOptimal([])).toBeUndefined();
    });
  });
});
