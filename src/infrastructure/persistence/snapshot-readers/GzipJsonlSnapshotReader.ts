/**
 * Gzipped JSONL Snapshot Reader
 *
 * @remarks
 * Reads .jsonl.gz files by decompressing to temporary file first.
 * Ensures cleanup of temporary file in close().
 *
 * Algorithm:
 * 1. Decompress .gz to temp file
 * 2. Read from temp file line by line
 * 3. Delete temp file in close()
 *
 * @example
 * ```typescript
 * const reader = new GzipJsonlSnapshotReader('/path/to/file.jsonl.gz', logger);
 *
 * try {
 *   for await (const line of reader.readLines()) {
 *     console.log(line);
 *   }
 * } finally {
 *   await reader.close(); // Deletes temp file
 * }
 * ```
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import * as readline from 'readline';
import { pipeline } from 'stream/promises';
import type { ILogger } from '../../../domain/ports/ILogger.js';
import type { ISnapshotReader } from './ISnapshotReader.js';

/**
 * Gzipped JSONL Snapshot Reader
 */
export class GzipJsonlSnapshotReader implements ISnapshotReader {
  private readonly filePath: string;
  private readonly logger: ILogger;
  private tempFilePath: string | null = null;
  private stream: fs.ReadStream | null = null;
  private isDecompressed = false;

  constructor(filePath: string, logger: ILogger) {
    this.filePath = filePath;
    this.logger = logger;
  }

  /**
   * Read lines from .jsonl.gz file
   *
   * @yields JSON lines
   *
   * @remarks
   * First call decompresses file to temp location.
   * Subsequent calls read from cached temp file.
   */
  async *readLines(): AsyncGenerator<string, void, undefined> {
    // Decompress if not done yet
    if (!this.isDecompressed) {
      await this.decompress();
    }

    if (!this.tempFilePath) {
      throw new Error('Failed to decompress file');
    }

    // Create read stream from temp file
    this.stream = fs.createReadStream(this.tempFilePath, {
      encoding: 'utf8',
      highWaterMark: 64 * 1024, // 64KB buffer
    });

    // Create readline interface
    const rl = readline.createInterface({
      input: this.stream,
      crlfDelay: Infinity,
    });

    // Yield lines
    for await (const line of rl) {
      // Skip empty lines
      if (line.trim().length === 0) {
        continue;
      }

      yield line;
    }
  }

  /**
   * Decompress .gz file to temporary location
   *
   * @remarks
   * Temp file: <original>.decompressed.<pid>
   * Uses streams for memory efficiency.
   */
  private async decompress(): Promise<void> {
    // Generate temp file path
    const dir = path.dirname(this.filePath);
    const baseName = path.basename(this.filePath, '.gz');
    this.tempFilePath = path.join(dir, `${baseName}.decompressed.${process.pid}`);

    // Decompress using streams
    const source = fs.createReadStream(this.filePath);
    const destination = fs.createWriteStream(this.tempFilePath);
    const gunzip = zlib.createGunzip();

    try {
      await pipeline(source, gunzip, destination);
      this.isDecompressed = true;
    } catch (error) {
      // Cleanup on error
      await this.cleanupTempFile();
      throw new Error(`Failed to decompress ${this.filePath}: ${error}`);
    }
  }

  /**
   * Close reader and cleanup
   *
   * @remarks
   * CRITICAL: Deletes temporary decompressed file.
   * Always call in finally block.
   */
  async close(): Promise<void> {
    // Close stream
    if (this.stream) {
      this.stream.destroy();
      this.stream = null;
    }

    // Delete temp file
    await this.cleanupTempFile();
  }

  /**
   * Delete temporary decompressed file
   */
  private async cleanupTempFile(): Promise<void> {
    if (!this.tempFilePath) {
      return;
    }

    try {
      if (fs.existsSync(this.tempFilePath)) {
        await fs.promises.unlink(this.tempFilePath);
      }
    } catch (error) {
      this.logger.warn('Failed to delete temp file', {
        temp: this.tempFilePath,
        error,
      });
    } finally {
      this.tempFilePath = null;
      this.isDecompressed = false;
    }
  }

  /**
   * Get original file path
   */
  getFilePath(): string {
    return this.filePath;
  }
}
