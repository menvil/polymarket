/**
 * Arrow Formatter - Apache Arrow IPC format
 *
 * @remarks
 * Записывает данные в формате Apache Arrow IPC (Inter-Process Communication).
 * Arrow - это columnar in-memory формат, эффективный для аналитики.
 *
 * Особенности:
 * - Columnar format (эффективен для аналитических запросов)
 * - Zero-copy reads (быстрый доступ к данным)
 * - Cross-language compatibility (Python, R, Julia, etc.)
 * - Batch-based (накапливает записи в batch перед сериализацией)
 *
 * Ограничения:
 * - Не поддерживает streaming (требует accumulate + finalize)
 * - Больший memory footprint при накоплении
 *
 * @example
 * ```typescript
 * const formatter = new ArrowFormatter();
 *
 * // Накопление записей
 * formatter.formatRecord({ event_type: 'book', ... });
 * formatter.formatRecord({ event_type: 'trade', ... });
 *
 * // Финализация в Arrow IPC buffer
 * const buffer = formatter.finalize();
 * fs.writeFileSync('data.arrow', buffer);
 * ```
 *
 * @module infrastructure/persistence/data-collection/formatters
 */

import {
  tableToIPC,
  tableFromArrays,
} from 'apache-arrow';
import type { IFormatter, DataFormat } from './IFormatter.js';

/**
 * Accumulated record for Arrow table
 */
interface AccumulatedRecord {
  event_type: string;
  asset_id: string;
  timestamp: bigint;
  raw_json: string;
}

/**
 * Arrow Formatter
 *
 * @remarks
 * Форматирует данные в Apache Arrow IPC формат.
 * Накапливает записи в памяти и сериализует при finalize().
 */
export class ArrowFormatter implements IFormatter {
  /**
   * File extension for Arrow files
   */
  readonly extension = 'arrow';

  /**
   * Format identifier
   */
  readonly format: DataFormat = 'arrow';

  /**
   * Accumulated records
   */
  private records: AccumulatedRecord[] = [];

  /**
   * Check if formatter supports streaming
   *
   * @returns false - Arrow requires batch processing
   */
  supportsStreaming(): boolean {
    return false;
  }

  /**
   * Format a single record
   *
   * @param record - Record to format
   * @returns Empty string (Arrow doesn't support streaming)
   *
   * @remarks
   * Накапливает записи в памяти.
   * Реальная сериализация происходит в finalize().
   */
  formatRecord(record: object): string {
    // Extract common fields
    const rawRecord = record as Record<string, unknown>;
    const eventType = (rawRecord.event_type as string) || (rawRecord.t as string) || 'unknown';
    const assetId = (rawRecord.asset_id as string) || '';
    const timestamp = this.extractTimestamp(rawRecord);

    // Store accumulated record
    this.records.push({
      event_type: eventType,
      asset_id: assetId,
      timestamp: BigInt(timestamp),
      raw_json: JSON.stringify(record),
    });

    // Return empty string - Arrow doesn't support streaming writes
    return '';
  }

  /**
   * Format a batch of records
   *
   * @param records - Records to format
   * @returns Arrow IPC buffer
   */
  formatBatch(records: object[]): Buffer {
    for (const record of records) {
      this.formatRecord(record);
    }
    return this.finalize() ?? Buffer.alloc(0);
  }

  /**
   * Finalize and return Arrow IPC buffer
   *
   * @returns Arrow IPC buffer or null if no records
   *
   * @remarks
   * Создаёт Arrow Table из накопленных записей и сериализует в IPC формат.
   */
  finalize(): Buffer | null {
    if (this.records.length === 0) {
      return null;
    }

    try {
      // Create column arrays
      const eventTypes: string[] = [];
      const assetIds: string[] = [];
      const timestamps: bigint[] = [];
      const rawJsons: string[] = [];

      for (const record of this.records) {
        eventTypes.push(record.event_type);
        assetIds.push(record.asset_id);
        timestamps.push(record.timestamp);
        rawJsons.push(record.raw_json);
      }

      // Create Arrow table
      const table = tableFromArrays({
        event_type: eventTypes,
        asset_id: assetIds,
        timestamp: timestamps,
        raw_json: rawJsons,
      });

      // Serialize to IPC format
      const ipcBuffer = tableToIPC(table);

      // Clear accumulated records
      this.records = [];

      return Buffer.from(ipcBuffer);
    } catch (error) {
      // Fallback: clear records and return null
      this.records = [];
      throw error;
    }
  }

  /**
   * Extract timestamp from record
   */
  private extractTimestamp(record: Record<string, unknown>): number {
    // Try different timestamp fields
    if (typeof record.timestamp === 'string') {
      return parseInt(record.timestamp, 10);
    }
    if (typeof record.timestamp === 'number') {
      return record.timestamp;
    }
    if (typeof record.ts === 'number') {
      return record.ts;
    }
    return Date.now();
  }

  /**
   * Get number of accumulated records
   */
  getRecordCount(): number {
    return this.records.length;
  }

  /**
   * Clear accumulated records
   */
  clear(): void {
    this.records = [];
  }
}
