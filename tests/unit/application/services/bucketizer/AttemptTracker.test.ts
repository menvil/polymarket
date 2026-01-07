/**
 * AttemptTracker Tests
 *
 * @remarks
 * Comprehensive tests for AttemptTracker - core stateful attempt lifecycle management.
 */

import { AttemptTracker } from '../../../../../src/application/services/bucketizer/AttemptTracker.js';
import { MockLogger } from '../../../../helpers/MockLogger.js';

describe('AttemptTracker', () => {
  let tracker: AttemptTracker;
  let logger: MockLogger;

  beforeEach(() => {
    logger = new MockLogger();
    tracker = new AttemptTracker(
      {
        horizonsSec: [5, 10, 15, 30, 60, 120],
        maxHorizonSec: 120,
        volumeConfig: {
          volumeMin: 0,
          volumeMax: 1000,
          volumeStep: 100,
        },
        levelsConfig: {
          maxLevels: 10,
        },
      },
      logger
    );
  });

  describe('onOrderBookSnapshot', () => {
    it('should create buy attempts from bids', () => {
      const results = tracker.onOrderBookSnapshot(
        1000, // t0 = 1000ms
        [
          { price: 0.50, size: 50 },  // Level 1, cum 50
          { price: 0.49, size: 100 }, // Level 2, cum 150
        ],
        []
      );

      // No results on snapshot (attempts created but not completed)
      expect(results).toEqual([]);

      // Check stats
      const stats = tracker.getStats();
      expect(stats.activeAttempts).toBe(2); // 2 buy attempts
    });

    it('should create sell attempts from asks', () => {
      const results = tracker.onOrderBookSnapshot(
        1000,
        [],
        [
          { price: 0.51, size: 75 },  // Level 1, cum 75
          { price: 0.52, size: 50 },  // Level 2, cum 125
        ]
      );

      expect(results).toEqual([]);

      const stats = tracker.getStats();
      expect(stats.activeAttempts).toBe(2); // 2 sell attempts
    });

    it('should create attempts for both sides', () => {
      tracker.onOrderBookSnapshot(
        1000,
        [
          { price: 0.50, size: 50 },
          { price: 0.49, size: 100 },
        ],
        [
          { price: 0.51, size: 75 },
          { price: 0.52, size: 50 },
        ]
      );

      const stats = tracker.getStats();
      expect(stats.activeAttempts).toBe(4); // 2 buy + 2 sell
    });

    it('should respect maxLevels', () => {
      const bids = Array.from({ length: 20 }, (_, i) => ({
        price: 0.5 - i * 0.01,
        size: 10,
      }));

      tracker.onOrderBookSnapshot(1000, bids, []);

      const stats = tracker.getStats();
      // Should only create attempts for first 10 levels
      expect(stats.activeAttempts).toBeLessThanOrEqual(10);
    });

    it('should expire old attempts on new snapshot', () => {
      // Create attempts at t=1000
      tracker.onOrderBookSnapshot(
        1000,
        [{ price: 0.50, size: 50 }],
        []
      );

      expect(tracker.getStats().activeAttempts).toBe(1);

      // New snapshot at t=121001 (121 seconds later, exceeds maxHorizon)
      const results = tracker.onOrderBookSnapshot(121001, [], []);

      // Should expire the old attempt
      expect(results).toHaveLength(1);
      expect(results[0].filled).toBe(false);
      expect(tracker.getStats().activeAttempts).toBe(0);
    });

    it('should handle multiple volume bins for same level', () => {
      // If cum volume crosses multiple bins, we create multiple attempts
      tracker.onOrderBookSnapshot(
        1000,
        [
          { price: 0.50, size: 50 },   // cum 50 → bin 0-100
          { price: 0.49, size: 100 },  // cum 150 → bin 100-200
          { price: 0.48, size: 200 },  // cum 350 → bin 300-400
        ],
        []
      );

      const stats = tracker.getStats();
      expect(stats.activeAttempts).toBe(3);
    });
  });

  describe('onTrade - buy attempt matching', () => {
    it('should fill buy attempt when trade price <= myPrice', () => {
      // Create buy attempt with myPrice=0.50
      tracker.onOrderBookSnapshot(
        1000,
        [{ price: 0.50, size: 50 }],
        []
      );

      // Trade at 0.45 (< 0.50) should match
      const results = tracker.onTrade(
        4000, // 3 seconds later
        0.45,
        50,
        'BUY'
      );

      expect(results).toHaveLength(1);
      expect(results[0].filled).toBe(true);
      expect(results[0].fillTimeSec).toBe(3);
      expect(results[0].fillPrice).toBe(0.45);
      expect(results[0].bucketKey.side).toBe('buy');
    });

    it('should NOT fill buy attempt when trade price > myPrice', () => {
      // Create buy attempt with myPrice=0.50
      tracker.onOrderBookSnapshot(
        1000,
        [{ price: 0.50, size: 50 }],
        []
      );

      // Trade at 0.55 (> 0.50) should NOT match
      const results = tracker.onTrade(2000, 0.55, 50, 'BUY');

      expect(results).toEqual([]);
      expect(tracker.getStats().activeAttempts).toBe(1); // Still active
    });

    it('should handle partial fills', () => {
      // Create buy attempt with size=100
      tracker.onOrderBookSnapshot(
        1000,
        [{ price: 0.50, size: 100 }],
        []
      );

      // First trade: 40 units
      const results1 = tracker.onTrade(2000, 0.48, 40, 'BUY');
      expect(results1).toEqual([]); // Not filled yet
      expect(tracker.getStats().activeAttempts).toBe(1);

      // Second trade: 60 units → fills
      const results2 = tracker.onTrade(4000, 0.49, 60, 'BUY');
      expect(results2).toHaveLength(1);
      expect(results2[0].filled).toBe(true);
      expect(results2[0].fillTimeSec).toBe(3);
      expect(results2[0].fillPrice).toBe(0.49);
      expect(tracker.getStats().activeAttempts).toBe(0);
    });

    it('should fill multiple attempts with one trade', () => {
      // Create 2 buy attempts at different levels
      tracker.onOrderBookSnapshot(
        1000,
        [
          { price: 0.50, size: 50 },  // Attempt 1
          { price: 0.49, size: 100 }, // Attempt 2
        ],
        []
      );

      expect(tracker.getStats().activeAttempts).toBe(2);

      // Trade at 0.45 matches BOTH attempts (0.45 <= 0.50 and 0.45 <= 0.49)
      const results = tracker.onTrade(4000, 0.45, 200, 'BUY');

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.filled)).toBe(true);
      expect(tracker.getStats().activeAttempts).toBe(0);
    });
  });

  describe('onTrade - sell attempt matching', () => {
    it('should fill sell attempt when trade price >= myPrice', () => {
      // Create sell attempt with myPrice=0.51
      tracker.onOrderBookSnapshot(
        1000,
        [],
        [{ price: 0.51, size: 75 }]
      );

      // Trade at 0.55 (> 0.51) should match
      const results = tracker.onTrade(6000, 0.55, 75, 'SELL');

      expect(results).toHaveLength(1);
      expect(results[0].filled).toBe(true);
      expect(results[0].fillTimeSec).toBe(5);
      expect(results[0].fillPrice).toBe(0.55);
      expect(results[0].bucketKey.side).toBe('sell');
    });

    it('should NOT fill sell attempt when trade price < myPrice', () => {
      // Create sell attempt with myPrice=0.51
      tracker.onOrderBookSnapshot(
        1000,
        [],
        [{ price: 0.51, size: 75 }]
      );

      // Trade at 0.48 (< 0.51) should NOT match
      const results = tracker.onTrade(2000, 0.48, 75, 'SELL');

      expect(results).toEqual([]);
      expect(tracker.getStats().activeAttempts).toBe(1);
    });
  });

  describe('attempt expiry', () => {
    it('should expire attempts after maxHorizon', () => {
      // Create attempt at t=1000
      tracker.onOrderBookSnapshot(
        1000,
        [{ price: 0.50, size: 50 }],
        []
      );

      // Trade at t=121001 (121 seconds later, exceeds maxHorizon)
      const results = tracker.onTrade(121001, 0.45, 50, 'BUY');

      // Attempt should be expired before trade processing
      expect(results).toHaveLength(1);
      expect(results[0].filled).toBe(false); // Expired, not filled
      expect(tracker.getStats().activeAttempts).toBe(0);
    });

    it('should expire multiple attempts', () => {
      // Create 3 attempts at t=1000
      tracker.onOrderBookSnapshot(
        1000,
        [
          { price: 0.50, size: 50 },
          { price: 0.49, size: 100 },
        ],
        [{ price: 0.51, size: 75 }]
      );

      expect(tracker.getStats().activeAttempts).toBe(3);

      // All expire at t=121001
      const results = tracker.onTrade(121001, 0.45, 50, 'BUY');

      expect(results).toHaveLength(3);
      expect(results.every((r) => !r.filled)).toBe(true);
      expect(tracker.getStats().activeAttempts).toBe(0);
    });

    it('should not expire attempts before maxHorizon', () => {
      // Create attempt at t=1000
      tracker.onOrderBookSnapshot(
        1000,
        [{ price: 0.50, size: 50 }],
        []
      );

      // Trade at t=120000 (119 seconds later, within maxHorizon)
      const results = tracker.onTrade(120000, 0.45, 50, 'BUY');

      // Should fill, not expire
      expect(results).toHaveLength(1);
      expect(results[0].filled).toBe(true);
    });
  });

  describe('closeAll', () => {
    it('should return all active attempts as not filled', () => {
      // Create 3 attempts
      tracker.onOrderBookSnapshot(
        1000,
        [
          { price: 0.50, size: 50 },
          { price: 0.49, size: 100 },
        ],
        [{ price: 0.51, size: 75 }]
      );

      const results = tracker.closeAll();

      expect(results).toHaveLength(3);
      expect(results.every((r) => !r.filled)).toBe(true);
      expect(tracker.getStats().activeAttempts).toBe(0);
    });

    it('should not return already filled attempts', () => {
      // Create 2 attempts
      tracker.onOrderBookSnapshot(
        1000,
        [
          { price: 0.50, size: 50 },
          { price: 0.49, size: 100 },
        ],
        []
      );

      // Fill one
      tracker.onTrade(2000, 0.48, 50, 'BUY');

      // Close all
      const results = tracker.closeAll();

      // Should return only 1 (the unfilled one)
      expect(results).toHaveLength(1);
      expect(results[0].filled).toBe(false);
    });

    it('should clear all attempts', () => {
      tracker.onOrderBookSnapshot(
        1000,
        [{ price: 0.50, size: 50 }],
        []
      );

      expect(tracker.getStats().activeAttempts).toBe(1);

      tracker.closeAll();

      expect(tracker.getStats().activeAttempts).toBe(0);

      // Calling again should return empty
      const results = tracker.closeAll();
      expect(results).toEqual([]);
    });
  });

  describe('volume binning', () => {
    it('should bin cumulative volume correctly', () => {
      // volumeStep=100, volumeMin=0, volumeMax=1000
      tracker.onOrderBookSnapshot(
        1000,
        [
          { price: 0.50, size: 50 },   // cum 50 → bin 0-100
          { price: 0.49, size: 100 },  // cum 150 → bin 100-200
          { price: 0.48, size: 200 },  // cum 350 → bin 300-400
        ],
        []
      );

      // Create 3 attempts
      expect(tracker.getStats().activeAttempts).toBe(3);

      // Fill all
      const results = tracker.onTrade(2000, 0.40, 500, 'BUY');

      expect(results).toHaveLength(3);

      // Check bucket keys
      expect(results[0].bucketKey.volumeMin).toBe(0);
      expect(results[0].bucketKey.volumeMax).toBe(100);

      expect(results[1].bucketKey.volumeMin).toBe(100);
      expect(results[1].bucketKey.volumeMax).toBe(200);

      expect(results[2].bucketKey.volumeMin).toBe(300);
      expect(results[2].bucketKey.volumeMax).toBe(400);
    });

    it('should skip volumes outside range', () => {
      // volumeMin=0, volumeMax=1000
      tracker.onOrderBookSnapshot(
        1000,
        [
          { price: 0.50, size: 1500 }, // cum 1500 > volumeMax
        ],
        []
      );

      // Should not create attempt (volume out of range)
      expect(tracker.getStats().activeAttempts).toBe(0);
    });
  });

  describe('pessimistic queue model', () => {
    it('should update needToEatQty when size increases', () => {
      // First snapshot: size=50 → creates attempt at volume bin 0-100
      tracker.onOrderBookSnapshot(
        1000,
        [{ price: 0.50, size: 50 }],
        []
      );

      // Second snapshot: size=100 (increased by 50)
      // cumVolume=100 → creates NEW attempt at volume bin 100-200
      tracker.onOrderBookSnapshot(
        2000,
        [{ price: 0.50, size: 100 }],
        []
      );

      // Now we have 2 attempts (one for each volume bin)
      expect(tracker.getStats().activeAttempts).toBe(2);

      // Trade with 150 units should fill BOTH
      const results = tracker.onTrade(3000, 0.45, 150, 'BUY');

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.filled)).toBe(true);
    });

    it('should credit progress when size decreases after trades', () => {
      // First snapshot: size=100
      tracker.onOrderBookSnapshot(
        1000,
        [{ price: 0.50, size: 100 }],
        []
      );

      // Trade: 30 units
      tracker.onTrade(2000, 0.45, 30, 'BUY');

      // Second snapshot: size=80 (decreased by 20)
      tracker.onOrderBookSnapshot(
        3000,
        [{ price: 0.50, size: 80 }],
        []
      );

      // Attempt should credit the progress
      // Need to eat: 100 - 30 (trade) - 20 (credited) = 50
      const results = tracker.onTrade(4000, 0.45, 50, 'BUY');

      expect(results).toHaveLength(1);
      expect(results[0].filled).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should handle empty orderbook', () => {
      const results = tracker.onOrderBookSnapshot(1000, [], []);

      expect(results).toEqual([]);
      expect(tracker.getStats().activeAttempts).toBe(0);
    });

    it('should handle trade with side=null', () => {
      tracker.onOrderBookSnapshot(
        1000,
        [{ price: 0.50, size: 50 }],
        []
      );

      // Trade without side should still match based on price
      const results = tracker.onTrade(2000, 0.45, 50, null);

      expect(results).toHaveLength(1);
      expect(results[0].filled).toBe(true);
    });

    it('should handle zero-size levels', () => {
      const results = tracker.onOrderBookSnapshot(
        1000,
        [
          { price: 0.50, size: 0 },   // Level 1: size=0, cumVolume=0
          { price: 0.49, size: 100 }, // Level 2: size=100, cumVolume=100
        ],
        []
      );

      expect(results).toEqual([]);
      // Both levels create attempts (cumVolume increases for both)
      // Level 1: cumVolume=0 (no bin)
      // Level 2: cumVolume=100 → bin 0-100 AND bin 100-200
      // Actually, cumVolume=100 creates attempt at bin 0-100 (since 0 <= 100 < 100 is false, 100 <= 100 < 200 is true)
      // Wait, let me check the logic: volumeMin <= cumVolume < volumeMax
      // For cumVolume=100: 0 <= 100 < 100 is FALSE, 100 <= 100 < 200 is TRUE
      // So only 1 attempt at bin 100-200
      // But level 1 with cumVolume=0: 0 <= 0 < 100 is TRUE
      // So 2 attempts total
      expect(tracker.getStats().activeAttempts).toBe(2);
    });

    it('should handle very large trades', () => {
      tracker.onOrderBookSnapshot(
        1000,
        [{ price: 0.50, size: 50 }],
        []
      );

      // Trade size much larger than needToEatQty
      const results = tracker.onTrade(2000, 0.45, 10000, 'BUY');

      expect(results).toHaveLength(1);
      expect(results[0].filled).toBe(true);
    });
  });

  describe('getStats', () => {
    it('should return correct stats', () => {
      tracker.onOrderBookSnapshot(
        1000,
        [
          { price: 0.50, size: 50 },
          { price: 0.49, size: 100 },
        ],
        []
      );

      const stats = tracker.getStats();

      expect(stats.activeAttempts).toBe(2);
      expect(stats.expiryQueueSize).toBe(2);
    });

    it('should update after fills', () => {
      tracker.onOrderBookSnapshot(
        1000,
        [{ price: 0.50, size: 50 }],
        []
      );

      expect(tracker.getStats().activeAttempts).toBe(1);

      tracker.onTrade(2000, 0.45, 50, 'BUY');

      expect(tracker.getStats().activeAttempts).toBe(0);
      expect(tracker.getStats().expiryQueueSize).toBe(0);
    });
  });
});
