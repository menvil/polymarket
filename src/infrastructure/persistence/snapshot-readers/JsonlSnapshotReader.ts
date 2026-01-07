/**
 * Plain JSONL Snapshot Reader
 *
 * @remarks
 * Reads plain .jsonl files line by line.
 * Memory efficient - uses stream, не загружает весь файл в память.
 *
 * @example
 * ```typescript
 * const reader = new JsonlSnapshotReader('/path/to/file.jsonl');
 *
 * try {
 *   for await (const line of reader.readLines()) {
 *     console.log(line);
 *   }
 * } finally {
 *   await reader.close();
 * }
 * ```
 */

import * as fs from 'fs';
import * as readline from 'readline';
import type { ISnapshotReader } from './ISnapshotReader.js';

/**
 * Plain JSONL Snapshot Reader
 */
export class JsonlSnapshotReader implements ISnapshotReader {
  private readonly filePath: string;
  private stream: fs.ReadStream | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /**
   * Read lines from .jsonl file
   *
   * @yields JSON lines
   *
   * @remarks
   * Uses readline interface for line-by-line reading.
   * Empty lines are skipped.
   */
  async *readLines(): AsyncGenerator<string, void, undefined> {
    // Create read stream
    this.stream = fs.createReadStream(this.filePath, {
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
   * Close reader
   *
   * @remarks
   * Closes file stream if open.
   */
  async close(): Promise<void> {
    if (this.stream) {
      this.stream.destroy();
      this.stream = null;
    }
  }

  /**
   * Get file path
   */
  getFilePath(): string {
    return this.filePath;
  }
}
