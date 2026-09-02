/**
 * Тесты окна применимости policy.
 *
 * @remarks
 * Главное, что здесь фиксируется, — ПОЛУОТКРЫТОСТЬ интервала. Это не деталь
 * реализации: на стыке двух соседних policy от неё зависит, окажется ли
 * рынок в один и тот же момент подходящим сразу двум владельцам.
 */
import { describe, it, expect } from '@jest/globals';
import { TimestampService } from '@polymarket/timestamp';
import type { Timestamp } from '@polymarket/timestamp';
import { isPolicyEffectiveAt } from '../src/PolicyWindow.js';

/** Момент из фиксированной шкалы тестов. */
function at(iso: string): Timestamp {
  const result = TimestampService.fromISO(iso);
  if (!result.ok) throw new Error(`bad fixture timestamp: ${iso}`);
  return result.value;
}

const T17_55 = at('2026-09-01T17:55:00.000Z');
const T18_00 = at('2026-09-01T18:00:00.000Z');
const T18_05 = at('2026-09-01T18:05:00.000Z');

describe('окно без границ', () => {
  it('policy без обеих границ действует всегда', () => {
    expect(isPolicyEffectiveAt({}, T17_55)).toBe(true);
    expect(isPolicyEffectiveAt({}, T18_00)).toBe(true);
    expect(isPolicyEffectiveAt({}, T18_05)).toBe(true);
  });
});

describe('effectiveFrom — начало ВКЛЮЧЕНО', () => {
  it('до начала не действует', () => {
    expect(isPolicyEffectiveAt({ effectiveFrom: T18_00 }, T17_55)).toBe(false);
  });

  it('РОВНО в момент начала уже действует', () => {
    expect(isPolicyEffectiveAt({ effectiveFrom: T18_00 }, T18_00)).toBe(true);
  });

  it('после начала действует', () => {
    expect(isPolicyEffectiveAt({ effectiveFrom: T18_00 }, T18_05)).toBe(true);
  });
});

describe('effectiveUntil — конец ИСКЛЮЧЁН', () => {
  it('до конца действует', () => {
    expect(isPolicyEffectiveAt({ effectiveUntil: T18_00 }, T17_55)).toBe(true);
  });

  it('РОВНО в момент конца уже НЕ действует', () => {
    expect(isPolicyEffectiveAt({ effectiveUntil: T18_00 }, T18_00)).toBe(false);
  });

  it('после конца не действует', () => {
    expect(isPolicyEffectiveAt({ effectiveUntil: T18_00 }, T18_05)).toBe(false);
  });
});

describe('стык двух соседних policy', () => {
  it('в точке стыка действует РОВНО одна policy', () => {
    // Именно ради этого свойства интервал полуоткрыт: при замкнутых
    // границах обе policy в 18:00 претендовали бы на один и тот же рынок
    const earlier = { effectiveUntil: T18_00 };
    const later = { effectiveFrom: T18_00 };

    const atBoundary = [
      isPolicyEffectiveAt(earlier, T18_00),
      isPolicyEffectiveAt(later, T18_00),
    ];

    expect(atBoundary).toEqual([false, true]);
    expect(atBoundary.filter(Boolean)).toHaveLength(1);
  });

  it('окно с обеими границами действует внутри и не действует на правом конце', () => {
    const window = { effectiveFrom: T17_55, effectiveUntil: T18_05 };

    expect(isPolicyEffectiveAt(window, T17_55)).toBe(true);
    expect(isPolicyEffectiveAt(window, T18_00)).toBe(true);
    expect(isPolicyEffectiveAt(window, T18_05)).toBe(false);
  });
});
