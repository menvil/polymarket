/**
 * Snapshot Reader Factory
 *
 * @remarks
 * Создаёт правильный reader в зависимости от расширения файла:
 * - .jsonl → JsonlSnapshotReader
 * - .jsonl.gz → GzipJsonlSnapshotReader
 *
 * @example
 * ```typescript
 * const factory = new SnapshotReaderFactory(logger);
 *
 * const reader = factory.create('/path/to/file.jsonl.gz');
 * // Returns GzipJsonlSnapshotReader
 *
 * try {
 *   for await (const line of reader.readLines()) {
 *     // process
 *   }
 * } finally {
 *   await reader.close();
 * }
 * ```
 */

import type { ILogger } from '../../../domain/ports/ILogger.js';
import type { ISnapshotReader } from './ISnapshotReader.js';
import { JsonlSnapshotReader } from './JsonlSnapshotReader.js';
import { GzipJsonlSnapshotReader } from './GzipJsonlSnapshotReader.js';

/**
 * Snapshot Reader Factory
 */
export class SnapshotReaderFactory {
  private readonly logger: ILogger;

  constructor(logger: ILogger) {
    this.logger = logger;
  }

  /**
   * Create appropriate reader for file
   *
   * @param filePath - Path to snapshot file
   * @returns Reader instance
   *
   * @throws {Error} If file extension is not supported
   *
   * @remarks
   * Supported extensions:
   * - .jsonl → JsonlSnapshotReader
   * - .jsonl.gz → GzipJsonlSnapshotReader
   */
  create(filePath: string): ISnapshotReader {
    if (filePath.endsWith('.jsonl.gz')) {
      return new GzipJsonlSnapshotReader(filePath, this.logger);
    }

    if (filePath.endsWith('.jsonl')) {
      return new JsonlSnapshotReader(filePath);
    }

    throw new Error(
      `Unsupported file extension: ${filePath}. Expected .jsonl or .jsonl.gz`
    );
  }

  /**
   * Check if file is supported
   *
   * @param filePath - Path to check
   * @returns True if file can be read
   */
  isSupported(filePath: string): boolean {
    return filePath.endsWith('.jsonl') || filePath.endsWith('.jsonl.gz');
  }
}
