/**
 * Тесты TradeTape.
 *
 * @remarks
 * Покрывает:
 * - create(): создание с политикой хранения (Result), Err при пустой политике
 * - append(): добавление записей, вытеснение по maxAgeMs, FIFO по maxCount
 * - getAll(): возвращает все записи
 * - getLatest() / getLast(): доступ к записям с конца (делегировано RollingWindow)
 * - getWindow(): фильтрация по временному диапазону (включительно)
 * - getRecent(): выборка за последние N мс
 * - isEmpty() / size(): проверка состояния
 *
 * `evictBefore()` снят вместе с миграцией на `RollingWindow<TapeRecord>` (Этап 2 плана
 * миграции) — у метода не было ни одного реального вызывающего в репозитории.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { PaperClock } from '@polymarket/time';
import { TradeTape } from '../../src/TradeTape.js';
import type { TapeRecord } from '../../src/TapeRecord.js';
import { Price, Quantity } from '@polymarket/value-objects';
import { Timestamp } from '@polymarket/timestamp';
import Decimal from 'decimal.js';

// ==================== Вспомогательные функции ====================

const BASE_TIME = 1_700_000_000_000;

/** Детерминированный clock для тестов */
const clock = new PaperClock(new Date(BASE_TIME));

function makeRecord(params: {
  price?: number;
  size?: number;
  side?: 'BUY' | 'SELL';
  timestampMs?: number;
}): TapeRecord {
  return {
    price: Price.of(new Decimal(params.price ?? 0.65)),
    size: Quantity.of(new Decimal(params.size ?? 100)),
    side: params.side ?? 'BUY',
    timestamp: Timestamp.of(new Decimal(params.timestampMs ?? BASE_TIME)),
  };
}

/** Разворачивает Result, падает тестом при Err — сокращает шум в happy-path тестах. */
function unwrap<T>(result: { ok: boolean; value?: T; error?: unknown }): T {
  if (!result.ok) {
    throw new Error(`Expected Ok, got Err: ${JSON.stringify(result.error)}`);
  }
  return result.value as T;
}

// ==================== Тесты ====================

describe('TradeTape', () => {
  // ==================== create ====================

  describe('create()', () => {
    it('создаёт пустую ленту с maxCount', () => {
      const tape = unwrap(TradeTape.create({ maxCount: 100 }, clock));
      expect(tape.isEmpty()).toBe(true);
      expect(tape.size()).toBe(0);
    });

    it('создаёт пустую ленту с maxAgeMs', () => {
      const tape = unwrap(TradeTape.create({ maxAgeMs: 60_000 }, clock));
      expect(tape.isEmpty()).toBe(true);
    });

    it('создаёт ленту с обоими ограничениями', () => {
      const tape = unwrap(TradeTape.create({ maxCount: 500, maxAgeMs: 300_000 }, clock));
      expect(tape.isEmpty()).toBe(true);
    });

    it('возвращает Err если политика пустая', () => {
      expect(TradeTape.create({}, clock).ok).toBe(false);
    });
  });

  // ==================== append ====================

  describe('append()', () => {
    let tape: TradeTape;

    beforeEach(() => {
      tape = unwrap(TradeTape.create({ maxCount: 100 }, clock));
    });

    it('добавляет запись', () => {
      tape.append(makeRecord({}));
      expect(tape.size()).toBe(1);
      expect(tape.isEmpty()).toBe(false);
    });

    it('добавляет несколько записей', () => {
      tape.append(makeRecord({ timestampMs: BASE_TIME }));
      tape.append(makeRecord({ timestampMs: BASE_TIME + 1000 }));
      tape.append(makeRecord({ timestampMs: BASE_TIME + 2000 }));
      expect(tape.size()).toBe(3);
    });

    it('вытесняет самую старую при превышении maxCount (FIFO)', () => {
      const tape3 = unwrap(TradeTape.create({ maxCount: 3 }, clock));
      for (let i = 0; i < 5; i++) {
        tape3.append(makeRecord({ timestampMs: BASE_TIME + i * 1000 }));
      }
      expect(tape3.size()).toBe(3);
      // Первые два должны быть вытеснены — в ленте остались последние три
      const all = tape3.getAll();
      expect(all[0].timestamp.toNumber()).toBe(BASE_TIME + 2000);
      expect(all[2].timestamp.toNumber()).toBe(BASE_TIME + 4000);
    });

    it('вытесняет устаревшие по maxAgeMs', () => {
      const tape60 = unwrap(TradeTape.create({ maxAgeMs: 60_000 }, clock));

      tape60.append(makeRecord({ timestampMs: BASE_TIME }));
      tape60.append(makeRecord({ timestampMs: BASE_TIME + 30_000 }));

      // Новый трейд через 90s — первый должен вытесниться (старше 60s)
      tape60.append(makeRecord({ timestampMs: BASE_TIME + 90_000 }));

      expect(tape60.size()).toBe(2);
      const all = tape60.getAll();
      expect(all[0].timestamp.toNumber()).toBe(BASE_TIME + 30_000);
      expect(all[1].timestamp.toNumber()).toBe(BASE_TIME + 90_000);
    });

    it('оба ограничения работают вместе', () => {
      // maxAgeMs=60s + maxCount=3
      const tapeCombined = unwrap(TradeTape.create({ maxCount: 3, maxAgeMs: 60_000 }, clock));
      // Добавим 4 записи в разное время
      tapeCombined.append(makeRecord({ timestampMs: BASE_TIME }));
      tapeCombined.append(makeRecord({ timestampMs: BASE_TIME + 10_000 }));
      tapeCombined.append(makeRecord({ timestampMs: BASE_TIME + 20_000 }));
      tapeCombined.append(makeRecord({ timestampMs: BASE_TIME + 30_000 }));
      // maxCount=3: должно остаться 3
      expect(tapeCombined.size()).toBe(3);

      // Новый трейд через 80s — возраст отсечения = 80s - 60s = 20s от BASE
      // BASE_TIME + 10_000 < BASE_TIME + 20_000 (cutoff) → вытесняется
      tapeCombined.append(makeRecord({ timestampMs: BASE_TIME + 80_000 }));
      // После age eviction останутся: +20s, +30s; после добавления: +20s, +30s, +80s
      expect(tapeCombined.size()).toBe(3);
    });
  });

  // ==================== getAll ====================

  describe('getAll()', () => {
    it('возвращает пустой массив для новой ленты', () => {
      const tape = unwrap(TradeTape.create({ maxCount: 100 }, clock));
      expect(tape.getAll()).toHaveLength(0);
    });

    it('возвращает все добавленные записи', () => {
      const tape = unwrap(TradeTape.create({ maxCount: 100 }, clock));
      tape.append(makeRecord({ timestampMs: BASE_TIME }));
      tape.append(makeRecord({ timestampMs: BASE_TIME + 1000 }));
      expect(tape.getAll()).toHaveLength(2);
    });

    it('возвращает массив (readonly — compile-time гарантия TypeScript)', () => {
      const tape = unwrap(TradeTape.create({ maxCount: 100 }, clock));
      tape.append(makeRecord({}));
      const all = tape.getAll();
      expect(Array.isArray(all)).toBe(true);
    });
  });

  // ==================== getLatest / getLast ====================

  describe('getLatest() / getLast()', () => {
    it('getLatest() возвращает undefined для пустой ленты', () => {
      const tape = unwrap(TradeTape.create({ maxCount: 100 }, clock));
      expect(tape.getLatest()).toBeUndefined();
    });

    it('getLatest() возвращает последнюю добавленную запись', () => {
      const tape = unwrap(TradeTape.create({ maxCount: 100 }, clock));
      tape.append(makeRecord({ timestampMs: BASE_TIME, price: 0.5 }));
      tape.append(makeRecord({ timestampMs: BASE_TIME + 1000, price: 0.6 }));
      expect(tape.getLatest()?.price.value().toNumber()).toBe(0.6);
    });

    it('getLast(n) возвращает последние n записей в хронологическом порядке', () => {
      const tape = unwrap(TradeTape.create({ maxCount: 100 }, clock));
      tape.append(makeRecord({ timestampMs: BASE_TIME }));
      tape.append(makeRecord({ timestampMs: BASE_TIME + 1000 }));
      tape.append(makeRecord({ timestampMs: BASE_TIME + 2000 }));

      const last2 = tape.getLast(2);
      expect(last2).toHaveLength(2);
      expect(last2[0]!.timestamp.toNumber()).toBe(BASE_TIME + 1000);
      expect(last2[1]!.timestamp.toNumber()).toBe(BASE_TIME + 2000);
    });

    it('getLast(n) возвращает пустой массив для n <= 0', () => {
      const tape = unwrap(TradeTape.create({ maxCount: 100 }, clock));
      tape.append(makeRecord({}));
      expect(tape.getLast(0)).toEqual([]);
    });
  });

  // ==================== getWindow ====================

  describe('getWindow()', () => {
    let tape: TradeTape;

    beforeEach(() => {
      tape = unwrap(TradeTape.create({ maxCount: 100 }, clock));
      tape.append(makeRecord({ timestampMs: BASE_TIME }));
      tape.append(makeRecord({ timestampMs: BASE_TIME + 1000 }));
      tape.append(makeRecord({ timestampMs: BASE_TIME + 2000 }));
      tape.append(makeRecord({ timestampMs: BASE_TIME + 3000 }));
    });

    it('возвращает записи в диапазоне (включительно)', () => {
      const window = tape.getWindow(BASE_TIME + 1000, BASE_TIME + 2000);
      expect(window).toHaveLength(2);
    });

    it('включает граничные значения', () => {
      const window = tape.getWindow(BASE_TIME, BASE_TIME);
      expect(window).toHaveLength(1);
    });

    it('возвращает пустой массив если нет записей в диапазоне', () => {
      const window = tape.getWindow(BASE_TIME + 5000, BASE_TIME + 6000);
      expect(window).toHaveLength(0);
    });

    it('возвращает все записи при широком диапазоне', () => {
      const window = tape.getWindow(BASE_TIME - 1000, BASE_TIME + 9000);
      expect(window).toHaveLength(4);
    });
  });

  // ==================== getRecent ====================

  describe('getRecent()', () => {
    it('использует nowMs для определения окна', () => {
      const tape = unwrap(TradeTape.create({ maxCount: 100 }, clock));
      tape.append(makeRecord({ timestampMs: BASE_TIME }));
      tape.append(makeRecord({ timestampMs: BASE_TIME + 500 }));
      tape.append(makeRecord({ timestampMs: BASE_TIME + 1000 }));

      // окно: [BASE_TIME+500, BASE_TIME+1000] при nowMs=BASE_TIME+1000, durationMs=500
      const recent = tape.getRecent(500, BASE_TIME + 1000);
      expect(recent).toHaveLength(2);
    });

    it('возвращает пустой массив если нет записей в окне', () => {
      const tape = unwrap(TradeTape.create({ maxCount: 100 }, clock));
      tape.append(makeRecord({ timestampMs: BASE_TIME }));

      const recent = tape.getRecent(100, BASE_TIME + 1_000_000);
      expect(recent).toHaveLength(0);
    });

    it('возвращает все записи при очень большой duration', () => {
      const tape = unwrap(TradeTape.create({ maxCount: 100 }, clock));
      tape.append(makeRecord({ timestampMs: BASE_TIME }));
      tape.append(makeRecord({ timestampMs: BASE_TIME + 1000 }));

      const recent = tape.getRecent(999_999_999, BASE_TIME + 2000);
      expect(recent).toHaveLength(2);
    });
  });

  // ==================== isEmpty / size ====================

  describe('isEmpty() / size()', () => {
    it('isEmpty() = true для новой ленты', () => {
      const tape = unwrap(TradeTape.create({ maxCount: 100 }, clock));
      expect(tape.isEmpty()).toBe(true);
    });

    it('isEmpty() = false после добавления записи', () => {
      const tape = unwrap(TradeTape.create({ maxCount: 100 }, clock));
      tape.append(makeRecord({}));
      expect(tape.isEmpty()).toBe(false);
    });

    it('size() возвращает корректное количество', () => {
      const tape = unwrap(TradeTape.create({ maxCount: 100 }, clock));
      tape.append(makeRecord({}));
      tape.append(makeRecord({ timestampMs: BASE_TIME + 1 }));
      expect(tape.size()).toBe(2);
    });
  });
});
