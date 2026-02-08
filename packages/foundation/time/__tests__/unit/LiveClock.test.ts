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

      // Небольшая задержка
      await new Promise((resolve) => setTimeout(resolve, 10));

      const time2 = clock.now();

      expect(time2.getTime()).toBeGreaterThanOrEqual(time1.getTime());
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

      // Разница должна быть минимальной (< 100ms)
      expect(Math.abs(clockTime - systemTime)).toBeLessThan(100);
    });
  });

  describe('использование в production', () => {
    it('должен работать как источник реального времени', () => {
      const timestamps: number[] = [];

      // Собрать несколько временных меток
      for (let i = 0; i < 5; i++) {
        timestamps.push(clock.now().getTime());
      }

      // Все метки должны быть уникальными или возрастающими
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
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
    });

    it('должен работать в массиве разных реализаций IClock', () => {
      const clocks: IClock[] = [new LiveClock(), new LiveClock()];

      const times = clocks.map((c) => c.now());

      times.forEach((time) => {
        expect(time).toBeInstanceOf(Date);
      });
    });
  });
});
