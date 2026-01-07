/**
 * PolymarketExecutionAdapter.cancelOrder() Tests
 *
 * @remarks
 * Тестирование отмены ордеров:
 * - Success scenarios
 * - Event publishing (OrderCancelledEvent)
 * - Error handling (order not found, network errors)
 * - Logging
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { PolymarketExecutionAdapter } from '../../../../../../src/infrastructure/exchange/adapters/execution/PolymarketExecutionAdapter.js';
import type { CLOBClient } from '../../../../../../src/infrastructure/exchange/clients/CLOBClient.js';
import type { MarketConstraintsPolicy } from '../../../../../../src/infrastructure/exchange/policies/MarketConstraintsPolicy.js';
import type { BalancePolicy } from '../../../../../../src/infrastructure/exchange/policies/BalancePolicy.js';
import type { IEventBus } from '../../../../../../src/shared/events/IEventBus.js';
import type { UserEventsFeedService } from '../../../../../../src/infrastructure/exchange/services/UserEventsFeedService.js';
import { MockLogger } from '../../../../../helpers/MockLogger.js';
import { ExchangeError } from '../../../../../../src/shared/errors/TradingError.js';

describe('PolymarketExecutionAdapter.cancelOrder()', () => {
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
      cancelOrder: jest.fn().mockResolvedValue({
        success: true,
        orderId: '0xorder123',
        status: 'CANCELLED',
      }),
      getOrders: jest.fn(),
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

  describe('Success scenarios', () => {
    it('should cancel order successfully', async () => {
      await adapter.cancelOrder('0xorder123');

      expect(mockClobClient.cancelOrder).toHaveBeenCalledWith({ orderId: '0xorder123' });
      expect(mockClobClient.cancelOrder).toHaveBeenCalledTimes(1);
    });

    it('should handle different order IDs', async () => {
      const orderIds = ['0xabc123', '0xdef456', '0x789'];

      for (const orderId of orderIds) {
        await adapter.cancelOrder(orderId);
        expect(mockClobClient.cancelOrder).toHaveBeenCalledWith({ orderId });
      }

      expect(mockClobClient.cancelOrder).toHaveBeenCalledTimes(3);
    });

    it('should log cancel request', async () => {
      await adapter.cancelOrder('0xorder123');

      const infoLogs = mockLogger.infoCalls.filter((call) =>
        call.message.includes('Canceling order')
      );
      expect(infoLogs.length).toBeGreaterThan(0);
      expect(infoLogs[0].message).toContain('0xorder123');
    });

    it('should log successful cancel', async () => {
      await adapter.cancelOrder('0xorder123');

      const infoLogs = mockLogger.infoCalls.filter((call) =>
        call.message.includes('Cancel request sent')
      );
      expect(infoLogs.length).toBeGreaterThan(0);
    });
  });

  describe('Event publishing', () => {
    it('should publish OrderCancelledEvent on success', async () => {
      await adapter.cancelOrder('0xorder123');

      expect(mockEventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ eventName: 'OrderCancelled' })
      );
    });

    it('should include orderId in OrderCancelledEvent', async () => {
      await adapter.cancelOrder('0xorder123');

      const publishCall = (mockEventBus.publish as jest.Mock).mock.calls[0][0];
      expect(publishCall.orderId).toBe('0xorder123');
    });

    it('should include reason in OrderCancelledEvent', async () => {
      await adapter.cancelOrder('0xorder123');

      const publishCall = (mockEventBus.publish as jest.Mock).mock.calls[0][0];
      expect(publishCall.reason).toBe('User requested');
    });

    it('should log event publishing', async () => {
      await adapter.cancelOrder('0xorder123');

      const debugLogs = mockLogger.debugCalls.filter((call) =>
        call.message.includes('Published OrderCancelledEvent')
      );
      expect(debugLogs.length).toBeGreaterThan(0);
    });

    it('should NOT publish event if API call fails', async () => {
      mockClobClient.cancelOrder = jest.fn().mockRejectedValue(new Error('API error'));

      try {
        await adapter.cancelOrder('0xorder123');
      } catch (error) {
        // Expected
      }

      expect(mockEventBus.publish).not.toHaveBeenCalled();
    });
  });

  describe('Error handling', () => {
    it('should throw ExchangeError on API failure', async () => {
      mockClobClient.cancelOrder = jest.fn().mockRejectedValue(new Error('Network error'));

      await expect(adapter.cancelOrder('0xorder123')).rejects.toThrow(ExchangeError);
      await expect(adapter.cancelOrder('0xorder123')).rejects.toThrow(
        'Failed to cancel order: Network error'
      );
    });

    it('should handle "order not found" error', async () => {
      mockClobClient.cancelOrder = jest.fn().mockRejectedValue(new Error('Order not found'));

      await expect(adapter.cancelOrder('0xinvalid')).rejects.toThrow(ExchangeError);
      await expect(adapter.cancelOrder('0xinvalid')).rejects.toThrow('Order not found');
    });

    it('should handle "order already cancelled" error', async () => {
      mockClobClient.cancelOrder = jest
        .fn()
        .mockRejectedValue(new Error('Order already cancelled'));

      await expect(adapter.cancelOrder('0xorder123')).rejects.toThrow(
        'Order already cancelled'
      );
    });

    it('should handle non-Error exceptions', async () => {
      mockClobClient.cancelOrder = jest.fn().mockRejectedValue('String error');

      await expect(adapter.cancelOrder('0xorder123')).rejects.toThrow(ExchangeError);
    });

    it('should log error details', async () => {
      mockClobClient.cancelOrder = jest.fn().mockRejectedValue(new Error('API error'));

      try {
        await adapter.cancelOrder('0xorder123');
      } catch (error) {
        // Expected
      }

      expect(mockLogger.errorCalls.length).toBeGreaterThan(0);
      expect(mockLogger.errorCalls[0].message).toContain('Failed to cancel order');
      expect(mockLogger.errorCalls[0].message).toContain('0xorder123');
    });

    it('should include error message in log', async () => {
      mockClobClient.cancelOrder = jest.fn().mockRejectedValue(new Error('Specific error'));

      try {
        await adapter.cancelOrder('0xorder123');
      } catch (error) {
        // Expected
      }

      expect(mockLogger.errorCalls[0].message).toContain('Specific error');
    });
  });

  describe('Edge cases', () => {
    it('should pass empty orderId to CLOBClient', async () => {
      await adapter.cancelOrder('');
      expect(mockClobClient.cancelOrder).toHaveBeenCalledWith({ orderId: '' });
    });

    it('should handle very long orderId', async () => {
      const longId = '0x' + 'a'.repeat(100);
      await adapter.cancelOrder(longId);

      expect(mockClobClient.cancelOrder).toHaveBeenCalledWith({ orderId: longId });
    });

    it('should handle special characters in orderId', async () => {
      const specialId = '0xorder-123_test';
      await adapter.cancelOrder(specialId);

      expect(mockClobClient.cancelOrder).toHaveBeenCalledWith({ orderId: specialId });
    });
  });
});
