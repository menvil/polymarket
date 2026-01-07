/**
 * Volume Level Probability Fill Bucket Type Tests (Stateful)
 *
 * @remarks
 * Тесты для stateful bucket type с AttemptTracker.
 */

import { VolumeLevelProbabilityFillBucketType } from '../../../../../../src/application/services/bucketizer/bucket-types/VolumeLevelProbabilityFillBucketType.js';
import { OrderBookSnapshotReceivedEvent } from '../../../../../../src/domain/events/OrderBookSnapshotReceivedEvent.js';
import { TradeExecutedEvent } from '../../../../../../src/domain/events/TradeExecutedEvent.js';
import { MockLogger } from '../../../../../helpers/MockLogger.js';

describe('VolumeLevelProbabilityFillBucketType (Stateful)', () => {
  let bucketType: VolumeLevelProbabilityFillBucketType;
  let logger: MockLogger;

  beforeEach(() => {
    logger = new MockLogger();
    bucketType = new VolumeLevelProbabilityFillBucketType({
      maxLevels: 10,
      volumeStep: 100,
      volumeMin: 0,
      volumeMax: 1000,
      horizonsSec: [5, 10, 15, 30, 60, 120],
      logger,
    });
  });

  describe('getName', () => {
    it('should return correct name', () => {
      expect(bucketType.getName()).toBe('volume_level_probability_fill');
    });
  });

  describe('processEvent - OrderBookSnapshot', () => {
    it('should create buy attempts from bids', () => {
      const event = new OrderBookSnapshotReceivedEvent(
        'asset1',
        [
          { price: 0.50, size: 50 }, // Level 1: cum 50
          { price: 0.49, size: 100 }, // Level 2: cum 150
        ],
        [],
        new Date('2024-01-01T00:00:00Z')
      );

      const results = bucketType.processEvent(event);

      // На snapshot создаются attempts, но не возвращаются results (пока не filled/expired)
      expect(results).toEqual([]);
    });

    it('should create sell attempts from asks', () => {
      const event = new OrderBookSnapshotReceivedEvent(
        'asset1',
        [],
        [
          { price: 0.51, size: 75 }, // Level 1: cum 75
          { price: 0.52, size: 50 }, // Level 2: cum 125
        ],
        new Date('2024-01-01T00:00:00Z')
      );

      const results = bucketType.processEvent(event);

      expect(results).toEqual([]);
    });

    it('should create attempts for both sides', () => {
      const event = new OrderBookSnapshotReceivedEvent(
        'asset1',
        [{ price: 0.50, size: 50 }],
        [{ price: 0.51, size: 50 }],
        new Date('2024-01-01T00:00:00Z')
      );

      const results = bucketType.processEvent(event);

      expect(results).toEqual([]);
    });
  });

  describe('processEvent - TradeExecuted', () => {
    it('should fill buy attempt when trade price matches', () => {
      const t0 = new Date('2024-01-01T00:00:00Z');
      const t1 = new Date('2024-01-01T00:00:03Z'); // 3 seconds later

      // Create buy attempt with myPrice=0.50
      const orderbook = new OrderBookSnapshotReceivedEvent(
        'asset1',
        [{ price: 0.50, size: 50 }],
        [],
        t0
      );

      bucketType.processEvent(orderbook);

      // Trade at price 0.45 (< 0.50) should fill buy attempt
      const trade = new TradeExecutedEvent('asset1', 0.45, 50, 'BUY', t1);

      const results = bucketType.processEvent(trade);

      expect(results).toHaveLength(1);
      expect(results[0].filled).toBe(true);
      expect(results[0].fillTimeSec).toBe(3);
      expect(results[0].fillPrice).toBe(0.45);
      expect(results[0].bucketKey.side).toBe('buy');
      expect(results[0].bucketKey.level).toBe(1);
    });

    it('should fill sell attempt when trade price matches', () => {
      const t0 = new Date('2024-01-01T00:00:00Z');
      const t1 = new Date('2024-01-01T00:00:05Z'); // 5 seconds later

      // Create sell attempt with myPrice=0.51
      const orderbook = new OrderBookSnapshotReceivedEvent(
        'asset1',
        [],
        [{ price: 0.51, size: 75 }],
        t0
      );

      bucketType.processEvent(orderbook);

      // Trade at price 0.55 (> 0.51) should fill sell attempt
      const trade = new TradeExecutedEvent('asset1', 0.55, 75, 'SELL', t1);

      const results = bucketType.processEvent(trade);

      expect(results).toHaveLength(1);
      expect(results[0].filled).toBe(true);
      expect(results[0].fillTimeSec).toBe(5);
      expect(results[0].fillPrice).toBe(0.55);
      expect(results[0].bucketKey.side).toBe('sell');
    });

    it('should not fill when trade price does not match', () => {
      const t0 = new Date('2024-01-01T00:00:00Z');
      const t1 = new Date('2024-01-01T00:00:02Z');

      // Create buy attempt with myPrice=0.50
      const orderbook = new OrderBookSnapshotReceivedEvent(
        'asset1',
        [{ price: 0.50, size: 50 }],
        [],
        t0
      );

      bucketType.processEvent(orderbook);

      // Trade at price 0.55 (> 0.50) should NOT fill buy attempt
      const trade = new TradeExecutedEvent('asset1', 0.55, 50, 'BUY', t1);

      const results = bucketType.processEvent(trade);

      expect(results).toEqual([]);
    });

    it('should handle partial fills', () => {
      const t0 = new Date('2024-01-01T00:00:00Z');
      const t1 = new Date('2024-01-01T00:00:02Z');
      const t2 = new Date('2024-01-01T00:00:04Z');

      // Create buy attempt with size=100
      const orderbook = new OrderBookSnapshotReceivedEvent(
        'asset1',
        [{ price: 0.50, size: 100 }],
        [],
        t0
      );

      bucketType.processEvent(orderbook);

      // First trade: 40 units
      const trade1 = new TradeExecutedEvent('asset1', 0.48, 40, 'BUY', t1);
      const results1 = bucketType.processEvent(trade1);
      expect(results1).toEqual([]); // Not filled yet

      // Second trade: 60 units → fills
      const trade2 = new TradeExecutedEvent('asset1', 0.49, 60, 'BUY', t2);
      const results2 = bucketType.processEvent(trade2);

      expect(results2).toHaveLength(1);
      expect(results2[0].filled).toBe(true);
      expect(results2[0].fillTimeSec).toBe(4);
      expect(results2[0].fillPrice).toBe(0.49); // Last trade price
    });
  });

  describe('finalize', () => {
    it('should return all active attempts as not filled', () => {
      const t0 = new Date('2024-01-01T00:00:00Z');

      // Create 3 attempts
      const orderbook = new OrderBookSnapshotReceivedEvent(
        'asset1',
        [
          { price: 0.50, size: 50 },
          { price: 0.49, size: 100 },
        ],
        [{ price: 0.51, size: 75 }],
        t0
      );

      bucketType.processEvent(orderbook);

      // Finalize without any fills
      const results = bucketType.finalize();

      expect(results).toHaveLength(3);
      expect(results.every((r) => r.filled === false)).toBe(true);
    });

    it('should not return already filled attempts', () => {
      const t0 = new Date('2024-01-01T00:00:00Z');
      const t1 = new Date('2024-01-01T00:00:02Z');

      // Create 2 attempts
      const orderbook = new OrderBookSnapshotReceivedEvent(
        'asset1',
        [
          { price: 0.50, size: 50 },
          { price: 0.49, size: 100 },
        ],
        [],
        t0
      );

      bucketType.processEvent(orderbook);

      // Fill one attempt
      const trade = new TradeExecutedEvent('asset1', 0.48, 50, 'BUY', t1);
      bucketType.processEvent(trade);

      // Finalize
      const results = bucketType.finalize();

      // Should return only 1 unfilled attempt (the second one)
      expect(results).toHaveLength(1);
      expect(results[0].filled).toBe(false);
    });
  });

  describe('resetTrackers', () => {
    it('should clear all trackers', () => {
      const t0 = new Date('2024-01-01T00:00:00Z');

      // Create attempts for asset1
      const orderbook1 = new OrderBookSnapshotReceivedEvent(
        'asset1',
        [{ price: 0.50, size: 50 }],
        [],
        t0
      );

      bucketType.processEvent(orderbook1);

      // Reset
      bucketType.resetTrackers();

      // Finalize should return nothing
      const results = bucketType.finalize();
      expect(results).toEqual([]);
    });
  });

  describe('aggregateResult', () => {
    it('should update fill_time_distribution for filled result', () => {
      const result = {
        bucketKey: { side: 'buy' as const, level: 1, volumeMin: 0, volumeMax: 100 },
        filled: true,
        fillTimeSec: 8, // Within 10s, 15s, 30s, 60s, 120s horizons
        fillPrice: 0.45,
      };

      bucketType.aggregateResult(result);

      const buckets = bucketType.getBuckets();
      expect(buckets.size).toBe(1);

      const bucket = Array.from(buckets.values())[0];
      const data = bucket.data as any;

      // Should increment attempts for all horizons
      expect(data.fill_time_distribution[5].attempts).toBe(1);
      expect(data.fill_time_distribution[10].attempts).toBe(1);
      expect(data.fill_time_distribution[120].attempts).toBe(1);

      // Should increment fills only for horizons >= 8s
      expect(data.fill_time_distribution[5].fills).toBe(0); // 5s < 8s
      expect(data.fill_time_distribution[10].fills).toBe(1); // 10s >= 8s
      expect(data.fill_time_distribution[15].fills).toBe(1);
      expect(data.fill_time_distribution[120].fills).toBe(1);

      // Check probabilities
      expect(data.fill_time_distribution[5].probability).toBe(0);
      expect(data.fill_time_distribution[10].probability).toBe(1);
    });

    it('should update price_fill_distribution', () => {
      const result = {
        bucketKey: { side: 'buy' as const, level: 1, volumeMin: 0, volumeMax: 100 },
        filled: true,
        fillTimeSec: 3,
        fillPrice: 0.456789,
      };

      bucketType.aggregateResult(result);

      const buckets = bucketType.getBuckets();
      const bucket = Array.from(buckets.values())[0];
      const data = bucket.data as any;

      // Price should be rounded to 6 decimals
      expect(data.price_fill_distribution['0.456789']).toBe(1);
    });

    it('should aggregate multiple results into same bucket', () => {
      const result1 = {
        bucketKey: { side: 'buy' as const, level: 1, volumeMin: 0, volumeMax: 100 },
        filled: true,
        fillTimeSec: 3,
        fillPrice: 0.45,
      };

      const result2 = {
        bucketKey: { side: 'buy' as const, level: 1, volumeMin: 0, volumeMax: 100 },
        filled: false,
      };

      const result3 = {
        bucketKey: { side: 'buy' as const, level: 1, volumeMin: 0, volumeMax: 100 },
        filled: true,
        fillTimeSec: 7,
        fillPrice: 0.48,
      };

      bucketType.aggregateResult(result1);
      bucketType.aggregateResult(result2);
      bucketType.aggregateResult(result3);

      const buckets = bucketType.getBuckets();
      expect(buckets.size).toBe(1);

      const bucket = Array.from(buckets.values())[0];
      const data = bucket.data as any;

      // 3 attempts total
      expect(data.fill_time_distribution[10].attempts).toBe(3);

      // 2 fills (result1 and result3)
      expect(data.fill_time_distribution[10].fills).toBe(2);

      // Probability
      expect(data.fill_time_distribution[10].probability).toBeCloseTo(
        2 / 3,
        5
      );

      // Price distribution
      expect(data.price_fill_distribution['0.450000']).toBe(1);
      expect(data.price_fill_distribution['0.480000']).toBe(1);
    });
  });

  describe('createBucket', () => {
    it('should create bucket with initialized horizons', () => {
      const bucket = bucketType.createBucket('buy_1_0_100');

      expect(bucket.bucketKey).toBe('buy_1_0_100');
      expect(bucket.bucketType).toBe('volume_level_probability_fill');

      const data = bucket.data as any;
      expect(data.fill_time_distribution[5]).toEqual({
        attempts: 0,
        fills: 0,
        probability: 0,
      });
      expect(data.fill_time_distribution[120]).toEqual({
        attempts: 0,
        fills: 0,
        probability: 0,
      });
      expect(data.price_fill_distribution).toEqual({});
    });
  });

  describe('serialize / deserialize', () => {
    it('should serialize bucket to JSON', () => {
      const bucket = bucketType.createBucket('buy_1_0_100');
      const data = bucket.data as any;
      data.fill_time_distribution[10] = { attempts: 100, fills: 75, probability: 0.75 };
      data.price_fill_distribution['0.450000'] = 50;
      data.price_fill_distribution['0.480000'] = 25;

      const serialized = bucketType.serialize(bucket);
      const parsed = JSON.parse(serialized);

      expect(parsed.bucket_type).toBe('volume_level_probability_fill');
      expect(parsed.bucket_key).toEqual({
        side: 'buy',
        level: 1,
        volumeMin: 0,
        volumeMax: 100,
      });
      expect(parsed.fill_time_distribution[10]).toEqual({
        attempts: 100,
        fills: 75,
        probability: 0.75,
      });
      expect(parsed.price_fill_distribution).toEqual({
        '0.450000': 50,
        '0.480000': 25,
      });
    });

    it('should deserialize JSON to bucket', () => {
      const json = JSON.stringify({
        bucket_type: 'volume_level_probability_fill',
        bucket_key: {
          side: 'sell',
          level: 2,
          volumeMin: 100,
          volumeMax: 200,
        },
        fill_time_distribution: {
          10: { attempts: 50, fills: 30, probability: 0.6 },
        },
        price_fill_distribution: {
          '0.550000': 20,
          '0.560000': 10,
        },
      });

      const bucket = bucketType.deserialize(json);

      expect(bucket).not.toBeNull();
      expect(bucket!.bucketKey).toBe('sell_2_100_200');
      expect(bucket!.bucketType).toBe('volume_level_probability_fill');

      const data = bucket!.data as any;
      expect(data.fill_time_distribution[10]).toEqual({
        attempts: 50,
        fills: 30,
        probability: 0.6,
      });
      expect(data.price_fill_distribution).toEqual({
        '0.550000': 20,
        '0.560000': 10,
      });
    });

    it('should return null for invalid JSON', () => {
      const bucket = bucketType.deserialize('{invalid json}');
      expect(bucket).toBeNull();
    });

    it('should return null for wrong bucket type', () => {
      const json = JSON.stringify({
        bucket_type: 'wrong_type',
        bucket_key: { side: 'buy', level: 1, volumeMin: 0, volumeMax: 100 },
        fill_time_distribution: {},
      });

      const bucket = bucketType.deserialize(json);
      expect(bucket).toBeNull();
    });
  });

  describe('integration scenario', () => {
    it('should track full lifecycle: create → fill → finalize → aggregate', () => {
      const t0 = new Date('2024-01-01T00:00:00Z');
      const t1 = new Date('2024-01-01T00:00:03Z');
      const t2 = new Date('2024-01-01T00:00:08Z');

      // Create 3 attempts
      const orderbook = new OrderBookSnapshotReceivedEvent(
        'asset1',
        [
          { price: 0.50, size: 50 }, // Attempt 1
          { price: 0.49, size: 100 }, // Attempt 2
        ],
        [{ price: 0.51, size: 75 }], // Attempt 3
        t0
      );

      bucketType.processEvent(orderbook);

      // Fill attempt 1 (buy at 0.50 → trade at 0.45)
      const trade1 = new TradeExecutedEvent('asset1', 0.45, 50, 'BUY', t1);
      const results1 = bucketType.processEvent(trade1);
      expect(results1).toHaveLength(1);

      // Fill attempt 3 (sell at 0.51 → trade at 0.55)
      const trade2 = new TradeExecutedEvent('asset1', 0.55, 75, 'SELL', t2);
      const results2 = bucketType.processEvent(trade2);
      expect(results2).toHaveLength(1);

      // Finalize → should return attempt 2 as not filled
      const finalResults = bucketType.finalize();
      expect(finalResults).toHaveLength(1);
      expect(finalResults[0].filled).toBe(false);

      // Aggregate all results
      for (const result of [...results1, ...results2, ...finalResults]) {
        bucketType.aggregateResult(result);
      }

      // Check buckets
      const buckets = bucketType.getBuckets();
      expect(buckets.size).toBe(3); // buy_1, buy_2, sell_1

      const buyBucket1 = buckets.get('buy_1_0_100');
      const buyBucket2 = buckets.get('buy_2_100_200');
      const sellBucket1 = buckets.get('sell_1_0_100');

      expect(buyBucket1).toBeDefined();
      expect(buyBucket2).toBeDefined();
      expect(sellBucket1).toBeDefined();

      // Check buy_1 stats (1 fill at 3s)
      const buy1Data = buyBucket1!.data as any;
      expect(buy1Data.fill_time_distribution[5].attempts).toBe(1);
      expect(buy1Data.fill_time_distribution[5].fills).toBe(1); // 3s <= 5s
      expect(buy1Data.price_fill_distribution['0.450000']).toBe(1);

      // Check buy_2 stats (1 not filled)
      const buy2Data = buyBucket2!.data as any;
      expect(buy2Data.fill_time_distribution[10].attempts).toBe(1);
      expect(buy2Data.fill_time_distribution[10].fills).toBe(0);

      // Check sell_1 stats (1 fill at 8s)
      const sell1Data = sellBucket1!.data as any;
      expect(sell1Data.fill_time_distribution[10].attempts).toBe(1);
      expect(sell1Data.fill_time_distribution[10].fills).toBe(1); // 8s <= 10s
      expect(sell1Data.fill_time_distribution[5].fills).toBe(0); // 8s > 5s
      expect(sell1Data.price_fill_distribution['0.550000']).toBe(1);
    });
  });
});
