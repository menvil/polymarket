/**
 * SnapshotReaderFactory — фабрика читателей снапшотов.
 *
 * @remarks
 * Автоматически выбирает реализацию на основе расширения файла:
 * - `.jsonl` → `JsonlSnapshotReader`
 * - `.jsonl.gz` → `GzipJsonlSnapshotReader`
 *
 * @example
 * ```typescript
 * const factory = new SnapshotReaderFactory(logger);
 * const reader = factory.create('./data/market.jsonl.gz');
 * ```
 */
import type { ILogger } from '@polymarket/logger';
import type { ISnapshotReader } from './ISnapshotReader.js';
import { JsonlSnapshotReader } from './JsonlSnapshotReader.js';
import { GzipJsonlSnapshotReader } from './GzipJsonlSnapshotReader.js';

export class SnapshotReaderFactory {
  /**
   * @param _logger - Логгер (передаётся в GzipJsonlSnapshotReader)
   */
  constructor(private readonly _logger: ILogger) {}

  /**
   * Создаёт читатель для указанного файла.
   *
   * @param filePath - Путь к файлу (.jsonl или .jsonl.gz)
   * @returns Соответствующий ISnapshotReader
   *
   * @throws {Error} Если расширение файла не поддерживается
   *
   * @example
   * ```typescript
   * const reader = factory.create('./snapshots/2026-01-01/market.jsonl.gz');
   * for await (const line of reader.readLines()) {
   *   const event = JSON.parse(line);
   * }
   * await reader.close();
   * ```
   */
  create(filePath: string): ISnapshotReader {
    if (filePath.endsWith('.jsonl.gz')) {
      return new GzipJsonlSnapshotReader(filePath, this._logger);
    }
    if (filePath.endsWith('.jsonl')) {
      return new JsonlSnapshotReader(filePath);
    }
    throw new Error(`Unsupported snapshot file extension: ${filePath}`);
  }

  /**
   * Проверяет, поддерживается ли формат файла.
   *
   * @param filePath - Путь к файлу
   * @returns true для .jsonl и .jsonl.gz
   *
   * @example
   * ```typescript
   * factory.isSupported('market.jsonl');    // true
   * factory.isSupported('market.jsonl.gz'); // true
   * factory.isSupported('market.parquet');  // false
   * ```
   */
  isSupported(filePath: string): boolean {
    return filePath.endsWith('.jsonl') || filePath.endsWith('.jsonl.gz');
  }
}
