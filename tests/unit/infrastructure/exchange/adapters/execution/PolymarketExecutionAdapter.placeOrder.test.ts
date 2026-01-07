/**
 * PolymarketExecutionAdapter.placeOrder() Tests
 *
 * @remarks
 * Детальное тестирование процесса размещения ордеров:
 * - Нормализация размера через MarketConstraintsPolicy
 * - Валидация баланса через BalancePolicy
 * - Success scenarios с различными параметрами
 * - Event publishing (OrderPlacedEvent, OrderRejectedEvent)
 * - Error handling и learning from constraint errors
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { PolymarketExecutionAdapter } from '../../../../../../src/infrastructure/exchange/adapters/execution/PolymarketExecutionAdapter.js';
import type { CLOBClient } from '../../../../../../src/infrastructure/exchange/clients/CLOBClient.js';
import type { MarketConstraintsPolicy } from '../../../../../../src/infrastructure/exchange/policies/MarketConstraintsPolicy.js';
import type { BalancePolicy } from '../../../../../../src/infrastructure/exchange/policies/BalancePolicy.js';
import type { IEventBus } from '../../../../../../src/shared/events/IEventBus.js';
import type { UserEventsFeedService } from '../../../../../../src/infrastructure/exchange/services/UserEventsFeedService.js';
import { MockLogger } from '../../../../../helpers/MockLogger.js';
import { Order } from '../../../../../../src/domain/entities/Order.js';
import { Price } from '../../../../../../src/domain/value-objects/Price.js';
import { Quantity } from '../../../../../../src/domain/value-objects/Quantity.js';
import { ExchangeError } from '../../../../../../src/shared/errors/TradingError.js';

describe('PolymarketExecutionAdapter.placeOrder()', () => {
  let adapter: PolymarketExecutionAdapter;
  let mockClobClient: CLOBClient;
  let mockMarketConstraintsPolicy: MarketConstraintsPolicy;
  let mockBalancePolicy: BalancePolicy;
  let mockEventBus: IEventBus;
  let mockUserEventsFeed: UserEventsFeedService;
  let mockLogger: MockLogger;

  beforeEach(() => {
    mockClobClient = {
      placeOrder: jest.fn().mockResolvedValue({
        orderId: '0xorder123',
        status: 'PENDING',
        tokenId: '0xtoken123',
        side: 'BUY',
        price: '0.55',
        size: '100',
        filledSize: '0',
        timestamp: Date.now(),
      }),
      cancelOrder: jest.fn(),
      getOrders: jest.fn(),
      getBalances: jest.fn(),
      getPositions: jest.fn(),
      getMarket: jest.fn(),
    } as unknown as CLOBClient;

    mockMarketConstraintsPolicy = {
      normalizeSize: jest.fn().mockResolvedValue({
        normalizedSize: 100,
        originalSize: 100,
        wasNormalized: false,
        reason: 'No normalization needed',
      }),
      learnFromError: jest.fn(),
    } as unknown as MarketConstraintsPolicy;

    mockBalancePolicy = {
      checkBalance: jest.fn().mockReturnValue({
        isValid: true,
        reason: 'Sufficient balance',
        required: 55,
        available: 1000,
      }),
    } as unknown as BalancePolicy;

    mockEventBus = {
      publish: jest.fn(),
      subscribe: jest.fn().mockReturnValue(() => {}),
      unsubscribe: jest.fn(),
      getAllSubscriberCount: jest.fn(),
      getSubscriberCount: jest.fn(),
    } as unknown as IEventBus;

    mockUserEventsFeed = {
      subscribeToOrder: jest.fn().mockReturnValue(() => {}),
      start: jest.fn(),
      stop: jest.fn(),
      getStats: jest.fn(),
    } as unknown as UserEventsFeedService;

    mockLogger = new MockLogger();

    adapter = new PolymarketExecutionAdapter(
      mockClobClient,
      mockMarketConstraintsPolicy,
      mockBalancePolicy,
      mockEventBus,
      mockUserEventsFeed,
      mockLogger
    );
  });

  describe('Size normalization', () => {
    it('should normalize size via MarketConstraintsPolicy', async () => {
      const order = Order.create({
        id: 'test-order-' + Math.random().toString(36).substring(7),
        tokenId: '0xtoken123',
        side: 'BUY',
        price: Price.fromNumber(0.55),
        size: Quantity.fromNumber(100.567),
        status: 'PENDING',
        timestamp: new Date(),
        filledSize: Quantity.fromNumber(0),
        averageFillPrice: null,
      });

      await adapter.placeOrder(order);

      expect(mockMarketConstraintsPolicy.normalizeSize).toHaveBeenCalledWith('0xtoken123', 100.567);
    });

    it('should use normalized size when placing order', async () => {
      mockMarketConstraintsPolicy.normalizeSize = jest.fn().mockResolvedValue({
        normalizedSize: 100.5,
        originalSize: 100.567,
        wasNormalized: true,
        reason: 'Rounded to sizeTick 0.01',
      });

      const order = Order.create({
        id: 'test-order-' + Math.random().toString(36).substring(7),
        tokenId: '0xtoken123',
        side: 'BUY',
        price: Price.fromNumber(0.55),
        size: Quantity.fromNumber(100.567),
        status: 'PENDING',
        timestamp: new Date(),
        filledSize: Quantity.fromNumber(0),
        averageFillPrice: null,
      });

      await adapter.placeOrder(order);

      const apiCall = (mockClobClient.placeOrder as jest.Mock).mock.calls[0][0];
      expect(apiCall.size).toBe('100.5');
    });

    it('should log when size was normalized', async () => {
      mockMarketConstraintsPolicy.normalizeSize = jest.fn().mockResolvedValue({
        normalizedSize: 100,
        originalSize: 100.567,
        wasNormalized: true,
        reason: 'Rounded to sizeTick 0.01',
      });

      const order = Order.create({
        id: 'test-order-' + Math.random().toString(36).substring(7),
        tokenId: '0xtoken123',
        side: 'BUY',
        price: Price.fromNumber(0.55),
        size: Quantity.fromNumber(100.567),
        status: 'PENDING',
        timestamp: new Date(),
        filledSize: Quantity.fromNumber(0),
        averageFillPrice: null,
      });

      await adapter.placeOrder(order);

      const debugLogs = mockLogger.debugCalls.filter((call) =>
        call.message.includes('Size normalized')
      );
      expect(debugLogs.length).toBeGreaterThan(0);
    });
  });

  describe('Balance validation', () => {
    it('should check balance via BalancePolicy', async () => {
      const order = Order.create({
        id: 'test-order-' + Math.random().toString(36).substring(7),
        tokenId: '0xtoken123',
        side: 'BUY',
        price: Price.fromNumber(0.55),
        size: Quantity.fromNumber(100),
        status: 'PENDING',
        timestamp: new Date(),
        filledSize: Quantity.fromNumber(0),
        averageFillPrice: null,
      });

      await adapter.placeOrder(order);

      expect(mockBalancePolicy.checkBalance).toHaveBeenCalled();
    });

    it('should throw error if balance is insufficient', async () => {
      mockBalancePolicy.checkBalance = jest.fn().mockReturnValue({
        isValid: false,
        reason: 'Insufficient balance: required 55 USDC, available 10 USDC',
        required: 55,
        available: 10,
      });

      const order = Order.create({
        id: 'test-order-' + Math.random().toString(36).substring(7),
        tokenId: '0xtoken123',
        side: 'BUY',
        price: Price.fromNumber(0.55),
        size: Quantity.fromNumber(100),
        status: 'PENDING',
        timestamp: new Date(),
        filledSize: Quantity.fromNumber(0),
        averageFillPrice: null,
      });

      await expect(adapter.placeOrder(order)).rejects.toThrow(
        'Insufficient balance: required 55 USDC, available 10 USDC'
      );
    });

    it('should log balance check result', async () => {
      mockBalancePolicy.checkBalance = jest.fn().mockReturnValue({
        isValid: true,
        reason: 'Sufficient balance',
        required: 55,
        available: 1000,
      });

      const order = Order.create({
        id: 'test-order-' + Math.random().toString(36).substring(7),
        tokenId: '0xtoken123',
        side: 'BUY',
        price: Price.fromNumber(0.55),
        size: Quantity.fromNumber(100),
        status: 'PENDING',
        timestamp: new Date(),
        filledSize: Quantity.fromNumber(0),
        averageFillPrice: null,
      });

      await adapter.placeOrder(order);

      const debugLogs = mockLogger.debugCalls.filter((call) =>
        call.message.includes('Balance check passed')
      );
      expect(debugLogs.length).toBeGreaterThan(0);
    });

    it('should not call CLOB API if balance is insufficient', async () => {
      mockBalancePolicy.checkBalance = jest.fn().mockReturnValue({
        isValid: false,
        reason: 'Insufficient balance',
        required: 55,
        available: 10,
      });

      const order = Order.create({
        id: 'test-order-' + Math.random().toString(36).substring(7),
        tokenId: '0xtoken123',
        side: 'BUY',
        price: Price.fromNumber(0.55),
        size: Quantity.fromNumber(100),
        status: 'PENDING',
        timestamp: new Date(),
        filledSize: Quantity.fromNumber(0),
        averageFillPrice: null,
      });

      try {
        await adapter.placeOrder(order);
      } catch (error) {
        // Expected error
      }

      expect(mockClobClient.placeOrder).not.toHaveBeenCalled();
    });
  });

  describe('Success scenarios', () => {
    it('should place BUY order successfully', async () => {
      const order = Order.create({
        id: 'test-order-' + Math.random().toString(36).substring(7),
        tokenId: '0xtoken123',
        side: 'BUY',
        price: Price.fromNumber(0.55),
        size: Quantity.fromNumber(100),
        status: 'PENDING',
        timestamp: new Date(),
        filledSize: Quantity.fromNumber(0),
        averageFillPrice: null,
      });

      const placedOrder = await adapter.placeOrder(order);

      expect(placedOrder.id).toBe('0xorder123');
      expect(placedOrder.side).toBe('BUY');
      expect(mockClobClient.placeOrder).toHaveBeenCalledTimes(1);
    });

    it('should place SELL order successfully', async () => {
      const order = Order.create({
        id: 'test-order-' + Math.random().toString(36).substring(7),
        tokenId: '0xtoken123',
        side: 'SELL',
        price: Price.fromNumber(0.45),
        size: Quantity.fromNumber(50),
        status: 'PENDING',
        timestamp: new Date(),
        filledSize: Quantity.fromNumber(0),
        averageFillPrice: null,
      });

      mockClobClient.placeOrder = jest.fn().mockResolvedValue({
        orderId: '0xorder456',
        status: 'PENDING',
        tokenId: '0xtoken123',
        side: 'SELL',
        price: '0.45',
        size: '50',
        filledSize: '0',
        timestamp: Date.now(),
      });

      const placedOrder = await adapter.placeOrder(order);

      expect(placedOrder.side).toBe('SELL');
      expect(placedOrder.price.value).toBe(0.45);
    });

    it('should return mapped domain order', async () => {
      const order = Order.create({
        id: 'test-order-' + Math.random().toString(36).substring(7),
        tokenId: '0xtoken123',
        side: 'BUY',
        price: Price.fromNumber(0.55),
        size: Quantity.fromNumber(100),
        status: 'PENDING',
        timestamp: new Date(),
        filledSize: Quantity.fromNumber(0),
        averageFillPrice: null,
      });

      const placedOrder = await adapter.placeOrder(order);

      expect(placedOrder).toBeInstanceOf(Order);
      expect(placedOrder.tokenId).toBe('0xtoken123');
      expect(placedOrder.status).toBe('PENDING');
    });
  });

  describe('Event publishing', () => {
    it('should publish OrderPlacedEvent on success', async () => {
      const order = Order.create({
        id: 'test-order-' + Math.random().toString(36).substring(7),
        tokenId: '0xtoken123',
        side: 'BUY',
        price: Price.fromNumber(0.55),
        size: Quantity.fromNumber(100),
        status: 'PENDING',
        timestamp: new Date(),
        filledSize: Quantity.fromNumber(0),
        averageFillPrice: null,
      });

      await adapter.placeOrder(order);

      expect(mockEventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ eventName: 'OrderPlaced' })
      );
    });

    it('should include placed order in OrderPlacedEvent', async () => {
      const order = Order.create({
        id: 'test-order-' + Math.random().toString(36).substring(7),
        tokenId: '0xtoken123',
        side: 'BUY',
        price: Price.fromNumber(0.55),
        size: Quantity.fromNumber(100),
        status: 'PENDING',
        timestamp: new Date(),
        filledSize: Quantity.fromNumber(0),
        averageFillPrice: null,
      });

      await adapter.placeOrder(order);

      const publishCall = (mockEventBus.publish as jest.Mock).mock.calls[0][0];
      expect(publishCall.order).toBeDefined();
      expect(publishCall.order.id).toBe('0xorder123');
    });

    it('should publish OrderRejectedEvent on failure', async () => {
      mockClobClient.placeOrder = jest.fn().mockRejectedValue(new Error('API error'));

      const order = Order.create({
        id: 'order-123',
        tokenId: '0xtoken123',
        side: 'BUY',
        price: Price.fromNumber(0.55),
        size: Quantity.fromNumber(100),
        status: 'PENDING',
        timestamp: new Date(),
        filledSize: Quantity.fromNumber(0),
        averageFillPrice: null,
      });

      await expect(adapter.placeOrder(order)).rejects.toThrow(ExchangeError);

      expect(mockEventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ eventName: 'OrderRejected' })
      );
    });

    it('should include error details in OrderRejectedEvent', async () => {
      mockClobClient.placeOrder = jest.fn().mockRejectedValue(new Error('Size below minimum 10'));

      const order = Order.create({
        id: 'order-123',
        tokenId: '0xtoken123',
        side: 'BUY',
        price: Price.fromNumber(0.55),
        size: Quantity.fromNumber(5),
        status: 'PENDING',
        timestamp: new Date(),
        filledSize: Quantity.fromNumber(0),
        averageFillPrice: null,
      });

      try {
        await adapter.placeOrder(order);
      } catch (error) {
        // Expected
      }

      const publishCall = (mockEventBus.publish as jest.Mock).mock.calls[0][0];
      expect(publishCall.orderId).toBe('order-123');
      expect(publishCall.reason).toContain('Size below minimum 10');
    });
  });

  describe('Error handling', () => {
    it('should throw ExchangeError on API failure', async () => {
      mockClobClient.placeOrder = jest.fn().mockRejectedValue(new Error('Network error'));

      const order = Order.create({
        id: 'test-order-' + Math.random().toString(36).substring(7),
        tokenId: '0xtoken123',
        side: 'BUY',
        price: Price.fromNumber(0.55),
        size: Quantity.fromNumber(100),
        status: 'PENDING',
        timestamp: new Date(),
        filledSize: Quantity.fromNumber(0),
        averageFillPrice: null,
      });

      await expect(adapter.placeOrder(order)).rejects.toThrow(ExchangeError);
      await expect(adapter.placeOrder(order)).rejects.toThrow('Failed to place order: Network error');
    });

    it('should log error details', async () => {
      mockClobClient.placeOrder = jest.fn().mockRejectedValue(new Error('API error'));

      const order = Order.create({
        id: 'test-order-' + Math.random().toString(36).substring(7),
        tokenId: '0xtoken123',
        side: 'BUY',
        price: Price.fromNumber(0.55),
        size: Quantity.fromNumber(100),
        status: 'PENDING',
        timestamp: new Date(),
        filledSize: Quantity.fromNumber(0),
        averageFillPrice: null,
      });

      try {
        await adapter.placeOrder(order);
      } catch (error) {
        // Expected
      }

      expect(mockLogger.errorCalls.length).toBeGreaterThan(0);
      expect(mockLogger.errorCalls[0].message).toContain('Failed to place order');
    });

    it('should handle non-Error exceptions', async () => {
      mockClobClient.placeOrder = jest.fn().mockRejectedValue('String error');

      const order = Order.create({
        id: 'test-order-' + Math.random().toString(36).substring(7),
        tokenId: '0xtoken123',
        side: 'BUY',
        price: Price.fromNumber(0.55),
        size: Quantity.fromNumber(100),
        status: 'PENDING',
        timestamp: new Date(),
        filledSize: Quantity.fromNumber(0),
        averageFillPrice: null,
      });

      await expect(adapter.placeOrder(order)).rejects.toThrow(ExchangeError);
    });
  });

  describe('Learning from constraint errors', () => {
    it('should call learnFromError for constraint violations', async () => {
      mockClobClient.placeOrder = jest.fn().mockRejectedValue(new Error('size below minimum 10'));

      const order = Order.create({
        id: 'test-order-' + Math.random().toString(36).substring(7),
        tokenId: '0xtoken123',
        side: 'BUY',
        price: Price.fromNumber(0.55),
        size: Quantity.fromNumber(5),
        status: 'PENDING',
        timestamp: new Date(),
        filledSize: Quantity.fromNumber(0),
        averageFillPrice: null,
      });

      try {
        await adapter.placeOrder(order);
      } catch (error) {
        // Expected
      }

      expect(mockMarketConstraintsPolicy.learnFromError).toHaveBeenCalledWith(
        '0xtoken123',
        'size below minimum 10'
      );
    });

    it('should learn from "min" errors', async () => {
      mockClobClient.placeOrder = jest.fn().mockRejectedValue(new Error('Order size must be at least 10'));

      const order = Order.create({
        id: 'test-order-' + Math.random().toString(36).substring(7),
        tokenId: '0xtoken123',
        side: 'BUY',
        price: Price.fromNumber(0.55),
        size: Quantity.fromNumber(5),
        status: 'PENDING',
        timestamp: new Date(),
        filledSize: Quantity.fromNumber(0),
        averageFillPrice: null,
      });

      try {
        await adapter.placeOrder(order);
      } catch (error) {
        // Expected
      }

      expect(mockMarketConstraintsPolicy.learnFromError).toHaveBeenCalled();
    });

    it('should learn from "tick" errors', async () => {
      mockClobClient.placeOrder = jest.fn().mockRejectedValue(new Error('Size must be multiple of tick 0.01'));

      const order = Order.create({
        id: 'test-order-' + Math.random().toString(36).substring(7),
        tokenId: '0xtoken123',
        side: 'BUY',
        price: Price.fromNumber(0.55),
        size: Quantity.fromNumber(100.567),
        status: 'PENDING',
        timestamp: new Date(),
        filledSize: Quantity.fromNumber(0),
        averageFillPrice: null,
      });

      try {
        await adapter.placeOrder(order);
      } catch (error) {
        // Expected
      }

      expect(mockMarketConstraintsPolicy.learnFromError).toHaveBeenCalled();
    });

    it('should NOT learn from non-constraint errors', async () => {
      mockClobClient.placeOrder = jest.fn().mockRejectedValue(new Error('Network timeout'));

      const order = Order.create({
        id: 'test-order-' + Math.random().toString(36).substring(7),
        tokenId: '0xtoken123',
        side: 'BUY',
        price: Price.fromNumber(0.55),
        size: Quantity.fromNumber(100),
        status: 'PENDING',
        timestamp: new Date(),
        filledSize: Quantity.fromNumber(0),
        averageFillPrice: null,
      });

      try {
        await adapter.placeOrder(order);
      } catch (error) {
        // Expected
      }

      expect(mockMarketConstraintsPolicy.learnFromError).not.toHaveBeenCalled();
    });
  });
});
