/**
 * Тесты RollingWindow.
 *
 * @remarks
 * Покрывает:
 * - create(): Result-валидация политики (пустая, невалидные значения)
 * - append(): добавление элементов
 * - Вытеснение по count (maxCount)
 * - Вытеснение по времени (maxAgeMs), включая границу age === maxAgeMs
 * - Вытеснение при обоих ограничениях одновременно
 * - getLatest(), getLast(), getRecent(), getWindow(), getAll()
 * - size(), isEmpty()
 */
import { describe, it, expect } from '@jest/globals';
import { PaperClock } from '@polymarket/time';
import { RollingWindow } from '../../src/RollingWindow.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

interface Item {
  readonly label: string;
  readonly ts: number;
}

function item(label: string, ts: number): Item {
  return { label, ts };
}

const getTs = (i: Item): number => i.ts;

/** Базовое время для детерминированных тестов */
const T0 = 1_700_000_000_000;

/** Детерминированный clock для тестов */
const clock = new PaperClock(new Date(T0));

/** Разворачивает Result, падает тестом при Err — сокращает шум в happy-path тестах. */
function unwrap<T>(result: { ok: boolean; value?: T; error?: unknown }): T {
  if (!result.ok) {
    throw new Error(`Expected Ok, got Err: ${JSON.stringify(result.error)}`);
  }
  return result.value as T;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('RollingWindow', () => {
  // ── create() ────────────────────────────────────────────────────────────────

  describe('create()', () => {
    it('создаёт окно с maxCount', () => {
      const result = RollingWindow.create<Item>({ maxCount: 100 }, clock, getTs);
      expect(result.ok).toBe(true);
    });

    it('создаёт окно с maxAgeMs', () => {
      const result = RollingWindow.create<Item>({ maxAgeMs: 60_000 }, clock, getTs);
      expect(result.ok).toBe(true);
    });

    it('создаёт окно с обоими ограничениями', () => {
      const result = RollingWindow.create<Item>({ maxCount: 100, maxAgeMs: 60_000 }, clock, getTs);
      expect(result.ok).toBe(true);
    });

    it('возвращает Err если ни maxCount ни maxAgeMs не заданы', () => {
      const result = RollingWindow.create<Item>({}, clock, getTs);
      expect(result.ok).toBe(false);
    });

    it('возвращает Err если maxCount не положительное целое', () => {
      expect(RollingWindow.create<Item>({ maxCount: 0 }, clock, getTs).ok).toBe(false);
      expect(RollingWindow.create<Item>({ maxCount: -5 }, clock, getTs).ok).toBe(false);
      expect(RollingWindow.create<Item>({ maxCount: 1.5 }, clock, getTs).ok).toBe(false);
    });

    it('возвращает Err если maxAgeMs не положительное конечное число', () => {
      expect(RollingWindow.create<Item>({ maxAgeMs: 0 }, clock, getTs).ok).toBe(false);
      expect(RollingWindow.create<Item>({ maxAgeMs: -1000 }, clock, getTs).ok).toBe(false);
      expect(RollingWindow.create<Item>({ maxAgeMs: Infinity }, clock, getTs).ok).toBe(false);
    });
  });

  // ── append() + вытеснение по maxCount ──────────────────────────────────────────

  describe('вытеснение по maxCount', () => {
    it('вытесняет самый старый элемент при превышении maxCount', () => {
      const window = unwrap(RollingWindow.create<Item>({ maxCount: 2 }, clock, getTs));
      window.append(item('a', T0));
      window.append(item('b', T0 + 1));
      window.append(item('c', T0 + 2));

      expect(window.size()).toBe(2);
      expect(window.getAll().map((i) => i.label)).toEqual(['b', 'c']);
    });
  });

  // ── append() + вытеснение по maxAgeMs ──────────────────────────────────────────

  describe('вытеснение по maxAgeMs', () => {
    it('вытесняет элементы старше maxAgeMs при append()', () => {
      const window = unwrap(RollingWindow.create<Item>({ maxAgeMs: 60_000 }, clock, getTs));
      window.append(item('old', T0));
      window.append(item('fresh', T0 + 90_000)); // T0 + 90s — old вытесняется (старше 60s)

      expect(window.size()).toBe(1);
      expect(window.getLatest()?.label).toBe('fresh');
    });

    it('не вытесняет элементы моложе maxAgeMs', () => {
      const window = unwrap(RollingWindow.create<Item>({ maxAgeMs: 60_000 }, clock, getTs));
      window.append(item('a', T0));
      window.append(item('b', T0 + 30_000));
      window.append(item('c', T0 + 59_000));
      window.append(item('d', T0 + 90_000)); // только 'a' вытесняется (старше 60s)

      expect(window.size()).toBe(3);
      expect(window.getAll().map((i) => i.label)).toEqual(['b', 'c', 'd']);
    });

    it('элемент с возрастом ровно maxAgeMs не вытесняется (строгое <)', () => {
      const window = unwrap(RollingWindow.create<Item>({ maxAgeMs: 30_000 }, clock, getTs));
      window.append(item('a', T0));
      window.append(item('b', T0 + 10_000));
      window.append(item('c', T0 + 40_000)); // 'a' устарел (40s>30s); 'b' на границе (30s=maxAgeMs) — остаётся

      expect(window.size()).toBe(2);
      expect(window.getAll().map((i) => i.label)).toEqual(['b', 'c']);
    });
  });

  // ── Оба ограничения одновременно ───────────────────────────────────────────────

  describe('вытеснение при обоих ограничениях', () => {
    it('maxAgeMs вытесняет раньше чем maxCount заполнится', () => {
      const window = unwrap(RollingWindow.create<Item>({ maxCount: 100, maxAgeMs: 30_000 }, clock, getTs));
      window.append(item('a', T0));
      window.append(item('b', T0 + 10_000));
      window.append(item('c', T0 + 40_000));

      expect(window.size()).toBe(2);
      expect(window.getAll().map((i) => i.label)).toEqual(['b', 'c']);
    });

    it('maxCount вытесняет раньше чем maxAgeMs сработает', () => {
      const window = unwrap(RollingWindow.create<Item>({ maxCount: 2, maxAgeMs: 1_000_000 }, clock, getTs));
      window.append(item('a', T0));
      window.append(item('b', T0 + 1));
      window.append(item('c', T0 + 2));

      expect(window.size()).toBe(2);
      expect(window.getAll().map((i) => i.label)).toEqual(['b', 'c']);
    });
  });

  // ── getLatest() ─────────────────────────────────────────────────────────────────

  describe('getLatest()', () => {
    it('возвращает undefined для пустого окна', () => {
      const window = unwrap(RollingWindow.create<Item>({ maxCount: 10 }, clock, getTs));
      expect(window.getLatest()).toBeUndefined();
    });

    it('возвращает последний добавленный элемент', () => {
      const window = unwrap(RollingWindow.create<Item>({ maxCount: 10 }, clock, getTs));
      window.append(item('a', T0));
      window.append(item('b', T0 + 1));
      expect(window.getLatest()?.label).toBe('b');
    });
  });

  // ── getLast() ───────────────────────────────────────────────────────────────────

  describe('getLast()', () => {
    it('возвращает последние n элементов в хронологическом порядке', () => {
      const window = unwrap(RollingWindow.create<Item>({ maxCount: 10 }, clock, getTs));
      window.append(item('a', T0));
      window.append(item('b', T0 + 1));
      window.append(item('c', T0 + 2));

      expect(window.getLast(2).map((i) => i.label)).toEqual(['b', 'c']);
    });

    it('возвращает пустой массив для n <= 0', () => {
      const window = unwrap(RollingWindow.create<Item>({ maxCount: 10 }, clock, getTs));
      window.append(item('a', T0));
      expect(window.getLast(0)).toEqual([]);
      expect(window.getLast(-1)).toEqual([]);
    });
  });

  // ── getWindow() / getRecent() ────────────────────────────────────────────────────

  describe('getWindow()', () => {
    it('возвращает элементы внутри окна (включительно по границам)', () => {
      const window = unwrap(RollingWindow.create<Item>({ maxCount: 10 }, clock, getTs));
      window.append(item('a', T0));
      window.append(item('b', T0 + 50));
      window.append(item('c', T0 + 100));

      expect(window.getWindow(T0, T0 + 50).map((i) => i.label)).toEqual(['a', 'b']);
    });

    it('возвращает пустой массив для пустого окна', () => {
      const window = unwrap(RollingWindow.create<Item>({ maxCount: 10 }, clock, getTs));
      expect(window.getWindow(T0, T0 + 1000)).toEqual([]);
    });
  });

  describe('getRecent()', () => {
    it('использует явный nowMs для детерминированного запроса', () => {
      const window = unwrap(RollingWindow.create<Item>({ maxCount: 10 }, clock, getTs));
      window.append(item('old', T0));
      window.append(item('fresh', T0 + 50_000));

      const recent = window.getRecent(10_000, T0 + 50_000);
      expect(recent.map((i) => i.label)).toEqual(['fresh']);
    });

    it('использует clock.now() по умолчанию', () => {
      const liveClock = new PaperClock(new Date(T0));
      const window = unwrap(RollingWindow.create<Item>({ maxCount: 10 }, liveClock, getTs));
      window.append(item('a', T0));

      expect(window.getRecent(10_000).map((i) => i.label)).toEqual(['a']);
    });
  });

  // ── size() / isEmpty() ───────────────────────────────────────────────────────────

  describe('size() / isEmpty()', () => {
    it('isEmpty() true для нового окна, false после append', () => {
      const window = unwrap(RollingWindow.create<Item>({ maxCount: 10 }, clock, getTs));
      expect(window.isEmpty()).toBe(true);

      window.append(item('a', T0));
      expect(window.isEmpty()).toBe(false);
      expect(window.size()).toBe(1);
    });
  });
});
