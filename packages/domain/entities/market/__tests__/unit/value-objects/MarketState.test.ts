/**
 * Тесты для MarketState — конструкторы, type guards, FSM-переходы
 *
 * @remarks
 * Проверяет:
 * - Конструкторы (active, closed, resolved)
 * - Type guards (isActive, isClosed, isResolved)
 * - FSM-переходы (transitionToClosed, transitionToResolved)
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

  it('resolved(0) создаёт состояние RESOLVED с индексом 0 (YES)', () => {
    const state = MarketState.resolved(0);
    expect(state.status).toBe('RESOLVED');
    if (state.status === 'RESOLVED') {
      expect(state.resolvedOutcomeIndex).toBe(0);
    }
  });

  it('resolved(1) создаёт состояние RESOLVED с индексом 1 (NO)', () => {
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

describe('MarketState.close()', () => {
  it('ACTIVE → CLOSED: возвращает новое состояние CLOSED', () => {
    const next = unwrap(MarketState.close(MarketState.active()));
    expect(next.status).toBe('CLOSED');
  });

  it('CLOSED → close: возвращает Err(MarketAlreadyClosedError)', () => {
    const result = MarketState.close(MarketState.closed());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketAlreadyClosedError);
    }
  });

  it('RESOLVED → close: возвращает Err(MarketAlreadyResolvedError)', () => {
    const result = MarketState.close(MarketState.resolved(0));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketAlreadyResolvedError);
    }
  });

  it('ошибки являются подклассом MarketLifecycleError', () => {
    const r1 = MarketState.close(MarketState.closed());
    const r2 = MarketState.close(MarketState.resolved(0));
    expect(!r1.ok && r1.error instanceof MarketLifecycleError).toBe(true);
    expect(!r2.ok && r2.error instanceof MarketLifecycleError).toBe(true);
  });

  it('context передаётся в ошибку', () => {
    const result = MarketState.close(MarketState.closed(), { marketId: 'test-id' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketAlreadyClosedError);
      expect(result.error.context?.marketId).toBe('test-id');
      expect(result.error.context?.currentStatus).toBe('CLOSED');
    }
  });
});

describe('MarketState.resolve()', () => {
  it('CLOSED → RESOLVED(0): возвращает состояние RESOLVED с индексом 0', () => {
    const next = unwrap(MarketState.resolve(MarketState.closed(), 0));
    expect(next.status).toBe('RESOLVED');
    if (next.status === 'RESOLVED') {
      expect(next.resolvedOutcomeIndex).toBe(0);
    }
  });

  it('CLOSED → RESOLVED(1): возвращает состояние RESOLVED с индексом 1', () => {
    const next = unwrap(MarketState.resolve(MarketState.closed(), 1));
    expect(next.status).toBe('RESOLVED');
    if (next.status === 'RESOLVED') {
      expect(next.resolvedOutcomeIndex).toBe(1);
    }
  });

  it('ACTIVE → resolve: возвращает Err(MarketInvalidTransitionError)', () => {
    const result = MarketState.resolve(MarketState.active(), 0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketInvalidTransitionError);
    }
  });

  it('RESOLVED → resolve: возвращает Err(MarketAlreadyResolvedError)', () => {
    const result = MarketState.resolve(MarketState.resolved(0), 1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketAlreadyResolvedError);
    }
  });

  it('ошибки являются подклассом MarketLifecycleError', () => {
    const r1 = MarketState.resolve(MarketState.active(), 0);
    const r2 = MarketState.resolve(MarketState.resolved(0), 1);
    expect(!r1.ok && r1.error instanceof MarketLifecycleError).toBe(true);
    expect(!r2.ok && r2.error instanceof MarketLifecycleError).toBe(true);
  });

  it('MarketInvalidTransitionError содержит сообщение про Call close() first', () => {
    const result = MarketState.resolve(MarketState.active(), 0, { marketId: 'test-id' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketInvalidTransitionError);
      expect(result.error.message).toContain('Call close() first');
      expect(result.error.context?.marketId).toBe('test-id');
    }
  });
});
