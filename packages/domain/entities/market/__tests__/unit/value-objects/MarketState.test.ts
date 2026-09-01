/**
 * Тесты для MarketState — конструкторы, type guards, FSM-переходы
 *
 * @remarks
 * Проверяет:
 * - Конструкторы (active, closed, resolved)
 * - Type guards (isActive, isClosed, isResolved)
 * - Переходы-наблюдения (markClosed, markResolved), включая идемпотентность
 * - Отклонение регрессии и конфликта исхода
 * - normalize() — защитная копия состояния
 * - Иммутабельность возвращаемых состояний
 */

import { describe, it, expect } from '@jest/globals';
import {
  MarketState,
  isActive,
  isClosed,
  isResolved,
} from '../../../src/value-objects/MarketState.js';
import {
  MarketAlreadyResolvedError,
  MarketLifecycleError,
} from '@polymarket/errors/market';

// Вспомогательная функция для извлечения значения из Result в тестах
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }, ctx = ''): T {
  if (!result.ok) throw new Error(`Expected Ok result in test setup${ctx ? `: ${ctx}` : ''}`);
  return result.value;
}

describe('MarketState конструкторы', () => {
  it('active() создаёт состояние ACTIVE', () => {
    const state = MarketState.active();
    expect(state.status).toBe('ACTIVE');
  });

  it('closed() создаёт состояние CLOSED', () => {
    const state = MarketState.closed();
    expect(state.status).toBe('CLOSED');
  });

  it('resolved(0) создаёт состояние RESOLVED с индексом первого исхода', () => {
    const state = MarketState.resolved(0);
    expect(state.status).toBe('RESOLVED');
    if (state.status === 'RESOLVED') {
      expect(state.resolvedOutcomeIndex).toBe(0);
    }
  });

  it('resolved(1) создаёт состояние RESOLVED с индексом второго исхода', () => {
    const state = MarketState.resolved(1);
    expect(state.status).toBe('RESOLVED');
    if (state.status === 'RESOLVED') {
      expect(state.resolvedOutcomeIndex).toBe(1);
    }
  });
});

describe('MarketState type guards', () => {
  it('isActive() возвращает true только для ACTIVE', () => {
    expect(isActive(MarketState.active())).toBe(true);
    expect(isActive(MarketState.closed())).toBe(false);
    expect(isActive(MarketState.resolved(0))).toBe(false);
  });

  it('isClosed() возвращает true только для CLOSED', () => {
    expect(isClosed(MarketState.closed())).toBe(true);
    expect(isClosed(MarketState.active())).toBe(false);
    expect(isClosed(MarketState.resolved(0))).toBe(false);
  });

  it('isResolved() возвращает true только для RESOLVED', () => {
    expect(isResolved(MarketState.resolved(0))).toBe(true);
    expect(isResolved(MarketState.resolved(1))).toBe(true);
    expect(isResolved(MarketState.active())).toBe(false);
    expect(isResolved(MarketState.closed())).toBe(false);
  });
});

describe('MarketState.markClosed()', () => {
  it('ACTIVE → CLOSED: возвращает новое состояние CLOSED', () => {
    const next = unwrap(MarketState.markClosed(MarketState.active()));
    expect(next.status).toBe('CLOSED');
  });

  it('CLOSED → markClosed: идемпотентно, возвращает то же состояние', () => {
    const closed = MarketState.closed();
    const result = MarketState.markClosed(closed);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(closed); // тот же объект — признак no-op
    }
  });

  it('RESOLVED → markClosed: возвращает Err(MarketAlreadyResolvedError) — регрессия', () => {
    const result = MarketState.markClosed(MarketState.resolved(0));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketAlreadyResolvedError);
      expect(result.error).toBeInstanceOf(MarketLifecycleError);
    }
  });

  it('context передаётся в ошибку', () => {
    const result = MarketState.markClosed(MarketState.resolved(1), { marketId: 'test-id' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.marketId).toBe('test-id');
      expect(result.error.context?.currentStatus).toBe('RESOLVED');
      expect(result.error.context?.resolvedOutcomeIndex).toBe(1);
    }
  });
});

describe('MarketState.markResolved()', () => {
  it('CLOSED → RESOLVED(0): возвращает состояние RESOLVED с индексом 0', () => {
    const next = unwrap(MarketState.markResolved(MarketState.closed(), 0));
    expect(next.status).toBe('RESOLVED');
    if (next.status === 'RESOLVED') {
      expect(next.resolvedOutcomeIndex).toBe(0);
    }
  });

  it('CLOSED → RESOLVED(1): возвращает состояние RESOLVED с индексом 1', () => {
    const next = unwrap(MarketState.markResolved(MarketState.closed(), 1));
    expect(next.status).toBe('RESOLVED');
    if (next.status === 'RESOLVED') {
      expect(next.resolvedOutcomeIndex).toBe(1);
    }
  });

  it('ACTIVE → RESOLVED: разрешён — промежуточный CLOSED мог не попасть в опрос', () => {
    const next = unwrap(MarketState.markResolved(MarketState.active(), 1));
    expect(next.status).toBe('RESOLVED');
    if (next.status === 'RESOLVED') {
      expect(next.resolvedOutcomeIndex).toBe(1);
    }
  });

  it('RESOLVED(i) → markResolved(i): идемпотентно, возвращает то же состояние', () => {
    const resolved = MarketState.resolved(0);
    const result = MarketState.markResolved(resolved, 0);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(resolved); // тот же объект — признак no-op
    }
  });

  it('RESOLVED(0) → markResolved(1): Err — конфликт исхода', () => {
    const result = MarketState.markResolved(MarketState.resolved(0), 1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketAlreadyResolvedError);
      expect(result.error).toBeInstanceOf(MarketLifecycleError);
      expect(result.error.message).toContain('different outcome');
    }
  });

  it('ошибка конфликта несёт и зафиксированный, и наблюдённый исход', () => {
    const result = MarketState.markResolved(MarketState.resolved(0), 1, { marketId: 'test-id' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context?.marketId).toBe('test-id');
      expect(result.error.context?.resolvedOutcomeIndex).toBe(0);
      expect(result.error.context?.observedOutcomeIndex).toBe(1);
    }
  });
});

describe('MarketState.normalize()', () => {
  it.each([
    ['ACTIVE', { status: 'ACTIVE' as const }],
    ['CLOSED', { status: 'CLOSED' as const }],
  ])('возвращает замороженную копию для %s', (_label, mutable) => {
    const normalized = MarketState.normalize(mutable);

    expect(normalized).toEqual(mutable);
    expect(normalized).not.toBe(mutable);
    expect(Object.isFrozen(normalized)).toBe(true);
  });

  it('сохраняет индекс победителя для RESOLVED', () => {
    const mutable = { status: 'RESOLVED' as const, resolvedOutcomeIndex: 1 as const };
    const normalized = MarketState.normalize(mutable);

    expect(normalized).toEqual({ status: 'RESOLVED', resolvedOutcomeIndex: 1 });
    expect(normalized).not.toBe(mutable);
    expect(Object.isFrozen(normalized)).toBe(true);
  });
});

describe('MarketState — иммутабельность', () => {
  it('конструкторы возвращают замороженные объекты', () => {
    expect(Object.isFrozen(MarketState.active())).toBe(true);
    expect(Object.isFrozen(MarketState.closed())).toBe(true);
    expect(Object.isFrozen(MarketState.resolved(0))).toBe(true);
  });

  it('переход не мутирует исходное состояние', () => {
    const active = MarketState.active();
    unwrap(MarketState.markClosed(active));

    expect(active.status).toBe('ACTIVE');
  });
});

describe('MarketState — семантика наблюдения', () => {
  it('нет переходов UPCOMING/OPEN/ENDED: хранимых состояний ровно три', () => {
    const statuses = [
      MarketState.active().status,
      MarketState.closed().status,
      MarketState.resolved(0).status,
    ];

    expect(new Set(statuses)).toEqual(new Set(['ACTIVE', 'CLOSED', 'RESOLVED']));
  });

  it('повторное наблюдение закрытия не ошибка — внешние снапшоты повторяются', () => {
    const closed = unwrap(MarketState.markClosed(MarketState.active()));
    const again = MarketState.markClosed(closed);

    expect(again.ok).toBe(true);
  });

  it('вернуться в ACTIVE нельзя: обратного перехода нет в API', () => {
    // RESOLVED → ACTIVE и CLOSED → ACTIVE — конфликты, которые невозможно даже выразить:
    // MarketState.active() — конструктор нового состояния, а не переход из существующего.
    const transitions = Object.keys(MarketState).filter((key) => key.startsWith('mark'));

    expect(transitions.sort()).toEqual(['markClosed', 'markResolved']);
  });

  it('отклоняются только противоречия уже зафиксированному факту', () => {
    const resolvedUp = MarketState.resolved(0);

    expect(MarketState.markClosed(resolvedUp).ok).toBe(false);        // регрессия
    expect(MarketState.markResolved(resolvedUp, 1).ok).toBe(false);   // конфликт исхода
    expect(MarketState.markResolved(resolvedUp, 0).ok).toBe(true);    // повтор того же
  });
});
