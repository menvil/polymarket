/**
 * Snapshot Reader Interface
 *
 * @remarks
 * Интерфейс для чтения snapshot файлов построчно.
 * Поддерживает plain .jsonl и gzipped .jsonl.gz файлы.
 *
 * @example
 * ```typescript
 * const reader = await factory.create(filePath);
 *
 * for await (const line of reader.readLines()) {
 *   const event = JSON.parse(line);
 *   // process event
 * }
 *
 * await reader.close();
 * ```
 */

/**
 * Snapshot Reader Interface
 */
export interface ISnapshotReader {
  /**
   * Read lines from snapshot file
   *
   * @yields JSON lines as strings
   *
   * @remarks
   * Yields one line at a time (memory efficient).
   * Each line is a valid JSON string.
   */
  readLines(): AsyncGenerator<string, void, undefined>;

  /**
   * Close reader and cleanup resources
   *
   * @remarks
   * For gzipped files: removes temporary decompressed file.
   * Always call this in finally block.
   */
  close(): Promise<void>;

  /**
   * Get file path being read
   */
  getFilePath(): string;
}

/**
 * Snapshot file metadata
 */
export interface SnapshotFileInfo {
  /** Full path to file */
  filePath: string;
  /** Date folder (YYYY-MM-DD) */
  date: string;
  /** File name without path */
  fileName: string;
  /** Is gzipped? */
  isGzipped: boolean;
  /** File size in bytes */
  sizeBytes: number;
}
