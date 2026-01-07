/**
 * Parquet Formatter - Apache Parquet columnar format
 *
 * @remarks
 * Записывает данные в формате Apache Parquet.
 * Parquet - это columnar storage format, оптимизированный для аналитики.
 *
 * Особенности:
 * - Columnar format (эффективные аналитические запросы)
 * - Отличное сжатие (особенно для повторяющихся данных)
 * - Schema-based (строгая типизация)
 * - Широко поддерживается (Spark, Pandas, DuckDB, etc.)
 *
 * Использование:
 * - Batch-based: накапливает записи, затем finalize() записывает файл
 * - Требует finalizePath() для записи в файл (Parquet не поддерживает append)
 *
 * @example
 * ```typescript
 * const formatter = new ParquetFormatter();
 *
 * // Накопление записей
 * formatter.formatRecord({ event_type: 'book', ... });
 * formatter.formatRecord({ event_type: 'trade', ... });
 *
 * // Финализация в файл
 * await formatter.finalizePath('/path/to/data.parquet');
 * ```
 *
 * @module infrastructure/persistence/data-collection/formatters
 */

import type { IFormatter, DataFormat } from './IFormatter.js';

// Dynamic import for parquetjs (ESM compatibility)
let ParquetSchema: any;
let ParquetWriter: any;

/**
 * Accumulated record for Parquet
 */
interface ParquetRecord {
  event_type: string;
  asset_id: string;
  timestamp: bigint;
  raw_json: string;
}

/**
 * Parquet schema for market data
 */
const SCHEMA_DEFINITION = {
  event_type: { type: 'UTF8' },
  asset_id: { type: 'UTF8' },
  timestamp: { type: 'INT64' },
  raw_json: { type: 'UTF8' },
};

/**
 * Parquet Formatter
 *
 * @remarks
 * Форматирует данные в Apache Parquet формат.
 * Накапливает записи в памяти и записывает при finalizePath().
 */
export class ParquetFormatter implements IFormatter {
  /**
   * File extension for Parquet files
   */
  readonly extension = 'parquet';

  /**
   * Format identifier
   */
  readonly format: DataFormat = 'parquet';

  /**
   * Accumulated records
   */
  private records: ParquetRecord[] = [];

  /**
   * Whether parquetjs is loaded
   */
  private static parquetLoaded = false;

  /**
   * Load parquetjs dynamically
   */
  private async loadParquet(): Promise<void> {
    if (ParquetFormatter.parquetLoaded) return;

    try {
      const parquet = await import('@dsnp/parquetjs');
      ParquetSchema = parquet.ParquetSchema;
      ParquetWriter = parquet.ParquetWriter;
      ParquetFormatter.parquetLoaded = true;
    } catch (error) {
      throw new Error(
        'Failed to load @dsnp/parquetjs. Install it with: npm install @dsnp/parquetjs'
      );
    }
  }

  /**
   * Check if formatter supports streaming
   *
   * @returns false - Parquet requires batch processing
   */
  supportsStreaming(): boolean {
    return false;
  }

  /**
   * Format a single record
   *
   * @param record - Record to format
   * @returns Empty string (Parquet doesn't support streaming)
   *
   * @remarks
   * Накапливает записи в памяти.
   * Реальная запись происходит в finalizePath().
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

    // Return empty string - Parquet doesn't support streaming writes
    return '';
  }

  /**
   * Format a batch of records
   *
   * @param records - Records to format
   * @returns Empty buffer (use finalizePath instead)
   */
  formatBatch(records: object[]): Buffer {
    for (const record of records) {
      this.formatRecord(record);
    }
    return Buffer.alloc(0);
  }

  /**
   * Finalize (for IFormatter interface)
   *
   * @returns null - Use finalizePath() for Parquet
   *
   * @remarks
   * Parquet требует прямую запись в файл.
   * Используйте finalizePath() для записи.
   */
  finalize(): Buffer | null {
    // Parquet cannot return a buffer - must write to file directly
    // This is a limitation of the parquetjs library
    return null;
  }

  /**
   * Finalize and write to file
   *
   * @param filePath - Path to output file
   *
   * @remarks
   * Записывает накопленные данные в Parquet файл.
   */
  async finalizePath(filePath: string): Promise<void> {
    if (this.records.length === 0) {
      return;
    }

    await this.loadParquet();

    try {
      // Create schema
      const schema = new ParquetSchema(SCHEMA_DEFINITION);

      // Create writer
      const writer = await ParquetWriter.openFile(schema, filePath, {
        compression: 'SNAPPY',
      });

      // Write records
      for (const record of this.records) {
        await writer.appendRow({
          event_type: record.event_type,
          asset_id: record.asset_id,
          timestamp: record.timestamp,
          raw_json: record.raw_json,
        });
      }

      // Close writer
      await writer.close();

      // Clear records
      this.records = [];
    } catch (error) {
      // Clear records on error too
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
