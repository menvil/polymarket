/**
 * Тесты для OrderStatus с discriminated union
 */

import { describe, it, expect } from '@jest/globals';
import {
  OrderStatusConstructors,
  CancelReason,
  RejectReason,
  ExpireReason,
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

describe('OrderStatus - Discriminated Union', () => {
  describe('Constructors', () => {
    it('should create PENDING status', () => {
      const status = OrderStatusConstructors.pending();
      expect(status.type).toBe('PENDING');
      expect('reason' in status).toBe(false);
    });

    it('should create OPEN status', () => {
      const status = OrderStatusConstructors.open();
      expect(status.type).toBe('OPEN');
      expect('reason' in status).toBe(false);
    });

    it('should create PARTIALLY_FILLED status', () => {
      const status = OrderStatusConstructors.partiallyFilled();
      expect(status.type).toBe('PARTIALLY_FILLED');
      expect('reason' in status).toBe(false);
    });

    it('should create FILLED status', () => {
      const status = OrderStatusConstructors.filled();
      expect(status.type).toBe('FILLED');
      expect('reason' in status).toBe(false);
    });

    it('should create CANCELED status with reason', () => {
      const status = OrderStatusConstructors.canceled(CancelReason.USER_REQUESTED);
      expect(status.type).toBe('CANCELED');
      expect(status.reason).toBe(CancelReason.USER_REQUESTED);
    });

    it('should create REJECTED status with reason', () => {
      const status = OrderStatusConstructors.rejected(RejectReason.INVALID_PRICE);
      expect(status.type).toBe('REJECTED');
      expect(status.reason).toBe(RejectReason.INVALID_PRICE);
    });

    it('should create EXPIRED status without reason', () => {
      const status = OrderStatusConstructors.expired();
      expect(status.type).toBe('EXPIRED');
      expect(status.reason).toBeUndefined();
    });

    it('should create EXPIRED status with reason', () => {
      const status = OrderStatusConstructors.expired(ExpireReason.TIME_IN_FORCE);
      expect(status.type).toBe('EXPIRED');
      expect(status.reason).toBe(ExpireReason.TIME_IN_FORCE);
    });
  });

  describe('Type Guards', () => {
    it('should identify PENDING status', () => {
      const status = OrderStatusConstructors.pending();
      expect(isPending(status)).toBe(true);
      expect(isOpen(status)).toBe(false);
      expect(isFilled(status)).toBe(false);
    });

    it('should identify OPEN status', () => {
      const status = OrderStatusConstructors.open();
      expect(isOpen(status)).toBe(true);
      expect(isPending(status)).toBe(false);
    });

    it('should identify PARTIALLY_FILLED status', () => {
      const status = OrderStatusConstructors.partiallyFilled();
      expect(isPartiallyFilled(status)).toBe(true);
      expect(isOpen(status)).toBe(false);
    });

    it('should identify FILLED status', () => {
      const status = OrderStatusConstructors.filled();
      expect(isFilled(status)).toBe(true);
      expect(isOpen(status)).toBe(false);
    });

    it('should identify CANCELED status and provide reason', () => {
      const status = OrderStatusConstructors.canceled(CancelReason.USER_REQUESTED);
      expect(isCanceled(status)).toBe(true);
      expect(isOpen(status)).toBe(false);

      // Type narrowing - TypeScript knows status.reason exists
      if (isCanceled(status)) {
        expect(status.reason).toBe(CancelReason.USER_REQUESTED);
      }
    });

    it('should identify REJECTED status and provide reason', () => {
      const status = OrderStatusConstructors.rejected(RejectReason.MARKET_CLOSED);
      expect(isRejected(status)).toBe(true);
      expect(isFilled(status)).toBe(false);

      // Type narrowing
      if (isRejected(status)) {
        expect(status.reason).toBe(RejectReason.MARKET_CLOSED);
      }
    });

    it('should identify EXPIRED status and provide optional reason', () => {
      const statusWithReason = OrderStatusConstructors.expired(ExpireReason.TIME_IN_FORCE);
      const statusWithoutReason = OrderStatusConstructors.expired();

      expect(isExpired(statusWithReason)).toBe(true);
      expect(isExpired(statusWithoutReason)).toBe(true);

      // Type narrowing
      if (isExpired(statusWithReason)) {
        expect(statusWithReason.reason).toBe(ExpireReason.TIME_IN_FORCE);
      }
      if (isExpired(statusWithoutReason)) {
        expect(statusWithoutReason.reason).toBeUndefined();
      }
    });
  });

  describe('Terminal Status', () => {
    it('should identify terminal statuses', () => {
      expect(isTerminal(OrderStatusConstructors.filled())).toBe(true);
      expect(isTerminal(OrderStatusConstructors.canceled(CancelReason.USER_REQUESTED))).toBe(true);
      expect(isTerminal(OrderStatusConstructors.rejected(RejectReason.INVALID_PRICE))).toBe(true);
      expect(isTerminal(OrderStatusConstructors.expired())).toBe(true);
    });

    it('should identify non-terminal statuses', () => {
      expect(isTerminal(OrderStatusConstructors.pending())).toBe(false);
      expect(isTerminal(OrderStatusConstructors.open())).toBe(false);
      expect(isTerminal(OrderStatusConstructors.partiallyFilled())).toBe(false);
    });
  });

  describe('Active Status', () => {
    it('should identify active statuses', () => {
      expect(isActive(OrderStatusConstructors.pending())).toBe(true);
      expect(isActive(OrderStatusConstructors.open())).toBe(true);
      expect(isActive(OrderStatusConstructors.partiallyFilled())).toBe(true);
    });

    it('should identify non-active statuses', () => {
      expect(isActive(OrderStatusConstructors.filled())).toBe(false);
      expect(isActive(OrderStatusConstructors.canceled(CancelReason.USER_REQUESTED))).toBe(false);
      expect(isActive(OrderStatusConstructors.rejected(RejectReason.INVALID_PRICE))).toBe(false);
      expect(isActive(OrderStatusConstructors.expired())).toBe(false);
    });
  });

  describe('Can Cancel', () => {
    it('should allow canceling OPEN orders', () => {
      expect(canCancel(OrderStatusConstructors.open())).toBe(true);
    });

    it('should allow canceling PARTIALLY_FILLED orders', () => {
      expect(canCancel(OrderStatusConstructors.partiallyFilled())).toBe(true);
    });

    it('should not allow canceling PENDING orders', () => {
      expect(canCancel(OrderStatusConstructors.pending())).toBe(false);
    });

    it('should not allow canceling terminal statuses', () => {
      expect(canCancel(OrderStatusConstructors.filled())).toBe(false);
      expect(canCancel(OrderStatusConstructors.canceled(CancelReason.USER_REQUESTED))).toBe(false);
      expect(canCancel(OrderStatusConstructors.rejected(RejectReason.INVALID_PRICE))).toBe(false);
      expect(canCancel(OrderStatusConstructors.expired())).toBe(false);
    });
  });

  describe('Transitions', () => {
    it('should allow valid transitions from PENDING', () => {
      const status = OrderStatusConstructors.pending();
      expect(canTransition(status, 'OPEN')).toBe(true);
      expect(canTransition(status, 'REJECTED')).toBe(true);
      expect(canTransition(status, 'FILLED')).toBe(false);
      expect(canTransition(status, 'CANCELED')).toBe(false);
    });

    it('should allow valid transitions from OPEN', () => {
      const status = OrderStatusConstructors.open();
      expect(canTransition(status, 'PARTIALLY_FILLED')).toBe(true);
      expect(canTransition(status, 'FILLED')).toBe(true);
      expect(canTransition(status, 'CANCELED')).toBe(true);
      expect(canTransition(status, 'EXPIRED')).toBe(true);
      expect(canTransition(status, 'REJECTED')).toBe(false);
    });

    it('should allow valid transitions from PARTIALLY_FILLED', () => {
      const status = OrderStatusConstructors.partiallyFilled();
      expect(canTransition(status, 'FILLED')).toBe(true);
      expect(canTransition(status, 'CANCELED')).toBe(true);
      expect(canTransition(status, 'EXPIRED')).toBe(true);
      expect(canTransition(status, 'OPEN')).toBe(false);
      expect(canTransition(status, 'REJECTED')).toBe(false);
    });

    it('should not allow transitions from terminal statuses', () => {
      expect(canTransition(OrderStatusConstructors.filled(), 'OPEN')).toBe(false);
      expect(canTransition(OrderStatusConstructors.canceled(CancelReason.USER_REQUESTED), 'OPEN')).toBe(false);
      expect(canTransition(OrderStatusConstructors.rejected(RejectReason.INVALID_PRICE), 'OPEN')).toBe(false);
      expect(canTransition(OrderStatusConstructors.expired(), 'OPEN')).toBe(false);
    });
  });

  describe('Status to String', () => {
    it('should format simple statuses', () => {
      expect(statusToString(OrderStatusConstructors.pending())).toBe('PENDING');
      expect(statusToString(OrderStatusConstructors.open())).toBe('OPEN');
      expect(statusToString(OrderStatusConstructors.partiallyFilled())).toBe('PARTIALLY_FILLED');
      expect(statusToString(OrderStatusConstructors.filled())).toBe('FILLED');
    });

    it('should format CANCELED with reason', () => {
      const status = OrderStatusConstructors.canceled(CancelReason.USER_REQUESTED);
      expect(statusToString(status)).toBe('CANCELED (USER_REQUESTED)');
    });

    it('should format REJECTED with reason', () => {
      const status = OrderStatusConstructors.rejected(RejectReason.MARKET_CLOSED);
      expect(statusToString(status)).toBe('REJECTED (MARKET_CLOSED)');
    });

    it('should format EXPIRED without reason', () => {
      const status = OrderStatusConstructors.expired();
      expect(statusToString(status)).toBe('EXPIRED');
    });

    it('should format EXPIRED with reason', () => {
      const status = OrderStatusConstructors.expired(ExpireReason.TIME_IN_FORCE);
      expect(statusToString(status)).toBe('EXPIRED (TIME_IN_FORCE)');
    });
  });

  describe('Type Safety', () => {
    it('should prevent accessing reason on statuses without it (compile-time)', () => {
      const open = OrderStatusConstructors.open();

      // This should compile - checking type
      expect(open.type).toBe('OPEN');

      // @ts-expect-error - reason doesn't exist on OPEN status
      const _ = open.reason;

      // Suppress unused variable warning
      expect(_).toBeUndefined();
    });

    it('should allow accessing reason after type guard', () => {
      const status = OrderStatusConstructors.canceled(CancelReason.USER_REQUESTED);

      // Before type guard - can't access reason without narrowing
      // status.reason; // Would be type error in strict mode

      // After type guard - TypeScript knows reason exists
      if (isCanceled(status)) {
        expect(status.reason).toBe(CancelReason.USER_REQUESTED);
        expect(typeof status.reason).toBe('string');
      }
    });
  });
});
