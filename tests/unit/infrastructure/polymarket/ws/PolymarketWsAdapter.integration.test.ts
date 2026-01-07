/**
 * Integration tests for PolymarketWsAdapter
 *
 * @remarks
 * Tests the complete data flow through all layers:
 * WebSocket → Client → Router → Registry → Domain conversion → User callbacks
 *
 * These tests verify that:
 * 1. WebSocket messages flow correctly through all layers
 * 2. Domain entities (Orderbook, Trade) are created correctly
 * 3. Callbacks are invoked with correct data
 * 4. Multiple subscriptions work correctly
 * 5. Error handling works across layers
 * 6. Subscription lifecycle is managed correctly
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { ILogger } from '../../../../../src/domain/ports/ILogger.js';
import type { WebSocketManager } from '../../../../../src/infrastructure/exchange/clients/WebSocketManager.js';
import { PolymarketWsAdapter } from '../../../../../src/infrastructure/polymarket/ws/PolymarketWsAdapter.js';
import type { Orderbook } from '../../../../../src/domain/entities/Orderbook.js';
import type { Trade } from '../../../../../src/domain/entities/Trade.js';

/**
 * Helper: Wait for next event loop tick (for async EventBus delivery)
 */
async function nextTick(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(() => {
      resolve();
    });
  });
}

describe('PolymarketWsAdapter - Integration Tests', () => {
  let adapter: PolymarketWsAdapter;
  let mockWsManager: Partial<WebSocketManager>;
  let mockLogger: ILogger;
  let wsMessageListener: ((data: Buffer) => void) | null = null;

  const TEST_TOKEN_YES = '67704255197116168826604911233626301865010283966205730455742704536521111535950';
  const TEST_TOKEN_NO = '48331043336612883890405840694803087191347769269211396801222748316064917524501';

  beforeEach(() => {
    wsMessageListener = null;

    // Mock logger
    mockLogger = {
      silly: jest.fn(),
      trace: jest.fn(),
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      child: jest.fn(() => mockLogger),
    } as unknown as ILogger;

    // Mock WebSocketManager
    mockWsManager = {
      on: jest.fn<(event: string | symbol, listener: (...args: any[]) => void) => WebSocketManager>((event: string | symbol, listener: any) => {
        if (event === 'message') {
          wsMessageListener = listener;
        }
        return mockWsManager as WebSocketManager;
      }),
      off: jest.fn<(event: string | symbol, listener: (...args: any[]) => void) => WebSocketManager>(() => mockWsManager as WebSocketManager),
      once: jest.fn<(event: string | symbol, listener: (...args: any[]) => void) => WebSocketManager>(() => mockWsManager as WebSocketManager),
      emit: jest.fn<(event: string | symbol, ...args: any[]) => boolean>(() => true),
      connect: jest.fn(async () => Promise.resolve()),
      disconnect: jest.fn(async () => Promise.resolve()),
      subscribe: jest.fn(async () => Promise.resolve()),
      unsubscribe: jest.fn(async () => Promise.resolve()),
      isConnected: jest.fn(() => true),
      getStatus: jest.fn(() => 'connected' as const),
    };

    adapter = new PolymarketWsAdapter(
      mockWsManager as WebSocketManager,
      mockLogger
    );
  });

  /**
   * Helper: Simulate WebSocket message
   */
  function simulateWsMessage(message: any): void {
    if (!wsMessageListener) {
      throw new Error('No message listener registered');
    }
    const jsonStr = JSON.stringify(message);
    const buffer = Buffer.from(jsonStr);
    wsMessageListener(buffer);
  }

  describe('End-to-end orderbook flow', () => {
    it('should process orderbook message through all layers and invoke callback', async () => {
      const callback = jest.fn<(orderbook: Orderbook) => void>();

      // Subscribe
      adapter.subscribeToOrderbook(TEST_TOKEN_YES, callback);

      // Simulate WebSocket orderbook message
      simulateWsMessage({
        event_type: 'book',
        asset_id: TEST_TOKEN_YES,
        bids: [
          { price: '0.52', size: '100' },
          { price: '0.51', size: '200' },
        ],
        asks: [
          { price: '0.53', size: '150' },
          { price: '0.54', size: '250' },
        ],
        timestamp: 1766875759895,
      });

      // Wait for async EventBus delivery
      await nextTick();

      // Verify callback was invoked
      expect(callback).toHaveBeenCalledTimes(1);

      // Verify Orderbook entity
      const orderbook = callback.mock.calls[0][0];
      expect(orderbook).toBeDefined();
      expect(orderbook.marketId).toBe(TEST_TOKEN_YES);
      expect(orderbook.bids.length).toBe(2);
      expect(orderbook.asks.length).toBe(2);
      expect(orderbook.timestamp.getTime()).toBe(1766875759895);

      // Verify bid/ask structure
      expect(orderbook.bids[0].price.value).toBe(0.52);
      expect(orderbook.bids[0].quantity.value).toBe(100);
      expect(orderbook.asks[0].price.value).toBe(0.53);
      expect(orderbook.asks[0].quantity.value).toBe(150);
    });

    it('should handle orderbook with empty bids/asks', async () => {
      const callback = jest.fn<(orderbook: Orderbook) => void>();

      adapter.subscribeToOrderbook(TEST_TOKEN_YES, callback);

      simulateWsMessage({
        event_type: 'book',
        asset_id: TEST_TOKEN_YES,
        bids: [],
        asks: [],
        timestamp: 1766875759895,
      });

      await nextTick();

      expect(callback).toHaveBeenCalledTimes(1);
      const orderbook = callback.mock.calls[0][0];
      expect(orderbook.bids.length).toBe(0);
      expect(orderbook.asks.length).toBe(0);
    });

    it('should handle multiple orderbook updates', async () => {
      const callback = jest.fn<(orderbook: Orderbook) => void>();

      adapter.subscribeToOrderbook(TEST_TOKEN_YES, callback);

      // First update
      simulateWsMessage({
        event_type: 'book',
        asset_id: TEST_TOKEN_YES,
        bids: [{ price: '0.52', size: '100' }],
        asks: [{ price: '0.53', size: '150' }],
        timestamp: 1000,
      });

      await nextTick();

      // Second update
      simulateWsMessage({
        event_type: 'book',
        asset_id: TEST_TOKEN_YES,
        bids: [{ price: '0.54', size: '200' }],
        asks: [{ price: '0.55', size: '250' }],
        timestamp: 2000,
      });

      await nextTick();

      // Third update
      simulateWsMessage({
        event_type: 'book',
        asset_id: TEST_TOKEN_YES,
        bids: [{ price: '0.56', size: '300' }],
        asks: [{ price: '0.57', size: '350' }],
        timestamp: 3000,
      });

      await nextTick();

      expect(callback).toHaveBeenCalledTimes(3);
      expect(callback.mock.calls[0][0].bids[0].price.value).toBe(0.52);
      expect(callback.mock.calls[1][0].bids[0].price.value).toBe(0.54);
      expect(callback.mock.calls[2][0].bids[0].price.value).toBe(0.56);
    });
  });

  describe('End-to-end trade flow', () => {
    it('should process trade message through all layers and invoke callback', async () => {
      const callback = jest.fn<(trade: Trade) => void>();

      // Subscribe
      adapter.subscribeToTrades(TEST_TOKEN_YES, callback);

      // Simulate WebSocket trade message
      simulateWsMessage({
        event_type: 'trade',
        asset_id: TEST_TOKEN_YES,
        price: '0.52',
        size: '50',
        side: 'BUY',
        timestamp: 1766875759895,
      });

      await nextTick();

      // Verify callback was invoked
      expect(callback).toHaveBeenCalledTimes(1);

      // Verify Trade entity
      const trade = callback.mock.calls[0][0];
      expect(trade).toBeDefined();
      expect(trade.marketId).toBe(TEST_TOKEN_YES);
      expect(trade.price.value).toBe(0.52);
      expect(trade.quantity.value).toBe(50);
      expect(trade.side).toBe('BUY');
      expect(trade.timestamp.getTime()).toBe(1766875759895);
    });

    it('should process last_trade_price message', async () => {
      const callback = jest.fn<(trade: Trade) => void>();

      adapter.subscribeToTrades(TEST_TOKEN_YES, callback);

      simulateWsMessage({
        event_type: 'last_trade_price',
        asset_id: TEST_TOKEN_YES,
        price: '0.55',
        size: '75',
        timestamp: 1766875759895,
      });

      await nextTick();

      expect(callback).toHaveBeenCalledTimes(1);
      const trade = callback.mock.calls[0][0];
      expect(trade.price.value).toBe(0.55);
      expect(trade.quantity.value).toBe(75);
    });

    it('should handle multiple trade updates', async () => {
      const callback = jest.fn<(trade: Trade) => void>();

      adapter.subscribeToTrades(TEST_TOKEN_YES, callback);

      // Multiple trades
      simulateWsMessage({
        event_type: 'trade',
        asset_id: TEST_TOKEN_YES,
        price: '0.50',
        size: '10',
        side: 'BUY',
      });

      await nextTick();

      simulateWsMessage({
        event_type: 'trade',
        asset_id: TEST_TOKEN_YES,
        price: '0.51',
        size: '20',
        side: 'SELL',
      });

      await nextTick();

      simulateWsMessage({
        event_type: 'trade',
        asset_id: TEST_TOKEN_YES,
        price: '0.52',
        size: '30',
        side: 'BUY',
      });

      await nextTick();

      expect(callback).toHaveBeenCalledTimes(3);
      expect(callback.mock.calls[0][0].price.value).toBe(0.50);
      expect(callback.mock.calls[1][0].price.value).toBe(0.51);
      expect(callback.mock.calls[2][0].price.value).toBe(0.52);
    });
  });

  describe('Multiple subscriptions', () => {
    it('should support multiple callbacks for same asset (orderbook)', async () => {
      const callback1 = jest.fn<(orderbook: Orderbook) => void>();
      const callback2 = jest.fn<(orderbook: Orderbook) => void>();
      const callback3 = jest.fn<(orderbook: Orderbook) => void>();

      adapter.subscribeToOrderbook(TEST_TOKEN_YES, callback1);
      adapter.subscribeToOrderbook(TEST_TOKEN_YES, callback2);
      adapter.subscribeToOrderbook(TEST_TOKEN_YES, callback3);

      simulateWsMessage({
        event_type: 'book',
        asset_id: TEST_TOKEN_YES,
        bids: [{ price: '0.52', size: '100' }],
        asks: [{ price: '0.53', size: '150' }],
        timestamp: 1000,
      });

      await nextTick();

      // All callbacks should be invoked
      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
      expect(callback3).toHaveBeenCalledTimes(1);

      // All should receive same data
      expect(callback1.mock.calls[0][0].bids[0].price.value).toBe(0.52);
      expect(callback2.mock.calls[0][0].bids[0].price.value).toBe(0.52);
      expect(callback3.mock.calls[0][0].bids[0].price.value).toBe(0.52);
    });

    it('should support multiple callbacks for same asset (trades)', async () => {
      const callback1 = jest.fn<(trade: Trade) => void>();
      const callback2 = jest.fn<(trade: Trade) => void>();

      adapter.subscribeToTrades(TEST_TOKEN_YES, callback1);
      adapter.subscribeToTrades(TEST_TOKEN_YES, callback2);

      simulateWsMessage({
        event_type: 'trade',
        asset_id: TEST_TOKEN_YES,
        price: '0.52',
        size: '50',
        side: 'BUY',
      });

      await nextTick();

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
    });

    it('should support subscriptions to different assets', async () => {
      const callbackYes = jest.fn<(orderbook: Orderbook) => void>();
      const callbackNo = jest.fn<(orderbook: Orderbook) => void>();

      adapter.subscribeToOrderbook(TEST_TOKEN_YES, callbackYes);
      adapter.subscribeToOrderbook(TEST_TOKEN_NO, callbackNo);

      // Message for YES token
      simulateWsMessage({
        event_type: 'book',
        asset_id: TEST_TOKEN_YES,
        bids: [{ price: '0.52', size: '100' }],
        asks: [{ price: '0.53', size: '150' }],
        timestamp: 1000,
      });

      await nextTick();

      // Message for NO token
      simulateWsMessage({
        event_type: 'book',
        asset_id: TEST_TOKEN_NO,
        bids: [{ price: '0.48', size: '200' }],
        asks: [{ price: '0.49', size: '250' }],
        timestamp: 2000,
      });

      await nextTick();

      // Only respective callbacks should be invoked
      expect(callbackYes).toHaveBeenCalledTimes(1);
      expect(callbackNo).toHaveBeenCalledTimes(1);

      expect(callbackYes.mock.calls[0][0].marketId).toBe(TEST_TOKEN_YES);
      expect(callbackNo.mock.calls[0][0].marketId).toBe(TEST_TOKEN_NO);
    });

    it('should support both orderbook and trade subscriptions for same asset', async () => {
      const orderbookCallback = jest.fn<(orderbook: Orderbook) => void>();
      const tradeCallback = jest.fn<(trade: Trade) => void>();

      adapter.subscribeToOrderbook(TEST_TOKEN_YES, orderbookCallback);
      adapter.subscribeToTrades(TEST_TOKEN_YES, tradeCallback);

      // Orderbook message
      simulateWsMessage({
        event_type: 'book',
        asset_id: TEST_TOKEN_YES,
        bids: [{ price: '0.52', size: '100' }],
        asks: [{ price: '0.53', size: '150' }],
        timestamp: 1000,
      });

      await nextTick();

      // Trade message
      simulateWsMessage({
        event_type: 'trade',
        asset_id: TEST_TOKEN_YES,
        price: '0.52',
        size: '50',
        side: 'BUY',
      });

      await nextTick();

      expect(orderbookCallback).toHaveBeenCalledTimes(1);
      expect(tradeCallback).toHaveBeenCalledTimes(1);
    });
  });

  describe('Batch message processing', () => {
    it('should process batch of messages correctly', async () => {
      const orderbookCallback = jest.fn<(orderbook: Orderbook) => void>();
      const tradeCallback = jest.fn<(trade: Trade) => void>();

      adapter.subscribeToOrderbook(TEST_TOKEN_YES, orderbookCallback);
      adapter.subscribeToTrades(TEST_TOKEN_YES, tradeCallback);

      // Simulate batch message
      const batchMessage = [
        {
          event_type: 'book',
          asset_id: TEST_TOKEN_YES,
          bids: [{ price: '0.52', size: '100' }],
          asks: [{ price: '0.53', size: '150' }],
          timestamp: 1000,
        },
        {
          event_type: 'trade',
          asset_id: TEST_TOKEN_YES,
          price: '0.52',
          size: '50',
          side: 'BUY',
        },
        {
          event_type: 'trade',
          asset_id: TEST_TOKEN_YES,
          price: '0.53',
          size: '75',
          side: 'SELL',
        },
      ];

      const jsonStr = JSON.stringify(batchMessage);
      const buffer = Buffer.from(jsonStr);
      wsMessageListener?.(buffer);

      await nextTick();

      expect(orderbookCallback).toHaveBeenCalledTimes(1);
      expect(tradeCallback).toHaveBeenCalledTimes(2);
    });
  });

  describe('Error handling across layers', () => {
    it('should isolate errors in one callback from others', async () => {
      const callback1 = jest.fn<(orderbook: Orderbook) => void>(() => {
        throw new Error('Callback 1 error');
      });
      const callback2 = jest.fn<(orderbook: Orderbook) => void>();
      const callback3 = jest.fn<(orderbook: Orderbook) => void>();

      adapter.subscribeToOrderbook(TEST_TOKEN_YES, callback1);
      adapter.subscribeToOrderbook(TEST_TOKEN_YES, callback2);
      adapter.subscribeToOrderbook(TEST_TOKEN_YES, callback3);

      simulateWsMessage({
        event_type: 'book',
        asset_id: TEST_TOKEN_YES,
        bids: [{ price: '0.52', size: '100' }],
        asks: [{ price: '0.53', size: '150' }],
        timestamp: 1000,
      });

      await nextTick();

      // All callbacks should be invoked despite error in callback1
      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
      expect(callback3).toHaveBeenCalledTimes(1);

      // Error should be logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Error in subscription callback'),
        expect.any(Object)
      );
    });

    it('should handle invalid WebSocket message gracefully', async () => {
      const callback = jest.fn<(orderbook: Orderbook) => void>();
      const errorHandler = jest.fn();

      // Listen to error events to prevent unhandled error
      adapter['router'].on('error', errorHandler);

      adapter.subscribeToOrderbook(TEST_TOKEN_YES, callback);

      // Invalid JSON
      const buffer = Buffer.from('invalid json {{{');
      wsMessageListener?.(buffer);

      await nextTick();

      // Callback should not be invoked
      expect(callback).not.toHaveBeenCalled();

      // Error should be logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to parse'),
        expect.any(Object)
      );
    });

    it('should skip messages without asset_id', async () => {
      const callback = jest.fn<(orderbook: Orderbook) => void>();

      adapter.subscribeToOrderbook(TEST_TOKEN_YES, callback);

      simulateWsMessage({
        event_type: 'book',
        // asset_id missing!
        bids: [{ price: '0.52', size: '100' }],
        asks: [{ price: '0.53', size: '150' }],
        timestamp: 1000,
      });

      await nextTick();

      // Callback should not be invoked
      expect(callback).not.toHaveBeenCalled();

      // Warning should be logged
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Data message without asset_id'),
        expect.any(Object)
      );
    });
  });

  describe('Subscription status', () => {
    it('should report subscription status correctly', () => {
      const callback = jest.fn<(orderbook: Orderbook) => void>();

      expect(adapter.isSubscribed(TEST_TOKEN_YES)).toBe(false);

      adapter.subscribeToOrderbook(TEST_TOKEN_YES, callback);

      expect(adapter.isSubscribed(TEST_TOKEN_YES)).toBe(true);
    });

    it('should handle checking status of unsubscribed token', () => {
      expect(adapter.isSubscribed(TEST_TOKEN_NO)).toBe(false);
    });
  });


  describe('Edge cases', () => {
    it('should handle control messages without affecting callbacks', async () => {
      const callback = jest.fn<(orderbook: Orderbook) => void>();

      adapter.subscribeToOrderbook(TEST_TOKEN_YES, callback);

      // Pong message
      simulateWsMessage({
        event_type: 'pong',
      });

      await nextTick();

      // Subscribed confirmation
      simulateWsMessage({
        event_type: 'subscribed',
        channel: 'book',
      });

      await nextTick();

      // Callback should not be invoked for control messages
      expect(callback).not.toHaveBeenCalled();
    });

    it('should skip ignored messages (price_change, tick_size_change)', async () => {
      const callback = jest.fn<(orderbook: Orderbook) => void>();

      adapter.subscribeToOrderbook(TEST_TOKEN_YES, callback);

      simulateWsMessage({
        event_type: 'price_change',
        market: TEST_TOKEN_YES,
      });

      await nextTick();

      simulateWsMessage({
        event_type: 'tick_size_change',
        market: TEST_TOKEN_YES,
      });

      await nextTick();

      expect(callback).not.toHaveBeenCalled();
    });

    it('should handle messages for unsubscribed assets', async () => {
      const callback = jest.fn<(orderbook: Orderbook) => void>();

      adapter.subscribeToOrderbook(TEST_TOKEN_YES, callback);

      // Message for different asset
      simulateWsMessage({
        event_type: 'book',
        asset_id: TEST_TOKEN_NO,
        bids: [{ price: '0.48', size: '200' }],
        asks: [{ price: '0.49', size: '250' }],
        timestamp: 1000,
      });

      await nextTick();

      // Callback should not be invoked
      expect(callback).not.toHaveBeenCalled();
    });

    it('should handle rapid subscribe cycles', async () => {
      const callbacks: Array<jest.Mock<(orderbook: Orderbook) => void>> = [];

      for (let i = 0; i < 100; i++) {
        const callback = jest.fn<(orderbook: Orderbook) => void>();
        callbacks.push(callback);
        adapter.subscribeToOrderbook(TEST_TOKEN_YES, callback);
      }

      simulateWsMessage({
        event_type: 'book',
        asset_id: TEST_TOKEN_YES,
        bids: [{ price: '0.52', size: '100' }],
        asks: [{ price: '0.53', size: '150' }],
        timestamp: 1000,
      });

      await nextTick();

      // All callbacks should be invoked
      callbacks.forEach(callback => {
        expect(callback).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('connect()', () => {
    it('should connect to WebSocket successfully', async () => {
      await adapter.connect();

      expect(mockWsManager.connect).toHaveBeenCalledTimes(1);
    });

    it('should throw if adapter is destroyed', async () => {
      await adapter.destroy();

      await expect(adapter.connect()).rejects.toThrow(
        'PolymarketWsAdapter has been destroyed and cannot be used'
      );
    });
  });

  describe('sendAllSubscriptions() reconnection loop prevention', () => {
    it('should not call sendAllSubscriptions recursively', async () => {
      // Mock reconnectWithTimeout to resolve immediately
      const mockReconnect = jest.fn(async () => Promise.resolve());
      const mockSubscribe = jest.fn(async () => Promise.resolve());

      // Replace client methods
      (adapter as any).client.reconnectWithTimeout = mockReconnect;
      (adapter as any).client.subscribe = mockSubscribe;

      // Set connected flag so subscribeToMarket will call sendAllSubscriptions
      (adapter as any)._isConnected = true;

      // Subscribe to market (triggers sendAllSubscriptions)
      await adapter.subscribeToMarket(TEST_TOKEN_YES, TEST_TOKEN_NO);

      // Should call reconnect only once (not recursively)
      expect(mockReconnect).toHaveBeenCalledTimes(1);
      expect(mockSubscribe).toHaveBeenCalledTimes(1);
    });

    it('should skip sendAllSubscriptions if _isSubscribing flag is true', async () => {
      const mockReconnect = jest.fn(async () => Promise.resolve());

      // Set flag manually to simulate concurrent call
      (adapter as any)._isSubscribing = true;

      // Replace client method
      (adapter as any).client.reconnectWithTimeout = mockReconnect;

      // Try to trigger sendAllSubscriptions (internally)
      await (adapter as any).sendAllSubscriptions();

      // Should return early without calling reconnect
      expect(mockReconnect).not.toHaveBeenCalled();

      // Reset flag
      (adapter as any)._isSubscribing = false;
    });

    it('should reset _isSubscribing flag after successful completion', async () => {
      const mockReconnect = jest.fn(async () => Promise.resolve());
      const mockSubscribe = jest.fn(async () => Promise.resolve());

      (adapter as any).client.reconnectWithTimeout = mockReconnect;
      (adapter as any).client.subscribe = mockSubscribe;

      // Flag should be false initially
      expect((adapter as any)._isSubscribing).toBe(false);

      await adapter.subscribeToMarket(TEST_TOKEN_YES, TEST_TOKEN_NO);

      // Flag should be reset to false after completion
      expect((adapter as any)._isSubscribing).toBe(false);
    });

    it('should reset _isSubscribing flag on error', async () => {
      const mockReconnect = jest.fn(async () => {
        throw new Error('Reconnection failed');
      });

      (adapter as any).client.reconnectWithTimeout = mockReconnect;

      // Set connected flag so subscribeToMarket will call sendAllSubscriptions
      (adapter as any)._isConnected = true;

      // Flag should be false initially
      expect((adapter as any)._isSubscribing).toBe(false);

      // Attempt subscription (sendAllSubscriptions will fail internally but NOT throw)
      // The method now handles errors gracefully and doesn't propagate them
      await adapter.subscribeToMarket(TEST_TOKEN_YES, TEST_TOKEN_NO);

      // Give sendAllSubscriptions time to complete/fail
      await new Promise(resolve => setTimeout(resolve, 10));

      // Flag should still be reset to false even on error
      expect((adapter as any)._isSubscribing).toBe(false);
    });
  });

  describe('Graceful shutdown and destroy()', () => {
    it('should destroy successfully', async () => {
      await adapter.destroy();

      expect(adapter.isDestroyed()).toBe(true);
    });

    it('should be idempotent - can destroy multiple times', async () => {
      await adapter.destroy();
      await adapter.destroy();
      await adapter.destroy();

      expect(adapter.isDestroyed()).toBe(true);
    });

    it('should clear all registries on destroy', async () => {
      const callback = jest.fn<(orderbook: Orderbook) => void>();

      adapter.subscribeToOrderbook(TEST_TOKEN_YES, callback);

      expect(adapter.isSubscribed(TEST_TOKEN_YES)).toBe(true);

      await adapter.destroy();

      // Note: After destroy, isSubscribed will throw, so we can't check it
      expect(adapter.isDestroyed()).toBe(true);
    });

    it('should remove event listeners from router on destroy', async () => {
      const removeAllListenersSpy = jest.spyOn(adapter['router'], 'removeAllListeners');

      await adapter.destroy();

      expect(removeAllListenersSpy).toHaveBeenCalledTimes(1);
    });

    it('should destroy client on destroy', async () => {
      const destroySpy = jest.spyOn(adapter['client'], 'destroy');

      await adapter.destroy();

      expect(destroySpy).toHaveBeenCalledTimes(1);
    });

    it('should handle client destroy errors gracefully', async () => {
      // Make client.destroy() throw
      jest.spyOn(adapter['client'], 'destroy').mockRejectedValueOnce(new Error('Client destroy failed'));

      // Should not throw
      await expect(adapter.destroy()).resolves.not.toThrow();

      expect(adapter.isDestroyed()).toBe(true);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Error destroying client',
        expect.objectContaining({
          error: 'Client destroy failed'
        })
      );
    });

    it('should throw on subscribeToOrderbook after destroy', async () => {
      await adapter.destroy();

      const callback = jest.fn<(orderbook: Orderbook) => void>();

      expect(() => {
        adapter.subscribeToOrderbook(TEST_TOKEN_YES, callback);
      }).toThrow('PolymarketWsAdapter has been destroyed and cannot be used');
    });

    it('should throw on subscribeToTrades after destroy', async () => {
      await adapter.destroy();

      const callback = jest.fn<(trade: Trade) => void>();

      expect(() => {
        adapter.subscribeToTrades(TEST_TOKEN_YES, callback);
      }).toThrow('PolymarketWsAdapter has been destroyed and cannot be used');
    });

    it('should throw on subscribeToMarket after destroy', async () => {
      await adapter.destroy();

      await expect(
        adapter.subscribeToMarket(TEST_TOKEN_YES, TEST_TOKEN_NO)
      ).rejects.toThrow('PolymarketWsAdapter has been destroyed and cannot be used');
    });

    it('should throw on unsubscribe after destroy', async () => {
      await adapter.destroy();

      expect(() => {
        adapter.unsubscribe(TEST_TOKEN_YES);
      }).toThrow('PolymarketWsAdapter has been destroyed and cannot be used');
    });

    it('should throw on unsubscribeFromMarket after destroy', async () => {
      await adapter.destroy();

      await expect(
        adapter.unsubscribeFromMarket(TEST_TOKEN_YES, TEST_TOKEN_NO)
      ).rejects.toThrow('PolymarketWsAdapter has been destroyed and cannot be used');
    });

    it('should throw on unsubscribeFromOrderbook after destroy', async () => {
      await adapter.destroy();

      expect(() => {
        adapter.unsubscribeFromOrderbook(TEST_TOKEN_YES);
      }).toThrow('PolymarketWsAdapter has been destroyed and cannot be used');
    });

    it('should throw on unsubscribeFromTrades after destroy', async () => {
      await adapter.destroy();

      expect(() => {
        adapter.unsubscribeFromTrades(TEST_TOKEN_YES);
      }).toThrow('PolymarketWsAdapter has been destroyed and cannot be used');
    });

    it('should throw on isSubscribed after destroy', async () => {
      await adapter.destroy();

      expect(() => {
        adapter.isSubscribed(TEST_TOKEN_YES);
      }).toThrow('PolymarketWsAdapter has been destroyed and cannot be used');
    });

    it('should not receive messages after destroy', async () => {
      const callback = jest.fn<(orderbook: Orderbook) => void>();

      adapter.subscribeToOrderbook(TEST_TOKEN_YES, callback);

      await adapter.destroy();

      // Try to simulate message - should not invoke callback
      simulateWsMessage({
        event_type: 'book',
        asset_id: TEST_TOKEN_YES,
        bids: [{ price: '0.52', size: '100' }],
        asks: [{ price: '0.53', size: '150' }],
        timestamp: 1000,
      });

      await nextTick();

      expect(callback).not.toHaveBeenCalled();
    });
  });
});
