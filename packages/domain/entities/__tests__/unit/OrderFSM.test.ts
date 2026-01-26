/**
 * Order FSM (Finite State Machine) tests
 *
 * @remarks
 * Тестирует state transitions: accept(), reject(), cancel(), expire(), applyTrade()
 */

import { describe, it, expect } from '@jest/globals';
import { Order } from '../../src/Order.js';
import { Trade } from '../../src/Trade.js';
import { Price, Quantity } from '@polymarket/value-objects';
import { OrderValidationError } from '@polymarket/errors';

describe('Order FSM Transitions', () => {
  // Helpers
  const createPrice = (value: number): Price => {
    const result = Price.fromValue(value);
    if (!result.ok) throw new Error(`Failed to create Price: ${result.error.message}`);
    return result.value;
  };

  const createQuantity = (value: number): Quantity => {
    const result = Quantity.fromValue(value);
    if (!result.ok) throw new Error(`Failed to create Quantity: ${result.error.message}`);
    return result.value;
  };

  describe('accept() - PENDING → OPEN', () => {
    it('should accept PENDING order', () => {
      const pendingResult = Order.create({
        id: 'order-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        side: 'BUY',
        price: createPrice(0.65),
        size: createQuantity(100),
        status: 'PENDING',
        timestamp: new Date()
      });

      expect(pendingResult.ok).toBe(true);
      if (!pendingResult.ok) return;

      const acceptResult = pendingResult.value.accept();

      expect(acceptResult.ok).toBe(true);
      if (acceptResult.ok) {
        expect(acceptResult.value.status).toBe('OPEN');
        expect(acceptResult.value.id).toBe('order-1');
        expect(acceptResult.value.price.value).toBe(0.65);
      }
    });

    it('should fail to accept non-PENDING order', () => {
      const openResult = Order.create({
        id: 'order-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        side: 'BUY',
        price: createPrice(0.65),
        size: createQuantity(100),
        status: 'OPEN',
        timestamp: new Date()
      });

      expect(openResult.ok).toBe(true);
      if (!openResult.ok) return;

      const acceptResult = openResult.value.accept();

      expect(acceptResult.ok).toBe(false);
      if (!acceptResult.ok) {
        expect(acceptResult.error).toBeInstanceOf(OrderValidationError);
        expect(acceptResult.error.message).toContain('Cannot accept order with status OPEN');
      }
    });
  });

  describe('reject() - PENDING → REJECTED', () => {
    it('should reject PENDING order with reason', () => {
      const pendingResult = Order.create({
        id: 'order-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        side: 'BUY',
        price: createPrice(0.65),
        size: createQuantity(100),
        status: 'PENDING',
        timestamp: new Date()
      });

      expect(pendingResult.ok).toBe(true);
      if (!pendingResult.ok) return;

      const rejectResult = pendingResult.value.reject('Insufficient balance');

      expect(rejectResult.ok).toBe(true);
      if (rejectResult.ok) {
        expect(rejectResult.value.status).toBe('REJECTED');
        expect(rejectResult.value.reason).toBe('Insufficient balance');
      }
    });

    it('should fail to reject with empty reason', () => {
      const pendingResult = Order.create({
        id: 'order-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        side: 'BUY',
        price: createPrice(0.65),
        size: createQuantity(100),
        status: 'PENDING',
        timestamp: new Date()
      });

      expect(pendingResult.ok).toBe(true);
      if (!pendingResult.ok) return;

      const rejectResult = pendingResult.value.reject('');

      expect(rejectResult.ok).toBe(false);
      if (!rejectResult.ok) {
        expect(rejectResult.error.message).toContain('Reject reason must be a non-empty string');
      }
    });

    it('should fail to reject non-PENDING order', () => {
      const openResult = Order.create({
        id: 'order-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        side: 'BUY',
        price: createPrice(0.65),
        size: createQuantity(100),
        status: 'OPEN',
        timestamp: new Date()
      });

      expect(openResult.ok).toBe(true);
      if (!openResult.ok) return;

      const rejectResult = openResult.value.reject('Some reason');

      expect(rejectResult.ok).toBe(false);
      if (!rejectResult.ok) {
        expect(rejectResult.error.message).toContain('Cannot reject order with status OPEN');
      }
    });
  });

  describe('cancel() - OPEN/PARTIALLY_FILLED → CANCELED', () => {
    it('should cancel OPEN order', () => {
      const openResult = Order.create({
        id: 'order-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        side: 'BUY',
        price: createPrice(0.65),
        size: createQuantity(100),
        status: 'OPEN',
        timestamp: new Date()
      });

      expect(openResult.ok).toBe(true);
      if (!openResult.ok) return;

      const cancelResult = openResult.value.cancel('User cancelled');

      expect(cancelResult.ok).toBe(true);
      if (cancelResult.ok) {
        expect(cancelResult.value.status).toBe('CANCELED');
        expect(cancelResult.value.reason).toBe('User cancelled');
      }
    });

    it('should cancel PARTIALLY_FILLED order', () => {
      const partialResult = Order.create({
        id: 'order-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        side: 'BUY',
        price: createPrice(0.65),
        size: createQuantity(100),
        status: 'PARTIALLY_FILLED',
        filledSize: createQuantity(30),
        averageFillPrice: createPrice(0.65),
        timestamp: new Date()
      });

      expect(partialResult.ok).toBe(true);
      if (!partialResult.ok) return;

      const cancelResult = partialResult.value.cancel();

      expect(cancelResult.ok).toBe(true);
      if (cancelResult.ok) {
        expect(cancelResult.value.status).toBe('CANCELED');
        expect(cancelResult.value.reason).toBe('User cancelled');
        expect(cancelResult.value.filledSize?.value).toBe(30); // Сохраняется
      }
    });

    it('should use default reason if not provided', () => {
      const openResult = Order.create({
        id: 'order-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        side: 'BUY',
        price: createPrice(0.65),
        size: createQuantity(100),
        status: 'OPEN',
        timestamp: new Date()
      });

      expect(openResult.ok).toBe(true);
      if (!openResult.ok) return;

      const cancelResult = openResult.value.cancel();

      expect(cancelResult.ok).toBe(true);
      if (cancelResult.ok) {
        expect(cancelResult.value.reason).toBe('User cancelled');
      }
    });

    it('should fail to cancel PENDING order', () => {
      const pendingResult = Order.create({
        id: 'order-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        side: 'BUY',
        price: createPrice(0.65),
        size: createQuantity(100),
        status: 'PENDING',
        timestamp: new Date()
      });

      expect(pendingResult.ok).toBe(true);
      if (!pendingResult.ok) return;

      const cancelResult = pendingResult.value.cancel();

      expect(cancelResult.ok).toBe(false);
      if (!cancelResult.ok) {
        expect(cancelResult.error.message).toContain('Cannot cancel order with status PENDING');
      }
    });

    it('should fail to cancel FILLED order', () => {
      const filledResult = Order.create({
        id: 'order-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        side: 'BUY',
        price: createPrice(0.65),
        size: createQuantity(100),
        status: 'FILLED',
        filledSize: createQuantity(100),
        averageFillPrice: createPrice(0.65),
        timestamp: new Date()
      });

      expect(filledResult.ok).toBe(true);
      if (!filledResult.ok) return;

      const cancelResult = filledResult.value.cancel();

      expect(cancelResult.ok).toBe(false);
      if (!cancelResult.ok) {
        expect(cancelResult.error.message).toContain('Cannot cancel order with status FILLED');
      }
    });
  });

  describe('expire() - OPEN/PARTIALLY_FILLED → EXPIRED', () => {
    it('should expire OPEN order', () => {
      const openResult = Order.create({
        id: 'order-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        side: 'BUY',
        price: createPrice(0.65),
        size: createQuantity(100),
        status: 'OPEN',
        timestamp: new Date()
      });

      expect(openResult.ok).toBe(true);
      if (!openResult.ok) return;

      const expireResult = openResult.value.expire();

      expect(expireResult.ok).toBe(true);
      if (expireResult.ok) {
        expect(expireResult.value.status).toBe('EXPIRED');
        expect(expireResult.value.reason).toBe('Expired');
      }
    });

    it('should expire PARTIALLY_FILLED order', () => {
      const partialResult = Order.create({
        id: 'order-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        side: 'BUY',
        price: createPrice(0.65),
        size: createQuantity(100),
        status: 'PARTIALLY_FILLED',
        filledSize: createQuantity(50),
        averageFillPrice: createPrice(0.65),
        timestamp: new Date()
      });

      expect(partialResult.ok).toBe(true);
      if (!partialResult.ok) return;

      const expireResult = partialResult.value.expire();

      expect(expireResult.ok).toBe(true);
      if (expireResult.ok) {
        expect(expireResult.value.status).toBe('EXPIRED');
        expect(expireResult.value.filledSize?.value).toBe(50);
      }
    });

    it('should fail to expire PENDING order', () => {
      const pendingResult = Order.create({
        id: 'order-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        side: 'BUY',
        price: createPrice(0.65),
        size: createQuantity(100),
        status: 'PENDING',
        timestamp: new Date()
      });

      expect(pendingResult.ok).toBe(true);
      if (!pendingResult.ok) return;

      const expireResult = pendingResult.value.expire();

      expect(expireResult.ok).toBe(false);
      if (!expireResult.ok) {
        expect(expireResult.error.message).toContain('Cannot expire order with status PENDING');
      }
    });
  });

  describe('applyTrade() - OPEN → PARTIALLY_FILLED/FILLED', () => {
    it('should apply trade and transition to PARTIALLY_FILLED', () => {
      const orderResult = Order.create({
        id: 'order-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        side: 'BUY',
        price: createPrice(0.65),
        size: createQuantity(100),
        status: 'OPEN',
        timestamp: new Date()
      });

      expect(orderResult.ok).toBe(true);
      if (!orderResult.ok) return;

      const tradeResult = Trade.create({
        id: 'trade-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        price: createPrice(0.65),
        size: createQuantity(30),
        side: 'BUY',
        timestamp: new Date(),
        transactionHash: '0xabc123',
        orderId: 'order-1'
      });

      expect(tradeResult.ok).toBe(true);
      if (!tradeResult.ok) return;

      const applyResult = orderResult.value.applyTrade(tradeResult.value);

      expect(applyResult.ok).toBe(true);
      if (applyResult.ok) {
        expect(applyResult.value.status).toBe('PARTIALLY_FILLED');
        expect(applyResult.value.filledSize?.value).toBe(30);
        expect(applyResult.value.getRemainingSize().value).toBe(70);
        expect(applyResult.value.averageFillPrice?.value).toBe(0.65);
        expect(applyResult.value.tradeIds).toContain('trade-1');
        expect(applyResult.value.getTradeCount()).toBe(1);
      }
    });

    it('should apply trade and transition to FILLED', () => {
      const orderResult = Order.create({
        id: 'order-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        side: 'BUY',
        price: createPrice(0.65),
        size: createQuantity(100),
        status: 'OPEN',
        timestamp: new Date()
      });

      expect(orderResult.ok).toBe(true);
      if (!orderResult.ok) return;

      const tradeResult = Trade.create({
        id: 'trade-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        price: createPrice(0.65),
        size: createQuantity(100),
        side: 'BUY',
        timestamp: new Date(),
        transactionHash: '0xabc123',
        orderId: 'order-1'
      });

      expect(tradeResult.ok).toBe(true);
      if (!tradeResult.ok) return;

      const applyResult = orderResult.value.applyTrade(tradeResult.value);

      expect(applyResult.ok).toBe(true);
      if (applyResult.ok) {
        expect(applyResult.value.status).toBe('FILLED');
        expect(applyResult.value.filledSize?.value).toBe(100);
        expect(applyResult.value.getRemainingSize().value).toBe(0);
      }
    });

    it('should apply multiple trades with weighted average price', () => {
      // Создаём order
      const orderResult = Order.create({
        id: 'order-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        side: 'BUY',
        price: createPrice(0.65),
        size: createQuantity(100),
        status: 'OPEN',
        timestamp: new Date()
      });

      expect(orderResult.ok).toBe(true);
      if (!orderResult.ok) return;

      // Первый trade: 30 @ 0.60
      const trade1Result = Trade.create({
        id: 'trade-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        price: createPrice(0.60),
        size: createQuantity(30),
        side: 'BUY',
        timestamp: new Date(),
        transactionHash: '0xabc1',
        orderId: 'order-1'
      });

      expect(trade1Result.ok).toBe(true);
      if (!trade1Result.ok) return;

      const after1 = orderResult.value.applyTrade(trade1Result.value);
      expect(after1.ok).toBe(true);
      if (!after1.ok) return;

      expect(after1.value.filledSize?.value).toBe(30);
      expect(after1.value.averageFillPrice?.value).toBe(0.60);

      // Второй trade: 70 @ 0.70
      const trade2Result = Trade.create({
        id: 'trade-2',
        marketId: 'market-1',
        tokenId: 'token-yes',
        price: createPrice(0.70),
        size: createQuantity(70),
        side: 'BUY',
        timestamp: new Date(),
        transactionHash: '0xabc2',
        orderId: 'order-1'
      });

      expect(trade2Result.ok).toBe(true);
      if (!trade2Result.ok) return;

      const after2 = after1.value.applyTrade(trade2Result.value);
      expect(after2.ok).toBe(true);
      if (!after2.ok) return;

      // Weighted average: (30 * 0.60 + 70 * 0.70) / 100 = (18 + 49) / 100 = 0.67
      expect(after2.value.status).toBe('FILLED');
      expect(after2.value.filledSize?.value).toBe(100);
      expect(after2.value.averageFillPrice?.value).toBeCloseTo(0.67, 5);
      expect(after2.value.tradeIds).toEqual(['trade-1', 'trade-2']);
      expect(after2.value.getTradeCount()).toBe(2);
    });

    it('should accept trade with undefined orderId (FIFO matching)', () => {
      const orderResult = Order.create({
        id: 'order-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        side: 'BUY',
        price: createPrice(0.65),
        size: createQuantity(100),
        status: 'OPEN',
        timestamp: new Date()
      });

      expect(orderResult.ok).toBe(true);
      if (!orderResult.ok) return;

      // Trade без orderId (FIFO matching)
      const tradeResult = Trade.create({
        id: 'trade-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        price: createPrice(0.65),
        size: createQuantity(30),
        side: 'BUY',
        timestamp: new Date(),
        transactionHash: '0xabc123'
        // orderId: undefined
      });

      expect(tradeResult.ok).toBe(true);
      if (!tradeResult.ok) return;

      const applyResult = orderResult.value.applyTrade(tradeResult.value);

      expect(applyResult.ok).toBe(true);
      if (applyResult.ok) {
        expect(applyResult.value.status).toBe('PARTIALLY_FILLED');
        expect(applyResult.value.filledSize?.value).toBe(30);
      }
    });

    it('should fail if trade.marketId does not match', () => {
      const orderResult = Order.create({
        id: 'order-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        side: 'BUY',
        price: createPrice(0.65),
        size: createQuantity(100),
        status: 'OPEN',
        timestamp: new Date()
      });

      expect(orderResult.ok).toBe(true);
      if (!orderResult.ok) return;

      const tradeResult = Trade.create({
        id: 'trade-1',
        marketId: 'market-2', // Different!
        tokenId: 'token-yes',
        price: createPrice(0.65),
        size: createQuantity(30),
        side: 'BUY',
        timestamp: new Date(),
        transactionHash: '0xabc123',
        orderId: 'order-1'
      });

      expect(tradeResult.ok).toBe(true);
      if (!tradeResult.ok) return;

      const applyResult = orderResult.value.applyTrade(tradeResult.value);

      expect(applyResult.ok).toBe(false);
      if (!applyResult.ok) {
        expect(applyResult.error.message).toContain('marketId');
      }
    });

    it('should fail if trade.tokenId does not match', () => {
      const orderResult = Order.create({
        id: 'order-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        side: 'BUY',
        price: createPrice(0.65),
        size: createQuantity(100),
        status: 'OPEN',
        timestamp: new Date()
      });

      expect(orderResult.ok).toBe(true);
      if (!orderResult.ok) return;

      const tradeResult = Trade.create({
        id: 'trade-1',
        marketId: 'market-1',
        tokenId: 'token-no', // Different!
        price: createPrice(0.65),
        size: createQuantity(30),
        side: 'BUY',
        timestamp: new Date(),
        transactionHash: '0xabc123',
        orderId: 'order-1'
      });

      expect(tradeResult.ok).toBe(true);
      if (!tradeResult.ok) return;

      const applyResult = orderResult.value.applyTrade(tradeResult.value);

      expect(applyResult.ok).toBe(false);
      if (!applyResult.ok) {
        expect(applyResult.error.message).toContain('tokenId');
      }
    });

    it('should fail if trade.side does not match', () => {
      const orderResult = Order.create({
        id: 'order-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        side: 'BUY',
        price: createPrice(0.65),
        size: createQuantity(100),
        status: 'OPEN',
        timestamp: new Date()
      });

      expect(orderResult.ok).toBe(true);
      if (!orderResult.ok) return;

      const tradeResult = Trade.create({
        id: 'trade-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        price: createPrice(0.65),
        size: createQuantity(30),
        side: 'SELL', // Different!
        timestamp: new Date(),
        transactionHash: '0xabc123',
        orderId: 'order-1'
      });

      expect(tradeResult.ok).toBe(true);
      if (!tradeResult.ok) return;

      const applyResult = orderResult.value.applyTrade(tradeResult.value);

      expect(applyResult.ok).toBe(false);
      if (!applyResult.ok) {
        expect(applyResult.error.message).toContain('side');
      }
    });

    it('should fail if trade.orderId does not match', () => {
      const orderResult = Order.create({
        id: 'order-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        side: 'BUY',
        price: createPrice(0.65),
        size: createQuantity(100),
        status: 'OPEN',
        timestamp: new Date()
      });

      expect(orderResult.ok).toBe(true);
      if (!orderResult.ok) return;

      const tradeResult = Trade.create({
        id: 'trade-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        price: createPrice(0.65),
        size: createQuantity(30),
        side: 'BUY',
        timestamp: new Date(),
        transactionHash: '0xabc123',
        orderId: 'order-2' // Different!
      });

      expect(tradeResult.ok).toBe(true);
      if (!tradeResult.ok) return;

      const applyResult = orderResult.value.applyTrade(tradeResult.value);

      expect(applyResult.ok).toBe(false);
      if (!applyResult.ok) {
        expect(applyResult.error.message).toContain('orderId');
      }
    });

    it('should fail if trade.size exceeds remainingSize', () => {
      const orderResult = Order.create({
        id: 'order-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        side: 'BUY',
        price: createPrice(0.65),
        size: createQuantity(100),
        status: 'OPEN',
        timestamp: new Date()
      });

      expect(orderResult.ok).toBe(true);
      if (!orderResult.ok) return;

      const tradeResult = Trade.create({
        id: 'trade-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        price: createPrice(0.65),
        size: createQuantity(150), // Exceeds order size!
        side: 'BUY',
        timestamp: new Date(),
        transactionHash: '0xabc123',
        orderId: 'order-1'
      });

      expect(tradeResult.ok).toBe(true);
      if (!tradeResult.ok) return;

      const applyResult = orderResult.value.applyTrade(tradeResult.value);

      expect(applyResult.ok).toBe(false);
      if (!applyResult.ok) {
        expect(applyResult.error.message).toContain('exceeds remaining');
      }
    });

    it('should fail if duplicate trade.id', () => {
      const orderResult = Order.create({
        id: 'order-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        side: 'BUY',
        price: createPrice(0.65),
        size: createQuantity(100),
        status: 'OPEN',
        timestamp: new Date()
      });

      expect(orderResult.ok).toBe(true);
      if (!orderResult.ok) return;

      const tradeResult = Trade.create({
        id: 'trade-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        price: createPrice(0.65),
        size: createQuantity(30),
        side: 'BUY',
        timestamp: new Date(),
        transactionHash: '0xabc123',
        orderId: 'order-1'
      });

      expect(tradeResult.ok).toBe(true);
      if (!tradeResult.ok) return;

      // Apply first time
      const after1 = orderResult.value.applyTrade(tradeResult.value);
      expect(after1.ok).toBe(true);
      if (!after1.ok) return;

      // Try to apply same trade again
      const after2 = after1.value.applyTrade(tradeResult.value);

      expect(after2.ok).toBe(false);
      if (!after2.ok) {
        expect(after2.error.message).toContain('already been applied');
      }
    });

    it('should fail to apply trade to PENDING order', () => {
      const pendingResult = Order.create({
        id: 'order-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        side: 'BUY',
        price: createPrice(0.65),
        size: createQuantity(100),
        status: 'PENDING',
        timestamp: new Date()
      });

      expect(pendingResult.ok).toBe(true);
      if (!pendingResult.ok) return;

      const tradeResult = Trade.create({
        id: 'trade-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        price: createPrice(0.65),
        size: createQuantity(30),
        side: 'BUY',
        timestamp: new Date(),
        transactionHash: '0xabc123',
        orderId: 'order-1'
      });

      expect(tradeResult.ok).toBe(true);
      if (!tradeResult.ok) return;

      const applyResult = pendingResult.value.applyTrade(tradeResult.value);

      expect(applyResult.ok).toBe(false);
      if (!applyResult.ok) {
        expect(applyResult.error.message).toContain('Cannot apply trade to order with status PENDING');
      }
    });
  });

  describe('Helper methods', () => {
    describe('getTradeCount()', () => {
      it('should return 0 for order without trades', () => {
        const orderResult = Order.create({
          id: 'order-1',
          marketId: 'market-1',
          tokenId: 'token-yes',
          side: 'BUY',
          price: createPrice(0.65),
          size: createQuantity(100),
          status: 'OPEN',
          timestamp: new Date()
        });

        expect(orderResult.ok).toBe(true);
        if (!orderResult.ok) return;

        expect(orderResult.value.getTradeCount()).toBe(0);
      });

      it('should return correct count for order with trades', () => {
        const orderResult = Order.create({
          id: 'order-1',
          marketId: 'market-1',
          tokenId: 'token-yes',
          side: 'BUY',
          price: createPrice(0.65),
          size: createQuantity(100),
          status: 'PARTIALLY_FILLED',
          filledSize: createQuantity(50),
          averageFillPrice: createPrice(0.65),
          tradeIds: ['trade-1', 'trade-2', 'trade-3'],
          timestamp: new Date()
        });

        expect(orderResult.ok).toBe(true);
        if (!orderResult.ok) return;

        expect(orderResult.value.getTradeCount()).toBe(3);
      });
    });

    describe('hasTrade()', () => {
      it('should return false if trade not applied', () => {
        const orderResult = Order.create({
          id: 'order-1',
          marketId: 'market-1',
          tokenId: 'token-yes',
          side: 'BUY',
          price: createPrice(0.65),
          size: createQuantity(100),
          status: 'OPEN',
          timestamp: new Date()
        });

        expect(orderResult.ok).toBe(true);
        if (!orderResult.ok) return;

        expect(orderResult.value.hasTrade('trade-1')).toBe(false);
      });

      it('should return true if trade was applied', () => {
        const orderResult = Order.create({
          id: 'order-1',
          marketId: 'market-1',
          tokenId: 'token-yes',
          side: 'BUY',
          price: createPrice(0.65),
          size: createQuantity(100),
          status: 'PARTIALLY_FILLED',
          filledSize: createQuantity(50),
          averageFillPrice: createPrice(0.65),
          tradeIds: ['trade-1', 'trade-2'],
          timestamp: new Date()
        });

        expect(orderResult.ok).toBe(true);
        if (!orderResult.ok) return;

        expect(orderResult.value.hasTrade('trade-1')).toBe(true);
        expect(orderResult.value.hasTrade('trade-2')).toBe(true);
        expect(orderResult.value.hasTrade('trade-3')).toBe(false);
      });
    });

    describe('canAcceptTrade()', () => {
      it('should return true if all validations pass', () => {
        const orderResult = Order.create({
          id: 'order-1',
          marketId: 'market-1',
          tokenId: 'token-yes',
          side: 'BUY',
          price: createPrice(0.65),
          size: createQuantity(100),
          status: 'OPEN',
          timestamp: new Date()
        });

        expect(orderResult.ok).toBe(true);
        if (!orderResult.ok) return;

        const tradeResult = Trade.create({
          id: 'trade-1',
          marketId: 'market-1',
          tokenId: 'token-yes',
          price: createPrice(0.65),
          size: createQuantity(30),
          side: 'BUY',
          timestamp: new Date(),
          transactionHash: '0xabc123',
          orderId: 'order-1'
        });

        expect(tradeResult.ok).toBe(true);
        if (!tradeResult.ok) return;

        expect(orderResult.value.canAcceptTrade(tradeResult.value)).toBe(true);
      });

      it('should return false if status is not OPEN/PARTIALLY_FILLED', () => {
        const orderResult = Order.create({
          id: 'order-1',
          marketId: 'market-1',
          tokenId: 'token-yes',
          side: 'BUY',
          price: createPrice(0.65),
          size: createQuantity(100),
          status: 'PENDING',
          timestamp: new Date()
        });

        expect(orderResult.ok).toBe(true);
        if (!orderResult.ok) return;

        const tradeResult = Trade.create({
          id: 'trade-1',
          marketId: 'market-1',
          tokenId: 'token-yes',
          price: createPrice(0.65),
          size: createQuantity(30),
          side: 'BUY',
          timestamp: new Date(),
          transactionHash: '0xabc123',
          orderId: 'order-1'
        });

        expect(tradeResult.ok).toBe(true);
        if (!tradeResult.ok) return;

        expect(orderResult.value.canAcceptTrade(tradeResult.value)).toBe(false);
      });

      it('should return false if marketId does not match', () => {
        const orderResult = Order.create({
          id: 'order-1',
          marketId: 'market-1',
          tokenId: 'token-yes',
          side: 'BUY',
          price: createPrice(0.65),
          size: createQuantity(100),
          status: 'OPEN',
          timestamp: new Date()
        });

        expect(orderResult.ok).toBe(true);
        if (!orderResult.ok) return;

        const tradeResult = Trade.create({
          id: 'trade-1',
          marketId: 'market-2',
          tokenId: 'token-yes',
          price: createPrice(0.65),
          size: createQuantity(30),
          side: 'BUY',
          timestamp: new Date(),
          transactionHash: '0xabc123',
          orderId: 'order-1'
        });

        expect(tradeResult.ok).toBe(true);
        if (!tradeResult.ok) return;

        expect(orderResult.value.canAcceptTrade(tradeResult.value)).toBe(false);
      });
    });

    describe('canCancel()', () => {
      it('should return true for OPEN order', () => {
        const orderResult = Order.create({
          id: 'order-1',
          marketId: 'market-1',
          tokenId: 'token-yes',
          side: 'BUY',
          price: createPrice(0.65),
          size: createQuantity(100),
          status: 'OPEN',
          timestamp: new Date()
        });

        expect(orderResult.ok).toBe(true);
        if (!orderResult.ok) return;

        expect(orderResult.value.canCancel()).toBe(true);
      });

      it('should return true for PARTIALLY_FILLED order', () => {
        const orderResult = Order.create({
          id: 'order-1',
          marketId: 'market-1',
          tokenId: 'token-yes',
          side: 'BUY',
          price: createPrice(0.65),
          size: createQuantity(100),
          status: 'PARTIALLY_FILLED',
          filledSize: createQuantity(30),
          averageFillPrice: createPrice(0.65),
          timestamp: new Date()
        });

        expect(orderResult.ok).toBe(true);
        if (!orderResult.ok) return;

        expect(orderResult.value.canCancel()).toBe(true);
      });

      it('should return false for PENDING order', () => {
        const orderResult = Order.create({
          id: 'order-1',
          marketId: 'market-1',
          tokenId: 'token-yes',
          side: 'BUY',
          price: createPrice(0.65),
          size: createQuantity(100),
          status: 'PENDING',
          timestamp: new Date()
        });

        expect(orderResult.ok).toBe(true);
        if (!orderResult.ok) return;

        expect(orderResult.value.canCancel()).toBe(false);
      });

      it('should return false for FILLED order', () => {
        const orderResult = Order.create({
          id: 'order-1',
          marketId: 'market-1',
          tokenId: 'token-yes',
          side: 'BUY',
          price: createPrice(0.65),
          size: createQuantity(100),
          status: 'FILLED',
          filledSize: createQuantity(100),
          averageFillPrice: createPrice(0.65),
          timestamp: new Date()
        });

        expect(orderResult.ok).toBe(true);
        if (!orderResult.ok) return;

        expect(orderResult.value.canCancel()).toBe(false);
      });
    });
  });

  describe('Complete lifecycle scenario', () => {
    it('should handle full order lifecycle: PENDING → OPEN → PARTIALLY_FILLED → FILLED', () => {
      // 1. Create PENDING order
      const pendingResult = Order.create({
        id: 'order-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        side: 'BUY',
        price: createPrice(0.65),
        size: createQuantity(100),
        status: 'PENDING',
        timestamp: new Date()
      });

      expect(pendingResult.ok).toBe(true);
      if (!pendingResult.ok) return;

      // 2. Accept → OPEN
      const openResult = pendingResult.value.accept();
      expect(openResult.ok).toBe(true);
      if (!openResult.ok) return;

      expect(openResult.value.status).toBe('OPEN');

      // 3. First trade → PARTIALLY_FILLED
      const trade1 = Trade.create({
        id: 'trade-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        price: createPrice(0.64),
        size: createQuantity(40),
        side: 'BUY',
        timestamp: new Date(),
        transactionHash: '0xabc1',
        orderId: 'order-1'
      });

      expect(trade1.ok).toBe(true);
      if (!trade1.ok) return;

      const partial1 = openResult.value.applyTrade(trade1.value);
      expect(partial1.ok).toBe(true);
      if (!partial1.ok) return;

      expect(partial1.value.status).toBe('PARTIALLY_FILLED');
      expect(partial1.value.filledSize?.value).toBe(40);

      // 4. Second trade → FILLED
      const trade2 = Trade.create({
        id: 'trade-2',
        marketId: 'market-1',
        tokenId: 'token-yes',
        price: createPrice(0.66),
        size: createQuantity(60),
        side: 'BUY',
        timestamp: new Date(),
        transactionHash: '0xabc2',
        orderId: 'order-1'
      });

      expect(trade2.ok).toBe(true);
      if (!trade2.ok) return;

      const filled = partial1.value.applyTrade(trade2.value);
      expect(filled.ok).toBe(true);
      if (!filled.ok) return;

      expect(filled.value.status).toBe('FILLED');
      expect(filled.value.filledSize?.value).toBe(100);
      expect(filled.value.getRemainingSize().value).toBe(0);
      expect(filled.value.getTradeCount()).toBe(2);

      // Weighted average: (40 * 0.64 + 60 * 0.66) / 100 = (25.6 + 39.6) / 100 = 0.652
      expect(filled.value.averageFillPrice?.value).toBeCloseTo(0.652, 5);
    });

    it('should handle cancellation of partially filled order', () => {
      // 1. Create and accept order
      const orderResult = Order.create({
        id: 'order-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        side: 'BUY',
        price: createPrice(0.65),
        size: createQuantity(100),
        status: 'PENDING',
        timestamp: new Date()
      });

      expect(orderResult.ok).toBe(true);
      if (!orderResult.ok) return;

      const openResult = orderResult.value.accept();
      expect(openResult.ok).toBe(true);
      if (!openResult.ok) return;

      // 2. Partial fill
      const trade = Trade.create({
        id: 'trade-1',
        marketId: 'market-1',
        tokenId: 'token-yes',
        price: createPrice(0.65),
        size: createQuantity(30),
        side: 'BUY',
        timestamp: new Date(),
        transactionHash: '0xabc1',
        orderId: 'order-1'
      });

      expect(trade.ok).toBe(true);
      if (!trade.ok) return;

      const partialResult = openResult.value.applyTrade(trade.value);
      expect(partialResult.ok).toBe(true);
      if (!partialResult.ok) return;

      // 3. Cancel
      const cancelResult = partialResult.value.cancel('User changed mind');
      expect(cancelResult.ok).toBe(true);
      if (!cancelResult.ok) return;

      expect(cancelResult.value.status).toBe('CANCELED');
      expect(cancelResult.value.filledSize?.value).toBe(30); // Preserved
      expect(cancelResult.value.reason).toBe('User changed mind');
      expect(cancelResult.value.canCancel()).toBe(false); // Cannot cancel again
    });
  });
});
