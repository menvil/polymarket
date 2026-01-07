/**
 * Bucket Writer Tests
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BucketWriter } from '../../../../../src/application/services/bucketizer/BucketWriter.js';
import { BucketTypeRegistry } from '../../../../../src/application/services/bucketizer/BucketTypeRegistry.js';
import { VolumeLevelProbabilityFillBucketType } from '../../../../../src/application/services/bucketizer/bucket-types/VolumeLevelProbabilityFillBucketType.js';
import type { Bucket } from '../../../../../src/application/services/bucketizer/types/bucket.js';
import { MockLogger } from '../../../../helpers/MockLogger.js';

describe('BucketWriter', () => {
  let writer: BucketWriter;
  let registry: BucketTypeRegistry;
  let logger: MockLogger;
  let tempDir: string;

  beforeEach(async () => {
    logger = new MockLogger();
    registry = new BucketTypeRegistry();

    const bucketType = new VolumeLevelProbabilityFillBucketType({
      maxLevels: 10,
      volumeStep: 100,
      volumeMin: 0,
      volumeMax: 1000,
      horizonsSec: [5, 10, 15, 30, 60, 120],
      logger,
    });

    registry.register(bucketType);

    writer = new BucketWriter(registry, logger);

    // Create temp directory для тестов
    tempDir = path.join(
      process.cwd(),
      'tests',
      'temp',
      `bucket-writer-${Date.now()}`
    );
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    // Cleanup temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('overwrite mode', () => {
    it('should write buckets to new file', async () => {
      const buckets = new Map<string, Bucket>();

      buckets.set(
        'volume_level_probability_fill:buy_1_0_100',
        createBucket('buy_1_0_100', { attempts: 10, fills: 5 })
      );

      buckets.set(
        'volume_level_probability_fill:buy_2_100_200',
        createBucket('buy_2_100_200', { attempts: 20, fills: 10 })
      );

      const stats = await writer.write(buckets, {
        mode: 'overwrite',
        outputDir: tempDir,
      });

      expect(stats.bucketsWritten).toBe(2);
      expect(stats.filesWritten).toBe(1);
      expect(stats.newBuckets).toBe(2);
      expect(stats.mergedBuckets).toBe(0);
      expect(stats.bytesWritten).toBeGreaterThan(0);

      // Verify file exists
      const filePath = path.join(
        tempDir,
        'volume_level_probability_fill',
        'buckets.jsonl'
      );
      const exists = await fileExists(filePath);
      expect(exists).toBe(true);

      // Verify content
      const content = await fs.readFile(filePath, 'utf8');
      const lines = content.trim().split('\n');
      expect(lines.length).toBe(2);
    });

    it('should replace existing file', async () => {
      const filePath = path.join(
        tempDir,
        'volume_level_probability_fill',
        'buckets.jsonl'
      );

      // Create existing file
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, 'old content\n', 'utf8');

      const buckets = new Map<string, Bucket>();
      buckets.set(
        'volume_level_probability_fill:buy_1_0_100',
        createBucket('buy_1_0_100', { attempts: 1, fills: 1 })
      );

      await writer.write(buckets, {
        mode: 'overwrite',
        outputDir: tempDir,
      });

      // Verify file was replaced
      const content = await fs.readFile(filePath, 'utf8');
      expect(content).not.toContain('old content');
      // Check that it contains valid bucket data
      expect(content).toContain('"bucket_type":"volume_level_probability_fill"');
      expect(content).toContain('"side":"buy"');
    });

    it('should handle multiple bucket types', async () => {
      // Register second bucket type (мок)
      const mockBucketType = {
        getName: () => 'mock_bucket_type',
        getBucketKeys: () => [],
        createBucket: (key: string) => ({
          bucketKey: key,
          bucketType: 'mock_bucket_type',
          data: {},
        }),
        update: () => {},
        serialize: (bucket: Bucket) => JSON.stringify(bucket),
        deserialize: (line: string) => JSON.parse(line) as Bucket,
      };

      registry.register(mockBucketType);

      const buckets = new Map<string, Bucket>();

      // Type 1
      buckets.set(
        'volume_level_probability_fill:buy_1_0_100',
        createBucket('buy_1_0_100', { attempts: 1, fills: 1 })
      );

      // Type 2
      buckets.set('mock_bucket_type:BUCKET_2', {
        bucketKey: 'BUCKET_2',
        bucketType: 'mock_bucket_type',
        data: {},
      });

      const stats = await writer.write(buckets, {
        mode: 'overwrite',
        outputDir: tempDir,
      });

      expect(stats.bucketsWritten).toBe(2);
      expect(stats.filesWritten).toBe(2);

      // Verify both files exist
      const file1 = path.join(
        tempDir,
        'volume_level_probability_fill',
        'buckets.jsonl'
      );
      const file2 = path.join(tempDir, 'mock_bucket_type', 'buckets.jsonl');

      expect(await fileExists(file1)).toBe(true);
      expect(await fileExists(file2)).toBe(true);
    });

    it('should create output directory if it does not exist', async () => {
      const nonExistentDir = path.join(tempDir, 'nested', 'deep', 'dir');

      const buckets = new Map<string, Bucket>();
      buckets.set(
        'volume_level_probability_fill:buy_1_0_100',
        createBucket('buy_1_0_100', { attempts: 1, fills: 0 })
      );

      await writer.write(buckets, {
        mode: 'overwrite',
        outputDir: nonExistentDir,
      });

      const filePath = path.join(
        nonExistentDir,
        'volume_level_probability_fill',
        'buckets.jsonl'
      );
      expect(await fileExists(filePath)).toBe(true);
    });
  });

  describe('merge mode', () => {
    it('should merge with existing buckets', async () => {
      const filePath = path.join(
        tempDir,
        'volume_level_probability_fill',
        'buckets.jsonl'
      );

      // Create existing file with 2 buckets
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const existing = [
        createBucket('buy_1_0_100', { attempts: 10, fills: 5 }),
        createBucket('buy_2_100_200', { attempts: 20, fills: 10 }),
      ];

      const bucketType = registry.get('volume_level_probability_fill')!;
      const lines = existing.map((b) => bucketType.serialize(b));
      await fs.writeFile(filePath, lines.join('\n') + '\n', 'utf8');

      // Write new buckets (1 update, 1 new)
      const buckets = new Map<string, Bucket>();
      buckets.set(
        'volume_level_probability_fill:buy_1_0_100',
        createBucket('buy_1_0_100', { attempts: 15, fills: 8 }) // Update buy_1_0_100
      );
      buckets.set(
        'volume_level_probability_fill:sell_1_0_100',
        createBucket('sell_1_0_100', { attempts: 5, fills: 2 }) // New sell_1_0_100
      );

      const stats = await writer.write(buckets, {
        mode: 'merge',
        outputDir: tempDir,
      });

      expect(stats.bucketsWritten).toBe(3); // Total after merge
      expect(stats.mergedBuckets).toBe(1); // buy_1_0_100 updated
      expect(stats.newBuckets).toBe(1); // sell_1_0_100 added

      // Verify merged content
      const content = await fs.readFile(filePath, 'utf8');
      const lines2 = content.trim().split('\n');
      expect(lines2.length).toBe(3);

      // Verify buy_1_0_100 was updated
      const bucket1Line = lines2.find((line) => line.includes('"side":"buy"') && line.includes('"level":1'));
      expect(bucket1Line).toBeDefined();
      const bucket1 = JSON.parse(bucket1Line!);
      expect(bucket1.fill_time_distribution[5].attempts).toBe(15);
      expect(bucket1.fill_time_distribution[5].fills).toBe(8);
    });

    it('should create new file if it does not exist', async () => {
      const buckets = new Map<string, Bucket>();
      buckets.set(
        'volume_level_probability_fill:buy_1_0_100',
        createBucket('buy_1_0_100', { attempts: 5, fills: 2 })
      );

      const stats = await writer.write(buckets, {
        mode: 'merge',
        outputDir: tempDir,
      });

      expect(stats.bucketsWritten).toBe(1);
      expect(stats.newBuckets).toBe(1);
      expect(stats.mergedBuckets).toBe(0);

      const filePath = path.join(
        tempDir,
        'volume_level_probability_fill',
        'buckets.jsonl'
      );
      expect(await fileExists(filePath)).toBe(true);
    });

    it('should preserve buckets not in new set', async () => {
      const filePath = path.join(
        tempDir,
        'volume_level_probability_fill',
        'buckets.jsonl'
      );

      // Create existing file
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const bucketType = registry.get('volume_level_probability_fill')!;

      const existing = [
        createBucket('buy_1_0_100', { attempts: 10, fills: 5 }),
        createBucket('buy_2_100_200', { attempts: 20, fills: 10 }),
      ];

      const lines = existing.map((b) => bucketType.serialize(b));
      await fs.writeFile(filePath, lines.join('\n') + '\n', 'utf8');

      // Write only sell_1_0_100 (не трогаем buy_1 и buy_2)
      const buckets = new Map<string, Bucket>();
      buckets.set(
        'volume_level_probability_fill:sell_1_0_100',
        createBucket('sell_1_0_100', { attempts: 5, fills: 2 })
      );

      await writer.write(buckets, {
        mode: 'merge',
        outputDir: tempDir,
      });

      // Verify all 3 buckets exist
      const content = await fs.readFile(filePath, 'utf8');
      const lines2 = content.trim().split('\n');
      expect(lines2.length).toBe(3);

      expect(content).toContain('"side":"buy"');
      expect(content).toContain('"side":"sell"');
      expect(content).toContain('"level":1');
      expect(content).toContain('"level":2');
    });
  });

  describe('atomic writes', () => {
    it('should use temp file for atomic write', async () => {
      const buckets = new Map<string, Bucket>();
      buckets.set(
        'volume_level_probability_fill:buy_1_0_100',
        createBucket('buy_1_0_100', { attempts: 1, fills: 0 })
      );

      const writePromise = writer.write(buckets, {
        mode: 'overwrite',
        outputDir: tempDir,
      });

      // Temp file должен быть создан во время записи
      // (но это сложно проверить т.к. операция быстрая)

      await writePromise;

      // Verify temp file was removed
      const tempFile = path.join(
        tempDir,
        'volume_level_probability_fill',
        'buckets.jsonl.tmp'
      );
      const tempExists = await fileExists(tempFile);
      expect(tempExists).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should skip unknown bucket types', async () => {
      const buckets = new Map<string, Bucket>();

      // Valid bucket type
      buckets.set(
        'volume_level_probability_fill:buy_1_0_100',
        createBucket('buy_1_0_100', { attempts: 1, fills: 1 })
      );

      // Unknown bucket type
      buckets.set('unknown_type:INVALID', {
        bucketKey: 'INVALID',
        bucketType: 'unknown_type',
        data: {},
      });

      const stats = await writer.write(buckets, {
        mode: 'overwrite',
        outputDir: tempDir,
      });

      // Only valid bucket should be written
      expect(stats.bucketsWritten).toBe(1);
      expect(stats.filesWritten).toBe(1);

      // Verify warning was logged
      expect(logger.warnCalls.length).toBeGreaterThan(0);
    });
  });

  describe('statistics', () => {
    it('should calculate correct statistics', async () => {
      const buckets = new Map<string, Bucket>();

      for (let i = 1; i <= 5; i++) {
        buckets.set(
          `volume_level_probability_fill:BUCKET_${i}`,
          createBucket(`BUCKET_${i}`, { attempts: i * 10, fills: i * 5 })
        );
      }

      const stats = await writer.write(buckets, {
        mode: 'overwrite',
        outputDir: tempDir,
      });

      expect(stats.bucketsWritten).toBe(5);
      expect(stats.filesWritten).toBe(1);
      expect(stats.bytesWritten).toBeGreaterThan(0);
      expect(stats.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should track merge statistics correctly', async () => {
      const filePath = path.join(
        tempDir,
        'volume_level_probability_fill',
        'buckets.jsonl'
      );

      // Create existing file
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const bucketType = registry.get('volume_level_probability_fill')!;

      const existing = [createBucket('buy_1_0_100', { attempts: 10, fills: 5 })];

      const lines = existing.map((b) => bucketType.serialize(b));
      await fs.writeFile(filePath, lines.join('\n') + '\n', 'utf8');

      // Merge: 1 update, 2 new
      const buckets = new Map<string, Bucket>();
      buckets.set(
        'volume_level_probability_fill:buy_1_0_100',
        createBucket('buy_1_0_100', { attempts: 20, fills: 10 })
      );
      buckets.set(
        'volume_level_probability_fill:buy_2_100_200',
        createBucket('buy_2_100_200', { attempts: 5, fills: 2 })
      );
      buckets.set(
        'volume_level_probability_fill:sell_1_0_100',
        createBucket('sell_1_0_100', { attempts: 3, fills: 1 })
      );

      const stats = await writer.write(buckets, {
        mode: 'merge',
        outputDir: tempDir,
      });

      expect(stats.bucketsWritten).toBe(3);
      expect(stats.mergedBuckets).toBe(1); // buy_1_0_100 updated
      expect(stats.newBuckets).toBe(2); // buy_2_100_200, sell_1_0_100 new
    });
  });

  describe('empty input', () => {
    it('should handle empty buckets map', async () => {
      const buckets = new Map<string, Bucket>();

      const stats = await writer.write(buckets, {
        mode: 'overwrite',
        outputDir: tempDir,
      });

      expect(stats.bucketsWritten).toBe(0);
      expect(stats.filesWritten).toBe(0);
    });
  });
});

// Helper functions

function createBucket(
  key: string,
  data: { attempts: number; fills: number }
): Bucket {
  // Создаём multi-horizon формат
  const horizons = [5, 10, 15, 30, 60, 120];
  const fill_time_distribution: Record<number, { attempts: number; fills: number; probability: number }> = {};

  for (const horizon of horizons) {
    fill_time_distribution[horizon] = {
      attempts: data.attempts,
      fills: data.fills,
      probability: data.attempts > 0 ? data.fills / data.attempts : 0,
    };
  }

  return {
    bucketKey: key,
    bucketType: 'volume_level_probability_fill',
    data: {
      fill_time_distribution,
      price_fill_distribution: {},
    },
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
