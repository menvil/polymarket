/**
 * Replay Runner Tests
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { ReplayRunner } from '../../../../../src/application/services/bucketizer/ReplayRunner.js';
import { SnapshotScanner } from '../../../../../src/infrastructure/persistence/snapshot-readers/SnapshotScanner.js';
import { SnapshotReaderFactory } from '../../../../../src/infrastructure/persistence/snapshot-readers/SnapshotReaderFactory.js';
import type { ReplayConfig } from '../../../../../src/application/services/bucketizer/types/replay.js';
import type { DomainEvent } from '../../../../../src/domain/events/DomainEvent.js';
import { MockLogger } from '../../../../helpers/MockLogger.js';

describe('ReplayRunner', () => {
  const testDir = '/tmp/bucketizer-test-replay';
  let scanner: SnapshotScanner;
  let readerFactory: SnapshotReaderFactory;
  let logger: MockLogger;

  beforeEach(async () => {
    logger = new MockLogger();
    scanner = new SnapshotScanner(testDir, logger);
    readerFactory = new SnapshotReaderFactory(logger);

    // Create test directory structure
    await createTestStructure();
  });

  afterEach(async () => {
    // Cleanup test directory
    if (fs.existsSync(testDir)) {
      await fs.promises.rm(testDir, { recursive: true, force: true });
    }
  });

  async function createTestStructure(): Promise<void> {
    await fs.promises.mkdir(testDir, { recursive: true });
    await fs.promises.mkdir(path.join(testDir, '2026-01-01'), {
      recursive: true,
    });
    await fs.promises.mkdir(path.join(testDir, '2026-01-02'), {
      recursive: true,
    });

    // Create test events with timestamps
    const baseTime = new Date('2026-01-01T10:00:00Z').getTime();

    const events = [
      // Book event at T+0s
      {
        event_type: 'book',
        asset_id: '0x123',
        bids: [{ price: '0.50', size: '100' }],
        asks: [{ price: '0.51', size: '100' }],
        timestamp: baseTime,
      },
      // Trade event at T+5s
      {
        event_type: 'trade',
        asset_id: '0x123',
        price: '0.50',
        size: '10',
        side: 'BUY',
        timestamp: baseTime + 5000,
      },
      // Book event at T+10s
      {
        event_type: 'book',
        asset_id: '0x123',
        bids: [{ price: '0.51', size: '200' }],
        asks: [{ price: '0.52', size: '150' }],
        timestamp: baseTime + 10000,
      },
      // Control message (should be skipped)
      {
        event_type: 'pong',
      },
      // Invalid JSON (should be skipped)
      'invalid json',
    ];

    const content = events
      .map((e) => (typeof e === 'string' ? e : JSON.stringify(e)))
      .join('\n');

    await fs.promises.writeFile(
      path.join(testDir, '2026-01-01', 'market1.jsonl'),
      content
    );

    // Create gzipped file for day 2
    const events2 = [
      {
        event_type: 'trade',
        asset_id: '0x456',
        price: '0.75',
        size: '50',
        side: 'SELL',
        timestamp: baseTime + 20000,
      },
    ];

    const content2 = events2.map((e) => JSON.stringify(e)).join('\n');
    const compressed = zlib.gzipSync(content2);
    await fs.promises.writeFile(
      path.join(testDir, '2026-01-02', 'market2.jsonl.gz'),
      compressed
    );
  }

  describe('MAX mode', () => {
    it('should process all events without delays', async () => {
      const config: ReplayConfig = {
        mode: 'MAX',
      };

      const runner = new ReplayRunner(scanner, readerFactory, config, logger);

      const processedEvents: DomainEvent[] = [];
      const stats = await runner.run(async (event) => {
        processedEvents.push(event);
      });

      // 3 valid events from file1 + 1 from file2
      expect(stats.processedEvents).toBe(4);
      expect(stats.totalEvents).toBe(6); // Including skipped
      expect(stats.skippedEvents).toBe(2); // pong + invalid json
      expect(stats.errorEvents).toBe(0);
      expect(stats.filesProcessed).toBe(2);
      expect(stats.totalDelayMs).toBe(0); // MAX mode = no delays
      expect(processedEvents).toHaveLength(4);

      // Check event types distribution
      expect(stats.eventsByType['OrderBookSnapshotReceived']).toBe(2);
      expect(stats.eventsByType['TradeExecuted']).toBe(2);
    });

    it('should process events as fast as possible', async () => {
      const config: ReplayConfig = {
        mode: 'MAX',
      };

      const runner = new ReplayRunner(scanner, readerFactory, config, logger);

      const start = Date.now();
      await runner.run(async () => {
        // No-op handler
      });
      const duration = Date.now() - start;

      // Should be very fast (< 100ms for 4 events)
      expect(duration).toBeLessThan(100);
    });
  });

  describe('SCALED mode', () => {
    it('should apply scaled delays between events', async () => {
      const config: ReplayConfig = {
        mode: 'SCALED',
        scale: 0.01, // 100x faster
      };

      const runner = new ReplayRunner(scanner, readerFactory, config, logger);

      const start = Date.now();
      const stats = await runner.run(async () => {
        // No-op handler
      });
      const duration = Date.now() - start;

      // Events have timestamps: 0s, 5s, 10s, 20s
      // Delays: 0ms, 50ms (5s * 0.01), 50ms (5s * 0.01), 100ms (10s * 0.01)
      // Total expected delay: ~200ms
      expect(stats.totalDelayMs).toBeGreaterThan(150);
      expect(stats.totalDelayMs).toBeLessThan(250);

      // Actual duration should be close to total delay
      expect(duration).toBeGreaterThan(150);
      expect(duration).toBeLessThan(300);
    });

    it('should respect maxCatchupDelayMs limit', async () => {
      const config: ReplayConfig = {
        mode: 'SCALED',
        scale: 1.0, // Real time
        maxCatchupDelayMs: 10, // Max 10ms
      };

      const runner = new ReplayRunner(scanner, readerFactory, config, logger);

      const start = Date.now();
      const stats = await runner.run(async () => {
        // No-op handler
      });
      const duration = Date.now() - start;

      // Without limit, delays would be: 5000ms, 5000ms, 10000ms = 20000ms
      // With limit=10ms: 10ms, 10ms, 10ms = 30ms
      expect(stats.totalDelayMs).toBeLessThan(50);
      expect(duration).toBeLessThan(100);
    });

    it('should handle negative time diffs gracefully', async () => {
      // Create file with reversed timestamps
      const reverseDir = path.join(testDir, '2026-01-03');
      await fs.promises.mkdir(reverseDir, { recursive: true });

      const baseTime = Date.now();
      const content = [
        JSON.stringify({
          event_type: 'book',
          asset_id: '0x999',
          bids: [],
          asks: [],
          timestamp: baseTime,
        }),
        JSON.stringify({
          event_type: 'book',
          asset_id: '0x999',
          bids: [],
          asks: [],
          timestamp: baseTime - 5000, // Earlier timestamp
        }),
      ].join('\n');

      await fs.promises.writeFile(
        path.join(reverseDir, 'reverse.jsonl'),
        content
      );

      const config: ReplayConfig = {
        mode: 'SCALED',
        scale: 1.0,
        scanOptions: { fromDate: '2026-01-03', toDate: '2026-01-03' },
      };

      const runner = new ReplayRunner(scanner, readerFactory, config, logger);

      const stats = await runner.run(async () => {
        // No-op
      });

      // Should not delay for negative diff
      expect(stats.processedEvents).toBe(2);
      expect(stats.totalDelayMs).toBe(0);
    });
  });

  describe('backpressure control', () => {
    it('should process events sequentially', async () => {
      const config: ReplayConfig = {
        mode: 'MAX',
      };

      const runner = new ReplayRunner(scanner, readerFactory, config, logger);

      const processingOrder: number[] = [];
      let currentlyProcessing = 0;
      let maxConcurrent = 0;

      await runner.run(async () => {
        currentlyProcessing++;
        maxConcurrent = Math.max(maxConcurrent, currentlyProcessing);
        processingOrder.push(currentlyProcessing);

        // Simulate async work
        await new Promise((resolve) => setTimeout(resolve, 1));

        currentlyProcessing--;
      });

      // Should never have more than 1 event processing at a time
      expect(maxConcurrent).toBe(1);
      expect(processingOrder).toEqual([1, 1, 1, 1]);
    });
  });

  describe('error handling', () => {
    it('should continue processing after callback errors', async () => {
      const config: ReplayConfig = {
        mode: 'MAX',
      };

      const runner = new ReplayRunner(scanner, readerFactory, config, logger);

      let callCount = 0;
      const stats = await runner.run(async (_event) => {
        callCount++;
        if (callCount === 2) {
          throw new Error('Test error');
        }
      });

      expect(stats.processedEvents).toBe(3); // 3 successful
      expect(stats.errorEvents).toBe(1); // 1 error
      expect(stats.totalEvents).toBe(6);
      expect(callCount).toBe(4); // All 4 valid events attempted
    });

    it('should log errors from callback', async () => {
      const config: ReplayConfig = {
        mode: 'MAX',
      };

      const runner = new ReplayRunner(scanner, readerFactory, config, logger);

      await runner.run(async () => {
        throw new Error('Callback error');
      });

      // Check that errors were logged
      expect(logger.errorCalls.length).toBeGreaterThan(0);
    });
  });

  describe('graceful shutdown', () => {
    it('should stop processing when signal is aborted', async () => {
      const config: ReplayConfig = {
        mode: 'MAX',
      };

      const runner = new ReplayRunner(scanner, readerFactory, config, logger);

      const abortController = new AbortController();
      let processedCount = 0;

      const runPromise = runner.run(
        async () => {
          processedCount++;
          if (processedCount === 2) {
            abortController.abort();
          }
        },
        async () => {
          // onFileComplete callback
        },
        abortController.signal
      );

      await expect(runPromise).rejects.toThrow('Aborted');

      // Should have processed at least 2 events before abort
      expect(processedCount).toBeGreaterThanOrEqual(2);
      expect(processedCount).toBeLessThan(4);
    });

    it('should throw immediately if signal is already aborted', async () => {
      const config: ReplayConfig = {
        mode: 'MAX',
      };

      const runner = new ReplayRunner(scanner, readerFactory, config, logger);

      const abortController = new AbortController();
      abortController.abort(); // Abort before run

      const runPromise = runner.run(
        async () => {
          // Should not be called
        },
        async () => {
          // onFileComplete callback
        },
        abortController.signal
      );

      await expect(runPromise).rejects.toThrow('Aborted');
    });

    it('should abort during sleep in SCALED mode', async () => {
      const config: ReplayConfig = {
        mode: 'SCALED',
        scale: 1.0, // Real time delays
      };

      const runner = new ReplayRunner(scanner, readerFactory, config, logger);

      const abortController = new AbortController();

      // Abort after 50ms
      setTimeout(() => abortController.abort(), 50);

      const runPromise = runner.run(
        async () => {
          // No-op
        },
        async () => {
          // onFileComplete callback
        },
        abortController.signal
      );

      await expect(runPromise).rejects.toThrow('Aborted');
    });
  });

  describe('statistics', () => {
    it('should track all statistics correctly', async () => {
      const config: ReplayConfig = {
        mode: 'MAX',
      };

      const runner = new ReplayRunner(scanner, readerFactory, config, logger);

      const stats = await runner.run(async () => {
        // No-op
      });

      expect(stats.totalEvents).toBe(6);
      expect(stats.processedEvents).toBe(4);
      expect(stats.skippedEvents).toBe(2);
      expect(stats.errorEvents).toBe(0);
      expect(stats.filesProcessed).toBe(2);
      expect(stats.startTime).toBeInstanceOf(Date);
      expect(stats.endTime).toBeInstanceOf(Date);
      expect(stats.durationMs).toBeGreaterThan(0);
      expect(stats.totalDelayMs).toBe(0);
      expect(stats.eventsByType).toEqual({
        OrderBookSnapshotReceived: 2,
        TradeExecuted: 2,
      });
    });

    it('should calculate duration correctly', async () => {
      const config: ReplayConfig = {
        mode: 'MAX',
      };

      const runner = new ReplayRunner(scanner, readerFactory, config, logger);

      const stats = await runner.run(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(stats.durationMs).toBeGreaterThan(40); // 4 events * 10ms
      expect(stats.endTime.getTime() - stats.startTime.getTime()).toBe(
        stats.durationMs
      );
    });
  });

  describe('file handling', () => {
    it('should handle multiple files in order', async () => {
      const config: ReplayConfig = {
        mode: 'MAX',
      };

      const runner = new ReplayRunner(scanner, readerFactory, config, logger);

      const assetIds: string[] = [];
      await runner.run(async (event) => {
        assetIds.push((event as any).assetId);
      });

      // First 3 events from day 1 (asset 0x123), then 1 from day 2 (asset 0x456)
      expect(assetIds).toEqual(['0x123', '0x123', '0x123', '0x456']);
    });

    it('should cleanup temp files for gzipped files', async () => {
      const config: ReplayConfig = {
        mode: 'MAX',
        scanOptions: { fromDate: '2026-01-02', toDate: '2026-01-02' },
      };

      const runner = new ReplayRunner(scanner, readerFactory, config, logger);

      await runner.run(async () => {
        // No-op
      });

      // Check no temp files remain
      const files = await fs.promises.readdir(path.join(testDir, '2026-01-02'));
      const tempFiles = files.filter((f) => f.includes('.decompressed.'));
      expect(tempFiles).toHaveLength(0);
    });

    it('should handle empty scan result', async () => {
      const emptyDir = '/tmp/bucketizer-test-empty';
      await fs.promises.mkdir(emptyDir, { recursive: true });

      const emptyScanner = new SnapshotScanner(emptyDir, logger);

      const config: ReplayConfig = {
        mode: 'MAX',
      };

      const runner = new ReplayRunner(
        emptyScanner,
        readerFactory,
        config,
        logger
      );

      const stats = await runner.run(async () => {
        // Should not be called
      });

      expect(stats.totalEvents).toBe(0);
      expect(stats.processedEvents).toBe(0);
      expect(stats.filesProcessed).toBe(0);

      await fs.promises.rm(emptyDir, { recursive: true });
    });
  });

  describe('date filtering', () => {
    it('should respect scanOptions date range', async () => {
      const config: ReplayConfig = {
        mode: 'MAX',
        scanOptions: {
          fromDate: '2026-01-01',
          toDate: '2026-01-01',
        },
      };

      const runner = new ReplayRunner(scanner, readerFactory, config, logger);

      const stats = await runner.run(async () => {
        // No-op
      });

      // Only file from 2026-01-01 (3 valid events)
      expect(stats.processedEvents).toBe(3);
      expect(stats.filesProcessed).toBe(1);
    });

    it('should process only day 2 when filtered', async () => {
      const config: ReplayConfig = {
        mode: 'MAX',
        scanOptions: {
          fromDate: '2026-01-02',
          toDate: '2026-01-02',
        },
      };

      const runner = new ReplayRunner(scanner, readerFactory, config, logger);

      const assetIds: string[] = [];
      await runner.run(async (event) => {
        assetIds.push((event as any).assetId);
      });

      // Only file from 2026-01-02 (1 event with asset 0x456)
      expect(assetIds).toEqual(['0x456']);
    });
  });
});
