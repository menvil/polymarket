/**
 * Bucket Writer Types
 *
 * @remarks
 * Типы для записи buckets на диск с поддержкой merge strategies.
 *
 * @module application/services/bucketizer/types
 */

import type { Bucket } from './bucket.js';

/**
 * Режим записи buckets
 */
export type WriteMode = 'overwrite' | 'merge';

/**
 * Опции для записи buckets
 */
export interface BucketWriteOptions {
  /**
   * Режим записи
   *
   * @remarks
   * - 'overwrite': Заменить существующие файлы
   * - 'merge': Объединить с существующими buckets
   */
  mode: WriteMode;

  /**
   * Директория для сохранения buckets
   *
   * @example
   * ```typescript
   * './buckets'
   * ```
   */
  outputDir: string;

  /**
   * Размер batch для записи (опционально)
   *
   * @remarks
   * Если указан, buckets будут записываться батчами для оптимизации I/O.
   * Default: записать все buckets за один проход.
   */
  batchSize?: number;
}

/**
 * Статистика записи buckets
 */
export interface BucketWriteStats {
  /** Количество записанных buckets */
  bucketsWritten: number;

  /** Количество созданных/обновлённых файлов */
  filesWritten: number;

  /** Общий размер записанных данных (байты) */
  bytesWritten: number;

  /** Количество объединённых buckets (только для merge mode) */
  mergedBuckets: number;

  /** Количество новых buckets (только для merge mode) */
  newBuckets: number;

  /** Продолжительность операции (мс) */
  durationMs: number;
}

/**
 * Интерфейс для записи buckets на диск
 */
export interface IBucketWriter {
  /**
   * Записывает buckets на диск
   *
   * @param buckets - Map buckets (storageKey → Bucket)
   * @param options - Опции записи
   * @returns Статистика записи
   *
   * @remarks
   * Алгоритм:
   * 1. Группировка buckets по типу
   * 2. Для каждого типа:
   *    - overwrite mode: записать в temp файл, затем atomic rename
   *    - merge mode: прочитать существующий файл, объединить, записать
   * 3. Возврат статистики
   *
   * @example
   * ```typescript
   * const stats = await writer.write(buckets, {
   *   mode: 'merge',
   *   outputDir: './buckets',
   *   batchSize: 1000
   * });
   * console.log(`Written ${stats.bucketsWritten} buckets`);
   * ```
   */
  write(
    buckets: Map<string, Bucket>,
    options: BucketWriteOptions
  ): Promise<BucketWriteStats>;
}

/**
 * Интерфейс для чтения buckets с диска
 *
 * @remarks
 * Используется для incremental merge.
 */
export interface IBucketReader {
  /**
   * Читает buckets из файла
   *
   * @param filePath - Путь к файлу с buckets
   * @param bucketType - Bucket type для десериализации
   * @returns Map buckets (bucketKey → Bucket)
   *
   * @throws {Error} Если файл не найден или формат невалиден
   *
   * @example
   * ```typescript
   * const existing = await reader.read('./buckets/volume_level_probability_fill/buckets.jsonl', bucketType);
   * console.log(`Loaded ${existing.size} existing buckets`);
   * ```
   */
  read(filePath: string, bucketTypeName: string): Promise<Map<string, Bucket>>;
}
