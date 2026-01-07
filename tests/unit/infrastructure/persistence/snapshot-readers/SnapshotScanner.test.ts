/**
 * Snapshot Scanner Tests
 */

import * as fs from 'fs';
import * as path from 'path';
import { SnapshotScanner } from '../../../../../src/infrastructure/persistence/snapshot-readers/SnapshotScanner.js';
import { MockLogger } from '../../../../helpers/MockLogger.js';

describe('SnapshotScanner', () => {
  const testDir = '/tmp/bucketizer-test-snapshots';
  let scanner: SnapshotScanner;
  let logger: MockLogger;

  beforeEach(async () => {
    logger = new MockLogger();
    scanner = new SnapshotScanner(testDir, logger);

    // Create test directory structure
    await createTestStructure();
  });

  afterEach(async () => {
    // Cleanup test directory
    await cleanupTestStructure();
  });

  async function createTestStructure(): Promise<void> {
    // Create directories
    await fs.promises.mkdir(testDir, { recursive: true });
    await fs.promises.mkdir(path.join(testDir, '2026-01-01'), { recursive: true });
    await fs.promises.mkdir(path.join(testDir, '2026-01-02'), { recursive: true });
    await fs.promises.mkdir(path.join(testDir, '2026-01-03'), { recursive: true });
    await fs.promises.mkdir(path.join(testDir, 'invalid-folder'), { recursive: true });

    // Create test files
    await fs.promises.writeFile(
      path.join(testDir, '2026-01-01', 'market1.jsonl'),
      '{"test":1}\n'
    );
    await fs.promises.writeFile(
      path.join(testDir, '2026-01-01', 'market2.jsonl.gz'),
      'gzipped content'
    );
    await fs.promises.writeFile(
      path.join(testDir, '2026-01-02', 'market3.jsonl'),
      '{"test":2}\n'
    );
    await fs.promises.writeFile(
      path.join(testDir, '2026-01-02', 'ignored.txt'),
      'should be ignored'
    );
    await fs.promises.writeFile(
      path.join(testDir, '2026-01-03', 'market4.jsonl.gz'),
      'gzipped content'
    );
    await fs.promises.writeFile(
      path.join(testDir, 'invalid-folder', 'market5.jsonl'),
      'should be ignored (invalid folder name)'
    );
  }

  async function cleanupTestStructure(): Promise<void> {
    if (fs.existsSync(testDir)) {
      await fs.promises.rm(testDir, { recursive: true, force: true });
    }
  }

  describe('scan()', () => {
    it('should find all .jsonl and .jsonl.gz files', async () => {
      const result = await scanner.scan();

      expect(result.totalFiles).toBe(4);
      expect(result.files).toHaveLength(4);

      const fileNames = result.files.map(f => f.fileName);
      expect(fileNames).toContain('market1.jsonl');
      expect(fileNames).toContain('market2.jsonl.gz');
      expect(fileNames).toContain('market3.jsonl');
      expect(fileNames).toContain('market4.jsonl.gz');
    });

    it('should ignore non-date folders', async () => {
      const result = await scanner.scan();

      const dates = result.files.map(f => f.date);
      expect(dates).not.toContain('invalid-folder');
    });

    it('should ignore non-.jsonl files', async () => {
      const result = await scanner.scan();

      const fileNames = result.files.map(f => f.fileName);
      expect(fileNames).not.toContain('ignored.txt');
    });

    it('should set correct isGzipped flag', async () => {
      const result = await scanner.scan();

      const gzippedFiles = result.files.filter(f => f.isGzipped);
      const plainFiles = result.files.filter(f => !f.isGzipped);

      expect(gzippedFiles).toHaveLength(2);
      expect(plainFiles).toHaveLength(2);

      expect(gzippedFiles.every(f => f.fileName.endsWith('.gz'))).toBe(true);
      expect(plainFiles.every(f => !f.fileName.endsWith('.gz'))).toBe(true);
    });

    it('should include file sizes', async () => {
      const result = await scanner.scan();

      expect(result.totalSizeBytes).toBeGreaterThan(0);
      expect(result.files.every(f => f.sizeBytes > 0)).toBe(true);
    });

    it('should sort files by date then filename', async () => {
      const result = await scanner.scan();

      for (let i = 1; i < result.files.length; i++) {
        const prev = result.files[i - 1];
        const curr = result.files[i];

        if (prev.date === curr.date) {
          expect(prev.fileName.localeCompare(curr.fileName)).toBeLessThanOrEqual(0);
        } else {
          expect(prev.date.localeCompare(curr.date)).toBeLessThan(0);
        }
      }
    });

    it('should filter by fromDate', async () => {
      const result = await scanner.scan({ fromDate: '2026-01-02' });

      expect(result.totalFiles).toBe(2);
      expect(result.files.every(f => f.date >= '2026-01-02')).toBe(true);
    });

    it('should filter by toDate', async () => {
      const result = await scanner.scan({ toDate: '2026-01-02' });

      expect(result.totalFiles).toBe(3);
      expect(result.files.every(f => f.date <= '2026-01-02')).toBe(true);
    });

    it('should filter by date range', async () => {
      const result = await scanner.scan({
        fromDate: '2026-01-02',
        toDate: '2026-01-02',
      });

      expect(result.totalFiles).toBe(1);
      expect(result.files.every(f => f.date === '2026-01-02')).toBe(true);
    });

    it('should include date range in result', async () => {
      const result = await scanner.scan({
        fromDate: '2026-01-01',
        toDate: '2026-01-03',
      });

      expect(result.dateRange.from).toBe('2026-01-01');
      expect(result.dateRange.to).toBe('2026-01-03');
    });

    it('should list all dates found', async () => {
      const result = await scanner.scan();

      expect(result.datesFound).toEqual(['2026-01-01', '2026-01-02', '2026-01-03']);
    });

    it('should throw if input directory does not exist', async () => {
      const badScanner = new SnapshotScanner('/nonexistent/path', logger);

      await expect(badScanner.scan()).rejects.toThrow('Input directory not found');
    });

    it('should handle empty directory', async () => {
      const emptyDir = '/tmp/bucketizer-test-empty';
      await fs.promises.mkdir(emptyDir, { recursive: true });

      const emptyScanner = new SnapshotScanner(emptyDir, logger);
      const result = await emptyScanner.scan();

      expect(result.totalFiles).toBe(0);
      expect(result.files).toHaveLength(0);

      await fs.promises.rm(emptyDir, { recursive: true });
    });
  });
});
