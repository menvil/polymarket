/**
 * PolymarketPortfolioAdapter Orderbook Tests
 *
 * @remarks
 * Тестирование работы с orderbook:
 * - getOrderBook(marketId) - получение стакана заявок
 * - OrderbookMapper integration
 * - Edge cases (empty orderbook, invalid data)
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { PolymarketPortfolioAdapter } from '../../../../../../src/infrastructure/exchange/adapters/portfolio/PolymarketPortfolioAdapter.js';
import type { PolymarketBalanceRestClient } from '../../../../../../src/infrastructure/exchange/clients/PolymarketBalanceRestClient.js';
import type { PolymarketPositionRestClient } from '../../../../../../src/infrastructure/exchange/clients/PolymarketPositionRestClient.js';
import type { PolymarketOrderbookRestClient } from '../../../../../../src/infrastructure/exchange/clients/PolymarketOrderbookRestClient.js';
import type { ApiOrderbook } from '../../../../../../src/infrastructure/exchange/clients/types.js';
import { MockLogger } from '../../../../../helpers/MockLogger.js';
import { ExchangeError } from '../../../../../../src/shared/errors/TradingError.js';

describe('PolymarketPortfolioAdapter Orderbook', () => {
  let adapter: PolymarketPortfolioAdapter;
  let mockBalanceClient: PolymarketBalanceRestClient;
  let mockPositionClient: PolymarketPositionRestClient;
  let mockOrderbookClient: PolymarketOrderbookRestClient;
  let mockLogger: MockLogger;

  const mockApiOrderbook: ApiOrderbook = {
    marketId: '0xmarket123',
    bids: [
      { price: '0.55', size: '100' },
      { price: '0.54', size: '200' },
      { price: '0.53', size: '150' },
    ],
    asks: [
      { price: '0.56', size: '100' },
      { price: '0.57', size: '200' },
      { price: '0.58', size: '150' },
    ],
    timestamp: Date.now(),
  };

  beforeEach(() => {
    mockBalanceClient = {
      getBalances: jest.fn(),
    } as unknown as PolymarketBalanceRestClient;

    mockPositionClient = {
      getPositions: jest.fn(),
    } as unknown as PolymarketPositionRestClient;

    mockOrderbookClient = {
      getOrderbook: jest.fn().mockResolvedValue(mockApiOrderbook),
    } as unknown as PolymarketOrderbookRestClient;

    mockLogger = new MockLogger();

    adapter = new PolymarketPortfolioAdapter(
      mockBalanceClient,
      mockPositionClient,
      mockOrderbookClient,
      mockLogger
    );
  });

  describe('getOrderBook()', () => {
    describe('Success scenarios', () => {
      it('should fetch orderbook for marketId', async () => {
        const orderbook = await adapter.getOrderBook('0xmarket123');

        expect(orderbook.marketId).toBe('0xmarket123');
        expect(orderbook.bids.length).toBe(3);
        expect(orderbook.asks.length).toBe(3);
        expect(mockOrderbookClient.getOrderbook).toHaveBeenCalledWith('0xmarket123');
        expect(mockOrderbookClient.getOrderbook).toHaveBeenCalledTimes(1);
      });

      it('should map bids correctly', async () => {
        const orderbook = await adapter.getOrderBook('0xmarket123');

        expect(orderbook.bids[0].price.value).toBe(0.55);
        expect(orderbook.bids[0].quantity.value).toBe(100);
        expect(orderbook.bids[1].price.value).toBe(0.54);
        expect(orderbook.bids[1].quantity.value).toBe(200);
        expect(orderbook.bids[2].price.value).toBe(0.53);
        expect(orderbook.bids[2].quantity.value).toBe(150);
      });

      it('should map asks correctly', async () => {
        const orderbook = await adapter.getOrderBook('0xmarket123');

        expect(orderbook.asks[0].price.value).toBe(0.56);
        expect(orderbook.asks[0].quantity.value).toBe(100);
        expect(orderbook.asks[1].price.value).toBe(0.57);
        expect(orderbook.asks[1].quantity.value).toBe(200);
        expect(orderbook.asks[2].price.value).toBe(0.58);
        expect(orderbook.asks[2].quantity.value).toBe(150);
      });

      it('should handle different marketIds', async () => {
        const marketIds = ['0xmarket1', '0xmarket2', '0xmarket3'];

        for (const marketId of marketIds) {
          mockOrderbookClient.getOrderbook = jest.fn().mockResolvedValue({
            ...mockApiOrderbook,
            marketId,
          });

          const orderbook = await adapter.getOrderBook(marketId);
          expect(orderbook.marketId).toBe(marketId);
        }
      });

      it('should preserve orderbook timestamp', async () => {
        const testTimestamp = 1704067200000; // 2024-01-01T00:00:00.000Z

        mockOrderbookClient.getOrderbook = jest.fn().mockResolvedValue({
          ...mockApiOrderbook,
          timestamp: testTimestamp,
        });

        const orderbook = await adapter.getOrderBook('0xmarket123');

        expect(orderbook.timestamp.getTime()).toBe(testTimestamp);
      });

      it('should handle decimal precision in prices', async () => {
        mockOrderbookClient.getOrderbook = jest.fn().mockResolvedValue({
          ...mockApiOrderbook,
          bids: [{ price: '0.123456', size: '100' }],
          asks: [{ price: '0.654321', size: '100' }],
        });

        const orderbook = await adapter.getOrderBook('0xmarket123');

        expect(orderbook.bids[0].price.value).toBe(0.123456);
        expect(orderbook.asks[0].price.value).toBe(0.654321);
      });

      it('should handle decimal precision in sizes', async () => {
        mockOrderbookClient.getOrderbook = jest.fn().mockResolvedValue({
          ...mockApiOrderbook,
          bids: [{ price: '0.55', size: '123.456' }],
          asks: [{ price: '0.56', size: '654.321' }],
        });

        const orderbook = await adapter.getOrderBook('0xmarket123');

        expect(orderbook.bids[0].quantity.value).toBe(123.456);
        expect(orderbook.asks[0].quantity.value).toBe(654.321);
      });

      it('should handle orderbook with many levels', async () => {
        const manyBids = Array.from({ length: 30 }, (_, i) => ({
          price: (0.50 - i * 0.01).toFixed(2),
          size: `${(i + 1) * 10}`,
        }));

        const manyAsks = Array.from({ length: 30 }, (_, i) => ({
          price: (0.51 + i * 0.01).toFixed(2),
          size: `${(i + 1) * 10}`,
        }));

        mockOrderbookClient.getOrderbook = jest.fn().mockResolvedValue({
          ...mockApiOrderbook,
          bids: manyBids,
          asks: manyAsks,
        });

        const orderbook = await adapter.getOrderBook('0xmarket123');

        expect(orderbook.bids.length).toBe(30);
        expect(orderbook.asks.length).toBe(30);
      });
    });

    describe('Edge cases', () => {
      it('should handle empty orderbook', async () => {
        mockOrderbookClient.getOrderbook = jest.fn().mockResolvedValue({
          marketId: '0xmarket123',
          bids: [],
          asks: [],
          timestamp: Date.now(),
        });

        const orderbook = await adapter.getOrderBook('0xmarket123');

        expect(orderbook.bids).toEqual([]);
        expect(orderbook.asks).toEqual([]);
      });

      it('should handle orderbook with only bids', async () => {
        mockOrderbookClient.getOrderbook = jest.fn().mockResolvedValue({
          marketId: '0xmarket123',
          bids: [{ price: '0.55', size: '100' }],
          asks: [],
          timestamp: Date.now(),
        });

        const orderbook = await adapter.getOrderBook('0xmarket123');

        expect(orderbook.bids.length).toBe(1);
        expect(orderbook.asks.length).toBe(0);
      });

      it('should handle orderbook with only asks', async () => {
        mockOrderbookClient.getOrderbook = jest.fn().mockResolvedValue({
          marketId: '0xmarket123',
          bids: [],
          asks: [{ price: '0.56', size: '100' }],
          timestamp: Date.now(),
        });

        const orderbook = await adapter.getOrderBook('0xmarket123');

        expect(orderbook.bids.length).toBe(0);
        expect(orderbook.asks.length).toBe(1);
      });

      it('should handle missing timestamp', async () => {
        mockOrderbookClient.getOrderbook = jest.fn().mockResolvedValue({
          marketId: '0xmarket123',
          bids: [{ price: '0.55', size: '100' }],
          asks: [{ price: '0.56', size: '100' }],
          timestamp: undefined,
        });

        const orderbook = await adapter.getOrderBook('0xmarket123');

        // Should use current time when timestamp is missing
        expect(orderbook.timestamp).toBeInstanceOf(Date);
        expect(Math.abs(orderbook.timestamp.getTime() - Date.now())).toBeLessThan(1000);
      });

      it('should handle string timestamp', async () => {
        const testTimestamp = 1704067200000;

        mockOrderbookClient.getOrderbook = jest.fn().mockResolvedValue({
          marketId: '0xmarket123',
          bids: [{ price: '0.55', size: '100' }],
          asks: [{ price: '0.56', size: '100' }],
          timestamp: String(testTimestamp),
        });

        const orderbook = await adapter.getOrderBook('0xmarket123');

        expect(orderbook.timestamp.getTime()).toBe(testTimestamp);
      });
    });

    describe('Logging', () => {
      it('should log orderbook fetch request', async () => {
        await adapter.getOrderBook('0xmarket123456789abcdef');

        const debugLogs = mockLogger.debugCalls.filter((call) =>
          call.message.includes('Fetching orderbook for market 0xmarket12345678')
        );
        expect(debugLogs.length).toBeGreaterThan(0);
      });

      it('should log orderbook fetch result', async () => {
        await adapter.getOrderBook('0xmarket123');

        const debugLogs = mockLogger.debugCalls.filter((call) =>
          call.message.includes('Orderbook fetched: 3 bids, 3 asks')
        );
        expect(debugLogs.length).toBeGreaterThan(0);
      });

      it('should log correct counts for empty orderbook', async () => {
        mockOrderbookClient.getOrderbook = jest.fn().mockResolvedValue({
          marketId: '0xmarket123',
          bids: [],
          asks: [],
          timestamp: Date.now(),
        });

        await adapter.getOrderBook('0xmarket123');

        const debugLogs = mockLogger.debugCalls.filter((call) =>
          call.message.includes('Orderbook fetched: 0 bids, 0 asks')
        );
        expect(debugLogs.length).toBeGreaterThan(0);
      });
    });

    describe('Error handling', () => {
      it('should throw ExchangeError on API failure', async () => {
        mockOrderbookClient.getOrderbook = jest.fn().mockRejectedValue(new Error('Network error'));

        await expect(adapter.getOrderBook('0xmarket123')).rejects.toThrow(ExchangeError);
        await expect(adapter.getOrderBook('0xmarket123')).rejects.toThrow(
          'Failed to fetch orderbook: Network error'
        );
      });

      it('should log error details', async () => {
        mockOrderbookClient.getOrderbook = jest.fn().mockRejectedValue(new Error('API error'));

        try {
          await adapter.getOrderBook('0xmarket123');
        } catch (error) {
          // Expected
        }

        expect(mockLogger.errorCalls.length).toBeGreaterThan(0);
        expect(mockLogger.errorCalls[0].message).toContain('Failed to fetch orderbook');
      });

      it('should handle non-Error exceptions', async () => {
        mockOrderbookClient.getOrderbook = jest.fn().mockRejectedValue('String error');

        await expect(adapter.getOrderBook('0xmarket123')).rejects.toThrow(ExchangeError);
      });

      it('should throw ExchangeError on invalid price', async () => {
        mockOrderbookClient.getOrderbook = jest.fn().mockResolvedValue({
          marketId: '0xmarket123',
          bids: [{ price: 'invalid', size: '100' }],
          asks: [],
          timestamp: Date.now(),
        });

        await expect(adapter.getOrderBook('0xmarket123')).rejects.toThrow(ExchangeError);
      });

      it('should throw ExchangeError on negative price', async () => {
        mockOrderbookClient.getOrderbook = jest.fn().mockResolvedValue({
          marketId: '0xmarket123',
          bids: [{ price: '-0.55', size: '100' }],
          asks: [],
          timestamp: Date.now(),
        });

        await expect(adapter.getOrderBook('0xmarket123')).rejects.toThrow(ExchangeError);
      });

      it('should throw ExchangeError on invalid size', async () => {
        mockOrderbookClient.getOrderbook = jest.fn().mockResolvedValue({
          marketId: '0xmarket123',
          bids: [{ price: '0.55', size: 'invalid' }],
          asks: [],
          timestamp: Date.now(),
        });

        await expect(adapter.getOrderBook('0xmarket123')).rejects.toThrow(ExchangeError);
      });

      it('should throw ExchangeError on negative size', async () => {
        mockOrderbookClient.getOrderbook = jest.fn().mockResolvedValue({
          marketId: '0xmarket123',
          bids: [{ price: '0.55', size: '-100' }],
          asks: [],
          timestamp: Date.now(),
        });

        await expect(adapter.getOrderBook('0xmarket123')).rejects.toThrow(ExchangeError);
      });
    });

    describe('OrderbookMapper integration', () => {
      it('should use OrderbookMapper to convert API to Domain', async () => {
        const orderbook = await adapter.getOrderBook('0xmarket123');

        // Verify it's a Domain Orderbook entity
        expect(orderbook.marketId).toBe('0xmarket123');
        expect(orderbook.bids).toBeDefined();
        expect(orderbook.asks).toBeDefined();
        expect(orderbook.timestamp).toBeInstanceOf(Date);
      });

      it('should have getBestBid() method', async () => {
        const orderbook = await adapter.getOrderBook('0xmarket123');

        const bestBid = orderbook.getBestBid();
        expect(bestBid).toBeDefined();
        expect(bestBid?.value).toBe(0.55);
      });

      it('should have getBestAsk() method', async () => {
        const orderbook = await adapter.getOrderBook('0xmarket123');

        const bestAsk = orderbook.getBestAsk();
        expect(bestAsk).toBeDefined();
        expect(bestAsk?.value).toBe(0.56);
      });

      it('should return null for getBestBid on empty bids', async () => {
        mockOrderbookClient.getOrderbook = jest.fn().mockResolvedValue({
          marketId: '0xmarket123',
          bids: [],
          asks: [{ price: '0.56', size: '100' }],
          timestamp: Date.now(),
        });

        const orderbook = await adapter.getOrderBook('0xmarket123');

        expect(orderbook.getBestBid()).toBeNull();
      });

      it('should return null for getBestAsk on empty asks', async () => {
        mockOrderbookClient.getOrderbook = jest.fn().mockResolvedValue({
          marketId: '0xmarket123',
          bids: [{ price: '0.55', size: '100' }],
          asks: [],
          timestamp: Date.now(),
        });

        const orderbook = await adapter.getOrderBook('0xmarket123');

        expect(orderbook.getBestAsk()).toBeNull();
      });
    });

    describe('Multiple market fetches', () => {
      it('should handle multiple concurrent orderbook fetches', async () => {
        const marketIds = ['0xmarket1', '0xmarket2', '0xmarket3'];

        const promises = marketIds.map(async (marketId) => {
          mockOrderbookClient.getOrderbook = jest.fn().mockResolvedValue({
            ...mockApiOrderbook,
            marketId,
          });

          return adapter.getOrderBook(marketId);
        });

        const orderbooks = await Promise.all(promises);

        expect(orderbooks.length).toBe(3);
        orderbooks.forEach((orderbook, index) => {
          expect(orderbook.marketId).toBe(marketIds[index]);
        });
      });

      it('should handle sequential orderbook fetches', async () => {
        const orderbook1 = await adapter.getOrderBook('0xmarket1');
        const orderbook2 = await adapter.getOrderBook('0xmarket2');

        expect(orderbook1.marketId).toBe('0xmarket123');
        expect(orderbook2.marketId).toBe('0xmarket123');
        expect(mockOrderbookClient.getOrderbook).toHaveBeenCalledTimes(2);
      });
    });
  });
});
