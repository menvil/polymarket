/**
 * Bucket Writer - запись buckets на диск
 *
 * @remarks
 * Реализует запись buckets в JSONL файлы с поддержкой:
 * - Atomic writes (temp file → rename)
 * - Incremental merge с существующими данными
 * - Batch writing для оптимизации I/O
 *
 * Структура директорий:
 * ```
 * {outputDir}/
 *   {bucketType}/
 *     buckets.jsonl
 * ```
 *
 * @example
 * ```typescript
 * const writer = new BucketWriter(registry, logger);
 *
 * // Overwrite mode
 * await writer.write(buckets, {
 *   mode: 'overwrite',
 *   outputDir: './buckets'
 * });
 *
 * // Merge mode
 * await writer.write(buckets, {
 *   mode: 'merge',
 *   outputDir: './buckets'
 * });
 * ```
 *
 * @module application/services/bucketizer
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ILogger } from '../../../domain/ports/ILogger.js';
import type { Bucket } from './types/bucket.js';
import type { BucketTypeRegistry } from './BucketTypeRegistry.js';
import type {
  IBucketWriter,
  BucketWriteOptions,
  BucketWriteStats,
} from './types/writer.js';

/**
 * Bucket Writer
 *
 * @remarks
 * Записывает buckets в JSONL файлы с группировкой по типу.
 */
export class BucketWriter implements IBucketWriter {
  private readonly registry: BucketTypeRegistry;
  private readonly logger: ILogger;

  /**
   * Создаёт новый BucketWriter
   *
   * @param registry - Registry для десериализации buckets
   * @param logger - Logger для отладки
   */
  constructor(registry: BucketTypeRegistry, logger: ILogger) {
    this.registry = registry;
    this.logger = logger;
  }

  /**
   * Записывает buckets на диск
   *
   * @param buckets - Map buckets (storageKey → Bucket)
   * @param options - Опции записи
   * @returns Статистика записи
   */
  async write(
    buckets: Map<string, Bucket>,
    options: BucketWriteOptions
  ): Promise<BucketWriteStats> {
    const startTime = Date.now();

    const stats: BucketWriteStats = {
      bucketsWritten: 0,
      filesWritten: 0,
      bytesWritten: 0,
      mergedBuckets: 0,
      newBuckets: 0,
      durationMs: 0,
    };

    this.logger.info('Starting bucket write', {
      mode: options.mode,
      outputDir: options.outputDir,
      totalBuckets: buckets.size,
    });

    // Группировка buckets по типу
    const bucketsByType = this.groupBucketsByType(buckets);

    this.logger.debug('Grouped buckets by type', {
      types: Array.from(bucketsByType.keys()),
      counts: Array.from(bucketsByType.entries()).map(([type, bkts]) => ({
        type,
        count: bkts.length,
      })),
    });

    // Обработка каждого типа
    for (const [bucketTypeName, typeBuckets] of bucketsByType) {
      const bucketType = this.registry.get(bucketTypeName);
      if (!bucketType) {
        this.logger.warn('Bucket type not found in registry, skipping', {
          bucketType: bucketTypeName,
        });
        continue;
      }

      const typeDir = path.join(options.outputDir, bucketTypeName);
      const outputFile = path.join(typeDir, 'buckets.jsonl');

      // Создать директорию
      await fs.mkdir(typeDir, { recursive: true });

      // Обработка в зависимости от режима
      if (options.mode === 'overwrite') {
        const fileStats = await this.writeOverwrite(
          typeBuckets,
          bucketType,
          outputFile
        );
        this.updateStats(stats, fileStats);
      } else {
        const fileStats = await this.writeMerge(
          typeBuckets,
          bucketType,
          outputFile
        );
        this.updateStats(stats, fileStats);
      }

      stats.filesWritten++;
    }

    stats.durationMs = Date.now() - startTime;

    this.logger.info('Bucket write completed', stats);

    return stats;
  }

  /**
   * Записывает buckets в overwrite режиме (atomic write)
   *
   * @private
   */
  private async writeOverwrite(
    buckets: Bucket[],
    bucketType: { serialize(bucket: Bucket): string },
    outputFile: string
  ): Promise<Partial<BucketWriteStats>> {
    const tempFile = `${outputFile}.tmp`;

    this.logger.debug('Writing buckets (overwrite)', {
      file: outputFile,
      count: buckets.length,
    });

    // Записать в temp файл
    const lines: string[] = [];
    for (const bucket of buckets) {
      lines.push(bucketType.serialize(bucket));
    }

    const content = lines.join('\n') + '\n';
    await fs.writeFile(tempFile, content, 'utf8');

    // Atomic rename
    await fs.rename(tempFile, outputFile);

    this.logger.trace('Buckets written successfully', {
      file: outputFile,
      buckets: buckets.length,
    });

    return {
      bucketsWritten: buckets.length,
      bytesWritten: Buffer.byteLength(content, 'utf8'),
      newBuckets: buckets.length,
    };
  }

  /**
   * Записывает buckets в merge режиме
   *
   * @private
   */
  private async writeMerge(
    newBuckets: Bucket[],
    bucketType: {
      serialize(bucket: Bucket): string;
      deserialize(line: string): Bucket | null;
    },
    outputFile: string
  ): Promise<Partial<BucketWriteStats>> {
    this.logger.debug('Writing buckets (merge)', {
      file: outputFile,
      newCount: newBuckets.length,
    });

    // Прочитать существующие buckets
    const existingBuckets = await this.readExistingBuckets(
      outputFile,
      bucketType
    );

    this.logger.trace('Read existing buckets', {
      file: outputFile,
      existingCount: existingBuckets.size,
    });

    // Merge: обновить существующие, добавить новые
    let mergedCount = 0;
    let newCount = 0;

    for (const newBucket of newBuckets) {
      const key = newBucket.bucketKey;

      if (existingBuckets.has(key)) {
        // Bucket уже существует - заменить (merge)
        existingBuckets.set(key, newBucket);
        mergedCount++;
      } else {
        // Новый bucket
        existingBuckets.set(key, newBucket);
        newCount++;
      }
    }

    // Записать все buckets в temp файл
    const tempFile = `${outputFile}.tmp`;
    const lines: string[] = [];

    for (const bucket of existingBuckets.values()) {
      lines.push(bucketType.serialize(bucket));
    }

    const content = lines.join('\n') + '\n';
    await fs.writeFile(tempFile, content, 'utf8');

    // Atomic rename
    await fs.rename(tempFile, outputFile);

    this.logger.trace('Buckets merged and written', {
      file: outputFile,
      totalBuckets: existingBuckets.size,
      merged: mergedCount,
      new: newCount,
    });

    return {
      bucketsWritten: existingBuckets.size,
      bytesWritten: Buffer.byteLength(content, 'utf8'),
      mergedBuckets: mergedCount,
      newBuckets: newCount,
    };
  }

  /**
   * Читает существующие buckets из файла
   *
   * @private
   */
  private async readExistingBuckets(
    filePath: string,
    bucketType: { deserialize(line: string): Bucket | null }
  ): Promise<Map<string, Bucket>> {
    const buckets = new Map<string, Bucket>();

    try {
      const content = await fs.readFile(filePath, 'utf8');
      const lines = content.split('\n').filter((line) => line.trim() !== '');

      for (const line of lines) {
        const bucket = bucketType.deserialize(line);
        if (bucket) {
          buckets.set(bucket.bucketKey, bucket);
        }
      }
    } catch (error) {
      // Файл не существует - это нормально для первого запуска
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.logger.trace('File does not exist, starting fresh', { filePath });
        return buckets;
      }

      // Другая ошибка - пробрасываем
      throw error;
    }

    return buckets;
  }

  /**
   * Группирует buckets по типу
   *
   * @remarks
   * Storage key format: `{bucketType}:{bucketKey}`
   *
   * @private
   */
  private groupBucketsByType(
    buckets: Map<string, Bucket>
  ): Map<string, Bucket[]> {
    const groups = new Map<string, Bucket[]>();

    for (const [storageKey, bucket] of buckets) {
      const bucketType = storageKey.split(':')[0];

      if (!groups.has(bucketType)) {
        groups.set(bucketType, []);
      }

      groups.get(bucketType)!.push(bucket);
    }

    return groups;
  }

  /**
   * Обновляет общую статистику
   *
   * @private
   */
  private updateStats(
    total: BucketWriteStats,
    partial: Partial<BucketWriteStats>
  ): void {
    total.bucketsWritten += partial.bucketsWritten ?? 0;
    total.bytesWritten += partial.bytesWritten ?? 0;
    total.mergedBuckets += partial.mergedBuckets ?? 0;
    total.newBuckets += partial.newBuckets ?? 0;
  }
}
