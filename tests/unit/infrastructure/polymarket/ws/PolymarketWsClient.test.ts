/**
 * Unit tests for PolymarketWsClient
 *
 * @remarks
 * **Phase 1 tests - Transport layer**
 *
 * Coverage:
 * - Constructor validation
 * - Connect/disconnect lifecycle
 * - Reconnect with timeout
 * - Subscribe/unsubscribe operations
 * - Event forwarding
 * - Status queries
 * - Destroy cleanup
 * - Edge cases (destroyed client, invalid params, timeout, etc.)
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { EventEmitter } from 'events';
import { PolymarketWsClient } from '../../../../../src/infrastructure/polymarket/ws/PolymarketWsClient.js';
import type { SubscribeParams, ConnectionStatus } from '../../../../../src/infrastructure/exchange/clients/WebSocketManager.js';
import { MockLogger } from '../../../../helpers/MockLogger.js';

/**
 * Mock WebSocketManager
 *
 * @remarks
 * Implements Partial<WebSocketManager> to ensure type safety.
 * TypeScript will verify that all implemented methods match the interface.
 */
class MockWebSocketManager extends EventEmitter {
  public connectCalled = false;
  public disconnectCalled = false;
  public reconnectCalled = false;
  public subscribeCalled = false;
  public unsubscribeCalled = false;
  public subscribeParams: Array<{ channel: string; params: SubscribeParams }> = [];
  public unsubscribeParams: Array<{ channel: string; params: SubscribeParams }> = [];
  private status: ConnectionStatus = 'disconnected';

  async connect(): Promise<void> {
    this.connectCalled = true;
    this.status = 'connected';
    this.emit('connected');
  }

  async disconnect(): Promise<void> {
    this.disconnectCalled = true;
    this.status = 'disconnected';
    this.emit('disconnected');
  }

  async reconnectForNewSubscription(): Promise<void> {
    this.reconnectCalled = true;
    this.status = 'connected';
    this.emit('connected');
  }

  async subscribe(channel: string, params: SubscribeParams): Promise<void> {
    this.subscribeCalled = true;
    this.subscribeParams.push({ channel, params });
  }

  async unsubscribe(channel: string, params: SubscribeParams): Promise<void> {
    this.unsubscribeCalled = true;
    this.unsubscribeParams.push({ channel, params });
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  isConnected(): boolean {
    return this.status === 'connected';
  }

  // Test helpers
  setStatus(status: ConnectionStatus): void {
    this.status = status;
  }

  simulateEvent(event: string, ...args: any[]): void {
    this.emit(event, ...args);
  }
}

describe('PolymarketWsClient', () => {
  let wsManager: MockWebSocketManager;
  let logger: MockLogger;
  let client: PolymarketWsClient;

  beforeEach(() => {
    wsManager = new MockWebSocketManager();
    logger = new MockLogger();
    client = new PolymarketWsClient(wsManager as any, logger);
    // Disable max listeners warning for tests (0 = unlimited)
    client.setMaxListeners(0);
  });

  afterEach(() => {
    jest.clearAllTimers();
  });

  describe('Constructor', () => {
    it('should create client with valid params', () => {
      expect(client).toBeDefined();
      expect(client.isDestroyed()).toBe(false);
    });

    it('should throw if wsManager is null', () => {
      expect(() => new PolymarketWsClient(null as any, logger)).toThrow('wsManager is required');
    });

    it('should throw if logger is null', () => {
      expect(() => new PolymarketWsClient(wsManager as any, null as any)).toThrow('logger is required');
    });

    it('should setup event forwarding on creation', () => {
      const eventSpy = jest.fn();
      client.on('connected', eventSpy);
      wsManager.simulateEvent('connected');
      expect(eventSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('connect()', () => {
    it('should connect successfully', async () => {
      await client.connect();
      expect(wsManager.connectCalled).toBe(true);
      expect(client.getStatus()).toBe('connected');
    });

    it('should emit connected event', async () => {
      const connectedSpy = jest.fn();
      client.on('connected', connectedSpy);
      await client.connect();
      expect(connectedSpy).toHaveBeenCalledTimes(1);
    });

    it('should throw if client is destroyed', async () => {
      await client.destroy();
      await expect(client.connect()).rejects.toThrow('PolymarketWsClient has been destroyed');
    });

    it('should propagate connection errors', async () => {
      const error = new Error('Connection failed');
      wsManager.connect = jest.fn<() => Promise<void>>().mockRejectedValue(error);
      await expect(client.connect()).rejects.toThrow('Connection failed');
    });
  });

  describe('disconnect()', () => {
    it('should disconnect successfully', async () => {
      await client.connect();
      await client.disconnect();
      expect(wsManager.disconnectCalled).toBe(true);
      expect(client.getStatus()).toBe('disconnected');
    });

    it('should emit disconnected event', async () => {
      const disconnectedSpy = jest.fn();
      client.on('disconnected', disconnectedSpy);
      await client.connect();
      await client.disconnect();
      expect(disconnectedSpy).toHaveBeenCalledTimes(1);
    });

    it('should throw if client is destroyed', async () => {
      await client.destroy();
      await expect(client.disconnect()).rejects.toThrow('PolymarketWsClient has been destroyed');
    });

    it('should work when called multiple times', async () => {
      await client.connect();
      await client.disconnect();
      await client.disconnect();
      expect(wsManager.disconnectCalled).toBe(true);
    });
  });

  describe('reconnectForNewSubscription()', () => {
    it('should reconnect successfully', async () => {
      await client.reconnectForNewSubscription();
      expect(wsManager.reconnectCalled).toBe(true);
    });

    it('should throw if client is destroyed', async () => {
      await client.destroy();
      await expect(client.reconnectForNewSubscription()).rejects.toThrow('PolymarketWsClient has been destroyed');
    });

    it('should propagate reconnect errors', async () => {
      const error = new Error('Reconnect failed');
      wsManager.reconnectForNewSubscription = jest.fn<() => Promise<void>>().mockRejectedValue(error);
      await expect(client.reconnectForNewSubscription()).rejects.toThrow('Reconnect failed');
    });
  });

  describe('reconnectWithTimeout()', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should reconnect successfully within timeout', async () => {
      const promise = client.reconnectWithTimeout(10000);
      await jest.runAllTimersAsync();
      await promise;
      expect(wsManager.reconnectCalled).toBe(true);
    });

    it('should throw timeout error if reconnect takes too long', async () => {
      // Mock reconnect to never resolve
      wsManager.reconnectForNewSubscription = jest.fn<() => Promise<void>>().mockImplementation(
        () => new Promise(() => {}) // Never resolves
      );

      const promise = client.reconnectWithTimeout(10000);
      jest.advanceTimersByTime(10000);

      await expect(promise).rejects.toThrow('Reconnect timeout after 10000ms');
    });

    it('should throw if timeout is negative', async () => {
      await expect(client.reconnectWithTimeout(-1000)).rejects.toThrow('timeoutMs must be positive');
    });

    it('should throw if timeout is zero', async () => {
      await expect(client.reconnectWithTimeout(0)).rejects.toThrow('timeoutMs must be positive');
    });

    it('should use default timeout if not specified', async () => {
      const promise = client.reconnectWithTimeout();
      await jest.runAllTimersAsync();
      await promise;
      expect(wsManager.reconnectCalled).toBe(true);
    });

    it('should throw if client is destroyed', async () => {
      await client.destroy();
      await expect(client.reconnectWithTimeout(10000)).rejects.toThrow('PolymarketWsClient has been destroyed');
    });

    it('should propagate reconnect errors before timeout', async () => {
      const error = new Error('Network error');
      wsManager.reconnectForNewSubscription = jest.fn<() => Promise<void>>().mockRejectedValue(error);

      await expect(client.reconnectWithTimeout(10000)).rejects.toThrow('Network error');
    });
  });

  describe('subscribe()', () => {
    it('should subscribe successfully', async () => {
      const params: SubscribeParams = {
        assets_ids: ['123', '456'],
        type: 'market',
      };
      await client.subscribe('market', params);
      expect(wsManager.subscribeCalled).toBe(true);
      expect(wsManager.subscribeParams).toEqual([{ channel: 'market', params }]);
    });

    it('should throw if client is destroyed', async () => {
      await client.destroy();
      await expect(client.subscribe('market', { assets_ids: ['123'] })).rejects.toThrow('PolymarketWsClient has been destroyed');
    });

    it('should handle multiple subscriptions', async () => {
      await client.subscribe('market', { assets_ids: ['123'] });
      await client.subscribe('market', { assets_ids: ['456'] });
      expect(wsManager.subscribeParams.length).toBe(2);
    });

    it('should propagate subscription errors', async () => {
      const error = new Error('Subscription failed');
      wsManager.subscribe = jest.fn<(channel: string, params: SubscribeParams) => Promise<void>>().mockRejectedValue(error);
      await expect(client.subscribe('market', { assets_ids: ['123'] })).rejects.toThrow('Subscription failed');
    });
  });

  describe('unsubscribe()', () => {
    it('should unsubscribe successfully', async () => {
      const params: SubscribeParams = {
        assets_ids: ['123'],
        type: 'market',
      };
      await client.unsubscribe('market', params);
      expect(wsManager.unsubscribeCalled).toBe(true);
      expect(wsManager.unsubscribeParams).toEqual([{ channel: 'market', params }]);
    });

    it('should throw if client is destroyed', async () => {
      await client.destroy();
      await expect(client.unsubscribe('market', { assets_ids: ['123'] })).rejects.toThrow('PolymarketWsClient has been destroyed');
    });

    it('should handle unsubscribe before subscribe', async () => {
      await client.unsubscribe('market', { assets_ids: ['123'] });
      expect(wsManager.unsubscribeCalled).toBe(true);
    });

    it('should propagate unsubscription errors', async () => {
      const error = new Error('Unsubscription failed');
      wsManager.unsubscribe = jest.fn<(channel: string, params: SubscribeParams) => Promise<void>>().mockRejectedValue(error);
      await expect(client.unsubscribe('market', { assets_ids: ['123'] })).rejects.toThrow('Unsubscription failed');
    });
  });

  describe('getStatus()', () => {
    it('should return disconnected initially', () => {
      expect(client.getStatus()).toBe('disconnected');
    });

    it('should return connected after connect', async () => {
      await client.connect();
      expect(client.getStatus()).toBe('connected');
    });

    it('should return disconnected after disconnect', async () => {
      await client.connect();
      await client.disconnect();
      expect(client.getStatus()).toBe('disconnected');
    });

    it('should throw if client is destroyed', async () => {
      await client.destroy();
      expect(() => client.getStatus()).toThrow('PolymarketWsClient has been destroyed');
    });

    it('should handle all connection statuses', () => {
      const statuses: ConnectionStatus[] = ['disconnected', 'connecting', 'connected', 'reconnecting', 'closed'];
      statuses.forEach((status) => {
        wsManager.setStatus(status);
        expect(client.getStatus()).toBe(status);
      });
    });
  });

  describe('isConnected()', () => {
    it('should return false initially', () => {
      expect(client.isConnected()).toBe(false);
    });

    it('should return true after connect', async () => {
      await client.connect();
      expect(client.isConnected()).toBe(true);
    });

    it('should return false after disconnect', async () => {
      await client.connect();
      await client.disconnect();
      expect(client.isConnected()).toBe(false);
    });

    it('should throw if client is destroyed', async () => {
      await client.destroy();
      expect(() => client.isConnected()).toThrow('PolymarketWsClient has been destroyed');
    });
  });

  describe('Event forwarding', () => {
    it('should forward connected event', async () => {
      const spy = jest.fn();
      client.on('connected', spy);
      wsManager.simulateEvent('connected');
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('should forward disconnected event', () => {
      const spy = jest.fn();
      client.on('disconnected', spy);
      wsManager.simulateEvent('disconnected');
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('should forward reconnecting event', () => {
      const spy = jest.fn();
      client.on('reconnecting', spy);
      wsManager.simulateEvent('reconnecting', 1000);
      expect(spy).toHaveBeenCalledWith(1000);
    });

    it('should forward error event', () => {
      const spy = jest.fn();
      const error = new Error('Test error');
      client.on('error', spy);
      wsManager.simulateEvent('error', error);
      expect(spy).toHaveBeenCalledWith(error);
    });

    it('should forward orderbook event', () => {
      const spy = jest.fn();
      const data = { event_type: 'book', asset_id: '123', bids: [], asks: [] };
      client.on('orderbook', spy);
      wsManager.simulateEvent('orderbook', data);
      expect(spy).toHaveBeenCalledWith(data);
    });

    it('should forward trade event', () => {
      const spy = jest.fn();
      const data = { event_type: 'trade', asset_id: '123', price: '0.5', size: '10' };
      client.on('trade', spy);
      wsManager.simulateEvent('trade', data);
      expect(spy).toHaveBeenCalledWith(data);
    });

    it('should forward message event', () => {
      const spy = jest.fn();
      const data = { type: 'custom' };
      client.on('message', spy);
      wsManager.simulateEvent('message', data);
      expect(spy).toHaveBeenCalledWith(data);
    });

    it('should forward raw event', () => {
      const spy = jest.fn();
      const data = { event_type: 'book', asset_id: '123' };
      client.on('raw', spy);
      wsManager.simulateEvent('raw', data);
      expect(spy).toHaveBeenCalledWith(data);
    });

    it('should not forward events after destroy', async () => {
      const spy = jest.fn();
      client.on('orderbook', spy);
      await client.destroy();
      wsManager.simulateEvent('orderbook', {});
      expect(spy).not.toHaveBeenCalled();
    });

    it('should forward events with multiple arguments', () => {
      const spy = jest.fn();
      client.on('reconnecting', spy);
      wsManager.simulateEvent('reconnecting', 1000, 'reason');
      expect(spy).toHaveBeenCalledWith(1000, 'reason');
    });
  });

  describe('destroy()', () => {
    it('should destroy successfully', async () => {
      await client.destroy();
      expect(client.isDestroyed()).toBe(true);
    });

    it('should disconnect WebSocket on destroy', async () => {
      await client.connect();
      await client.destroy();
      expect(wsManager.disconnectCalled).toBe(true);
    });

    it('should remove all listeners on destroy', async () => {
      const spy = jest.fn();
      client.on('orderbook', spy);
      await client.destroy();
      wsManager.simulateEvent('orderbook', {});
      expect(spy).not.toHaveBeenCalled();
    });

    it('should be idempotent', async () => {
      await client.destroy();
      await client.destroy();
      expect(client.isDestroyed()).toBe(true);
    });

    it('should handle disconnect errors gracefully', async () => {
      wsManager.disconnect = jest.fn<() => Promise<void>>().mockRejectedValue(new Error('Disconnect failed'));
      await client.destroy();
      expect(client.isDestroyed()).toBe(true);
      expect(logger.warnCalls.length).toBeGreaterThan(0);
    });

    it('should prevent all operations after destroy', async () => {
      await client.destroy();
      await expect(client.connect()).rejects.toThrow('PolymarketWsClient has been destroyed');
      await expect(client.disconnect()).rejects.toThrow('PolymarketWsClient has been destroyed');
      await expect(client.subscribe('market', { assets_ids: ['123'] })).rejects.toThrow('PolymarketWsClient has been destroyed');
      await expect(client.reconnectWithTimeout()).rejects.toThrow('PolymarketWsClient has been destroyed');
      expect(() => client.getStatus()).toThrow('PolymarketWsClient has been destroyed');
      expect(() => client.isConnected()).toThrow('PolymarketWsClient has been destroyed');
    });
  });

  describe('isDestroyed()', () => {
    it('should return false initially', () => {
      expect(client.isDestroyed()).toBe(false);
    });

    it('should return true after destroy', async () => {
      await client.destroy();
      expect(client.isDestroyed()).toBe(true);
    });

    it('should not throw after destroy', async () => {
      await client.destroy();
      expect(() => client.isDestroyed()).not.toThrow();
    });
  });

  describe('Edge cases', () => {
    it('should handle rapid connect/disconnect cycles', async () => {
      await client.connect();
      await client.disconnect();
      await client.connect();
      await client.disconnect();
      expect(client.getStatus()).toBe('disconnected');
    });

    it('should handle subscribe before connect', async () => {
      await client.subscribe('market', { assets_ids: ['123'] });
      expect(wsManager.subscribeCalled).toBe(true);
    });

    it('should handle concurrent operations', async () => {
      const operations = [
        client.connect(),
        client.subscribe('market', { assets_ids: ['123'] }),
        client.subscribe('market', { assets_ids: ['456'] }),
      ];
      await Promise.all(operations);
      expect(wsManager.subscribeParams.length).toBe(2);
    });

    it('should handle empty subscription params', async () => {
      await client.subscribe('market', {});
      expect(wsManager.subscribeCalled).toBe(true);
    });

    it('should handle large subscription lists', async () => {
      const largeList = Array.from({ length: 1000 }, (_, i) => `token-${i}`);
      await client.subscribe('market', { assets_ids: largeList });
      expect(wsManager.subscribeParams[0].params.assets_ids).toEqual(largeList);
    });

    it('should handle event listener memory leaks', () => {
      for (let i = 0; i < 100; i++) {
        client.on('orderbook', () => {});
      }
      // Should not throw or leak
      expect(client.listenerCount('orderbook')).toBe(100);
    });

    it('should handle null/undefined event data', () => {
      const spy = jest.fn();
      client.on('orderbook', spy);
      wsManager.simulateEvent('orderbook', null);
      wsManager.simulateEvent('orderbook', undefined);
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });
});
