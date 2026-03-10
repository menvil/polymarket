import { describe, it, expect, beforeEach } from '@jest/globals';
import Decimal from 'decimal.js';
import { ImbalanceHistory } from '../../src/ImbalanceHistory.js';

describe('ImbalanceHistory', () => {
  let history: ImbalanceHistory;
  const BASE_TIME = 1700000000000;

  const d = (n: number) => new Decimal(n);

  beforeEach(() => {
    history = ImbalanceHistory.create();
  });

  // ==================== create ====================

  describe('create()', () => {
    it('создаёт пустую историю', () => {
      expect(history.isEmpty()).toBe(true);
      expect(history.size()).toBe(0);
    });

    it('использует maxSize по умолчанию 1000', () => {
      const h = ImbalanceHistory.create();
      for (let i = 0; i < 1001; i++) {
        h.record(d(0.1), BASE_TIME + i);
      }
      expect(h.size()).toBe(1000);
    });

    it('принимает кастомный maxSize', () => {
      const h = ImbalanceHistory.create(5);
      for (let i = 0; i < 6; i++) {
        h.record(d(0.1), BASE_TIME + i);
      }
      expect(h.size()).toBe(5);
    });
  });

  // ==================== record ====================

  describe('record()', () => {
    it('добавляет запись', () => {
      history.record(d(0.3), BASE_TIME);
      expect(history.size()).toBe(1);
      expect(history.isEmpty()).toBe(false);
    });

    it('хранит все данные корректно', () => {
      history.record(d(0.5), BASE_TIME);
      const all = history.getAll();
      expect(all[0]!.imbalance.toNumber()).toBeCloseTo(0.5);
      expect(all[0]!.timestampMs).toBe(BASE_TIME);
    });

    it('удаляет старую запись при превышении maxSize (FIFO)', () => {
      const h = ImbalanceHistory.create(3);
      h.record(d(0.1), BASE_TIME);
      h.record(d(0.2), BASE_TIME + 1);
      h.record(d(0.3), BASE_TIME + 2);
      h.record(d(0.4), BASE_TIME + 3); // evict 0.1

      const all = h.getAll();
      expect(all).toHaveLength(3);
      expect(all[0]!.imbalance.toNumber()).toBeCloseTo(0.2);
      expect(all[2]!.imbalance.toNumber()).toBeCloseTo(0.4);
    });
  });

  // ==================== getAll ====================

  describe('getAll()', () => {
    it('возвращает пустой массив для новой истории', () => {
      expect(history.getAll()).toEqual([]);
    });

    it('возвращает все записи в порядке добавления', () => {
      history.record(d(0.1), BASE_TIME);
      history.record(d(0.2), BASE_TIME + 1000);
      history.record(d(-0.1), BASE_TIME + 2000);

      const all = history.getAll();
      expect(all).toHaveLength(3);
      expect(all[0]!.imbalance.toNumber()).toBeCloseTo(0.1);
      expect(all[1]!.imbalance.toNumber()).toBeCloseTo(0.2);
      expect(all[2]!.imbalance.toNumber()).toBeCloseTo(-0.1);
    });
  });

  // ==================== getWindow ====================

  describe('getWindow()', () => {
    beforeEach(() => {
      history.record(d(0.1), BASE_TIME);
      history.record(d(0.2), BASE_TIME + 1000);
      history.record(d(0.3), BASE_TIME + 2000);
      history.record(d(0.4), BASE_TIME + 3000);
    });

    it('возвращает записи в диапазоне (включительно)', () => {
      const window = history.getWindow(BASE_TIME + 1000, BASE_TIME + 2000);
      expect(window).toHaveLength(2);
      expect(window[0]!.imbalance.toNumber()).toBeCloseTo(0.2);
      expect(window[1]!.imbalance.toNumber()).toBeCloseTo(0.3);
    });

    it('возвращает пустой массив если нет записей в диапазоне', () => {
      const window = history.getWindow(BASE_TIME + 5000, BASE_TIME + 6000);
      expect(window).toHaveLength(0);
    });

    it('включает граничные значения', () => {
      const window = history.getWindow(BASE_TIME, BASE_TIME);
      expect(window).toHaveLength(1);
      expect(window[0]!.imbalance.toNumber()).toBeCloseTo(0.1);
    });
  });

  // ==================== getAverage ====================

  describe('getAverage()', () => {
    it('возвращает undefined для пустой истории', () => {
      expect(history.getAverage()).toBeUndefined();
    });

    it('вычисляет среднее по всем записям', () => {
      history.record(d(0.4), BASE_TIME);
      history.record(d(0.2), BASE_TIME + 1000);
      history.record(d(-0.2), BASE_TIME + 2000);

      // (0.4 + 0.2 + (-0.2)) / 3 = 0.4/3 ≈ 0.133
      const avg = history.getAverage();
      expect(avg).toBeDefined();
      expect(avg!.toNumber()).toBeCloseTo(0.133, 2);
    });

    it('для одной записи возвращает её значение', () => {
      history.record(d(0.75), BASE_TIME);
      const avg = history.getAverage();
      expect(avg).toBeDefined();
      expect(avg!.toNumber()).toBeCloseTo(0.75);
    });
  });

  // ==================== getDelta ====================

  describe('getDelta()', () => {
    it('возвращает undefined если менее 2 записей в окне', () => {
      history.record(d(0.3), BASE_TIME);
      expect(history.getDelta(60_000)).toBeUndefined();
    });

    it('возвращает undefined для пустой истории', () => {
      expect(history.getDelta(60_000)).toBeUndefined();
    });

    it('вычисляет дельту (last - first) в окне', () => {
      const h = ImbalanceHistory.create();
      const now = BASE_TIME + 10_000; // детерминированное время
      h.record(d(0.1), now - 4000);
      h.record(d(0.2), now - 3000);
      h.record(d(0.5), now - 1000);

      const delta = h.getDelta(5000, now);
      expect(delta).toBeDefined();
      // last(0.5) - first(0.1) = 0.4
      expect(delta!.toNumber()).toBeCloseTo(0.4, 5);
    });

    it('возвращает отрицательную дельту при убывании', () => {
      const h = ImbalanceHistory.create();
      const now = BASE_TIME + 10_000; // детерминированное время
      h.record(d(0.8), now - 3000);
      h.record(d(0.3), now - 1000);

      const delta = h.getDelta(5000, now);
      expect(delta).toBeDefined();
      // last(0.3) - first(0.8) = -0.5
      expect(delta!.toNumber()).toBeCloseTo(-0.5, 5);
    });
  });

  // ==================== isEmpty / size ====================

  describe('isEmpty() / size()', () => {
    it('isEmpty() = true для новой истории', () => {
      expect(history.isEmpty()).toBe(true);
    });

    it('isEmpty() = false после добавления записи', () => {
      history.record(d(0.1), BASE_TIME);
      expect(history.isEmpty()).toBe(false);
    });

    it('size() возвращает корректное количество', () => {
      history.record(d(0.1), BASE_TIME);
      history.record(d(0.2), BASE_TIME + 1);
      expect(history.size()).toBe(2);
    });
  });
});
