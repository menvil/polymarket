/**
 * Unit tests for SubscriptionRegistry
 *
 * @remarks
 * **Phase 3 tests - Subscription management layer**
 *
 * Coverage:
 * - Constructor validation
 * - Subscribe/unsubscribe operations
 * - Callback invocation (notify)
 * - Multiple subscribers per asset
 * - Error handling in callbacks
 * - Statistics tracking
 * - Edge cases
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { SubscriptionRegistry } from '../../../../../src/infrastructure/polymarket/ws/SubscriptionRegistry.js';
import { MockLogger } from '../../../../helpers/MockLogger.js';

/**
 * Test data type
 */
interface TestData {
  value: number;
  message: string;
}

describe('SubscriptionRegistry', () => {
  let logger: MockLogger;
  let registry: SubscriptionRegistry<TestData>;

  beforeEach(() => {
    logger = new MockLogger();
    registry = new SubscriptionRegistry<TestData>(logger);
  });

  describe('Constructor', () => {
    it('should create registry with valid logger', () => {
      expect(registry).toBeDefined();
      expect(registry.getStats()).toBeDefined();
    });

    it('should throw if logger is null', () => {
      expect(() => new SubscriptionRegistry(null as any)).toThrow('logger is required');
    });

    it('should throw if logger is undefined', () => {
      expect(() => new SubscriptionRegistry(undefined as any)).toThrow('logger is required');
    });

    it('should initialize stats to zero', () => {
      const stats = registry.getStats();
      expect(stats.uniqueAssets).toBe(0);
      expect(stats.totalCallbacks).toBe(0);
      expect(stats.totalNotifications).toBe(0);
      expect(stats.callbackErrors).toBe(0);
    });
  });

  describe('subscribe()', () => {
    it('should subscribe callback to asset', () => {
      const callback = jest.fn();
      const unsubscribe = registry.subscribe('asset1', callback);

      expect(typeof unsubscribe).toBe('function');
      expect(registry.has('asset1')).toBe(true);
      expect(registry.getCallbackCount('asset1')).toBe(1);
    });

    it('should update statistics on subscribe', () => {
      const callback = jest.fn();
      registry.subscribe('asset1', callback);

      const stats = registry.getStats();
      expect(stats.uniqueAssets).toBe(1);
      expect(stats.totalCallbacks).toBe(1);
    });

    it('should support multiple callbacks for same asset', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();
      const callback3 = jest.fn();

      registry.subscribe('asset1', callback1);
      registry.subscribe('asset1', callback2);
      registry.subscribe('asset1', callback3);

      expect(registry.getCallbackCount('asset1')).toBe(3);

      const stats = registry.getStats();
      expect(stats.uniqueAssets).toBe(1);
      expect(stats.totalCallbacks).toBe(3);
    });

    it('should support multiple assets', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      registry.subscribe('asset1', callback1);
      registry.subscribe('asset2', callback2);

      expect(registry.getCallbackCount('asset1')).toBe(1);
      expect(registry.getCallbackCount('asset2')).toBe(1);

      const stats = registry.getStats();
      expect(stats.uniqueAssets).toBe(2);
      expect(stats.totalCallbacks).toBe(2);
    });

    it('should not add same callback twice (Set behavior)', () => {
      const callback = jest.fn();

      registry.subscribe('asset1', callback);
      registry.subscribe('asset1', callback);

      expect(registry.getCallbackCount('asset1')).toBe(1);

      const stats = registry.getStats();
      expect(stats.totalCallbacks).toBe(1);
    });

    it('should throw if assetId is empty', () => {
      const callback = jest.fn();
      expect(() => registry.subscribe('', callback)).toThrow('assetId cannot be empty');
    });

    it('should throw if assetId is whitespace', () => {
      const callback = jest.fn();
      expect(() => registry.subscribe('   ', callback)).toThrow('assetId cannot be empty');
    });

    it('should throw if callback is not a function', () => {
      expect(() => registry.subscribe('asset1', null as any)).toThrow('callback must be a function');
      expect(() => registry.subscribe('asset1', undefined as any)).toThrow('callback must be a function');
      expect(() => registry.subscribe('asset1', 'not a function' as any)).toThrow('callback must be a function');
    });

    it('should return working unsubscribe function', () => {
      const callback = jest.fn();
      const unsubscribe = registry.subscribe('asset1', callback);

      expect(registry.has('asset1')).toBe(true);

      unsubscribe();

      expect(registry.has('asset1')).toBe(false);
    });
  });

  describe('unsubscribe()', () => {
    it('should unsubscribe callback from asset', () => {
      const callback = jest.fn();
      registry.subscribe('asset1', callback);

      const removed = registry.unsubscribe('asset1', callback);

      expect(removed).toBe(true);
      expect(registry.has('asset1')).toBe(false);

      const stats = registry.getStats();
      expect(stats.totalCallbacks).toBe(0);
    });

    it('should return false if callback not found', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      registry.subscribe('asset1', callback1);

      const removed = registry.unsubscribe('asset1', callback2);

      expect(removed).toBe(false);
      expect(registry.getCallbackCount('asset1')).toBe(1);
    });

    it('should return false if asset not found', () => {
      const callback = jest.fn();

      const removed = registry.unsubscribe('nonexistent', callback);

      expect(removed).toBe(false);
    });

    it('should remove only specified callback', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();
      const callback3 = jest.fn();

      registry.subscribe('asset1', callback1);
      registry.subscribe('asset1', callback2);
      registry.subscribe('asset1', callback3);

      registry.unsubscribe('asset1', callback2);

      expect(registry.getCallbackCount('asset1')).toBe(2);
    });

    it('should clean up empty asset entries', () => {
      const callback = jest.fn();
      registry.subscribe('asset1', callback);

      expect(registry.getAssetIds()).toContain('asset1');

      registry.unsubscribe('asset1', callback);

      expect(registry.getAssetIds()).not.toContain('asset1');

      const stats = registry.getStats();
      expect(stats.uniqueAssets).toBe(0);
    });

    it('should not affect other assets', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      registry.subscribe('asset1', callback1);
      registry.subscribe('asset2', callback2);

      registry.unsubscribe('asset1', callback1);

      expect(registry.has('asset1')).toBe(false);
      expect(registry.has('asset2')).toBe(true);
    });
  });

  describe('unsubscribeAll()', () => {
    it('should remove all callbacks for specific asset', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();
      const callback3 = jest.fn();

      registry.subscribe('asset1', callback1);
      registry.subscribe('asset1', callback2);
      registry.subscribe('asset2', callback3);

      const removed = registry.unsubscribeAll('asset1');

      expect(removed).toBe(2);
      expect(registry.has('asset1')).toBe(false);
      expect(registry.has('asset2')).toBe(true);

      const stats = registry.getStats();
      expect(stats.uniqueAssets).toBe(1);
      expect(stats.totalCallbacks).toBe(1);
    });

    it('should return 0 if asset not found', () => {
      const removed = registry.unsubscribeAll('nonexistent');
      expect(removed).toBe(0);
    });

    it('should clear all subscriptions if no assetId provided', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();
      const callback3 = jest.fn();

      registry.subscribe('asset1', callback1);
      registry.subscribe('asset1', callback2);
      registry.subscribe('asset2', callback3);

      const removed = registry.unsubscribeAll();

      expect(removed).toBe(3);
      expect(registry.getAssetIds()).toEqual([]);

      const stats = registry.getStats();
      expect(stats.uniqueAssets).toBe(0);
      expect(stats.totalCallbacks).toBe(0);
    });

    it('should clear all when called without parameters', () => {
      const callback = jest.fn();
      registry.subscribe('asset1', callback);
      registry.subscribe('asset2', callback);
      registry.subscribe('asset3', callback);

      registry.unsubscribeAll();

      expect(registry.getCallbackCount()).toBe(0);
      expect(registry.getAssetIds()).toEqual([]);
    });
  });

  describe('notify()', () => {
    it('should invoke callback with data', () => {
      const callback = jest.fn();
      const testData: TestData = { value: 42, message: 'test' };

      registry.subscribe('asset1', callback);
      const count = registry.notify('asset1', testData);

      expect(count).toBe(1);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(testData);
    });

    it('should invoke all callbacks for asset', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();
      const callback3 = jest.fn();
      const testData: TestData = { value: 42, message: 'test' };

      registry.subscribe('asset1', callback1);
      registry.subscribe('asset1', callback2);
      registry.subscribe('asset1', callback3);

      const count = registry.notify('asset1', testData);

      expect(count).toBe(3);
      expect(callback1).toHaveBeenCalledWith(testData);
      expect(callback2).toHaveBeenCalledWith(testData);
      expect(callback3).toHaveBeenCalledWith(testData);
    });

    it('should return 0 if asset has no subscribers', () => {
      const testData: TestData = { value: 42, message: 'test' };
      const count = registry.notify('nonexistent', testData);
      expect(count).toBe(0);
    });

    it('should not invoke callbacks for other assets', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();
      const testData: TestData = { value: 42, message: 'test' };

      registry.subscribe('asset1', callback1);
      registry.subscribe('asset2', callback2);

      registry.notify('asset1', testData);

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).not.toHaveBeenCalled();
    });

    it('should update statistics on notify', () => {
      const callback = jest.fn();
      const testData: TestData = { value: 42, message: 'test' };

      registry.subscribe('asset1', callback);
      registry.notify('asset1', testData);
      registry.notify('asset1', testData);

      const stats = registry.getStats();
      expect(stats.totalNotifications).toBe(2);
    });

    it('should handle errors in callbacks', () => {
      const errorCallback = jest.fn(() => {
        throw new Error('Callback error');
      });
      const goodCallback = jest.fn();
      const testData: TestData = { value: 42, message: 'test' };

      registry.subscribe('asset1', errorCallback);
      registry.subscribe('asset1', goodCallback);

      const count = registry.notify('asset1', testData);

      // Only good callback succeeds
      expect(count).toBe(1);
      expect(errorCallback).toHaveBeenCalled();
      expect(goodCallback).toHaveBeenCalled();

      const stats = registry.getStats();
      expect(stats.callbackErrors).toBe(1);
    });

    it('should isolate errors between callbacks', () => {
      const callback1 = jest.fn(() => {
        throw new Error('Error 1');
      });
      const callback2 = jest.fn();
      const callback3 = jest.fn(() => {
        throw new Error('Error 2');
      });
      const testData: TestData = { value: 42, message: 'test' };

      registry.subscribe('asset1', callback1);
      registry.subscribe('asset1', callback2);
      registry.subscribe('asset1', callback3);

      const count = registry.notify('asset1', testData);

      expect(count).toBe(1); // Only callback2 succeeded
      expect(callback1).toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
      expect(callback3).toHaveBeenCalled();

      const stats = registry.getStats();
      expect(stats.callbackErrors).toBe(2);
    });

    it('should log callback errors', () => {
      const errorCallback = jest.fn(() => {
        throw new Error('Test error');
      });
      const testData: TestData = { value: 42, message: 'test' };

      registry.subscribe('asset1', errorCallback);
      registry.notify('asset1', testData);

      expect(logger.errorCalls.some(c => c.message.includes('Error in subscription callback'))).toBe(true);
    });
  });

  describe('has()', () => {
    it('should return true if asset has subscriptions', () => {
      const callback = jest.fn();
      registry.subscribe('asset1', callback);

      expect(registry.has('asset1')).toBe(true);
    });

    it('should return false if asset has no subscriptions', () => {
      expect(registry.has('asset1')).toBe(false);
    });

    it('should return false after all callbacks unsubscribed', () => {
      const callback = jest.fn();
      registry.subscribe('asset1', callback);
      registry.unsubscribe('asset1', callback);

      expect(registry.has('asset1')).toBe(false);
    });
  });

  describe('getAssetIds()', () => {
    it('should return empty array initially', () => {
      expect(registry.getAssetIds()).toEqual([]);
    });

    it('should return array of subscribed asset IDs', () => {
      const callback = jest.fn();

      registry.subscribe('asset1', callback);
      registry.subscribe('asset2', callback);
      registry.subscribe('asset3', callback);

      const assetIds = registry.getAssetIds();
      expect(assetIds).toHaveLength(3);
      expect(assetIds).toContain('asset1');
      expect(assetIds).toContain('asset2');
      expect(assetIds).toContain('asset3');
    });

    it('should not include unsubscribed assets', () => {
      const callback = jest.fn();

      registry.subscribe('asset1', callback);
      registry.subscribe('asset2', callback);
      registry.unsubscribe('asset1', callback);

      const assetIds = registry.getAssetIds();
      expect(assetIds).toEqual(['asset2']);
    });
  });

  describe('getCallbackCount()', () => {
    it('should return 0 for nonexistent asset', () => {
      expect(registry.getCallbackCount('nonexistent')).toBe(0);
    });

    it('should return callback count for specific asset', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      registry.subscribe('asset1', callback1);
      registry.subscribe('asset1', callback2);

      expect(registry.getCallbackCount('asset1')).toBe(2);
    });

    it('should return total callback count when no assetId provided', () => {
      const callback = jest.fn();

      registry.subscribe('asset1', callback);
      registry.subscribe('asset2', callback);
      registry.subscribe('asset3', callback);

      expect(registry.getCallbackCount()).toBe(3);
    });

    it('should update after unsubscribe', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      registry.subscribe('asset1', callback1);
      registry.subscribe('asset1', callback2);

      expect(registry.getCallbackCount('asset1')).toBe(2);

      registry.unsubscribe('asset1', callback1);

      expect(registry.getCallbackCount('asset1')).toBe(1);
    });
  });

  describe('getStats()', () => {
    it('should return statistics object', () => {
      const stats = registry.getStats();

      expect(stats).toHaveProperty('uniqueAssets');
      expect(stats).toHaveProperty('totalCallbacks');
      expect(stats).toHaveProperty('totalNotifications');
      expect(stats).toHaveProperty('callbackErrors');
    });

    it('should return immutable stats copy', () => {
      const stats1 = registry.getStats();
      const stats2 = registry.getStats();

      expect(stats1).not.toBe(stats2);
      expect(stats1).toEqual(stats2);
    });

    it('should track all statistics correctly', () => {
      const callback = jest.fn();
      const testData: TestData = { value: 42, message: 'test' };

      registry.subscribe('asset1', callback);
      registry.subscribe('asset2', callback);
      registry.notify('asset1', testData);
      registry.notify('asset1', testData);

      const stats = registry.getStats();
      expect(stats.uniqueAssets).toBe(2);
      expect(stats.totalCallbacks).toBe(2);
      expect(stats.totalNotifications).toBe(2);
      expect(stats.callbackErrors).toBe(0);
    });
  });

  describe('resetStats()', () => {
    it('should reset notification counters', () => {
      const callback = jest.fn();
      const testData: TestData = { value: 42, message: 'test' };

      registry.subscribe('asset1', callback);
      registry.notify('asset1', testData);

      let stats = registry.getStats();
      expect(stats.totalNotifications).toBe(1);

      registry.resetStats();

      stats = registry.getStats();
      expect(stats.totalNotifications).toBe(0);
      expect(stats.callbackErrors).toBe(0);
    });

    it('should not affect subscription counters', () => {
      const callback = jest.fn();
      registry.subscribe('asset1', callback);
      registry.subscribe('asset2', callback);

      registry.resetStats();

      const stats = registry.getStats();
      expect(stats.uniqueAssets).toBe(2);
      expect(stats.totalCallbacks).toBe(2);
    });
  });

  describe('clear()', () => {
    it('should remove all subscriptions', () => {
      const callback = jest.fn();

      registry.subscribe('asset1', callback);
      registry.subscribe('asset2', callback);
      registry.subscribe('asset3', callback);

      registry.clear();

      expect(registry.getAssetIds()).toEqual([]);
      expect(registry.getCallbackCount()).toBe(0);
    });

    it('should reset subscription statistics', () => {
      const callback = jest.fn();

      registry.subscribe('asset1', callback);
      registry.subscribe('asset2', callback);

      registry.clear();

      const stats = registry.getStats();
      expect(stats.uniqueAssets).toBe(0);
      expect(stats.totalCallbacks).toBe(0);
    });

    it('should not reset notification statistics', () => {
      const callback = jest.fn();
      const testData: TestData = { value: 42, message: 'test' };

      registry.subscribe('asset1', callback);
      registry.notify('asset1', testData);

      registry.clear();

      const stats = registry.getStats();
      expect(stats.totalNotifications).toBe(1); // Not reset
    });
  });

  describe('Edge cases', () => {
    it('should handle very long asset IDs', () => {
      const callback = jest.fn();
      const longAssetId = '1'.repeat(1000);

      registry.subscribe(longAssetId, callback);

      expect(registry.has(longAssetId)).toBe(true);
    });

    it('should handle many callbacks on single asset', () => {
      const callbacks = Array.from({ length: 100 }, () => jest.fn());

      callbacks.forEach(cb => registry.subscribe('asset1', cb));

      expect(registry.getCallbackCount('asset1')).toBe(100);
    });

    it('should handle many assets', () => {
      const callback = jest.fn();
      const assetCount = 1000;

      for (let i = 0; i < assetCount; i++) {
        registry.subscribe(`asset${i}`, callback);
      }

      expect(registry.getAssetIds()).toHaveLength(assetCount);

      const stats = registry.getStats();
      expect(stats.uniqueAssets).toBe(assetCount);
    });

    it('should handle rapid subscribe/unsubscribe', () => {
      const callback = jest.fn();

      for (let i = 0; i < 100; i++) {
        registry.subscribe('asset1', callback);
        registry.unsubscribe('asset1', callback);
      }

      expect(registry.has('asset1')).toBe(false);

      const stats = registry.getStats();
      expect(stats.totalCallbacks).toBe(0);
    });

    it('should handle notify with no data', () => {
      const callback = jest.fn();

      registry.subscribe('asset1', callback);
      registry.notify('asset1', undefined as any);

      expect(callback).toHaveBeenCalledWith(undefined);
    });

    it('should handle callback that modifies registry', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn(() => {
        // Try to unsubscribe during notify
        registry.unsubscribe('asset1', callback1);
      });
      const testData: TestData = { value: 42, message: 'test' };

      registry.subscribe('asset1', callback1);
      registry.subscribe('asset1', callback2);

      const count = registry.notify('asset1', testData);

      // Both should be called (snapshot at notify time)
      expect(count).toBe(2);
      expect(callback1).toHaveBeenCalled();
      expect(callback2).toHaveBeenCalled();
    });
  });
});
