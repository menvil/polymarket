/**
 * Snapshot Readers Tests
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { JsonlSnapshotReader } from '../../../../../src/infrastructure/persistence/snapshot-readers/JsonlSnapshotReader.js';
import { GzipJsonlSnapshotReader } from '../../../../../src/infrastructure/persistence/snapshot-readers/GzipJsonlSnapshotReader.js';
import { SnapshotReaderFactory } from '../../../../../src/infrastructure/persistence/snapshot-readers/SnapshotReaderFactory.js';
import { MockLogger } from '../../../../helpers/MockLogger.js';

describe('Snapshot Readers', () => {
  const testDir = '/tmp/bucketizer-test-readers';
  let logger: MockLogger;

  beforeEach(async () => {
    logger = new MockLogger();
    await fs.promises.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    if (fs.existsSync(testDir)) {
      await fs.promises.rm(testDir, { recursive: true, force: true });
    }
  });

  describe('JsonlSnapshotReader', () => {
    it('should read plain .jsonl file line by line', async () => {
      const filePath = path.join(testDir, 'test.jsonl');
      const content = '{"line":1}\n{"line":2}\n{"line":3}\n';
      await fs.promises.writeFile(filePath, content);

      const reader = new JsonlSnapshotReader(filePath);
      const lines: string[] = [];

      try {
        for await (const line of reader.readLines()) {
          lines.push(line);
        }
      } finally {
        await reader.close();
      }

      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe('{"line":1}');
      expect(lines[1]).toBe('{"line":2}');
      expect(lines[2]).toBe('{"line":3}');
    });

    it('should skip empty lines', async () => {
      const filePath = path.join(testDir, 'test.jsonl');
      const content = '{"line":1}\n\n{"line":2}\n  \n{"line":3}\n';
      await fs.promises.writeFile(filePath, content);

      const reader = new JsonlSnapshotReader(filePath);
      const lines: string[] = [];

      try {
        for await (const line of reader.readLines()) {
          lines.push(line);
        }
      } finally {
        await reader.close();
      }

      expect(lines).toHaveLength(3);
    });

    it('should handle large files efficiently', async () => {
      const filePath = path.join(testDir, 'large.jsonl');

      // Create file with 1000 lines
      const lines = Array.from({ length: 1000 }, (_, i) => `{"line":${i}}`).join('\n');
      await fs.promises.writeFile(filePath, lines);

      const reader = new JsonlSnapshotReader(filePath);
      let count = 0;

      try {
        for await (const _line of reader.readLines()) {
          count++;
        }
      } finally {
        await reader.close();
      }

      expect(count).toBe(1000);
    });

    it('should return correct file path', () => {
      const filePath = path.join(testDir, 'test.jsonl');
      const reader = new JsonlSnapshotReader(filePath);

      expect(reader.getFilePath()).toBe(filePath);
    });
  });

  describe('GzipJsonlSnapshotReader', () => {
    it('should read gzipped .jsonl.gz file line by line', async () => {
      const filePath = path.join(testDir, 'test.jsonl.gz');
      const content = '{"line":1}\n{"line":2}\n{"line":3}\n';

      // Create gzipped file
      const compressed = zlib.gzipSync(content);
      await fs.promises.writeFile(filePath, compressed);

      const reader = new GzipJsonlSnapshotReader(filePath, logger);
      const lines: string[] = [];

      try {
        for await (const line of reader.readLines()) {
          lines.push(line);
        }
      } finally {
        await reader.close();
      }

      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe('{"line":1}');
      expect(lines[1]).toBe('{"line":2}');
      expect(lines[2]).toBe('{"line":3}');
    });

    it('should cleanup temp file after close', async () => {
      const filePath = path.join(testDir, 'test.jsonl.gz');
      const content = '{"line":1}\n';
      const compressed = zlib.gzipSync(content);
      await fs.promises.writeFile(filePath, compressed);

      const reader = new GzipJsonlSnapshotReader(filePath, logger);

      // Read lines (triggers decompression)
      for await (const _line of reader.readLines()) {
        // Read one line
        break;
      }

      // Check temp file exists before close
      const tempFiles = (await fs.promises.readdir(testDir)).filter(f =>
        f.includes('.decompressed.')
      );
      expect(tempFiles.length).toBeGreaterThan(0);

      // Close should delete temp file
      await reader.close();

      const tempFilesAfter = (await fs.promises.readdir(testDir)).filter(f =>
        f.includes('.decompressed.')
      );
      expect(tempFilesAfter).toHaveLength(0);
    });

    it('should skip empty lines', async () => {
      const filePath = path.join(testDir, 'test.jsonl.gz');
      const content = '{"line":1}\n\n{"line":2}\n';
      const compressed = zlib.gzipSync(content);
      await fs.promises.writeFile(filePath, compressed);

      const reader = new GzipJsonlSnapshotReader(filePath, logger);
      const lines: string[] = [];

      try {
        for await (const line of reader.readLines()) {
          lines.push(line);
        }
      } finally {
        await reader.close();
      }

      expect(lines).toHaveLength(2);
    });

    it('should return correct file path', () => {
      const filePath = path.join(testDir, 'test.jsonl.gz');
      const reader = new GzipJsonlSnapshotReader(filePath, logger);

      expect(reader.getFilePath()).toBe(filePath);
    });
  });

  describe('SnapshotReaderFactory', () => {
    it('should create JsonlSnapshotReader for .jsonl files', () => {
      const factory = new SnapshotReaderFactory(logger);
      const reader = factory.create('/path/to/file.jsonl');

      expect(reader).toBeInstanceOf(JsonlSnapshotReader);
    });

    it('should create GzipJsonlSnapshotReader for .jsonl.gz files', () => {
      const factory = new SnapshotReaderFactory(logger);
      const reader = factory.create('/path/to/file.jsonl.gz');

      expect(reader).toBeInstanceOf(GzipJsonlSnapshotReader);
    });

    it('should throw for unsupported extensions', () => {
      const factory = new SnapshotReaderFactory(logger);

      expect(() => factory.create('/path/to/file.txt')).toThrow(
        'Unsupported file extension'
      );
    });

    it('should correctly identify supported files', () => {
      const factory = new SnapshotReaderFactory(logger);

      expect(factory.isSupported('/path/to/file.jsonl')).toBe(true);
      expect(factory.isSupported('/path/to/file.jsonl.gz')).toBe(true);
      expect(factory.isSupported('/path/to/file.txt')).toBe(false);
      expect(factory.isSupported('/path/to/file.json')).toBe(false);
    });
  });
});
