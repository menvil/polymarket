/**
 * Тесты для OrderStatus (simple string union)
 */

import { describe, it, expect } from '@jest/globals';
import {
  OrderStatusConstructors,
  isPending,
  isOpen,
  isPartiallyFilled,
  isFilled,
  isCanceled,
  isRejected,
  isExpired,
  isTerminal,
  isActive,
  canCancel,
  canTransition,
  statusToString,
} from '../../../src/value-objects/index.js';

describe('OrderStatus - String Union', () => {
  describe('Constructors', () => {
    it('should create PENDING status', () => {
      expect(OrderStatusConstructors.pending()).toBe('PENDING');
    });

    it('should create OPEN status', () => {
      expect(OrderStatusConstructors.open()).toBe('OPEN');
    });

    it('should create PARTIALLY_FILLED status', () => {
      expect(OrderStatusConstructors.partiallyFilled()).toBe('PARTIALLY_FILLED');
    });

    it('should create FILLED status', () => {
      expect(OrderStatusConstructors.filled()).toBe('FILLED');
    });

    it('should create CANCELED status', () => {
      expect(OrderStatusConstructors.canceled()).toBe('CANCELED');
    });

    it('should create REJECTED status', () => {
      expect(OrderStatusConstructors.rejected()).toBe('REJECTED');
    });

    it('should create EXPIRED status', () => {
      expect(OrderStatusConstructors.expired()).toBe('EXPIRED');
    });
  });

  describe('Type Guards', () => {
    it('should identify PENDING status', () => {
      expect(isPending('PENDING')).toBe(true);
      expect(isPending('OPEN')).toBe(false);
      expect(isPending('FILLED')).toBe(false);
    });

    it('should identify OPEN status', () => {
      expect(isOpen('OPEN')).toBe(true);
      expect(isOpen('PENDING')).toBe(false);
    });

    it('should identify PARTIALLY_FILLED status', () => {
      expect(isPartiallyFilled('PARTIALLY_FILLED')).toBe(true);
      expect(isPartiallyFilled('OPEN')).toBe(false);
    });

    it('should identify FILLED status', () => {
      expect(isFilled('FILLED')).toBe(true);
      expect(isFilled('OPEN')).toBe(false);
    });

    it('should identify CANCELED status', () => {
      expect(isCanceled('CANCELED')).toBe(true);
      expect(isCanceled('OPEN')).toBe(false);
    });

    it('should identify REJECTED status', () => {
      expect(isRejected('REJECTED')).toBe(true);
      expect(isRejected('FILLED')).toBe(false);
    });

    it('should identify EXPIRED status', () => {
      expect(isExpired('EXPIRED')).toBe(true);
      expect(isExpired('OPEN')).toBe(false);
    });
  });

  describe('Terminal Status', () => {
    it('should identify terminal statuses', () => {
      expect(isTerminal('FILLED')).toBe(true);
      expect(isTerminal('CANCELED')).toBe(true);
      expect(isTerminal('REJECTED')).toBe(true);
      expect(isTerminal('EXPIRED')).toBe(true);
    });

    it('should identify non-terminal statuses', () => {
      expect(isTerminal('PENDING')).toBe(false);
      expect(isTerminal('OPEN')).toBe(false);
      expect(isTerminal('PARTIALLY_FILLED')).toBe(false);
    });
  });

  describe('Active Status', () => {
    it('should identify active statuses', () => {
      expect(isActive('PENDING')).toBe(true);
      expect(isActive('OPEN')).toBe(true);
      expect(isActive('PARTIALLY_FILLED')).toBe(true);
    });

    it('should identify non-active statuses', () => {
      expect(isActive('FILLED')).toBe(false);
      expect(isActive('CANCELED')).toBe(false);
      expect(isActive('REJECTED')).toBe(false);
      expect(isActive('EXPIRED')).toBe(false);
    });
  });

  describe('Can Cancel', () => {
    it('should allow canceling OPEN orders', () => {
      expect(canCancel('OPEN')).toBe(true);
    });

    it('should allow canceling PARTIALLY_FILLED orders', () => {
      expect(canCancel('PARTIALLY_FILLED')).toBe(true);
    });

    it('should not allow canceling PENDING orders', () => {
      expect(canCancel('PENDING')).toBe(false);
    });

    it('should not allow canceling terminal statuses', () => {
      expect(canCancel('FILLED')).toBe(false);
      expect(canCancel('CANCELED')).toBe(false);
      expect(canCancel('REJECTED')).toBe(false);
      expect(canCancel('EXPIRED')).toBe(false);
    });
  });

  describe('Transitions', () => {
    it('should allow valid transitions from PENDING', () => {
      expect(canTransition('PENDING', 'OPEN')).toBe(true);
      expect(canTransition('PENDING', 'REJECTED')).toBe(true);
      expect(canTransition('PENDING', 'FILLED')).toBe(false);
      expect(canTransition('PENDING', 'CANCELED')).toBe(false);
    });

    it('should allow valid transitions from OPEN', () => {
      expect(canTransition('OPEN', 'PARTIALLY_FILLED')).toBe(true);
      expect(canTransition('OPEN', 'FILLED')).toBe(true);
      expect(canTransition('OPEN', 'CANCELED')).toBe(true);
      expect(canTransition('OPEN', 'EXPIRED')).toBe(true);
      expect(canTransition('OPEN', 'REJECTED')).toBe(false);
    });

    it('should allow valid transitions from PARTIALLY_FILLED', () => {
      expect(canTransition('PARTIALLY_FILLED', 'FILLED')).toBe(true);
      expect(canTransition('PARTIALLY_FILLED', 'CANCELED')).toBe(true);
      expect(canTransition('PARTIALLY_FILLED', 'EXPIRED')).toBe(true);
      expect(canTransition('PARTIALLY_FILLED', 'OPEN')).toBe(false);
      expect(canTransition('PARTIALLY_FILLED', 'REJECTED')).toBe(false);
    });

    it('should not allow transitions from terminal statuses', () => {
      expect(canTransition('FILLED', 'OPEN')).toBe(false);
      expect(canTransition('CANCELED', 'OPEN')).toBe(false);
      expect(canTransition('REJECTED', 'OPEN')).toBe(false);
      expect(canTransition('EXPIRED', 'OPEN')).toBe(false);
    });
  });

  describe('Status to String', () => {
    it('should return string representation', () => {
      expect(statusToString('PENDING')).toBe('PENDING');
      expect(statusToString('OPEN')).toBe('OPEN');
      expect(statusToString('PARTIALLY_FILLED')).toBe('PARTIALLY_FILLED');
      expect(statusToString('FILLED')).toBe('FILLED');
      expect(statusToString('CANCELED')).toBe('CANCELED');
      expect(statusToString('REJECTED')).toBe('REJECTED');
      expect(statusToString('EXPIRED')).toBe('EXPIRED');
    });
  });
});
