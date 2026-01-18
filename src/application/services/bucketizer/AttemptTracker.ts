/**
 * Attempt Tracker - управление активными attempts для fill probability модели
 *
 * @remarks
 * Отслеживает активные attempts и агрегирует результаты в buckets.
 *
 * Ключевые операции:
 * 1. Создание attempts при OrderBookSnapshot
 * 2. Обновление attempts при Trade (уменьшение needToEatQty, fill detection)
 * 3. Обновление attempts при следующем OrderBookSnapshot (корректировка по size изменениям)
 * 4. Expire attempts по maxHorizon
 * 5. Агрегация завершённых attempts в buckets
 *
 * @module application/services/bucketizer
 */

import type { ILogger } from '../../../domain/ports/ILogger.js';
import type {
  AttemptState,
  AttemptResult,
  AttemptTrackerConfig,
} from './types/attempt.js';
import type { BucketKey } from './types/bucket.js';

/**
 * Менеджер активных attempts
 *
 * @remarks
 * Хранит состояние всех активных attempts для одного assetId.
 * Обновляет attempts при поступлении событий.
 * Генерирует AttemptResults для агрегации в buckets.
 *
 * @example
 * ```typescript
 * const tracker = new AttemptTracker(config, logger);
 *
 * // На snapshot
 * const results = tracker.onOrderBookSnapshot(
 *   timestamp,
 *   bids,
 *   asks
 * );
 *
 * // На trade
 * const results = tracker.onTrade(
 *   timestamp,
 *   price,
 *   size,
 *   side
 * );
 *
 * // Агрегировать results в buckets
 * for (const result of results) {
 *   aggregateToBucket(result);
 * }
 *
 * // В конце обработки
 * const finalResults = tracker.closeAll();
 * ```
 */
export class AttemptTracker {
  private readonly config: AttemptTrackerConfig;
  private readonly logger: ILogger;

  /**
   * Активные attempts
   *
   * @remarks
   * Map: attempt ID → AttemptState
   *
   * Attempt ID = bucketKeyStr + '_' + t0Ms
   * (позволяет иметь несколько активных attempts для одного bucket key)
   */
  private activeAttempts: Map<string, AttemptState> = new Map();

  /**
   * Min-heap для эффективного expire
   *
   * @remarks
   * Сортированный массив по expiryMs.
   * При обработке события удаляем все attempts где expiryMs <= eventTs.
   */
  private expiryQueue: AttemptState[] = [];

  /**
   * Последний известный orderbook (для обновления attempts)
   *
   * @remarks
   * Map: price → size
   *
   * Хранится для того чтобы при следующем snapshot определить
   * изменение size на каждом уровне цен.
   */
  private lastOrderbook: {
    bids: Map<number, number>;
    asks: Map<number, number>;
  } = {
    bids: new Map(),
    asks: new Map(),
  };

  constructor(config: AttemptTrackerConfig, logger: ILogger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Обработать OrderBookSnapshot
   *
   * @param timestampMs - Timestamp snapshot'а (мс)
   * @param bids - Bid levels [{price, size}, ...]
   * @param asks - Ask levels [{price, size}, ...]
   * @returns Завершённые attempts (expired) для агрегации
   *
   * @remarks
   * Алгоритм:
   * 1. Expire старые attempts (expiryMs <= timestampMs)
   * 2. Обновить существующие attempts (корректировка по size изменениям)
   * 3. Создать новые attempts для всех (side, level, volumeBin)
   * 4. Обновить lastOrderbook
   *
   * @example
   * ```typescript
   * const results = tracker.onOrderBookSnapshot(
   *   1767300000000,
   *   [{price: 0.54, size: 150}, {price: 0.53, size: 200}],
   *   [{price: 0.56, size: 80}, {price: 0.57, size: 150}]
   * );
   * ```
   */
  onOrderBookSnapshot(
    timestampMs: number,
    bids: readonly { price: number; size: number }[],
    asks: readonly { price: number; size: number }[]
  ): AttemptResult[] {
    const results: AttemptResult[] = [];

    // 1. Expire старые attempts
    results.push(...this.expireAttempts(timestampMs));

    // 2. Обновить существующие attempts
    this.updateAttemptsOnSnapshot(timestampMs, bids, asks);

    // 3. Создать новые attempts
    this.createAttempts(timestampMs, 'buy', bids);
    this.createAttempts(timestampMs, 'sell', asks);

    // 4. Обновить lastOrderbook
    this.updateLastOrderbook(bids, asks);

    return results;
  }

  /**
   * Обработать Trade
   *
   * @param timestampMs - Timestamp trade'а (мс)
   * @param price - Цена trade'а
   * @param size - Объём trade'а
   * @param side - Сторона trade'а (BUY или SELL)
   * @returns Завершённые attempts (filled или expired) для агрегации
   *
   * @remarks
   * Алгоритм:
   * 1. Expire старые attempts (expiryMs <= timestampMs)
   * 2. Для каждого активного attempt:
   *    - Проверить подходит ли цена
   *    - Уменьшить needToEatQty
   *    - Увеличить tradeProgressSinceLastBook
   *    - Если needToEatQty == 0 → fill!
   *
   * @example
   * ```typescript
   * const results = tracker.onTrade(
   *   1767300003000,
   *   0.57,
   *   100,
   *   'BUY'
   * );
   * ```
   */
  onTrade(
    timestampMs: number,
    price: number,
    size: number,
    side: 'BUY' | 'SELL' | null
  ): AttemptResult[] {
    const results: AttemptResult[] = [];

    // 1. Expire старые attempts
    results.push(...this.expireAttempts(timestampMs));

    // 2. Обработать trade для активных attempts
    for (const [attemptId, attempt] of this.activeAttempts) {
      // Проверить подходит ли цена для этого attempt
      const tradeMatches = this.doesTradeMatchAttempt(attempt, price, side);

      if (!tradeMatches) {
        continue;
      }

      // Уменьшить needToEatQty
      const consume = Math.min(attempt.needToEatQty, size);
      attempt.needToEatQty -= consume;
      attempt.tradeProgressSinceLastBook += consume;

      // Проверить fill
      if (attempt.needToEatQty <= 0) {
        attempt.filled = true;
        attempt.fillTimeMs = timestampMs;

        // Создать result
        const fillTimeSec = (timestampMs - attempt.t0Ms) / 1000;
        results.push({
          bucketKey: attempt.bucketKey,
          filled: true,
          fillTimeSec,
          fillPrice: price,
        });

        // Удалить из активных
        this.activeAttempts.delete(attemptId);
        this.removeFromExpiryQueue(attempt);
      }
    }

    return results;
  }

  /**
   * Закрыть все активные attempts
   *
   * @returns Все активные attempts как "not filled" для агрегации
   *
   * @remarks
   * Вызывается в конце обработки файла.
   * Все активные attempts считаются "не заполненными" и агрегируются.
   */
  closeAll(): AttemptResult[] {
    const results: AttemptResult[] = [];

    for (const attempt of this.activeAttempts.values()) {
      results.push({
        bucketKey: attempt.bucketKey,
        filled: false,
      });
    }

    this.activeAttempts.clear();
    this.expiryQueue = [];

    this.logger.info('Closed all attempts', {
      notFilledCount: results.length,
    });

    return results;
  }

  /**
   * Получить статистику активных attempts
   */
  getStats(): {
    activeAttempts: number;
    expiryQueueSize: number;
  } {
    return {
      activeAttempts: this.activeAttempts.size,
      expiryQueueSize: this.expiryQueue.length,
    };
  }

  // ========================================
  // Private methods
  // ========================================

  /**
   * Expire attempts по maxHorizon
   */
  private expireAttempts(nowMs: number): AttemptResult[] {
    const results: AttemptResult[] = [];

    // Удаляем из expiryQueue все attempts где expiryMs <= nowMs
    while (this.expiryQueue.length > 0 && this.expiryQueue[0].expiryMs <= nowMs) {
      const attempt = this.expiryQueue.shift()!;
      const attemptId = this.getAttemptId(attempt);

      // Проверяем что attempt ещё активен (мог быть filled раньше)
      if (this.activeAttempts.has(attemptId)) {
        results.push({
          bucketKey: attempt.bucketKey,
          filled: false,
        });

        this.activeAttempts.delete(attemptId);
      }
    }

    return results;
  }

  /**
   * Обновить активные attempts при новом snapshot
   */
  private updateAttemptsOnSnapshot(
    _timestampMs: number,
    bids: readonly { price: number; size: number }[],
    asks: readonly { price: number; size: number }[]
  ): void {
    // Создаём Map для быстрого доступа к size по price
    const newBids = new Map(bids.map((l) => [l.price, l.size]));
    const newAsks = new Map(asks.map((l) => [l.price, l.size]));

    for (const attempt of this.activeAttempts.values()) {
      const side = attempt.bucketKey.side;
      const myPrice = attempt.myPrice;

      // Получаем новый size на myPrice
      const newBook = side === 'buy' ? newBids : newAsks;
      const sizeNow = newBook.get(myPrice) ?? 0;
      const sizePrev = attempt.lastBookSizeAtMyPrice;

      if (sizeNow > sizePrev) {
        // Добавился объём "позади нас" (пессимистично)
        attempt.needToEatQty += sizeNow - sizePrev;
      } else if (sizeNow < sizePrev) {
        // Объём уменьшился - кредитуем если были trades
        const decrease = sizePrev - sizeNow;
        const credited = Math.min(decrease, attempt.tradeProgressSinceLastBook);
        attempt.needToEatQty = Math.max(0, attempt.needToEatQty - credited);
      }

      // Обновляем состояние
      attempt.lastBookSizeAtMyPrice = sizeNow;
      attempt.tradeProgressSinceLastBook = 0;
    }
  }

  /**
   * Создать новые attempts для side+levels
   */
  private createAttempts(
    timestampMs: number,
    side: 'buy' | 'sell',
    levels: readonly { price: number; size: number }[]
  ): void {
    if (levels.length === 0) {
      return;
    }

    // Вычисляем cumulative volumes
    let cumVolume = 0;
    const cumLevels: Array<{ level: number; price: number; size: number; cumVolume: number }> =
      [];

    for (let i = 0; i < levels.length && i < this.config.levelsConfig.maxLevels; i++) {
      cumVolume += levels[i].size;
      cumLevels.push({
        level: i + 1, // 1-based
        price: levels[i].price,
        size: levels[i].size,
        cumVolume,
      });
    }

    // Для каждого уровня создаём attempts для всех volume bins
    for (const cumLevel of cumLevels) {
      // Находим volume bin
      const volumeBin = this.getVolumeBin(cumLevel.cumVolume);
      if (!volumeBin) {
        continue; // cumVolume не попадает ни в один bin
      }

      // Создаём bucket key
      const bucketKey: BucketKey = {
        side,
        level: cumLevel.level,
        volumeMin: volumeBin.min,
        volumeMax: volumeBin.max,
      };

      // Создаём attempt
      const attempt: AttemptState = {
        bucketKey,
        t0Ms: timestampMs,
        expiryMs: timestampMs + this.config.maxHorizonSec * 1000,
        myPrice: cumLevel.price,
        needToEatQty: cumLevel.size,
        remainingQty: 1,
        lastBookSizeAtMyPrice: cumLevel.size,
        tradeProgressSinceLastBook: 0,
        filled: false,
      };

      // Добавляем в активные
      const attemptId = this.getAttemptId(attempt);
      this.activeAttempts.set(attemptId, attempt);

      // Добавляем в expiry queue
      this.addToExpiryQueue(attempt);
    }
  }

  /**
   * Определить volume bin для cumVolume
   */
  private getVolumeBin(cumVolume: number): { min: number; max: number } | null {
    const { volumeMin, volumeMax, volumeStep } = this.config.volumeConfig;

    // Биннинг: volumeMin <= cumVolume < volumeMax (полуинтервал)
    for (let min = volumeMin; min < volumeMax; min += volumeStep) {
      const max = min + volumeStep;
      if (cumVolume >= min && cumVolume < max) {
        return { min, max };
      }
    }

    return null; // Не попадает ни в один bin
  }

  /**
   * Проверить подходит ли trade для attempt
   */
  private doesTradeMatchAttempt(
    attempt: AttemptState,
    tradePrice: number,
    _tradeSide: 'BUY' | 'SELL' | null
  ): boolean {
    const myPrice = attempt.myPrice;
    const side = attempt.bucketKey.side;

    if (side === 'sell') {
      // Для sell attempt (ask): trade должен быть >= myPrice
      return tradePrice >= myPrice;
    } else {
      // Для buy attempt (bid): trade должен быть <= myPrice
      return tradePrice <= myPrice;
    }
  }

  /**
   * Обновить lastOrderbook
   */
  private updateLastOrderbook(
    bids: readonly { price: number; size: number }[],
    asks: readonly { price: number; size: number }[]
  ): void {
    this.lastOrderbook.bids = new Map(bids.map((l) => [l.price, l.size]));
    this.lastOrderbook.asks = new Map(asks.map((l) => [l.price, l.size]));
  }

  /**
   * Добавить attempt в expiry queue (сортированный вставкой)
   */
  private addToExpiryQueue(attempt: AttemptState): void {
    // Binary search для вставки в правильное место
    let left = 0;
    let right = this.expiryQueue.length;

    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (this.expiryQueue[mid].expiryMs < attempt.expiryMs) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }

    this.expiryQueue.splice(left, 0, attempt);
  }

  /**
   * Удалить attempt из expiry queue
   */
  private removeFromExpiryQueue(attempt: AttemptState): void {
    const index = this.expiryQueue.findIndex((a) => a === attempt);
    if (index !== -1) {
      this.expiryQueue.splice(index, 1);
    }
  }

  /**
   * Получить уникальный ID attempt
   */
  private getAttemptId(attempt: AttemptState): string {
    return this.bucketKeyToString(attempt.bucketKey) + '_' + attempt.t0Ms;
  }

  /**
   * Конвертировать BucketKey в строку
   */
  private bucketKeyToString(key: BucketKey): string {
    return `${key.side}_${key.level}_${key.volumeMin}_${key.volumeMax}`;
  }
}
