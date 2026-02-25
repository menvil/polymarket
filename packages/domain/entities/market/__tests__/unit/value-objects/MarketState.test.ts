/**
 * Тесты для MarketState discriminated union и type guards
 */

import { describe, it, expect } from '@jest/globals';
import {
  MarketState,
  isActive,
  isClosed,
  isResolved,
  canTransition,
} from '../../../src/value-objects/MarketState.js';

describe('MarketState', () => {
  describe('конструкторы', () => {
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

  describe('type guards', () => {
    it('isActive() возвращает true для ACTIVE', () => {
      expect(isActive(MarketState.active())).toBe(true);
      expect(isActive(MarketState.closed())).toBe(false);
      expect(isActive(MarketState.resolved(0))).toBe(false);
    });

    it('isClosed() возвращает true для CLOSED', () => {
      expect(isClosed(MarketState.closed())).toBe(true);
      expect(isClosed(MarketState.active())).toBe(false);
      expect(isClosed(MarketState.resolved(0))).toBe(false);
    });

    it('isResolved() возвращает true для RESOLVED', () => {
      expect(isResolved(MarketState.resolved(0))).toBe(true);
      expect(isResolved(MarketState.resolved(1))).toBe(true);
      expect(isResolved(MarketState.active())).toBe(false);
      expect(isResolved(MarketState.closed())).toBe(false);
    });
  });

  describe('canTransition()', () => {
    it('ACTIVE → CLOSED: допустим', () => {
      expect(canTransition(MarketState.active(), 'CLOSED')).toBe(true);
    });

    it('CLOSED → RESOLVED: допустим', () => {
      expect(canTransition(MarketState.closed(), 'RESOLVED')).toBe(true);
    });

    it('ACTIVE → RESOLVED: запрещён (нельзя пропускать CLOSED)', () => {
      expect(canTransition(MarketState.active(), 'RESOLVED')).toBe(false);
    });

    it('CLOSED → CLOSED: запрещён', () => {
      expect(canTransition(MarketState.closed(), 'CLOSED')).toBe(false);
    });

    it('RESOLVED → CLOSED: запрещён (терминальное состояние)', () => {
      expect(canTransition(MarketState.resolved(0), 'CLOSED')).toBe(false);
    });

    it('RESOLVED → RESOLVED: запрещён (терминальное состояние)', () => {
      expect(canTransition(MarketState.resolved(0), 'RESOLVED')).toBe(false);
    });
  });
});
