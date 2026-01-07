/**
 * End-to-End tests for PolymarketWsAdapter
 *
 * @remarks
 * These tests verify the complete lifecycle and real-world usage scenarios:
 * 1. Adapter creation and initialization
 * 2. WebSocket connection and subscription
 * 3. Data flow through all layers (Client → Router → Registry → Callbacks)
 * 4. Reconnection and resubscription
 * 5. Error recovery
 * 6. Graceful shutdown
 *
 * Unlike unit and integration tests, these E2E tests simulate complete
 * real-world scenarios from start to finish.
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

describe('PolymarketWsAdapter - End-to-End Tests', () => {
  let adapter: PolymarketWsAdapter;
  let mockWsManager: Partial<WebSocketManager>;
  let mockLogger: ILogger;
  let wsMessageListener: ((data: Buffer) => void) | null = null;
  let wsConnectedListener: (() => void) | null = null;
  let wsDisconnectedListener: (() => void) | null = null;
  let wsErrorListener: ((error: Error) => void) | null = null;

  const TEST_TOKEN_YES = '67704255197116168826604911233626301865010283966205730455742704536521111535950';
  const TEST_TOKEN_NO = '48331043336612883890405840694803087191347769269211396801222748316064917524501';

  beforeEach(() => {
    wsMessageListener = null;
    wsConnectedListener = null;
    wsDisconnectedListener = null;
    wsErrorListener = null;

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

    // Mock WebSocketManager with event capture
    mockWsManager = {
      on: jest.fn<(event: string | symbol, listener: (...args: any[]) => void) => WebSocketManager>((event: string | symbol, listener: any) => {
        if (event === 'message') {
          wsMessageListener = listener;
        } else if (event === 'connected') {
          wsConnectedListener = listener;
        } else if (event === 'disconnected') {
          wsDisconnectedListener = listener;
        } else if (event === 'error') {
          wsErrorListener = listener;
        }
        return mockWsManager as WebSocketManager;
      }),
      off: jest.fn<(event: string | symbol, listener: (...args: any[]) => void) => WebSocketManager>(() => mockWsManager as WebSocketManager),
      once: jest.fn<(event: string | symbol, listener: (...args: any[]) => void) => WebSocketManager>(() => mockWsManager as WebSocketManager),
      emit: jest.fn<(event: string | symbol, ...args: any[]) => boolean>(() => true),
      connect: jest.fn(async () => Promise.resolve()),
      disconnect: jest.fn(async () => Promise.resolve()),
      reconnectForNewSubscription: jest.fn(async () => Promise.resolve()),
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
    const buffer = Buffer.from(JSON.stringify(message));
    wsMessageListener(buffer);
  }

  /**
   * Helper: Simulate WebSocket connection
   */
  function simulateWsConnect(): void {
    if (wsConnectedListener) {
      wsConnectedListener();
    }
  }

  /**
   * Helper: Simulate WebSocket disconnection
   */
  function simulateWsDisconnect(): void {
    if (wsDisconnectedListener) {
      wsDisconnectedListener();
    }
  }

  /**
   * Helper: Simulate WebSocket error
   */
  function simulateWsError(error: Error): void {
    if (wsErrorListener) {
      wsErrorListener(error);
    }
  }

  describe('Complete lifecycle scenario', () => {
    it('should handle full lifecycle: subscribe → data → unsubscribe → destroy', async () => {
      // Track received data
      const orderbookUpdates: Orderbook[] = [];
      const tradeUpdates: Trade[] = [];

      // Step 1: Subscribe to orderbook and trades
      adapter.subscribeToOrderbook(TEST_TOKEN_YES, (orderbook) => {
        orderbookUpdates.push(orderbook);
      });

      adapter.subscribeToTrades(TEST_TOKEN_YES, (trade) => {
        tradeUpdates.push(trade);
      });

      expect(adapter.isSubscribed(TEST_TOKEN_YES)).toBe(true);

      // Step 2: Simulate receiving data
      simulateWsMessage({
        event_type: 'book',
        asset_id: TEST_TOKEN_YES,
        bids: [{ price: '0.52', size: '100' }],
        asks: [{ price: '0.53', size: '150' }],
        timestamp: 1000,
      });

      simulateWsMessage({
        event_type: 'trade',
        asset_id: TEST_TOKEN_YES,
        price: '0.52',
        size: '50',
        side: 'BUY',
        timestamp: 1001,
      });

      await nextTick();

      // Verify data received
      expect(orderbookUpdates.length).toBe(1);
      expect(tradeUpdates.length).toBe(1);
      expect(orderbookUpdates[0].marketId).toBe(TEST_TOKEN_YES);
      expect(tradeUpdates[0].marketId).toBe(TEST_TOKEN_YES);

      // Step 3: Unsubscribe from orderbook only
      adapter.unsubscribeFromOrderbook(TEST_TOKEN_YES);

      // Verify still subscribed to trades
      expect(adapter.isSubscribed(TEST_TOKEN_YES)).toBe(true);

      // Step 4: Send more data - only trades should be received
      simulateWsMessage({
        event_type: 'book',
        asset_id: TEST_TOKEN_YES,
        bids: [{ price: '0.54', size: '200' }],
        asks: [{ price: '0.55', size: '250' }],
        timestamp: 2000,
      });

      simulateWsMessage({
        event_type: 'trade',
        asset_id: TEST_TOKEN_YES,
        price: '0.54',
        size: '75',
        side: 'SELL',
        timestamp: 2001,
      });

      await nextTick();

      expect(orderbookUpdates.length).toBe(1); // Still 1, not updated
      expect(tradeUpdates.length).toBe(2); // Incremented

      // Step 5: Unsubscribe completely
      adapter.unsubscribe(TEST_TOKEN_YES);

      expect(adapter.isSubscribed(TEST_TOKEN_YES)).toBe(false);

      // Step 6: Destroy adapter
      adapter.destroy();

      expect(adapter.isDestroyed()).toBe(true);
    });
  });

  describe('Multi-market scenario', () => {
    it('should handle multiple markets simultaneously', async () => {
      const yesOrderbooks: Orderbook[] = [];
      const noOrderbooks: Orderbook[] = [];
      const yesTrades: Trade[] = [];
      const noTrades: Trade[] = [];

      // Subscribe to both YES and NO tokens
      adapter.subscribeToOrderbook(TEST_TOKEN_YES, (ob) => yesOrderbooks.push(ob));
      adapter.subscribeToOrderbook(TEST_TOKEN_NO, (ob) => noOrderbooks.push(ob));
      adapter.subscribeToTrades(TEST_TOKEN_YES, (trade) => yesTrades.push(trade));
      adapter.subscribeToTrades(TEST_TOKEN_NO, (trade) => noTrades.push(trade));

      // Simulate data for both tokens
      simulateWsMessage({
        event_type: 'book',
        asset_id: TEST_TOKEN_YES,
        bids: [{ price: '0.60', size: '100' }],
        asks: [{ price: '0.61', size: '100' }],
        timestamp: 1000,
      });

      simulateWsMessage({
        event_type: 'book',
        asset_id: TEST_TOKEN_NO,
        bids: [{ price: '0.40', size: '200' }],
        asks: [{ price: '0.41', size: '200' }],
        timestamp: 1001,
      });

      simulateWsMessage({
        event_type: 'trade',
        asset_id: TEST_TOKEN_YES,
        price: '0.60',
        size: '50',
        side: 'BUY',
      });

      simulateWsMessage({
        event_type: 'trade',
        asset_id: TEST_TOKEN_NO,
        price: '0.40',
        size: '75',
        side: 'SELL',
      });

      await nextTick();

      // Verify correct routing
      expect(yesOrderbooks.length).toBe(1);
      expect(noOrderbooks.length).toBe(1);
      expect(yesTrades.length).toBe(1);
      expect(noTrades.length).toBe(1);

      expect(yesOrderbooks[0].bids[0].price.value).toBe(0.60);
      expect(noOrderbooks[0].bids[0].price.value).toBe(0.40);
      expect(yesTrades[0].side).toBe('BUY');
      expect(noTrades[0].side).toBe('SELL');
    });
  });

  describe('Reconnection scenario', () => {
    it('should handle disconnect and reconnect gracefully', async () => {
      const orderbookUpdates: Orderbook[] = [];

      // Subscribe
      adapter.subscribeToOrderbook(TEST_TOKEN_YES, (ob) => orderbookUpdates.push(ob));

      // Simulate connection
      simulateWsConnect();

      // Receive data
      simulateWsMessage({
        event_type: 'book',
        asset_id: TEST_TOKEN_YES,
        bids: [{ price: '0.50', size: '100' }],
        asks: [{ price: '0.51', size: '100' }],
        timestamp: 1000,
      });

      await nextTick();

      expect(orderbookUpdates.length).toBe(1);

      // Simulate disconnection
      simulateWsDisconnect();

      // Simulate reconnection
      simulateWsConnect();

      // Data should continue flowing
      simulateWsMessage({
        event_type: 'book',
        asset_id: TEST_TOKEN_YES,
        bids: [{ price: '0.52', size: '200' }],
        asks: [{ price: '0.53', size: '200' }],
        timestamp: 2000,
      });

      await nextTick();

      expect(orderbookUpdates.length).toBe(2);
    });
  });

  describe('Error recovery scenario', () => {
    it('should continue operating after WebSocket errors', async () => {
      const orderbookUpdates: Orderbook[] = [];

      adapter.subscribeToOrderbook(TEST_TOKEN_YES, (ob) => orderbookUpdates.push(ob));

      // Simulate WebSocket error
      simulateWsError(new Error('Connection timeout'));

      // Should still be able to receive data after error
      simulateWsMessage({
        event_type: 'book',
        asset_id: TEST_TOKEN_YES,
        bids: [{ price: '0.50', size: '100' }],
        asks: [{ price: '0.51', size: '100' }],
        timestamp: 1000,
      });

      await nextTick();

      expect(orderbookUpdates.length).toBe(1);
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should isolate errors in one callback from affecting others', async () => {
      const callback1 = jest.fn(() => {
        throw new Error('Callback 1 error');
      });
      const callback2 = jest.fn();
      const callback3 = jest.fn();

      adapter.subscribeToOrderbook(TEST_TOKEN_YES, callback1);
      adapter.subscribeToOrderbook(TEST_TOKEN_YES, callback2);
      adapter.subscribeToOrderbook(TEST_TOKEN_YES, callback3);

      simulateWsMessage({
        event_type: 'book',
        asset_id: TEST_TOKEN_YES,
        bids: [{ price: '0.50', size: '100' }],
        asks: [{ price: '0.51', size: '100' }],
        timestamp: 1000,
      });

      await nextTick();

      // All should be called despite error in callback1
      expect(callback1).toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
      expect(callback3).toHaveBeenCalled();
    });
  });

  describe('Batch data processing scenario', () => {
    it('should handle batch of mixed message types', async () => {
      const orderbookUpdates: Orderbook[] = [];
      const tradeUpdates: Trade[] = [];

      adapter.subscribeToOrderbook(TEST_TOKEN_YES, (ob) => orderbookUpdates.push(ob));
      adapter.subscribeToTrades(TEST_TOKEN_YES, (trade) => tradeUpdates.push(trade));

      // Simulate batch message with multiple types
      const batchMessage = [
        {
          event_type: 'book',
          asset_id: TEST_TOKEN_YES,
          bids: [{ price: '0.50', size: '100' }],
          asks: [{ price: '0.51', size: '100' }],
          timestamp: 1000,
        },
        {
          event_type: 'trade',
          asset_id: TEST_TOKEN_YES,
          price: '0.50',
          size: '50',
          side: 'BUY',
          timestamp: 1500,
        },
        {
          event_type: 'book',
          asset_id: TEST_TOKEN_YES,
          bids: [{ price: '0.51', size: '150' }],
          asks: [{ price: '0.52', size: '150' }],
          timestamp: 2000,
        },
        {
          event_type: 'trade',
          asset_id: TEST_TOKEN_YES,
          price: '0.51',
          size: '75',
          side: 'SELL',
          timestamp: 2500,
        },
      ];

      const buffer = Buffer.from(JSON.stringify(batchMessage));
      wsMessageListener?.(buffer);

      await nextTick();

      expect(orderbookUpdates.length).toBe(2);
      expect(tradeUpdates.length).toBe(2);
    });
  });

  describe('Performance scenario', () => {
    it('should handle high-frequency updates efficiently', async () => {
      const updates: Orderbook[] = [];

      adapter.subscribeToOrderbook(TEST_TOKEN_YES, (ob) => updates.push(ob));

      // Simulate 100 rapid updates
      for (let i = 0; i < 100; i++) {
        const bidPrice = (0.50 + i * 0.001).toFixed(3);
        const askPrice = (0.51 + i * 0.001).toFixed(3);

        simulateWsMessage({
          event_type: 'book',
          asset_id: TEST_TOKEN_YES,
          bids: [{ price: bidPrice, size: '100' }],
          asks: [{ price: askPrice, size: '100' }],
          timestamp: 1000 + i,
        });
      }

      await nextTick();

      expect(updates.length).toBe(100);
      expect(updates[0].bids[0].price.value).toBeCloseTo(0.50, 3);
      expect(updates[99].bids[0].price.value).toBeCloseTo(0.599, 3);
    });
  });

  describe('Real-world scenario: Trading bot lifecycle', () => {
    it('should simulate complete trading bot lifecycle', async () => {
      // Scenario: Bot starts, subscribes to market, receives data, makes decisions, shuts down

      const orderbookHistory: Orderbook[] = [];
      const tradeHistory: Trade[] = [];
      let currentSpread = 0;

      // Step 1: Bot initialization - subscribe to market data
      adapter.subscribeToOrderbook(TEST_TOKEN_YES, (orderbook) => {
        orderbookHistory.push(orderbook);

        const spread = orderbook.getSpread();
        currentSpread = spread ? spread.width() : 0;

        // Bot logic: Track spread
        if (currentSpread < 0.02) {
          // Tight spread - good for market making
        }
      });

      adapter.subscribeToTrades(TEST_TOKEN_YES, (trade) => {
        tradeHistory.push(trade);

        // Bot logic: Monitor trade flow
        if (trade.side === 'BUY') {
          // Buying pressure detected
        }
      });

      // Step 2: Market opens - initial orderbook
      simulateWsMessage({
        event_type: 'book',
        asset_id: TEST_TOKEN_YES,
        bids: [
          { price: '0.50', size: '1000' },
          { price: '0.49', size: '2000' },
        ],
        asks: [
          { price: '0.51', size: '1000' },
          { price: '0.52', size: '2000' },
        ],
        timestamp: 1000,
      });

      await nextTick();

      expect(orderbookHistory.length).toBe(1);
      expect(currentSpread).toBeCloseTo(0.01, 5); // 0.51 - 0.50

      // Step 3: Market activity - trades occur
      simulateWsMessage({
        event_type: 'trade',
        asset_id: TEST_TOKEN_YES,
        price: '0.51',
        size: '500',
        side: 'BUY',
        timestamp: 1001,
      });

      await nextTick();

      expect(tradeHistory.length).toBe(1);

      // Step 4: Orderbook updates
      simulateWsMessage({
        event_type: 'book',
        asset_id: TEST_TOKEN_YES,
        bids: [
          { price: '0.51', size: '500' },
          { price: '0.50', size: '1000' },
        ],
        asks: [
          { price: '0.52', size: '1500' },
          { price: '0.53', size: '2000' },
        ],
        timestamp: 1002,
      });

      await nextTick();

      expect(orderbookHistory.length).toBe(2);
      expect(currentSpread).toBeCloseTo(0.01, 5); // 0.52 - 0.51

      // Step 5: Bot shutdown
      adapter.unsubscribe(TEST_TOKEN_YES);
      adapter.destroy();

      // Verify no more data received after shutdown
      simulateWsMessage({
        event_type: 'book',
        asset_id: TEST_TOKEN_YES,
        bids: [{ price: '0.55', size: '100' }],
        asks: [{ price: '0.56', size: '100' }],
        timestamp: 2000,
      });

      await nextTick();

      expect(orderbookHistory.length).toBe(2); // Still 2, not incremented
      expect(adapter.isDestroyed()).toBe(true);
    });
  });

  describe('Edge cases in real usage', () => {
    it('should handle subscription before any data arrives', async () => {
      const updates: Orderbook[] = [];

      adapter.subscribeToOrderbook(TEST_TOKEN_YES, (ob) => updates.push(ob));

      // No data yet
      expect(updates.length).toBe(0);
      expect(adapter.isSubscribed(TEST_TOKEN_YES)).toBe(true);

      // Data arrives later
      simulateWsMessage({
        event_type: 'book',
        asset_id: TEST_TOKEN_YES,
        bids: [{ price: '0.50', size: '100' }],
        asks: [{ price: '0.51', size: '100' }],
        timestamp: 1000,
      });

      await nextTick();

      expect(updates.length).toBe(1);
    });

    it('should handle late subscription after data already flowing', async () => {
      const earlyUpdates: Orderbook[] = [];
      const lateUpdates: Orderbook[] = [];

      // Early subscriber
      adapter.subscribeToOrderbook(TEST_TOKEN_YES, (ob) => earlyUpdates.push(ob));

      // Send some data
      simulateWsMessage({
        event_type: 'book',
        asset_id: TEST_TOKEN_YES,
        bids: [{ price: '0.50', size: '100' }],
        asks: [{ price: '0.51', size: '100' }],
        timestamp: 1000,
      });

      await nextTick();

      expect(earlyUpdates.length).toBe(1);
      expect(lateUpdates.length).toBe(0);

      // Late subscriber joins
      adapter.subscribeToOrderbook(TEST_TOKEN_YES, (ob) => lateUpdates.push(ob));

      // More data
      simulateWsMessage({
        event_type: 'book',
        asset_id: TEST_TOKEN_YES,
        bids: [{ price: '0.52', size: '200' }],
        asks: [{ price: '0.53', size: '200' }],
        timestamp: 2000,
      });

      await nextTick();

      expect(earlyUpdates.length).toBe(2);
      expect(lateUpdates.length).toBe(1); // Only receives updates after subscription
    });

    it('should handle unsubscribe and resubscribe', async () => {
      const updates: Orderbook[] = [];

      // Subscribe
      adapter.subscribeToOrderbook(TEST_TOKEN_YES, (ob) => updates.push(ob));

      simulateWsMessage({
        event_type: 'book',
        asset_id: TEST_TOKEN_YES,
        bids: [{ price: '0.50', size: '100' }],
        asks: [{ price: '0.51', size: '100' }],
        timestamp: 1000,
      });

      await nextTick();

      expect(updates.length).toBe(1);

      // Unsubscribe
      adapter.unsubscribe(TEST_TOKEN_YES);

      simulateWsMessage({
        event_type: 'book',
        asset_id: TEST_TOKEN_YES,
        bids: [{ price: '0.52', size: '200' }],
        asks: [{ price: '0.53', size: '200' }],
        timestamp: 2000,
      });

      await nextTick();

      expect(updates.length).toBe(1); // No new update

      // Resubscribe
      adapter.subscribeToOrderbook(TEST_TOKEN_YES, (ob) => updates.push(ob));

      simulateWsMessage({
        event_type: 'book',
        asset_id: TEST_TOKEN_YES,
        bids: [{ price: '0.54', size: '300' }],
        asks: [{ price: '0.55', size: '300' }],
        timestamp: 3000,
      });

      await nextTick();

      expect(updates.length).toBe(2); // New update received
    });
  });
});
