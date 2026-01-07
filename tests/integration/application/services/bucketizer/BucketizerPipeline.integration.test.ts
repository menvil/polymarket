/**
 * Bucketizer Pipeline Integration Tests
 *
 * @remarks
 * End-to-end тесты для полного пайплайна bucketizer:
 * Snapshots → Normalization → Replay → Bucket Processing → Disk Write
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SnapshotScanner } from '../../../../../src/infrastructure/persistence/snapshot-readers/SnapshotScanner.js';
import { SnapshotReaderFactory } from '../../../../../src/infrastructure/persistence/snapshot-readers/SnapshotReaderFactory.js';
import { ReplayRunner } from '../../../../../src/application/services/bucketizer/ReplayRunner.js';
import { BucketTypeRegistry } from '../../../../../src/application/services/bucketizer/BucketTypeRegistry.js';
import { BucketPipeline } from '../../../../../src/application/services/bucketizer/BucketPipeline.js';
import { BucketWriter } from '../../../../../src/application/services/bucketizer/BucketWriter.js';
import { VolumeLevelProbabilityFillBucketType } from '../../../../../src/application/services/bucketizer/bucket-types/VolumeLevelProbabilityFillBucketType.js';
import { MockLogger } from '../../../../helpers/MockLogger.js';

describe('Bucketizer Pipeline - End-to-End', () => {
  let tempDir: string;
  let snapshotsDir: string;
  let outputDir: string;

  beforeEach(async () => {
    // Create temp directories
    tempDir = path.join(
      process.cwd(),
      'tests',
      'temp',
      `bucketizer-e2e-${Date.now()}`
    );
    snapshotsDir = path.join(tempDir, 'snapshots');
    outputDir = path.join(tempDir, 'buckets');

    await fs.mkdir(snapshotsDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });
  });

  afterEach(async () => {
    // Cleanup
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('should process snapshots end-to-end and write buckets', async () => {
    // ========================================
    // Setup: Create snapshot files
    // ========================================

    const market1 = '0xMarket1';
    const baseTime = new Date('2026-01-05T12:00:00Z').getTime();

    const snapshots = [
      // Orderbook 1
      {
        event_type: 'book',
        asset_id: market1,
        hash: 'hash1',
        bids: [
          { price: '0.50', size: '100' },
          { price: '0.49', size: '150' },
        ],
        asks: [
          { price: '0.51', size: '50' },
          { price: '0.52', size: '75' },
        ],
        timestamp: baseTime,
      },

      // Trade 1
      {
        event_type: 'trade',
        asset_id: market1,
        price: '0.51',
        size: '25',
        side: 'BUY',
        timestamp: baseTime + 1000,
      },

      // Orderbook 2
      {
        event_type: 'book',
        asset_id: market1,
        hash: 'hash2',
        bids: [
          { price: '0.50', size: '120' },
          { price: '0.49', size: '180' },
        ],
        asks: [
          { price: '0.51', size: '30' },
          { price: '0.52', size: '75' },
        ],
        timestamp: baseTime + 2000,
      },

      // Trade 2
      {
        event_type: 'trade',
        asset_id: market1,
        price: '0.50',
        size: '50',
        side: 'SELL',
        timestamp: baseTime + 3000,
      },
    ];

    // Create day directory structure
    const dayDir = path.join(snapshotsDir, '2026-01-05');
    await fs.mkdir(dayDir, { recursive: true });

    // Write snapshot file
    const snapshotFile = path.join(dayDir, 'market1.jsonl');
    const lines = snapshots.map((s) => JSON.stringify(s));
    await fs.writeFile(snapshotFile, lines.join('\n') + '\n', 'utf8');

    // ========================================
    // Execute: Run full pipeline
    // ========================================

    const logger = new MockLogger();

    // 1. Setup components
    const scanner = new SnapshotScanner(snapshotsDir, logger);
    const readerFactory = new SnapshotReaderFactory(logger);
    const registry = new BucketTypeRegistry();

    const bucketType = new VolumeLevelProbabilityFillBucketType({
      maxLevels: 10,
      volumeStep: 100,
      volumeMin: 0,
      volumeMax: 1000,
      horizonsSec: [5, 10, 15, 30, 60, 120],
      logger,
    });
    registry.register(bucketType);

    const pipeline = new BucketPipeline(registry, logger);

    // 2. Setup replay runner
    const runner = new ReplayRunner(
      scanner,
      readerFactory,
      { mode: 'MAX' },
      logger
    );

    // 3. Process events
    const replayStats = await runner.run(
      async (event) => {
        await pipeline.processEvent(event);
      },
      async () => {
        // Finalize after each file
        await pipeline.finalizeFile();
      }
    );

    expect(replayStats.processedEvents).toBe(4);

    // 4. Get buckets from pipeline
    const buckets = pipeline.getBuckets();
    expect(buckets.size).toBeGreaterThan(0);

    // 5. Write buckets to disk
    const writer = new BucketWriter(registry, logger);
    const writeStats = await writer.write(buckets, {
      mode: 'overwrite',
      outputDir,
    });

    // ========================================
    // Verify: Check results
    // ========================================

    expect(writeStats.bucketsWritten).toBeGreaterThan(0);
    expect(writeStats.filesWritten).toBe(1);

    // Verify file exists
    const outputFile = path.join(
      outputDir,
      'volume_level_probability_fill',
      'buckets.jsonl'
    );
    const fileExists = await fs
      .access(outputFile)
      .then(() => true)
      .catch(() => false);

    expect(fileExists).toBe(true);

    // Verify content
    const content = await fs.readFile(outputFile, 'utf8');
    const outputLines = content.trim().split('\n');

    expect(outputLines.length).toBeGreaterThan(0);

    // Parse and verify bucket structure (serialized format)
    const firstBucket = JSON.parse(outputLines[0]);
    expect(firstBucket).toHaveProperty('bucket_key');
    expect(firstBucket).toHaveProperty('bucket_type');
    expect(firstBucket).toHaveProperty('fill_time_distribution');
    expect(firstBucket.bucket_type).toBe('volume_level_probability_fill');
    expect(firstBucket.bucket_key).toHaveProperty('side');
    expect(firstBucket.bucket_key).toHaveProperty('level');

    // Verify multi-horizon structure
    expect(firstBucket.fill_time_distribution).toHaveProperty('5');
    expect(firstBucket.fill_time_distribution[5]).toHaveProperty('attempts');
    expect(firstBucket.fill_time_distribution[5]).toHaveProperty('fills');
    expect(firstBucket.fill_time_distribution[5]).toHaveProperty('probability');

    // Verify statistics are correct
    const pipelineStats = pipeline.getStats();
    expect(pipelineStats.eventsProcessed).toBe(4);
    expect(pipelineStats.bucketsAggregated).toBeGreaterThan(0);
  });

  it('should handle merge mode correctly', async () => {
    const logger = new MockLogger();
    const registry = new BucketTypeRegistry();

    const bucketType = new VolumeLevelProbabilityFillBucketType({
      maxLevels: 10,
      volumeStep: 100,
      volumeMin: 0,
      volumeMax: 1000,
      horizonsSec: [5, 10, 15, 30, 60, 120],
      logger,
    });
    registry.register(bucketType);

    const writer = new BucketWriter(registry, logger);

    // ========================================
    // First batch
    // ========================================

    const market1 = '0xMarket1';
    const baseTime = new Date('2026-01-05T12:00:00Z').getTime();

    const day1Dir = path.join(snapshotsDir, '2026-01-05');
    await fs.mkdir(day1Dir, { recursive: true });

    const snapshots1 = [
      {
        event_type: 'book',
        asset_id: market1,
        hash: 'hash1',
        bids: [{ price: '0.50', size: '100' }],
        asks: [],
        timestamp: baseTime,
      },
    ];

    const file1 = path.join(day1Dir, 'market1.jsonl');
    await fs.writeFile(
      file1,
      snapshots1.map((s) => JSON.stringify(s)).join('\n') + '\n',
      'utf8'
    );

    // Process first batch
    const scanner1 = new SnapshotScanner(snapshotsDir, logger);
    const readerFactory1 = new SnapshotReaderFactory(logger);
    const pipeline1 = new BucketPipeline(registry, logger);

    const runner1 = new ReplayRunner(
      scanner1,
      readerFactory1,
      { mode: 'MAX' },
      logger
    );

    await runner1.run(
      async (event) => {
        await pipeline1.processEvent(event);
      },
      async () => {
        // Finalize after each file
        await pipeline1.finalizeFile();
      }
    );

    // Write first batch
    const stats1 = await writer.write(pipeline1.getBuckets(), {
      mode: 'overwrite',
      outputDir,
    });

    expect(stats1.bucketsWritten).toBeGreaterThan(0);

    // ========================================
    // Second batch (merge)
    // ========================================

    const day2Dir = path.join(snapshotsDir, '2026-01-06');
    await fs.mkdir(day2Dir, { recursive: true });

    const snapshots2 = [
      {
        event_type: 'book',
        asset_id: market1,
        hash: 'hash2',
        bids: [{ price: '0.50', size: '120' }],
        asks: [],
        timestamp: baseTime + 86400000, // +1 day
      },
      {
        event_type: 'trade',
        asset_id: market1,
        price: '0.50',
        size: '50',
        side: 'SELL',
        timestamp: baseTime + 86400000 + 1000,
      },
    ];

    const file2 = path.join(day2Dir, 'market1.jsonl');
    await fs.writeFile(
      file2,
      snapshots2.map((s) => JSON.stringify(s)).join('\n') + '\n',
      'utf8'
    );

    // Process second batch
    const scanner2 = new SnapshotScanner(snapshotsDir, logger);
    const readerFactory2 = new SnapshotReaderFactory(logger);
    const pipeline2 = new BucketPipeline(registry, logger);

    const runner2 = new ReplayRunner(
      scanner2,
      readerFactory2,
      { mode: 'MAX' },
      logger
    );

    await runner2.run(
      async (event) => {
        await pipeline2.processEvent(event);
      },
      async () => {
        // Finalize after each file
        await pipeline2.finalizeFile();
      }
    );

    // Merge with existing
    const stats2 = await writer.write(pipeline2.getBuckets(), {
      mode: 'merge',
      outputDir,
    });

    // ========================================
    // Verify: Check merge results
    // ========================================

    expect(stats2.bucketsWritten).toBeGreaterThan(0);

    // Verify merged file
    const outputFile = path.join(
      outputDir,
      'volume_level_probability_fill',
      'buckets.jsonl'
    );

    const content = await fs.readFile(outputFile, 'utf8');
    const lines = content.trim().split('\n');

    // Should have buckets from both batches
    expect(lines.length).toBeGreaterThan(0);
  });

  it('should handle multiple days correctly', async () => {
    const logger = new MockLogger();
    const market1 = '0xMarket1';
    const baseTime = new Date('2026-01-05T12:00:00Z').getTime();

    // Create snapshots for 3 days
    for (let day = 0; day < 3; day++) {
      const dayStr = `2026-01-0${5 + day}`;
      const dayDir = path.join(snapshotsDir, dayStr);
      await fs.mkdir(dayDir, { recursive: true });

      const snapshots = [
        {
          event_type: 'book',
          asset_id: market1,
          hash: `hash${day}`,
          bids: [{ price: '0.50', size: `${(day + 1) * 100}` }],
          asks: [],
          timestamp: baseTime + day * 86400000,
        },
      ];

      const file = path.join(dayDir, 'market1.jsonl');
      await fs.writeFile(
        file,
        snapshots.map((s) => JSON.stringify(s)).join('\n') + '\n',
        'utf8'
      );
    }

    // Process all days
    const scanner = new SnapshotScanner(snapshotsDir, logger);
    const readerFactory = new SnapshotReaderFactory(logger);
    const registry = new BucketTypeRegistry();

    const bucketType = new VolumeLevelProbabilityFillBucketType({
      maxLevels: 10,
      volumeStep: 100,
      volumeMin: 0,
      volumeMax: 1000,
      horizonsSec: [5, 10, 15, 30, 60, 120],
      logger,
    });
    registry.register(bucketType);

    const pipeline = new BucketPipeline(registry, logger);
    const runner = new ReplayRunner(
      scanner,
      readerFactory,
      { mode: 'MAX' },
      logger
    );

    const stats = await runner.run(
      async (event) => {
        await pipeline.processEvent(event);
      },
      async () => {
        // Finalize after each file
        await pipeline.finalizeFile();
      }
    );

    expect(stats.processedEvents).toBe(3); // 3 orderbook snapshots

    // Write buckets
    const writer = new BucketWriter(registry, logger);
    await writer.write(pipeline.getBuckets(), {
      mode: 'overwrite',
      outputDir,
    });

    // Verify output
    const outputFile = path.join(
      outputDir,
      'volume_level_probability_fill',
      'buckets.jsonl'
    );
    const exists = await fs
      .access(outputFile)
      .then(() => true)
      .catch(() => false);

    expect(exists).toBe(true);
  });
});
