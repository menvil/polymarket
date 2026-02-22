/**
 * Тесты для LiveClock
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { LiveClock } from '../../src/LiveClock.js';
import type { IClock } from '../../src/IClock.js';

describe('LiveClock', () => {
  let clock: LiveClock;

  beforeEach(() => {
    clock = new LiveClock();
  });

  describe('now()', () => {
    it('должен возвращать текущее системное время', () => {
      const before = new Date();
      const result = clock.now();
      const after = new Date();

      expect(result.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(result.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('должен возвращать разные значения при последовательных вызовах', async () => {
      const time1 = clock.now();

      // Небольшая задержка для гарантии продвижения времени
      await new Promise((resolve) => setTimeout(resolve, 20));

      const time2 = clock.now();

      // Проверяем что время продвинулось (строго больше)
      expect(time2.getTime()).toBeGreaterThan(time1.getTime());
      // Проверяем что timestamp валидный (не NaN)
      expect(Number.isFinite(time2.getTime())).toBe(true);
    });

    it('должен создавать новый объект Date при каждом вызове', () => {
      const time1 = clock.now();
      const time2 = clock.now();

      // Разные объекты (не по ссылке)
      expect(time1).not.toBe(time2);
    });

    it('должен возвращать валидную дату', () => {
      const result = clock.now();
      expect(result.getTime()).not.toBeNaN();
      expect(result.getTime()).toBeGreaterThan(0);
    });

    it('должен возвращать время близкое к Date.now()', () => {
      const systemTime = Date.now();
      const clockTime = clock.now().getTime();

      // Разница должна быть разумной (< 1000ms для стабильности на загруженном CI)
      expect(Math.abs(clockTime - systemTime)).toBeLessThan(1000);
    });
  });

  describe('использование в production', () => {
    it('должен работать как источник реального времени', () => {
      const timestamps: number[] = [];

      // Собрать несколько временных меток
      for (let i = 0; i < 5; i++) {
        timestamps.push(clock.now().getTime());
      }

      // Все метки должны быть неубывающими (монотонность)
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
        // Проверка что timestamp валидный (не NaN, не Infinity)
        expect(Number.isFinite(timestamps[i])).toBe(true);
      }
    });

    it('должен быть пригоден для измерения коротких интервалов', async () => {
      const start = clock.now();
      const delay = 50; // 50ms

      await new Promise((resolve) => setTimeout(resolve, delay));

      const end = clock.now();
      const elapsed = end.getTime() - start.getTime();

      // Проверяем что прошло примерно 50ms (с погрешностью)
      expect(elapsed).toBeGreaterThanOrEqual(delay - 10);
      expect(elapsed).toBeLessThan(delay + 50);
    });
  });

  describe('интеграция с IClock', () => {
    it('должен быть совместим с IClock интерфейсом', () => {
      const usesClock = (clock: IClock): Date => {
        return clock.now();
      };

      const result = usesClock(clock);
      expect(result).toBeInstanceOf(Date);
      // Усиленная проверка: timestamp валидный и близко к текущему времени
      expect(Number.isFinite(result.getTime())).toBe(true);
      expect(Math.abs(result.getTime() - Date.now())).toBeLessThan(1000);
    });

    it('должен работать в массиве разных реализаций IClock', () => {
      const clocks: IClock[] = [new LiveClock(), new LiveClock()];

      const times = clocks.map((c) => c.now());

      times.forEach((time) => {
        expect(time).toBeInstanceOf(Date);
        // Усиленная проверка: timestamp валидный и не NaN
        expect(Number.isFinite(time.getTime())).toBe(true);
        expect(time.getTime()).toBeGreaterThan(0);
      });
    });
  });
});
