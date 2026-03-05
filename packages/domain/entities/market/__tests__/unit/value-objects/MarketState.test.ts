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

describe('MarketState.transitionToClosed()', () => {
  it('ACTIVE → CLOSED: возвращает новое состояние CLOSED', () => {
    const next = MarketState.transitionToClosed(MarketState.active());
    expect(next.status).toBe('CLOSED');
  });

  it('CLOSED → close: бросает MarketAlreadyClosedError', () => {
    expect(() => MarketState.transitionToClosed(MarketState.closed())).toThrow(
      MarketAlreadyClosedError
    );
  });

  it('RESOLVED → close: бросает MarketAlreadyResolvedError', () => {
    expect(() => MarketState.transitionToClosed(MarketState.resolved(0))).toThrow(
      MarketAlreadyResolvedError
    );
  });

  it('ошибки являются подклассом MarketLifecycleError', () => {
    expect(() => MarketState.transitionToClosed(MarketState.closed())).toThrow(
      MarketLifecycleError
    );
    expect(() => MarketState.transitionToClosed(MarketState.resolved(0))).toThrow(
      MarketLifecycleError
    );
  });

  it('context передаётся в ошибку', () => {
    try {
      MarketState.transitionToClosed(MarketState.closed(), { marketId: 'test-id' });
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(MarketAlreadyClosedError);
      expect((e as MarketAlreadyClosedError).context?.marketId).toBe('test-id');
      expect((e as MarketAlreadyClosedError).context?.currentStatus).toBe('CLOSED');
    }
  });
});

describe('MarketState.transitionToResolved()', () => {
  it('CLOSED → RESOLVED(0): возвращает состояние RESOLVED с индексом 0', () => {
    const next = MarketState.transitionToResolved(MarketState.closed(), 0);
    expect(next.status).toBe('RESOLVED');
    if (next.status === 'RESOLVED') {
      expect(next.resolvedOutcomeIndex).toBe(0);
    }
  });

  it('CLOSED → RESOLVED(1): возвращает состояние RESOLVED с индексом 1', () => {
    const next = MarketState.transitionToResolved(MarketState.closed(), 1);
    expect(next.status).toBe('RESOLVED');
    if (next.status === 'RESOLVED') {
      expect(next.resolvedOutcomeIndex).toBe(1);
    }
  });

  it('ACTIVE → resolve: бросает MarketInvalidTransitionError', () => {
    expect(() => MarketState.transitionToResolved(MarketState.active(), 0)).toThrow(
      MarketInvalidTransitionError
    );
  });

  it('RESOLVED → resolve: бросает MarketAlreadyResolvedError', () => {
    expect(() => MarketState.transitionToResolved(MarketState.resolved(0), 1)).toThrow(
      MarketAlreadyResolvedError
    );
  });

  it('ошибки являются подклассом MarketLifecycleError', () => {
    expect(() => MarketState.transitionToResolved(MarketState.active(), 0)).toThrow(
      MarketLifecycleError
    );
    expect(() => MarketState.transitionToResolved(MarketState.resolved(0), 1)).toThrow(
      MarketLifecycleError
    );
  });

  it('MarketInvalidTransitionError содержит сообщение про Call close() first', () => {
    try {
      MarketState.transitionToResolved(MarketState.active(), 0, { marketId: 'test-id' });
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(MarketInvalidTransitionError);
      expect((e as Error).message).toContain('Call close() first');
      expect((e as MarketInvalidTransitionError).context?.marketId).toBe('test-id');
    }
  });
});
