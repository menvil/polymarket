/**
 * Тесты для Order entity
 */

import { Price, Quantity } from '@polymarket/value-objects';
import { Order } from '../../src/Order';
import { OrderFill } from '../../src/value-objects/OrderFill';
import type { Trade } from '../../Trade';

// Helper для создания валидного Order
function createValidOrder(overrides?: Partial<Parameters<typeof Order.create>[0]>) {
  const defaults = {
    id: 'order-123',
    marketId: 'market-1',
    tokenId: 'token-yes',
    side: 'BUY' as const,
    price: Price.fromValue(0.65).value!,
    size: Quantity.fromValue(100).value!,
    status: 'PENDING' as const,
    timestamp: new Date('2024-01-01T00:00:00Z'),
  };

  return Order.create({ ...defaults, ...overrides });
}

// Helper для создания Trade object
function createTrade(overrides?: Partial<Trade>): Trade {
  const defaults: Trade = {
    id: 'trade-1',
    marketId: 'market-1',
    tokenId: 'token-yes',
    side: 'BUY' as const,
    orderId: 'order-123',
    size: Quantity.fromValue(30).value!,
    price: Price.fromValue(0.65).value!,
    timestamp: new Date(),
  };

  return { ...defaults, ...overrides };
}

describe('Order', () => {
  describe('create()', () => {
    it('should create valid order with all required fields', () => {
      const result = createValidOrder();

      expect(result.ok).toBe(true);
      if (result.ok) {
        const order = result.value;
        expect(order.id).toBe('order-123');
        expect(order.marketId).toBe('market-1');
        expect(order.tokenId).toBe('token-yes');
        expect(order.side).toBe('BUY');
        expect(order.price.value).toBe(0.65);
        expect(order.size.value).toBe(100);
        expect(order.status).toBe('PENDING');
        expect(order.fill.isEmpty()).toBe(true);
      }
    });

    it('should fail with empty id', () => {
      const result = createValidOrder({ id: '' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Order ID must be a non-empty string');
      }
    });

    it('should fail with empty marketId', () => {
      const result = createValidOrder({ marketId: '' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Market ID must be a non-empty string');
      }
    });

    it('should fail with empty tokenId', () => {
      const result = createValidOrder({ tokenId: '' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Token ID must be a non-empty string');
      }
    });

    it('should fail with negative size', () => {
      const result = createValidOrder({
        size: Quantity.fromValue(-10).value,
      });

      expect(result.ok).toBe(false);
    });

    it('should fail with invalid timestamp', () => {
      const result = createValidOrder({
        timestamp: new Date('invalid'),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('Invalid timestamp');
      }
    });

    it('should create order with optional strategyId', () => {
      const result = createValidOrder({ strategyId: 'strategy-1' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.strategyId).toBe('strategy-1');
      }
    });

    it('should create order with fill', () => {
      const fill = OrderFill.create(
        Quantity.fromValue(30).value!,
        Price.fromValue(0.65).value!,
        ['trade-1'],
        Quantity.fromValue(100).value!
      ).value!;

      const result = createValidOrder({ fill, status: 'PARTIALLY_FILLED' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.fill.getFilledSize().value).toBe(30);
      }
    });
  });

  describe('status predicates', () => {
    it('isPending() should return true for PENDING status', () => {
      const order = createValidOrder({ status: 'PENDING' }).value!;
      expect(order.isPending()).toBe(true);
      expect(order.isOpen()).toBe(false);
      expect(order.isFilled()).toBe(false);
    });

    it('isOpen() should return true for OPEN status', () => {
      const order = createValidOrder({ status: 'OPEN' }).value!;
      expect(order.isOpen()).toBe(true);
      expect(order.isPending()).toBe(false);
    });

    it('isFilled() should return true for FILLED status', () => {
      const order = createValidOrder({ status: 'FILLED' }).value!;
      expect(order.isFilled()).toBe(true);
      expect(order.isOpen()).toBe(false);
    });

    it('isPartiallyFilled() should detect partial fill', () => {
      const fill = OrderFill.create(
        Quantity.fromValue(30).value!,
        Price.fromValue(0.65).value!,
        ['trade-1'],
        Quantity.fromValue(100).value!
      ).value!;

      const order = createValidOrder({ fill, status: 'PARTIALLY_FILLED' }).value!;
      expect(order.isPartiallyFilled()).toBe(true);
    });

    it('canCancel() should return true for OPEN and PARTIALLY_FILLED', () => {
      const openOrder = createValidOrder({ status: 'OPEN' }).value!;
      const partialOrder = createValidOrder({ status: 'PARTIALLY_FILLED' }).value!;
      const filledOrder = createValidOrder({ status: 'FILLED' }).value!;

      expect(openOrder.canCancel()).toBe(true);
      expect(partialOrder.canCancel()).toBe(true);
      expect(filledOrder.canCancel()).toBe(false);
    });

    it('canModify() should return true for non-terminal statuses', () => {
      const openOrder = createValidOrder({ status: 'OPEN' }).value!;
      const filledOrder = createValidOrder({ status: 'FILLED' }).value!;
      const canceledOrder = createValidOrder({ status: 'CANCELED' }).value!;

      expect(openOrder.canModify()).toBe(true);
      expect(filledOrder.canModify()).toBe(false);
      expect(canceledOrder.canModify()).toBe(false);
    });
  });

  describe('calculations', () => {
    it('getNotional() should calculate price * size', () => {
      const order = createValidOrder({
        price: Price.fromValue(0.65).value!,
        size: Quantity.fromValue(100).value!,
      }).value!;

      const notional = order.getNotional();
      expect(notional.toNumber()).toBe(65);
    });

    it('getRemainingSize() should return unfilled amount', () => {
      const fill = OrderFill.create(
        Quantity.fromValue(30).value!,
        Price.fromValue(0.65).value!,
        ['trade-1'],
        Quantity.fromValue(100).value!
      ).value!;

      const order = createValidOrder({ fill, status: 'PARTIALLY_FILLED' }).value!;

      const remaining = order.getRemainingSize();
      expect(remaining.value).toBe(70);
    });

    it('getFillPercentage() should calculate percentage', () => {
      const fill = OrderFill.create(
        Quantity.fromValue(30).value!,
        Price.fromValue(0.65).value!,
        ['trade-1'],
        Quantity.fromValue(100).value!
      ).value!;

      const order = createValidOrder({ fill, status: 'PARTIALLY_FILLED' }).value!;

      const percentage = order.getFillPercentage();
      expect(percentage.toNumber()).toBe(30);
    });

    it('getTradeCount() should return number of trades', () => {
      const fill = OrderFill.create(
        Quantity.fromValue(30).value!,
        Price.fromValue(0.65).value!,
        ['trade-1', 'trade-2'],
        Quantity.fromValue(100).value!
      ).value!;

      const order = createValidOrder({ fill }).value!;
      expect(order.getTradeCount()).toBe(2);
    });

    it('hasTrade() should check for trade existence', () => {
      const fill = OrderFill.create(
        Quantity.fromValue(30).value!,
        Price.fromValue(0.65).value!,
        ['trade-1'],
        Quantity.fromValue(100).value!
      ).value!;

      const order = createValidOrder({ fill }).value!;
      expect(order.hasTrade('trade-1')).toBe(true);
      expect(order.hasTrade('trade-2')).toBe(false);
    });
  });

  describe('FSM transitions', () => {
    describe('accept()', () => {
      it('should transition PENDING → OPEN', () => {
        const order = createValidOrder({ status: 'PENDING' }).value!;
        const result = order.accept();

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.status).toBe('OPEN');
          expect(result.value.id).toBe(order.id); // Same ID
        }
      });

      it('should fail for non-PENDING status', () => {
        const order = createValidOrder({ status: 'OPEN' }).value!;
        const result = order.accept();

        expect(result.ok).toBe(false);
      });
    });

    describe('reject()', () => {
      it('should transition PENDING → REJECTED with reason', () => {
        const order = createValidOrder({ status: 'PENDING' }).value!;
        const result = order.reject('Insufficient funds');

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.status).toBe('REJECTED');
          expect(result.value.reason).toBe('Insufficient funds');
        }
      });

      it('should fail without reason', () => {
        const order = createValidOrder({ status: 'PENDING' }).value!;
        const result = order.reject('');

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.message).toContain('Reject reason must be a non-empty string');
        }
      });

      it('should fail for non-PENDING status', () => {
        const order = createValidOrder({ status: 'OPEN' }).value!;
        const result = order.reject('Some reason');

        expect(result.ok).toBe(false);
      });
    });

    describe('cancel()', () => {
      it('should transition OPEN → CANCELED', () => {
        const order = createValidOrder({ status: 'OPEN' }).value!;
        const result = order.cancel('User request');

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.status).toBe('CANCELED');
          expect(result.value.reason).toBe('User request');
        }
      });

      it('should use default reason if not provided', () => {
        const order = createValidOrder({ status: 'OPEN' }).value!;
        const result = order.cancel();

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.reason).toBe('User cancelled');
        }
      });

      it('should fail for terminal status', () => {
        const order = createValidOrder({ status: 'FILLED' }).value!;
        const result = order.cancel();

        expect(result.ok).toBe(false);
      });
    });

    describe('expire()', () => {
      it('should transition OPEN → EXPIRED', () => {
        const order = createValidOrder({ status: 'OPEN' }).value!;
        const result = order.expire();

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.status).toBe('EXPIRED');
        }
      });

      it('should fail for terminal status', () => {
        const order = createValidOrder({ status: 'FILLED' }).value!;
        const result = order.expire();

        expect(result.ok).toBe(false);
      });
    });

    describe('applyTrade()', () => {
      it('should transition OPEN → PARTIALLY_FILLED for partial fill', () => {
        const order = createValidOrder({ status: 'OPEN' }).value!;
        const trade = createTrade({ size: Quantity.fromValue(30).value! });

        const result = order.applyTrade(trade);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.status).toBe('PARTIALLY_FILLED');
          expect(result.value.fill.getFilledSize().value).toBe(30);
          expect(result.value.getRemainingSize().value).toBe(70);
        }
      });

      it('should transition OPEN → FILLED for complete fill', () => {
        const order = createValidOrder({ status: 'OPEN' }).value!;
        const trade = createTrade({ size: Quantity.fromValue(100).value! });

        const result = order.applyTrade(trade);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.status).toBe('FILLED');
          expect(result.value.fill.getFilledSize().value).toBe(100);
          expect(result.value.getRemainingSize().value).toBe(0);
        }
      });

      it('should accumulate multiple trades', () => {
        let order = createValidOrder({ status: 'OPEN' }).value!;

        // Trade 1: 30 units
        const trade1 = createTrade({ id: 'trade-1', size: Quantity.fromValue(30).value! });
        const result1 = order.applyTrade(trade1);
        expect(result1.ok).toBe(true);
        order = result1.value!;
        expect(order.status).toBe('PARTIALLY_FILLED');
        expect(order.fill.getFilledSize().value).toBe(30);

        // Trade 2: 20 units
        const trade2 = createTrade({ id: 'trade-2', size: Quantity.fromValue(20).value! });
        const result2 = order.applyTrade(trade2);
        expect(result2.ok).toBe(true);
        order = result2.value!;
        expect(order.status).toBe('PARTIALLY_FILLED');
        expect(order.fill.getFilledSize().value).toBe(50);

        // Trade 3: 50 units (completes)
        const trade3 = createTrade({ id: 'trade-3', size: Quantity.fromValue(50).value! });
        const result3 = order.applyTrade(trade3);
        expect(result3.ok).toBe(true);
        order = result3.value!;
        expect(order.status).toBe('FILLED');
        expect(order.fill.getFilledSize().value).toBe(100);
      });

      it('should fail for duplicate trade ID', () => {
        let order = createValidOrder({ status: 'OPEN' }).value!;

        const trade1 = createTrade({ id: 'trade-1', size: Quantity.fromValue(30).value! });
        const result1 = order.applyTrade(trade1);
        expect(result1.ok).toBe(true);
        order = result1.value!;

        // Try same trade ID again
        const trade2 = createTrade({ id: 'trade-1', size: Quantity.fromValue(20).value! });
        const result2 = order.applyTrade(trade2);
        expect(result2.ok).toBe(false);
      });

      it('should fail if trade exceeds remaining size', () => {
        const order = createValidOrder({ status: 'OPEN' }).value!;
        const trade = createTrade({ size: Quantity.fromValue(150).value! }); // Exceeds order size 100

        const result = order.applyTrade(trade);
        expect(result.ok).toBe(false);
      });

      it('should fail for terminal status', () => {
        const order = createValidOrder({ status: 'FILLED' }).value!;
        const trade = createTrade();

        const result = order.applyTrade(trade);
        expect(result.ok).toBe(false);
      });
    });

    describe('canAcceptTrade()', () => {
      it('should validate trade without applying it', () => {
        const order = createValidOrder({ status: 'OPEN' }).value!;
        const validTrade = createTrade({ size: Quantity.fromValue(30).value! });
        const invalidTrade = createTrade({ size: Quantity.fromValue(150).value! });

        expect(order.canAcceptTrade(validTrade)).toBe(true);
        expect(order.canAcceptTrade(invalidTrade)).toBe(false);
      });

      it('should reject trade with mismatched marketId', () => {
        const order = createValidOrder({ status: 'OPEN' }).value!;
        const trade = createTrade({ marketId: 'wrong-market' });

        expect(order.canAcceptTrade(trade)).toBe(false);
      });

      it('should reject trade with mismatched side', () => {
        const order = createValidOrder({ status: 'OPEN', side: 'BUY' }).value!;
        const trade = createTrade({ side: 'SELL' });

        expect(order.canAcceptTrade(trade)).toBe(false);
      });
    });
  });

  describe('immutability', () => {
    it('should return new instance on state changes', () => {
      const original = createValidOrder({ status: 'PENDING' }).value!;
      const result = original.accept();

      expect(result.ok).toBe(true);
      const accepted = result.value!;

      // Original should be unchanged
      expect(original.status).toBe('PENDING');

      // New instance should have new status
      expect(accepted.status).toBe('OPEN');

      // But same ID
      expect(accepted.id).toBe(original.id);
    });
  });

  describe('serialization', () => {
    it('toJSON() should serialize order', () => {
      const order = createValidOrder({
        id: 'order-123',
        status: 'OPEN',
      }).value!;

      const json = order.toJSON();

      expect(json.id).toBe('order-123');
      expect(json.status).toBe('OPEN');
      expect(json.price).toBe(0.65);
      expect(json.size).toBe(100);
      expect(json.notional).toBe(65);
      expect(json.remainingSize).toBe(100);
      expect(json.fillPercentage).toBe(0);
    });

    it('toString() should provide readable representation', () => {
      const order = createValidOrder({
        id: 'order-123',
        side: 'BUY',
        size: Quantity.fromValue(100).value!,
        price: Price.fromValue(0.65).value!,
        status: 'OPEN',
      }).value!;

      const str = order.toString();

      expect(str).toContain('order-123');
      expect(str).toContain('BUY');
      expect(str).toContain('100');
      expect(str).toContain('0.65');
      expect(str).toContain('OPEN');
    });
  });
});
