/**
 * PolymarketExecutionAdapter Orders Tests
 *
 * @remarks
 * Тестирование работы с ордерами:
 * - getOpenOrders() - получение открытых ордеров
 * - subscribeToOrderUpdates() - подписка на обновления через EventBus + UserEventsFeed
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
import { ExchangeError } from '../../../../../../src/shared/errors/TradingError.js';

describe('PolymarketExecutionAdapter Orders', () => {
  let adapter: PolymarketExecutionAdapter;
  let mockClobClient: CLOBClient;
  let mockMarketConstraintsPolicy: MarketConstraintsPolicy;
  let mockBalancePolicy: BalancePolicy;
  let mockEventBus: IEventBus;
  let mockUserEventsFeed: UserEventsFeedService;
  let mockLogger: MockLogger;

  beforeEach(() => {
    mockClobClient = {
      placeOrder: jest.fn(),
      cancelOrder: jest.fn(),
      getOrders: jest.fn().mockResolvedValue([]),
      getBalances: jest.fn(),
      getPositions: jest.fn(),
      getMarket: jest.fn(),
    } as unknown as CLOBClient;

    mockMarketConstraintsPolicy = {
      normalizeSize: jest.fn(),
      learnFromError: jest.fn(),
    } as unknown as MarketConstraintsPolicy;

    mockBalancePolicy = {
      checkBalance: jest.fn(),
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

  describe('getOpenOrders()', () => {
    describe('Success scenarios', () => {
      it('should fetch all open orders when no tokenId provided', async () => {
        mockClobClient.getOrders = jest.fn().mockResolvedValue([
          {
            orderId: '0xorder1',
            status: 'PENDING',
            tokenId: '0xtoken123',
            side: 'BUY',
            price: '0.55',
            size: '100',
            filledSize: '0',
            timestamp: Date.now() / 1000,
          },
          {
            orderId: '0xorder2',
            status: 'PENDING',
            tokenId: '0xtoken456',
            side: 'SELL',
            price: '0.45',
            size: '50',
            filledSize: '0',
            timestamp: Date.now() / 1000,
          },
        ]);

        const orders = await adapter.getOpenOrders();

        expect(orders).toHaveLength(2);
        expect(mockClobClient.getOrders).toHaveBeenCalledWith(undefined);
      });

      it('should fetch orders for specific token', async () => {
        mockClobClient.getOrders = jest.fn().mockResolvedValue([
          {
            orderId: '0xorder1',
            status: 'PENDING',
            tokenId: '0xtoken123',
            side: 'BUY',
            price: '0.55',
            size: '100',
            filledSize: '0',
            timestamp: Date.now() / 1000,
          },
        ]);

        const orders = await adapter.getOpenOrders('0xtoken123');

        expect(orders).toHaveLength(1);
        expect(orders[0].tokenId).toBe('0xtoken123');
        expect(mockClobClient.getOrders).toHaveBeenCalledWith('0xtoken123');
      });

      it('should return empty array when no orders', async () => {
        mockClobClient.getOrders = jest.fn().mockResolvedValue([]);

        const orders = await adapter.getOpenOrders();

        expect(orders).toEqual([]);
      });

      it('should map API orders to domain Orders', async () => {
        mockClobClient.getOrders = jest.fn().mockResolvedValue([
          {
            orderId: '0xorder1',
            status: 'PENDING',
            tokenId: '0xtoken123',
            side: 'BUY',
            price: '0.55',
            size: '100',
            filledSize: '0',
            timestamp: Date.now() / 1000,
          },
        ]);

        const orders = await adapter.getOpenOrders();

        expect(orders[0]).toBeInstanceOf(Order);
        expect(orders[0].id).toBe('0xorder1');
        expect(orders[0].side).toBe('BUY');
      });
    });

    describe('Logging', () => {
      it('should log fetch request', async () => {
        await adapter.getOpenOrders();

        const debugLogs = mockLogger.debugCalls.filter((call) =>
          call.message.includes('Fetching open orders')
        );
        expect(debugLogs.length).toBeGreaterThan(0);
      });

      it('should log tokenId when filtering', async () => {
        await adapter.getOpenOrders('0xtoken123456789abcdef');

        const debugLogs = mockLogger.debugCalls.filter((call) =>
          call.message.includes('for token 0xtoken123456789')
        );
        expect(debugLogs.length).toBeGreaterThan(0);
      });

      it('should log result count', async () => {
        mockClobClient.getOrders = jest.fn().mockResolvedValue([
          {
            orderId: '0xorder1',
            status: 'PENDING',
            tokenId: '0xtoken123',
            side: 'BUY',
            price: '0.55',
            size: '100',
            filledSize: '0',
            timestamp: Date.now() / 1000,
          },
          {
            orderId: '0xorder2',
            status: 'PENDING',
            tokenId: '0xtoken123',
            side: 'SELL',
            price: '0.45',
            size: '50',
            filledSize: '0',
            timestamp: Date.now() / 1000,
          },
        ]);

        await adapter.getOpenOrders();

        const debugLogs = mockLogger.debugCalls.filter((call) =>
          call.message.includes('Found 2 open orders')
        );
        expect(debugLogs.length).toBeGreaterThan(0);
      });
    });

    describe('Error handling', () => {
      it('should throw ExchangeError on API failure', async () => {
        mockClobClient.getOrders = jest.fn().mockRejectedValue(new Error('Network error'));

        await expect(adapter.getOpenOrders()).rejects.toThrow(ExchangeError);
        await expect(adapter.getOpenOrders()).rejects.toThrow(
          'Failed to fetch open orders: Network error'
        );
      });

      it('should log error details', async () => {
        mockClobClient.getOrders = jest.fn().mockRejectedValue(new Error('API error'));

        try {
          await adapter.getOpenOrders();
        } catch (error) {
          // Expected
        }

        expect(mockLogger.errorCalls.length).toBeGreaterThan(0);
        expect(mockLogger.errorCalls[0].message).toContain('Failed to fetch open orders');
      });
    });
  });

  describe('subscribeToOrderUpdates()', () => {
    describe('Subscription setup', () => {
      it('should subscribe to EventBus for order events', () => {
        const callback = jest.fn();

        adapter.subscribeToOrderUpdates('0xorder123', callback);

        expect(mockEventBus.subscribe).toHaveBeenCalledTimes(3);
        expect(mockEventBus.subscribe).toHaveBeenCalledWith('OrderFilled', expect.any(Function));
        expect(mockEventBus.subscribe).toHaveBeenCalledWith('OrderUpdated', expect.any(Function));
        expect(mockEventBus.subscribe).toHaveBeenCalledWith('OrderCancelled', expect.any(Function));
      });

      it('should subscribe to UserEventsFeed', () => {
        const callback = jest.fn();

        adapter.subscribeToOrderUpdates('0xorder123', callback);

        expect(mockUserEventsFeed.subscribeToOrder).toHaveBeenCalledWith('0xorder123');
      });

      it('should log subscription', () => {
        const callback = jest.fn();

        adapter.subscribeToOrderUpdates('0xorder123', callback);

        const debugLogs = mockLogger.debugCalls.filter((call) =>
          call.message.includes('Subscribing to order updates')
        );
        expect(debugLogs.length).toBeGreaterThan(0);
        expect(debugLogs[0].message).toContain('0xorder123');
      });

      it('should return unsubscribe function', () => {
        const callback = jest.fn();

        const unsubscribe = adapter.subscribeToOrderUpdates('0xorder123', callback);

        expect(typeof unsubscribe).toBe('function');
      });
    });

    describe('Unsubscribe', () => {
      it('should cleanup all subscriptions when unsubscribe is called', () => {
        const callback = jest.fn();
        const mockUnsubscribes = [jest.fn(), jest.fn(), jest.fn(), jest.fn()];
        let callIndex = 0;

        mockEventBus.subscribe = jest.fn(() => mockUnsubscribes[callIndex++]);
        mockUserEventsFeed.subscribeToOrder = jest.fn(() => mockUnsubscribes[3]);

        const unsubscribe = adapter.subscribeToOrderUpdates('0xorder123', callback);
        unsubscribe();

        mockUnsubscribes.forEach((unsub) => {
          expect(unsub).toHaveBeenCalledTimes(1);
        });
      });

      it('should log unsubscribe', () => {
        const callback = jest.fn();

        const unsubscribe = adapter.subscribeToOrderUpdates('0xorder123', callback);
        unsubscribe();

        const debugLogs = mockLogger.debugCalls.filter((call) =>
          call.message.includes('Unsubscribing from order updates')
        );
        expect(debugLogs.length).toBeGreaterThan(0);
      });
    });

    describe('Multiple subscriptions', () => {
      it('should handle multiple subscriptions to different orders', () => {
        const callback1 = jest.fn();
        const callback2 = jest.fn();
        const callback3 = jest.fn();

        adapter.subscribeToOrderUpdates('0xorder1', callback1);
        adapter.subscribeToOrderUpdates('0xorder2', callback2);
        adapter.subscribeToOrderUpdates('0xorder3', callback3);

        expect(mockUserEventsFeed.subscribeToOrder).toHaveBeenCalledTimes(3);
        expect(mockUserEventsFeed.subscribeToOrder).toHaveBeenCalledWith('0xorder1');
        expect(mockUserEventsFeed.subscribeToOrder).toHaveBeenCalledWith('0xorder2');
        expect(mockUserEventsFeed.subscribeToOrder).toHaveBeenCalledWith('0xorder3');
      });

      it('should handle subscription to same order multiple times', () => {
        const callback1 = jest.fn();
        const callback2 = jest.fn();

        adapter.subscribeToOrderUpdates('0xorder123', callback1);
        adapter.subscribeToOrderUpdates('0xorder123', callback2);

        expect(mockUserEventsFeed.subscribeToOrder).toHaveBeenCalledTimes(2);
        expect(mockUserEventsFeed.subscribeToOrder).toHaveBeenCalledWith('0xorder123');
      });
    });

    describe('Edge cases', () => {
      it('should handle empty orderId', () => {
        const callback = jest.fn();

        adapter.subscribeToOrderUpdates('', callback);

        expect(mockUserEventsFeed.subscribeToOrder).toHaveBeenCalledWith('');
      });

      it('should handle special characters in orderId', () => {
        const callback = jest.fn();
        const specialId = '0xorder-123_test!@#';

        adapter.subscribeToOrderUpdates(specialId, callback);

        expect(mockUserEventsFeed.subscribeToOrder).toHaveBeenCalledWith(specialId);
      });
    });
  });
});
