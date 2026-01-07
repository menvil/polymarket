/**
 * Bucket Pipeline - обработка событий через bucket types (Stateful версия)
 *
 * @remarks
 * Pipeline обрабатывает DomainEvent через все зарегистрированные bucket types.
 *
 * **Stateful режим:**
 * - Bucket types поддерживают активное состояние (AttemptTrackers)
 * - Каждое событие может генерировать завершённые attempts
 * - Attempts агрегируются в buckets через aggregateResult()
 * - В конце вызывается finalize() для закрытия активных attempts
 *
 * Алгоритм обработки события:
 * 1. Для каждого bucket type:
 *    - Вызвать processEvent(event) → AttemptResult[]
 *    - Для каждого result: aggregateResult(result)
 *
 * @example
 * ```typescript
 * const registry = new BucketTypeRegistry();
 * const bucketType = new VolumeLevelProbabilityFillBucketType({...});
 * registry.register(bucketType);
 *
 * const pipeline = new BucketPipeline(registry, logger);
 *
 * // Обработка событий
 * await pipeline.processEvent(orderbookEvent);
 * await pipeline.processEvent(tradeEvent);
 *
 * // В конце
 * await pipeline.finalize();
 *
 * // Получение buckets
 * const buckets = pipeline.getBuckets();
 * console.log(`Created ${buckets.size} buckets`);
 * ```
 *
 * @module application/services/bucketizer
 */

import type { ILogger } from '../../../domain/ports/ILogger.js';
import type { DomainEvent } from '../../../domain/events/DomainEvent.js';
import type { Bucket } from './types/bucket.js';
import type { BucketTypeRegistry } from './BucketTypeRegistry.js';
import type { AttemptResult } from './types/attempt.js';
import { VolumeLevelProbabilityFillBucketType } from './bucket-types/VolumeLevelProbabilityFillBucketType.js';

/**
 * Bucket Pipeline (Stateful)
 *
 * @remarks
 * Обрабатывает события через stateful bucket types.
 * Поддерживает активное состояние (attempts) и финализацию.
 */
export class BucketPipeline {
  private readonly logger: ILogger;

  /**
   * Stateful bucket types
   *
   * @remarks
   * Хранит только stateful bucket types (VolumeLevelProbabilityFillBucketType).
   * Для других типов можно расширить.
   */
  private readonly statefulBucketTypes: VolumeLevelProbabilityFillBucketType[] = [];

  /**
   * Статистика обработки
   */
  private stats = {
    eventsProcessed: 0,
    attemptsFinalized: 0,
    bucketsAggregated: 0,
  };

  /**
   * Создаёт новый BucketPipeline
   *
   * @param registry - Registry с зарегистрированными bucket types
   * @param logger - Logger для отладки
   */
  constructor(registry: BucketTypeRegistry, logger: ILogger) {
    this.logger = logger;

    // Извлекаем stateful bucket types
    for (const bucketType of registry.getAll()) {
      if (bucketType instanceof VolumeLevelProbabilityFillBucketType) {
        this.statefulBucketTypes.push(bucketType);
      }
    }
  }

  /**
   * Обрабатывает событие через все bucket types
   *
   * @param event - Domain событие
   *
   * @remarks
   * Алгоритм:
   * 1. Для каждого stateful bucket type:
   *    - Вызвать processEvent(event) → AttemptResult[]
   *    - Для каждого result: aggregateResult(result)
   * 2. Обновить статистику
   *
   * @example
   * ```typescript
   * const event = new OrderBookSnapshotReceivedEvent(...);
   * await pipeline.processEvent(event);
   * ```
   */
  async processEvent(event: DomainEvent): Promise<void> {
    for (const bucketType of this.statefulBucketTypes) {
      // Обработать событие → получить завершённые attempts
      const results: AttemptResult[] = bucketType.processEvent(event);

      // Агрегировать результаты в buckets
      for (const result of results) {
        bucketType.aggregateResult(result);
        this.stats.bucketsAggregated++;
      }
    }

    this.stats.eventsProcessed++;
  }

  /**
   * Финализировать текущий файл
   *
   * @remarks
   * Вызывает finalize() для всех bucket types и очищает trackers.
   * Каждый snapshot файл - независимая сессия, attempts не переносятся между файлами.
   *
   * Алгоритм:
   * 1. Вызвать finalize() для всех bucket types → получить незавершенные attempts
   * 2. Агрегировать results в buckets
   * 3. Очистить trackers (resetTrackers)
   *
   * ВАЖНО: Вызывать после обработки каждого файла!
   *
   * @example
   * ```typescript
   * // После обработки событий из файла
   * await pipeline.finalizeFile();
   * ```
   */
  async finalizeFile(): Promise<void> {
    for (const bucketType of this.statefulBucketTypes) {
      // 1. Финализировать активные attempts
      const results: AttemptResult[] = bucketType.finalize();

      // 2. Агрегировать в buckets
      for (const result of results) {
        bucketType.aggregateResult(result);
        this.stats.bucketsAggregated++;
      }

      this.stats.attemptsFinalized += results.length;

      // 3. Очистить trackers для следующего файла
      bucketType.resetTrackers();
    }
  }

  /**
   * Получает все buckets
   *
   * @returns Map всех buckets
   *
   * @remarks
   * Объединяет buckets из всех stateful bucket types.
   * Ключ: `${bucketType}:${bucketKey}`
   *
   * @example
   * ```typescript
   * const buckets = pipeline.getBuckets();
   * console.log(`Total buckets: ${buckets.size}`);
   *
   * for (const [key, bucket] of buckets) {
   *   console.log(key, bucket);
   * }
   * ```
   */
  getBuckets(): Map<string, Bucket> {
    const allBuckets = new Map<string, Bucket>();

    for (const bucketType of this.statefulBucketTypes) {
      const buckets = bucketType.getBuckets();

      for (const [bucketKey, bucket] of buckets) {
        const storageKey = this.getStorageKey(bucketType.getName(), bucketKey);
        allBuckets.set(storageKey, bucket);
      }
    }

    return allBuckets;
  }

  /**
   * Получает buckets для конкретного bucket type
   *
   * @param bucketTypeName - Имя bucket type
   * @returns Массив buckets для этого типа
   *
   * @example
   * ```typescript
   * const fillBuckets = pipeline.getBucketsByType('volume_level_probability_fill');
   * console.log(`Fill buckets: ${fillBuckets.length}`);
   * ```
   */
  getBucketsByType(bucketTypeName: string): Bucket[] {
    const result: Bucket[] = [];

    for (const bucketType of this.statefulBucketTypes) {
      if (bucketType.getName() === bucketTypeName) {
        const buckets = bucketType.getBuckets();
        result.push(...buckets.values());
      }
    }

    return result;
  }

  /**
   * Получает bucket по bucket type и bucket key
   *
   * @param bucketTypeName - Имя bucket type
   * @param bucketKey - Bucket key
   * @returns Bucket или null если не найден
   *
   * @example
   * ```typescript
   * const bucket = pipeline.getBucket('volume_level_probability_fill', 'sell_2_200_300');
   * if (bucket) {
   *   console.log('Bucket data:', bucket.data);
   * }
   * ```
   */
  getBucket(bucketTypeName: string, bucketKey: string): Bucket | null {
    for (const bucketType of this.statefulBucketTypes) {
      if (bucketType.getName() === bucketTypeName) {
        const buckets = bucketType.getBuckets();
        return buckets.get(bucketKey) ?? null;
      }
    }

    return null;
  }

  /**
   * Получает статистику обработки
   *
   * @returns Статистика pipeline
   *
   * @example
   * ```typescript
   * const stats = pipeline.getStats();
   * console.log(`Processed ${stats.eventsProcessed} events`);
   * console.log(`Finalized ${stats.attemptsFinalized} attempts`);
   * console.log(`Aggregated ${stats.bucketsAggregated} bucket updates`);
   * ```
   */
  getStats(): Readonly<{
    eventsProcessed: number;
    attemptsFinalized: number;
    bucketsAggregated: number;
  }> {
    return { ...this.stats };
  }

  /**
   * Очищает все buckets и статистику
   *
   * @remarks
   * НЕ РЕАЛИЗОВАНО для stateful bucket types.
   * Stateful bucket types не поддерживают clear() без пересоздания.
   *
   * @deprecated Не используется в stateful режиме
   */
  clear(): void {
    this.logger.warn('clear() not supported for stateful bucket types');
  }

  /**
   * Генерирует storage key для bucket
   *
   * @param bucketTypeName - Имя bucket type
   * @param bucketKey - Bucket key
   * @returns Storage key
   *
   * @private
   */
  private getStorageKey(bucketTypeName: string, bucketKey: string): string {
    return `${bucketTypeName}:${bucketKey}`;
  }
}
