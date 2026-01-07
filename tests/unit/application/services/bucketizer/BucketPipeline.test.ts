/**
 * Bucket Pipeline Tests (Stateful)
 *
 * @remarks
 * Тесты для stateful BucketPipeline с VolumeLevelProbabilityFillBucketType.
 */

import { BucketPipeline } from '../../../../../src/application/services/bucketizer/BucketPipeline.js';
import { BucketTypeRegistry } from '../../../../../src/application/services/bucketizer/BucketTypeRegistry.js';
import { VolumeLevelProbabilityFillBucketType } from '../../../../../src/application/services/bucketizer/bucket-types/VolumeLevelProbabilityFillBucketType.js';
import { OrderBookSnapshotReceivedEvent } from '../../../../../src/domain/events/OrderBookSnapshotReceivedEvent.js';
import { TradeExecutedEvent } from '../../../../../src/domain/events/TradeExecutedEvent.js';
import { MockLogger } from '../../../../helpers/MockLogger.js';

describe('BucketPipeline (Stateful)', () => {
  let registry: BucketTypeRegistry;
  let logger: MockLogger;
  let bucketType: VolumeLevelProbabilityFillBucketType;

  beforeEach(() => {
    registry = new BucketTypeRegistry();
    logger = new MockLogger();

    bucketType = new VolumeLevelProbabilityFillBucketType({
      maxLevels: 10,
      volumeStep: 100,
      volumeMin: 0,
      volumeMax: 1000,
      horizonsSec: [5, 10, 15, 30, 60, 120],
      logger,
    });

    registry.register(bucketType);
  });

  describe('construction', () => {
    it('should create pipeline with empty registry', () => {
      const emptyRegistry = new BucketTypeRegistry();
      const pipeline = new BucketPipeline(emptyRegistry, logger);

      expect(pipeline).toBeDefined();
      expect(pipeline.getBuckets().size).toBe(0);
    });

    it('should extract stateful bucket types from registry', () => {
      const pipeline = new BucketPipeline(registry, logger);

      expect(pipeline).toBeDefined();

      const stats = pipeline.getStats();
      expect(stats.eventsProcessed).toBe(0);
      expect(stats.attemptsFinalized).toBe(0);
      expect(stats.bucketsAggregated).toBe(0);
    });
  });

  describe('processEvent', () => {
    it('should process OrderBookSnapshot events', async () => {
      const pipeline = new BucketPipeline(registry, logger);

      const event = new OrderBookSnapshotReceivedEvent(
        'asset1',
        [{ price: 0.50, size: 50 }],
        [],
        new Date('2024-01-01T00:00:00Z')
      );

      await pipeline.processEvent(event);

      const stats = pipeline.getStats();
      expect(stats.eventsProcessed).toBe(1);

      // Snapshot creates attempts but doesn't immediately aggregate
      expect(stats.bucketsAggregated).toBe(0);
    });

    it('should process TradeExecuted events and aggregate fills', async () => {
      const pipeline = new BucketPipeline(registry, logger);
      const t0 = new Date('2024-01-01T00:00:00Z');
      const t1 = new Date('2024-01-01T00:00:03Z');

      // Create attempt
      const orderbook = new OrderBookSnapshotReceivedEvent(
        'asset1',
        [{ price: 0.50, size: 50 }],
        [],
        t0
      );

      await pipeline.processEvent(orderbook);

      // Fill attempt
      const trade = new TradeExecutedEvent('asset1', 0.45, 50, 'BUY', t1);

      await pipeline.processEvent(trade);

      const stats = pipeline.getStats();
      expect(stats.eventsProcessed).toBe(2);
      expect(stats.bucketsAggregated).toBe(1); // 1 fill aggregated
    });

    it('should handle multiple events', async () => {
      const pipeline = new BucketPipeline(registry, logger);
      const t0 = new Date('2024-01-01T00:00:00Z');
      const t1 = new Date('2024-01-01T00:00:03Z');
      const t2 = new Date('2024-01-01T00:00:05Z');

      // Create attempts
      await pipeline.processEvent(
        new OrderBookSnapshotReceivedEvent(
          'asset1',
          [
            { price: 0.50, size: 50 },
            { price: 0.49, size: 100 },
          ],
          [],
          t0
        )
      );

      // Fill first attempt
      await pipeline.processEvent(
        new TradeExecutedEvent('asset1', 0.45, 50, 'BUY', t1)
      );

      // Fill second attempt
      await pipeline.processEvent(
        new TradeExecutedEvent('asset1', 0.45, 100, 'BUY', t2)
      );

      const stats = pipeline.getStats();
      expect(stats.eventsProcessed).toBe(3);
      expect(stats.bucketsAggregated).toBe(2);
    });
  });

  describe('finalizeFile', () => {
    it('should finalize all active attempts', async () => {
      const pipeline = new BucketPipeline(registry, logger);
      const t0 = new Date('2024-01-01T00:00:00Z');

      // Create 3 attempts
      await pipeline.processEvent(
        new OrderBookSnapshotReceivedEvent(
          'asset1',
          [
            { price: 0.50, size: 50 },
            { price: 0.49, size: 100 },
          ],
          [{ price: 0.51, size: 75 }],
          t0
        )
      );

      // Finalize file
      await pipeline.finalizeFile();

      const stats = pipeline.getStats();
      expect(stats.attemptsFinalized).toBe(3);
      expect(stats.bucketsAggregated).toBe(3); // All 3 attempts aggregated as not filled
    });

    it('should only finalize unfilled attempts', async () => {
      const pipeline = new BucketPipeline(registry, logger);
      const t0 = new Date('2024-01-01T00:00:00Z');
      const t1 = new Date('2024-01-01T00:00:03Z');

      // Create 2 attempts
      await pipeline.processEvent(
        new OrderBookSnapshotReceivedEvent(
          'asset1',
          [
            { price: 0.50, size: 50 },
            { price: 0.49, size: 100 },
          ],
          [],
          t0
        )
      );

      // Fill one attempt
      await pipeline.processEvent(
        new TradeExecutedEvent('asset1', 0.45, 50, 'BUY', t1)
      );

      // Finalize file
      await pipeline.finalizeFile();

      const stats = pipeline.getStats();
      expect(stats.attemptsFinalized).toBe(1); // Only 1 unfilled attempt
      expect(stats.bucketsAggregated).toBe(2); // 1 fill + 1 unfilled
    });

    it('should clear trackers after finalization', async () => {
      const pipeline = new BucketPipeline(registry, logger);
      const t0 = new Date('2024-01-01T00:00:00Z');

      // Create attempts for first file
      await pipeline.processEvent(
        new OrderBookSnapshotReceivedEvent(
          'asset1',
          [{ price: 0.50, size: 50 }],
          [],
          t0
        )
      );

      // Finalize first file
      await pipeline.finalizeFile();

      // Create attempts for second file
      await pipeline.processEvent(
        new OrderBookSnapshotReceivedEvent(
          'asset1',
          [{ price: 0.50, size: 50 }],
          [],
          t0
        )
      );

      // Finalize second file
      await pipeline.finalizeFile();

      const stats = pipeline.getStats();
      // Should finalize 1 attempt from each file
      expect(stats.attemptsFinalized).toBe(2);
    });
  });

  describe('getBuckets', () => {
    it('should return all aggregated buckets', async () => {
      const pipeline = new BucketPipeline(registry, logger);
      const t0 = new Date('2024-01-01T00:00:00Z');
      const t1 = new Date('2024-01-01T00:00:03Z');

      // Create 2 attempts (different levels → different buckets)
      await pipeline.processEvent(
        new OrderBookSnapshotReceivedEvent(
          'asset1',
          [
            { price: 0.50, size: 50 },  // buy_1_0_100
            { price: 0.49, size: 100 }, // buy_2_100_200
          ],
          [],
          t0
        )
      );

      // Fill both
      await pipeline.processEvent(
        new TradeExecutedEvent('asset1', 0.45, 200, 'BUY', t1)
      );

      const buckets = pipeline.getBuckets();
      expect(buckets.size).toBe(2);

      const bucketKeys = Array.from(buckets.keys());
      expect(bucketKeys).toContain('volume_level_probability_fill:buy_1_0_100');
      expect(bucketKeys).toContain('volume_level_probability_fill:buy_2_100_200');
    });

    it('should aggregate multiple results into same bucket', async () => {
      const pipeline = new BucketPipeline(registry, logger);
      const t0 = new Date('2024-01-01T00:00:00Z');
      const t1 = new Date('2024-01-01T00:00:03Z');
      const t2 = new Date('2024-01-01T00:00:10Z');

      // Create attempt
      await pipeline.processEvent(
        new OrderBookSnapshotReceivedEvent(
          'asset1',
          [{ price: 0.50, size: 50 }],
          [],
          t0
        )
      );

      // Fill
      await pipeline.processEvent(
        new TradeExecutedEvent('asset1', 0.45, 50, 'BUY', t1)
      );

      // Create another attempt (same bucket key)
      await pipeline.processEvent(
        new OrderBookSnapshotReceivedEvent(
          'asset1',
          [{ price: 0.50, size: 50 }],
          [],
          t2
        )
      );

      // Finalize (not filled)
      await pipeline.finalizeFile();

      const buckets = pipeline.getBuckets();
      expect(buckets.size).toBe(1); // Same bucket

      const bucket = Array.from(buckets.values())[0];
      const data = bucket.data as any;

      // Should have 2 attempts (1 filled + 1 not filled)
      expect(data.fill_time_distribution[5].attempts).toBe(2);
      expect(data.fill_time_distribution[5].fills).toBe(1);
    });
  });

  describe('getBucketsByType', () => {
    it('should return buckets for specific type', async () => {
      const pipeline = new BucketPipeline(registry, logger);
      const t0 = new Date('2024-01-01T00:00:00Z');
      const t1 = new Date('2024-01-01T00:00:03Z');

      // Create attempts
      await pipeline.processEvent(
        new OrderBookSnapshotReceivedEvent(
          'asset1',
          [{ price: 0.50, size: 50 }],
          [{ price: 0.51, size: 75 }],
          t0
        )
      );

      // Fill both
      await pipeline.processEvent(
        new TradeExecutedEvent('asset1', 0.45, 50, 'BUY', t1)
      );
      await pipeline.processEvent(
        new TradeExecutedEvent('asset1', 0.55, 75, 'SELL', t1)
      );

      const buckets = pipeline.getBucketsByType('volume_level_probability_fill');

      expect(buckets).toHaveLength(2);
    });

    it('should return empty array for nonexistent type', () => {
      const pipeline = new BucketPipeline(registry, logger);

      const buckets = pipeline.getBucketsByType('nonexistent');

      expect(buckets).toEqual([]);
    });
  });

  describe('getBucket', () => {
    it('should return bucket by type and key', async () => {
      const pipeline = new BucketPipeline(registry, logger);
      const t0 = new Date('2024-01-01T00:00:00Z');
      const t1 = new Date('2024-01-01T00:00:03Z');

      // Create and fill attempt
      await pipeline.processEvent(
        new OrderBookSnapshotReceivedEvent(
          'asset1',
          [{ price: 0.50, size: 50 }],
          [],
          t0
        )
      );

      await pipeline.processEvent(
        new TradeExecutedEvent('asset1', 0.45, 50, 'BUY', t1)
      );

      const bucket = pipeline.getBucket(
        'volume_level_probability_fill',
        'buy_1_0_100'
      );

      expect(bucket).not.toBeNull();
      expect(bucket!.bucketKey).toBe('buy_1_0_100');
      expect(bucket!.bucketType).toBe('volume_level_probability_fill');
    });

    it('should return null for nonexistent bucket', () => {
      const pipeline = new BucketPipeline(registry, logger);

      const bucket = pipeline.getBucket('volume_level_probability_fill', 'nonexistent');

      expect(bucket).toBeNull();
    });
  });

  describe('getStats', () => {
    it('should return statistics snapshot', async () => {
      const pipeline = new BucketPipeline(registry, logger);
      const t0 = new Date('2024-01-01T00:00:00Z');

      // Create attempts
      await pipeline.processEvent(
        new OrderBookSnapshotReceivedEvent(
          'asset1',
          [{ price: 0.50, size: 50 }],
          [],
          t0
        )
      );

      // Finalize
      await pipeline.finalizeFile();

      const stats = pipeline.getStats();

      expect(stats.eventsProcessed).toBe(1);
      expect(stats.attemptsFinalized).toBe(1);
      expect(stats.bucketsAggregated).toBe(1);
    });

    it('should return immutable stats', () => {
      const pipeline = new BucketPipeline(registry, logger);

      const stats1 = pipeline.getStats();
      const stats2 = pipeline.getStats();

      expect(stats1).not.toBe(stats2); // Different objects
      expect(stats1).toEqual(stats2); // Same values
    });
  });

  describe('integration scenario', () => {
    it('should handle full file processing lifecycle', async () => {
      const pipeline = new BucketPipeline(registry, logger);

      // File 1: Process events
      const t0 = new Date('2024-01-01T00:00:00Z');
      const t1 = new Date('2024-01-01T00:00:03Z');
      const t2 = new Date('2024-01-01T00:00:05Z');

      // Create 3 attempts
      await pipeline.processEvent(
        new OrderBookSnapshotReceivedEvent(
          'asset1',
          [
            { price: 0.50, size: 50 },  // Attempt 1
            { price: 0.49, size: 100 }, // Attempt 2
          ],
          [{ price: 0.51, size: 75 }],  // Attempt 3
          t0
        )
      );

      // Fill attempt 1
      await pipeline.processEvent(
        new TradeExecutedEvent('asset1', 0.45, 50, 'BUY', t1)
      );

      // Fill attempt 3
      await pipeline.processEvent(
        new TradeExecutedEvent('asset1', 0.55, 75, 'SELL', t2)
      );

      // Finalize file 1 (attempt 2 remains unfilled)
      await pipeline.finalizeFile();

      const stats1 = pipeline.getStats();
      expect(stats1.eventsProcessed).toBe(3);
      expect(stats1.attemptsFinalized).toBe(1); // Attempt 2
      expect(stats1.bucketsAggregated).toBe(3); // 2 fills + 1 unfilled

      // File 2: New events
      const t3 = new Date('2024-01-01T00:01:00Z');
      const t4 = new Date('2024-01-01T00:01:03Z');

      // Create new attempts (trackers were cleared)
      await pipeline.processEvent(
        new OrderBookSnapshotReceivedEvent(
          'asset1',
          [{ price: 0.50, size: 50 }],
          [],
          t3
        )
      );

      // Fill
      await pipeline.processEvent(
        new TradeExecutedEvent('asset1', 0.45, 50, 'BUY', t4)
      );

      // Finalize file 2
      await pipeline.finalizeFile();

      const stats2 = pipeline.getStats();
      expect(stats2.eventsProcessed).toBe(5);
      expect(stats2.attemptsFinalized).toBe(1); // Still 1 (from file 1)
      expect(stats2.bucketsAggregated).toBe(4); // 3 from file1 + 1 from file2

      // Check buckets
      const buckets = pipeline.getBuckets();
      expect(buckets.size).toBe(3); // buy_1, buy_2, sell_1

      // Check buy_1 bucket (2 fills from different files)
      const buy1 = buckets.get('volume_level_probability_fill:buy_1_0_100');
      expect(buy1).toBeDefined();

      const buy1Data = buy1!.data as any;
      expect(buy1Data.fill_time_distribution[5].attempts).toBe(2);
      expect(buy1Data.fill_time_distribution[5].fills).toBe(2);
    });
  });
});
