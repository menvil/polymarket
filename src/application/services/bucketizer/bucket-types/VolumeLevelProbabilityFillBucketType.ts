/**
 * Volume Level Probability Fill Bucket Type (Stateful версия)
 *
 * @remarks
 * Вычисляет вероятность fill лимитного ордера на разных уровнях orderbook
 * при разном cumulative volume и разных временных горизонтах.
 *
 * Модель: "мы стоим последними на цене", пессимистичная очередь.
 *
 * Bucket Key Format:
 * ```
 * side_level_volumeMin_volumeMax
 * ```
 *
 * @example
 * ```
 * sell_2_200_300  // sell side, level 2, cumVolume 200-300
 * buy_1_0_100     // buy side, level 1, cumVolume 0-100
 * ```
 *
 * Bucket Data Format:
 * ```json
 * {
 *   "fill_time_distribution": {
 *     "5": { "attempts": 1000, "fills": 210, "probability": 0.21 },
 *     "10": { "attempts": 1000, "fills": 280, "probability": 0.28 }
 *   },
 *   "price_fill_distribution": {
 *     "0.56": 120,
 *     "0.57": 80
 *   }
 * }
 * ```
 *
 * Алгоритм:
 * 1. При OrderBookSnapshot: создаём attempts через AttemptTracker
 * 2. При Trade: обновляем attempts, детектим fills
 * 3. При завершении attempt (fill/expire): агрегируем в bucket
 *
 * @module application/services/bucketizer/bucket-types
 */

import type { ILogger } from '../../../../domain/ports/ILogger.js';
import type { DomainEvent } from '../../../../domain/events/DomainEvent.js';
import type {
  IBucketType,
  Bucket,
  BucketKey,
  VolumeLevelProbabilityFillData,
} from '../types/bucket.js';
import type { AttemptResult } from '../types/attempt.js';
import { AttemptTracker } from '../AttemptTracker.js';
import { OrderBookSnapshotReceivedEvent } from '../../../../domain/events/OrderBookSnapshotReceivedEvent.js';
import { TradeExecutedEvent } from '../../../../domain/events/TradeExecutedEvent.js';

/**
 * Configuration для bucket type
 */
export interface VolumeLevelProbabilityFillConfig {
  /** Максимальное количество уровней для отслеживания */
  maxLevels: number;

  /** Шаг volume bucket */
  volumeStep: number;

  /** Минимальный volume */
  volumeMin: number;

  /** Максимальный volume */
  volumeMax: number;

  /** Временные горизонты (секунды) */
  horizonsSec: readonly number[];

  /** Logger */
  logger: ILogger;
}

/**
 * Volume Level Probability Fill Bucket Type (Stateful)
 *
 * @remarks
 * Отслеживает активные attempts и агрегирует результаты в multi-horizon buckets.
 *
 * Состояние:
 * - AttemptTracker для каждого assetId
 * - Buckets с multi-horizon данными
 *
 * @example
 * ```typescript
 * const bucketType = new VolumeLevelProbabilityFillBucketType({
 *   maxLevels: 10,
 *   volumeStep: 100,
 *   volumeMin: 0,
 *   volumeMax: 10000,
 *   horizonsSec: [5, 10, 15, 30, 60, 120],
 *   logger
 * });
 *
 * // Обработка событий
 * for (const event of events) {
 *   const results = bucketType.processEvent(event);
 *   for (const result of results) {
 *     // result содержит завершённые attempts
 *   }
 * }
 *
 * // В конце
 * const finalResults = bucketType.finalize();
 * const buckets = bucketType.getBuckets();
 * ```
 */
export class VolumeLevelProbabilityFillBucketType implements IBucketType {
  private readonly config: VolumeLevelProbabilityFillConfig;
  private readonly logger: ILogger;

  /**
   * AttemptTrackers для каждого assetId
   *
   * @remarks
   * Key: assetId
   * Value: AttemptTracker
   */
  private readonly trackers: Map<string, AttemptTracker> = new Map();

  /**
   * Buckets с агрегированными данными
   *
   * @remarks
   * Key: bucketKey string
   * Value: Bucket
   */
  private readonly buckets: Map<string, Bucket> = new Map();

  /**
   * Максимальный горизонт (вычисляется из horizonsSec)
   */
  private readonly maxHorizonSec: number;

  constructor(config: VolumeLevelProbabilityFillConfig) {
    this.config = config;
    this.logger = config.logger;
    this.maxHorizonSec = Math.max(...config.horizonsSec);
  }

  getName(): string {
    return 'volume_level_probability_fill';
  }

  /**
   * Обработать событие и вернуть завершённые attempts
   *
   * @param event - Domain событие
   * @returns Завершённые attempts для агрегации
   *
   * @remarks
   * Вызывает AttemptTracker для обработки события.
   * Возвращает AttemptResults которые потом агрегируются в buckets.
   *
   * ВАЖНО: Этот метод НЕ часть интерфейса IBucketType!
   * Он нужен для stateful обработки.
   */
  processEvent(event: DomainEvent): AttemptResult[] {
    if (event instanceof OrderBookSnapshotReceivedEvent) {
      return this.processOrderBookSnapshot(event);
    } else if (event instanceof TradeExecutedEvent) {
      return this.processTrade(event);
    }

    return [];
  }

  /**
   * Завершить все активные attempts
   *
   * @returns Все активные attempts как "not filled"
   *
   * @remarks
   * Вызывается в конце обработки файла/потока.
   */
  finalize(): AttemptResult[] {
    const results: AttemptResult[] = [];

    for (const tracker of this.trackers.values()) {
      results.push(...tracker.closeAll());
    }

    this.logger.info('Finalized all trackers', {
      trackerCount: this.trackers.size,
      notFilledAttempts: results.length,
    });

    return results;
  }

  /**
   * Очистить все trackers
   *
   * @remarks
   * Вызывается после finalize() в конце каждого файла.
   * Каждый snapshot файл - независимая сессия, attempts не переносятся между файлами.
   *
   * @example
   * ```typescript
   * // После обработки файла
   * const results = bucketType.finalize();
   * // Агрегируем results в buckets
   * for (const result of results) {
   *   bucketType.aggregateResult(result);
   * }
   * // Очищаем trackers для следующего файла
   * bucketType.resetTrackers();
   * ```
   */
  resetTrackers(): void {
    this.trackers.clear();
    this.logger.debug('All trackers cleared');
  }

  /**
   * Агрегировать AttemptResult в bucket
   *
   * @param result - Результат завершённого attempt
   *
   * @remarks
   * Обновляет fill_time_distribution и price_fill_distribution.
   */
  aggregateResult(result: AttemptResult): void {
    const bucketKeyStr = this.bucketKeyToString(result.bucketKey);

    // Получить или создать bucket
    let bucket = this.buckets.get(bucketKeyStr);
    if (!bucket) {
      bucket = this.createBucket(bucketKeyStr);
      this.buckets.set(bucketKeyStr, bucket);
    }

    const data = bucket.data as VolumeLevelProbabilityFillData;

    // Обновить fill_time_distribution
    for (const horizon of this.config.horizonsSec) {
      if (!data.fill_time_distribution[horizon]) {
        data.fill_time_distribution[horizon] = {
          attempts: 0,
          fills: 0,
          probability: 0,
        };
      }

      const stats = data.fill_time_distribution[horizon];
      stats.attempts++;

      if (result.filled && result.fillTimeSec! <= horizon) {
        stats.fills++;
      }

      stats.probability = stats.attempts > 0 ? stats.fills / stats.attempts : 0;
    }

    // Обновить price_fill_distribution
    if (result.filled && result.fillPrice !== undefined) {
      const priceKey = result.fillPrice.toFixed(6); // 6 знаков для точности
      const prevCount = data.price_fill_distribution[priceKey] || 0;
      data.price_fill_distribution[priceKey] = prevCount + 1;
    }
  }

  /**
   * Получить все buckets
   */
  getBuckets(): Map<string, Bucket> {
    return this.buckets;
  }

  // ========================================
  // IBucketType interface (для совместимости)
  // ========================================

  createBucket(bucketKey: string): Bucket {
    const data: VolumeLevelProbabilityFillData = {
      fill_time_distribution: {},
      price_fill_distribution: {},
    };

    // Инициализируем все горизонты
    for (const horizon of this.config.horizonsSec) {
      data.fill_time_distribution[horizon] = {
        attempts: 0,
        fills: 0,
        probability: 0,
      };
    }

    return {
      bucketKey,
      bucketType: this.getName(),
      data,
    };
  }

  serialize(bucket: Bucket): string {
    const data = bucket.data as VolumeLevelProbabilityFillData;

    // Парсим bucketKey обратно
    const bucketKey = this.parseBucketKey(bucket.bucketKey);

    const output = {
      bucket_type: this.getName(),
      bucket_key: {
        side: bucketKey.side,
        level: bucketKey.level,
        volumeMin: bucketKey.volumeMin,
        volumeMax: bucketKey.volumeMax,
      },
      meta: bucket.meta,
      fill_time_distribution: data.fill_time_distribution,
      price_fill_distribution: data.price_fill_distribution,
    };

    return JSON.stringify(output);
  }

  deserialize(line: string): Bucket | null {
    try {
      const parsed = JSON.parse(line);

      if (parsed.bucket_type !== this.getName()) {
        return null;
      }

      if (!parsed.bucket_key || !parsed.fill_time_distribution) {
        return null;
      }

      // Собираем bucketKey string
      const bucketKey: BucketKey = {
        side: parsed.bucket_key.side,
        level: parsed.bucket_key.level,
        volumeMin: parsed.bucket_key.volumeMin,
        volumeMax: parsed.bucket_key.volumeMax,
      };
      const bucketKeyStr = this.bucketKeyToString(bucketKey);

      const data: VolumeLevelProbabilityFillData = {
        fill_time_distribution: parsed.fill_time_distribution,
        price_fill_distribution: parsed.price_fill_distribution || {},
      };

      return {
        bucketKey: bucketKeyStr,
        bucketType: this.getName(),
        data,
        meta: parsed.meta,
      };
    } catch (error) {
      this.logger.warn('Failed to deserialize bucket', { error });
      return null;
    }
  }

  /**
   * @deprecated Используйте processEvent() для stateful обработки
   *
   * @remarks
   * Stub для совместимости с IBucketType интерфейсом.
   * В stateful режиме не используется.
   */
  getBucketKeys(_event: DomainEvent): string[] {
    return [];
  }

  /**
   * @deprecated Используйте aggregateResult() для stateful обработки
   *
   * @remarks
   * Stub для совместимости с IBucketType интерфейсом.
   * В stateful режиме не используется.
   */
  update(_bucket: Bucket, _event: DomainEvent): void {
    // No-op: stateful bucket type использует aggregateResult()
  }

  // ========================================
  // Private methods
  // ========================================

  private processOrderBookSnapshot(
    event: OrderBookSnapshotReceivedEvent
  ): AttemptResult[] {
    const tracker = this.getOrCreateTracker(event.assetId);

    return tracker.onOrderBookSnapshot(
      event.timestamp.getTime(),
      event.bids,
      event.asks
    );
  }

  private processTrade(event: TradeExecutedEvent): AttemptResult[] {
    const tracker = this.getOrCreateTracker(event.assetId);

    return tracker.onTrade(
      event.timestamp.getTime(),
      event.price,
      event.size,
      event.side
    );
  }

  private getOrCreateTracker(assetId: string): AttemptTracker {
    let tracker = this.trackers.get(assetId);

    if (!tracker) {
      tracker = new AttemptTracker(
        {
          horizonsSec: this.config.horizonsSec,
          maxHorizonSec: this.maxHorizonSec,
          volumeConfig: {
            volumeMin: this.config.volumeMin,
            volumeMax: this.config.volumeMax,
            volumeStep: this.config.volumeStep,
          },
          levelsConfig: {
            maxLevels: this.config.maxLevels,
          },
        },
        this.logger
      );

      this.trackers.set(assetId, tracker);
    }

    return tracker;
  }

  private bucketKeyToString(key: BucketKey): string {
    return `${key.side}_${key.level}_${key.volumeMin}_${key.volumeMax}`;
  }

  private parseBucketKey(keyStr: string): BucketKey {
    const parts = keyStr.split('_');
    return {
      side: parts[0] as 'buy' | 'sell',
      level: parseInt(parts[1], 10),
      volumeMin: parseInt(parts[2], 10),
      volumeMax: parseInt(parts[3], 10),
    };
  }
}
