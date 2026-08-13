import { describe, it, expect } from '@jest/globals';
import {
  emptyReservation,
  heldReservation,
  hasHeldReservation,
  canConsumeHeldReservation,
  applyReservationDelta,
  type ReservationSnapshot,
} from '../src/reservationJournal.js';

/** Извлекает значение из Result в тестовом setup, бросает при Err. */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error('Expected Ok result in test setup');
  return result.value;
}

function held(kind: 'USDC' | 'TOKENS', initial: string): ReservationSnapshot {
  return unwrap(heldReservation(kind, initial));
}

describe('reservationJournal', () => {
  describe('emptyReservation', () => {
    it('создаёт NONE со всеми нулями', () => {
      expect(emptyReservation('USDC')).toEqual({
        kind: 'USDC', initial: '0', remaining: '0', consumed: '0', released: '0', status: 'NONE',
      });
    });
  });

  describe('heldReservation', () => {
    it('initial > 0 → HELD, remaining === initial', () => {
      expect(held('USDC', '65')).toEqual({
        kind: 'USDC', initial: '65', remaining: '65', consumed: '0', released: '0', status: 'HELD',
      });
    });

    it('initial === 0 → SETTLED', () => {
      expect(held('TOKENS', '0').status).toBe('SETTLED');
    });

    it('отрицательный initial → Err NEGATIVE_AMOUNT', () => {
      const r = heldReservation('USDC', '-1');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('NEGATIVE_AMOUNT');
    });
  });

  describe('hasHeldReservation', () => {
    it('HELD с remaining > 0 → true', () => {
      expect(hasHeldReservation(held('USDC', '10'))).toBe(true);
    });
    it('NONE → false', () => {
      expect(hasHeldReservation(emptyReservation('USDC'))).toBe(false);
    });
    it('SETTLED → false', () => {
      const settled = applyReservationDelta(held('USDC', '10'), { consume: '10' });
      expect(settled.ok && hasHeldReservation(settled.value)).toBe(false);
    });
    it('PARTIALLY_SETTLED с remaining > 0 → true', () => {
      const partial = applyReservationDelta(held('USDC', '10'), { consume: '4' });
      expect(partial.ok && hasHeldReservation(partial.value)).toBe(true);
    });
    it('RECONCILIATION_REQUIRED с remaining > 0 → true', () => {
      const rec = applyReservationDelta(held('USDC', '10'), { status: 'RECONCILIATION_REQUIRED' });
      expect(rec.ok && hasHeldReservation(rec.value)).toBe(true);
    });
  });

  describe('canConsumeHeldReservation', () => {
    it('HELD с remaining > 0 → true', () => {
      expect(canConsumeHeldReservation(held('USDC', '10'))).toBe(true);
    });
    it('PARTIALLY_SETTLED с remaining > 0 → true', () => {
      const partial = applyReservationDelta(held('USDC', '10'), { consume: '4' });
      expect(partial.ok && canConsumeHeldReservation(partial.value)).toBe(true);
    });
    it('RECONCILIATION_REQUIRED → false ДАЖЕ при remaining > 0 (в отличие от hasHeldReservation)', () => {
      const rec = applyReservationDelta(held('USDC', '10'), { status: 'RECONCILIATION_REQUIRED' });
      expect(rec.ok && hasHeldReservation(rec.value)).toBe(true);
      expect(rec.ok && canConsumeHeldReservation(rec.value)).toBe(false);
    });
    it('NONE / SETTLED → false', () => {
      expect(canConsumeHeldReservation(emptyReservation('USDC'))).toBe(false);
      const settled = applyReservationDelta(held('USDC', '10'), { consume: '10' });
      expect(settled.ok && canConsumeHeldReservation(settled.value)).toBe(false);
    });
  });

  describe('applyReservationDelta', () => {
    it('consume уменьшает remaining, увеличивает consumed, сохраняет инвариант', () => {
      const r = applyReservationDelta(held('USDC', '65'), { consume: '30' });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value).toMatchObject({ remaining: '35', consumed: '30', released: '0', status: 'PARTIALLY_SETTLED' });
        // initial = remaining + consumed + released
        expect(Number(r.value.remaining) + Number(r.value.consumed) + Number(r.value.released)).toBe(65);
      }
    });

    it('release уменьшает remaining, увеличивает released', () => {
      const r = applyReservationDelta(held('USDC', '65'), { release: '13' });
      expect(r.ok && r.value.released).toBe('13');
      expect(r.ok && r.value.remaining).toBe('52');
    });

    it('consume === remaining → SETTLED', () => {
      const r = applyReservationDelta(held('USDC', '65'), { consume: '65' });
      expect(r.ok && r.value.status).toBe('SETTLED');
      expect(r.ok && r.value.remaining).toBe('0');
    });

    it('consume + release > remaining → OVER_CONSUME', () => {
      const r = applyReservationDelta(held('USDC', '10'), { consume: '6', release: '6' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('OVER_CONSUME');
    });

    it('отрицательная сумма → NEGATIVE_AMOUNT', () => {
      const r = applyReservationDelta(held('USDC', '10'), { release: '-1' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('NEGATIVE_AMOUNT');
    });

    it('явный status переопределяет вычисленный', () => {
      const r = applyReservationDelta(held('USDC', '10'), { status: 'RECONCILIATION_REQUIRED' });
      expect(r.ok && r.value.status).toBe('RECONCILIATION_REQUIRED');
      expect(r.ok && r.value.remaining).toBe('10'); // без активности остаток тот же
    });

    it('exact decimal (без float-погрешности)', () => {
      const r = applyReservationDelta(held('USDC', '0.3'), { consume: '0.1' });
      expect(r.ok && r.value.remaining).toBe('0.2');
    });
  });

  describe('запрещённые состояния статус↔суммы (1.5)', () => {
    it('явный SETTLED при remaining > 0 → INVARIANT_VIOLATION', () => {
      const r = applyReservationDelta(held('USDC', '10'), { consume: '4', status: 'SETTLED' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVARIANT_VIOLATION');
    });

    it('явный HELD при remaining === 0 → INVARIANT_VIOLATION', () => {
      const r = applyReservationDelta(held('USDC', '10'), { consume: '10', status: 'HELD' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVARIANT_VIOLATION');
    });

    it('явный PARTIALLY_SETTLED при remaining === 0 → INVARIANT_VIOLATION', () => {
      const r = applyReservationDelta(held('USDC', '10'), { consume: '10', status: 'PARTIALLY_SETTLED' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVARIANT_VIOLATION');
    });

    it('явный NONE при ненулевых суммах → INVARIANT_VIOLATION', () => {
      const r = applyReservationDelta(held('USDC', '10'), { consume: '4', status: 'NONE' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('INVARIANT_VIOLATION');
    });

    it('автоматический consume из RECONCILIATION_REQUIRED → RECONCILIATION_LOCKED', () => {
      const rec = applyReservationDelta(held('USDC', '10'), { status: 'RECONCILIATION_REQUIRED' });
      expect(rec.ok).toBe(true);
      if (!rec.ok) return;
      const r = applyReservationDelta(rec.value, { consume: '5' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('RECONCILIATION_LOCKED');
    });

    it('автоматический release/смена статуса из RECONCILIATION_REQUIRED → RECONCILIATION_LOCKED', () => {
      const rec = applyReservationDelta(held('USDC', '10'), { status: 'RECONCILIATION_REQUIRED' });
      expect(rec.ok).toBe(true);
      if (!rec.ok) return;
      const release = applyReservationDelta(rec.value, { release: '10' });
      expect(release.ok).toBe(false);
      if (!release.ok) expect(release.error.code).toBe('RECONCILIATION_LOCKED');
      const toHeld = applyReservationDelta(rec.value, { status: 'HELD' });
      expect(toHeld.ok).toBe(false);
      if (!toHeld.ok) expect(toHeld.error.code).toBe('RECONCILIATION_LOCKED');
    });

    it('идемпотентный re-mark RECONCILIATION_REQUIRED (без сумм) → Ok, снимок не меняется', () => {
      const rec = applyReservationDelta(held('USDC', '10'), { status: 'RECONCILIATION_REQUIRED' });
      expect(rec.ok).toBe(true);
      if (!rec.ok) return;
      const remark = applyReservationDelta(rec.value, { status: 'RECONCILIATION_REQUIRED' });
      expect(remark.ok).toBe(true);
      if (remark.ok) expect(remark.value).toEqual(rec.value);
    });
  });
});
