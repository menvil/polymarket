/**
 * Тесты для MarketState — конструкторы, type guards, FSM-переходы
 *
 * @remarks
 * Проверяет:
 * - Конструкторы (active, closed, resolved)
 * - Type guards (isActive, isClosed, isResolved)
 * - Переходы-наблюдения (markClosed, markResolved)
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
  MarketAlreadyClosedError,
  MarketAlreadyResolvedError,
  MarketInvalidTransitionError,
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

  it('CLOSED → markClosed: возвращает Err(MarketAlreadyClosedError)', () => {
    const result = MarketState.markClosed(MarketState.closed());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketAlreadyClosedError);
    }
  });

  it('RESOLVED → markClosed: возвращает Err(MarketAlreadyResolvedError)', () => {
    const result = MarketState.markClosed(MarketState.resolved(0));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketAlreadyResolvedError);
    }
  });

  it('ошибки являются подклассом MarketLifecycleError', () => {
    const r1 = MarketState.markClosed(MarketState.closed());
    const r2 = MarketState.markClosed(MarketState.resolved(0));
    expect(!r1.ok && r1.error instanceof MarketLifecycleError).toBe(true);
    expect(!r2.ok && r2.error instanceof MarketLifecycleError).toBe(true);
  });

  it('context передаётся в ошибку', () => {
    const result = MarketState.markClosed(MarketState.closed(), { marketId: 'test-id' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketAlreadyClosedError);
      expect(result.error.context?.marketId).toBe('test-id');
      expect(result.error.context?.currentStatus).toBe('CLOSED');
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

  it('ACTIVE → markResolved: возвращает Err(MarketInvalidTransitionError)', () => {
    const result = MarketState.markResolved(MarketState.active(), 0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketInvalidTransitionError);
    }
  });

  it('RESOLVED → markResolved: возвращает Err(MarketAlreadyResolvedError)', () => {
    const result = MarketState.markResolved(MarketState.resolved(0), 1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketAlreadyResolvedError);
    }
  });

  it('ошибки являются подклассом MarketLifecycleError', () => {
    const r1 = MarketState.markResolved(MarketState.active(), 0);
    const r2 = MarketState.markResolved(MarketState.resolved(0), 1);
    expect(!r1.ok && r1.error instanceof MarketLifecycleError).toBe(true);
    expect(!r2.ok && r2.error instanceof MarketLifecycleError).toBe(true);
  });

  it('MarketInvalidTransitionError объясняет, что сначала фиксируется закрытие', () => {
    const result = MarketState.markResolved(MarketState.active(), 0, { marketId: 'test-id' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketInvalidTransitionError);
      expect(result.error.message).toContain('Observe the close first');
      expect(result.error.context?.marketId).toBe('test-id');
    }
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

  it('повторное наблюдение закрытия отклоняется, а не проглатывается', () => {
    const closed = unwrap(MarketState.markClosed(MarketState.active()));
    const again = MarketState.markClosed(closed);

    expect(again.ok).toBe(false);
  });
});
