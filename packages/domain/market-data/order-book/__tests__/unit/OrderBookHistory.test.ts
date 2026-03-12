/**
 * Тесты OrderBookHistory.
 *
 * @remarks
 * Покрывает:
 * - create(): валидация политики (пустая, невалидные значения)
 * - record(): добавление снапшотов
 * - Вытеснение по count (maxCount)
 * - Вытеснение по времени (maxAgeMs)
 * - Вытеснение при обоих ограничениях одновременно
 * - getLatest(), getLast(), getRecent(), getWindow(), getAll()
 * - size(), isEmpty()
 * - nowMs параметр для детерминированного тестирования
 */
import { describe, it, expect } from '@jest/globals';
import { PaperClock } from '@polymarket/time';
import { OrderBookHistory } from '../../src/OrderBookHistory.js';
import type { OrderBookSnapshot } from '../../src/OrderBook.js';
import type { PriceLevel } from '../../src/PriceLevel.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Создаёт минимальный OrderBookSnapshot для тестов.
 * Bid/ask уровни — пустые массивы (содержимое не важно для тестов истории).
 */
function makeSnapshot(
  marketId = 'mkt-1',
  tokenId = 'tok-1',
  bids: PriceLevel[] = [],
  asks: PriceLevel[] = [],
): OrderBookSnapshot {
  return { marketId, tokenId, bids, asks, timestamp: undefined };
}

/** Базовое время для детерминированных тестов */
const T0 = 1_700_000_000_000;

/** Детерминированный clock для тестов */
const clock = new PaperClock(new Date(T0));

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('OrderBookHistory', () => {

  // ── create() ────────────────────────────────────────────────────────────────

  describe('create()', () => {
    it('создаёт историю с maxCount', () => {
      expect(() => OrderBookHistory.create({ maxCount: 100 }, clock)).not.toThrow();
    });

    it('создаёт историю с maxAgeMs', () => {
      expect(() => OrderBookHistory.create({ maxAgeMs: 60_000 }, clock)).not.toThrow();
    });

    it('создаёт историю с обоими ограничениями', () => {
      expect(() => OrderBookHistory.create({ maxCount: 1000, maxAgeMs: 300_000 }, clock)).not.toThrow();
    });

    it('бросает RangeError если политика пустая', () => {
      expect(() => OrderBookHistory.create({}, clock)).toThrow(RangeError);
    });

    it('бросает RangeError если maxCount <= 0', () => {
      expect(() => OrderBookHistory.create({ maxCount: 0 }, clock)).toThrow(RangeError);
      expect(() => OrderBookHistory.create({ maxCount: -1 }, clock)).toThrow(RangeError);
    });

    it('бросает RangeError если maxCount не целое число', () => {
      expect(() => OrderBookHistory.create({ maxCount: 1.5 }, clock)).toThrow(RangeError);
    });

    it('бросает RangeError если maxAgeMs <= 0', () => {
      expect(() => OrderBookHistory.create({ maxAgeMs: 0 }, clock)).toThrow(RangeError);
      expect(() => OrderBookHistory.create({ maxAgeMs: -1000 }, clock)).toThrow(RangeError);
    });
  });

  // ── isEmpty / size ───────────────────────────────────────────────────────────

  describe('isEmpty() / size()', () => {
    it('новая история пустая', () => {
      const h = OrderBookHistory.create({ maxCount: 10 }, clock);
      expect(h.isEmpty()).toBe(true);
      expect(h.size()).toBe(0);
    });

    it('size() увеличивается при record()', () => {
      const h = OrderBookHistory.create({ maxCount: 10 }, clock);
      h.record(makeSnapshot(), T0);
      h.record(makeSnapshot(), T0 + 1000);
      expect(h.size()).toBe(2);
      expect(h.isEmpty()).toBe(false);
    });
  });

  // ── getLatest() ──────────────────────────────────────────────────────────────

  describe('getLatest()', () => {
    it('возвращает undefined для пустой истории', () => {
      const h = OrderBookHistory.create({ maxCount: 10 }, clock);
      expect(h.getLatest()).toBeUndefined();
    });

    it('возвращает последний добавленный снапшот', () => {
      const h = OrderBookHistory.create({ maxCount: 10 }, clock);
      const s1 = makeSnapshot('mkt-1', 'tok-1');
      const s2 = makeSnapshot('mkt-1', 'tok-2');
      h.record(s1, T0);
      h.record(s2, T0 + 1000);
      expect(h.getLatest()).toBe(s2);
    });
  });

  // ── getLast() ────────────────────────────────────────────────────────────────

  describe('getLast()', () => {
    it('возвращает пустой массив для пустой истории', () => {
      const h = OrderBookHistory.create({ maxCount: 10 }, clock);
      expect(h.getLast(5)).toHaveLength(0);
    });

    it('возвращает последние N снапшотов в хронологическом порядке', () => {
      const h = OrderBookHistory.create({ maxCount: 10 }, clock);
      const snapshots = Array.from({ length: 5 }, (_, i) => makeSnapshot('mkt-1', `tok-${i}`));
      snapshots.forEach((s, i) => h.record(s, T0 + i * 1000));

      const last3 = h.getLast(3);
      expect(last3).toHaveLength(3);
      expect(last3[0]).toBe(snapshots[2]);
      expect(last3[1]).toBe(snapshots[3]);
      expect(last3[2]).toBe(snapshots[4]);
    });

    it('возвращает все если n > size()', () => {
      const h = OrderBookHistory.create({ maxCount: 10 }, clock);
      h.record(makeSnapshot(), T0);
      h.record(makeSnapshot(), T0 + 1000);
      expect(h.getLast(100)).toHaveLength(2);
    });
  });

  // ── getRecent() ──────────────────────────────────────────────────────────────

  describe('getRecent()', () => {
    it('возвращает пустой массив для пустой истории', () => {
      const h = OrderBookHistory.create({ maxCount: 10 }, clock);
      expect(h.getRecent(60_000, T0)).toHaveLength(0);
    });

    it('возвращает снапшоты за последние durationMs мс', () => {
      const h = OrderBookHistory.create({ maxCount: 100 }, clock);
      const s1 = makeSnapshot('m', 'a'); // T0 - 120s — вне окна
      const s2 = makeSnapshot('m', 'b'); // T0 - 30s  — в окне
      const s3 = makeSnapshot('m', 'c'); // T0         — в окне
      h.record(s1, T0 - 120_000);
      h.record(s2, T0 - 30_000);
      h.record(s3, T0);

      const recent = h.getRecent(60_000, T0);
      expect(recent).toHaveLength(2);
      expect(recent[0]).toBe(s2);
      expect(recent[1]).toBe(s3);
    });
  });

  // ── getWindow() ──────────────────────────────────────────────────────────────

  describe('getWindow()', () => {
    it('возвращает снапшоты в заданном диапазоне (включительно)', () => {
      const h = OrderBookHistory.create({ maxCount: 100 }, clock);
      const s1 = makeSnapshot('m', 'a');
      const s2 = makeSnapshot('m', 'b');
      const s3 = makeSnapshot('m', 'c');
      h.record(s1, T0);
      h.record(s2, T0 + 1000);
      h.record(s3, T0 + 2000);

      const window = h.getWindow(T0 + 1000, T0 + 2000);
      expect(window).toHaveLength(2);
      expect(window[0]).toBe(s2);
      expect(window[1]).toBe(s3);
    });

    it('возвращает пустой массив если ни один снапшот не попадает в окно', () => {
      const h = OrderBookHistory.create({ maxCount: 10 }, clock);
      h.record(makeSnapshot(), T0);
      expect(h.getWindow(T0 + 1000, T0 + 2000)).toHaveLength(0);
    });
  });

  // ── getAll() ─────────────────────────────────────────────────────────────────

  describe('getAll()', () => {
    it('возвращает все снапшоты в хронологическом порядке', () => {
      const h = OrderBookHistory.create({ maxCount: 10 }, clock);
      const s1 = makeSnapshot('m', 'a');
      const s2 = makeSnapshot('m', 'b');
      h.record(s1, T0);
      h.record(s2, T0 + 1000);
      const all = h.getAll();
      expect(all).toHaveLength(2);
      expect(all[0]).toBe(s1);
      expect(all[1]).toBe(s2);
    });
  });

  // ── Вытеснение по count (maxCount) ───────────────────────────────────────────

  describe('вытеснение по maxCount', () => {
    it('вытесняет самый старый снапшот при превышении maxCount', () => {
      const h = OrderBookHistory.create({ maxCount: 3 }, clock);
      const snapshots = Array.from({ length: 5 }, (_, i) => makeSnapshot('m', `tok-${i}`));
      snapshots.forEach((s, i) => h.record(s, T0 + i * 1000));

      expect(h.size()).toBe(3);
      const all = h.getAll();
      // Остались последние 3 снапшота
      expect(all[0]).toBe(snapshots[2]);
      expect(all[1]).toBe(snapshots[3]);
      expect(all[2]).toBe(snapshots[4]);
    });

    it('не вытесняет если size() < maxCount', () => {
      const h = OrderBookHistory.create({ maxCount: 5 }, clock);
      h.record(makeSnapshot(), T0);
      h.record(makeSnapshot(), T0 + 1000);
      expect(h.size()).toBe(2);
    });

    it('ровно maxCount снапшотов при добавлении maxCount+1', () => {
      const h = OrderBookHistory.create({ maxCount: 2 }, clock);
      h.record(makeSnapshot('m', 'a'), T0);
      h.record(makeSnapshot('m', 'b'), T0 + 1000);
      h.record(makeSnapshot('m', 'c'), T0 + 2000);

      expect(h.size()).toBe(2);
      const all = h.getAll();
      expect(all[0]?.tokenId).toBe('b');
      expect(all[1]?.tokenId).toBe('c');
    });
  });

  // ── Вытеснение по времени (maxAgeMs) ─────────────────────────────────────────

  describe('вытеснение по maxAgeMs', () => {
    it('вытесняет снапшоты старше maxAgeMs при record()', () => {
      const h = OrderBookHistory.create({ maxAgeMs: 60_000 }, clock);
      const old   = makeSnapshot('m', 'old');
      const fresh = makeSnapshot('m', 'fresh');

      h.record(old,   T0);                   // T0
      h.record(fresh, T0 + 90_000);          // T0 + 90s — old вытесняется (старше 60s)

      expect(h.size()).toBe(1);
      expect(h.getLatest()).toBe(fresh);
    });

    it('не вытесняет снапшоты моложе maxAgeMs', () => {
      const h = OrderBookHistory.create({ maxAgeMs: 60_000 }, clock);
      h.record(makeSnapshot('m', 'a'), T0);
      h.record(makeSnapshot('m', 'b'), T0 + 30_000);
      h.record(makeSnapshot('m', 'c'), T0 + 59_000);

      // Следующий record в T0 + 90s — только 'a' вытесняется (старше 60s)
      h.record(makeSnapshot('m', 'd'), T0 + 90_000);

      expect(h.size()).toBe(3); // b, c, d
      const all = h.getAll();
      expect(all[0]?.tokenId).toBe('b');
    });

    it('вытесняет все снапшоты если все старше maxAgeMs', () => {
      const h = OrderBookHistory.create({ maxAgeMs: 10_000 }, clock);
      h.record(makeSnapshot('m', 'a'), T0);
      h.record(makeSnapshot('m', 'b'), T0 + 1000);

      // Через 60 секунд — оба устарели
      h.record(makeSnapshot('m', 'c'), T0 + 60_000);

      expect(h.size()).toBe(1);
      expect(h.getLatest()?.tokenId).toBe('c');
    });
  });

  // ── Оба ограничения ──────────────────────────────────────────────────────────

  describe('вытеснение при обоих ограничениях (maxCount + maxAgeMs)', () => {
    it('maxAgeMs вытесняет раньше чем maxCount заполнится', () => {
      const h = OrderBookHistory.create({ maxCount: 100, maxAgeMs: 30_000 }, clock);
      h.record(makeSnapshot('m', 'a'), T0);
      h.record(makeSnapshot('m', 'b'), T0 + 10_000);

      // Через 40 секунд — 'a' устарел (40s > 30s), 'b' устарел (30s = 30s граница, строго <)
      h.record(makeSnapshot('m', 'c'), T0 + 40_000);

      // 'a' устарел (40s > 30s) → evicted; 'b' на границе (30s = maxAgeMs) → строго < не выполняется → остаётся
      expect(h.size()).toBe(2); // 'b' и 'c' остаются
      expect(h.getLatest()?.tokenId).toBe('c');
    });

    it('maxCount вытесняет когда maxAgeMs ещё не истёк', () => {
      const h = OrderBookHistory.create({ maxCount: 2, maxAgeMs: 300_000 }, clock);
      const s1 = makeSnapshot('m', 'a');
      const s2 = makeSnapshot('m', 'b');
      const s3 = makeSnapshot('m', 'c');

      // Все добавлены в течение 1 секунды — maxAgeMs не срабатывает
      h.record(s1, T0);
      h.record(s2, T0 + 100);
      h.record(s3, T0 + 200);

      expect(h.size()).toBe(2);
      expect(h.getAll()[0]).toBe(s2);
      expect(h.getAll()[1]).toBe(s3);
    });
  });
});
