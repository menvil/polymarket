/**
 * Attempt Tracking Types
 *
 * @remarks
 * Типы для отслеживания активных attempts в fill probability модели.
 *
 * Ключевые концепции:
 * - Attempt создаётся на каждом OrderBookSnapshot для каждого (side, level, volumeBin)
 * - Attempt живёт независимо до fill или expire (maxHorizon)
 * - При fill/expire агрегируем статистику в bucket
 *
 * @module application/services/bucketizer/types
 */

import type { BucketKey } from './bucket.js';

/**
 * Состояние одного активного attempt
 *
 * @remarks
 * Модель: мы стоим ПОСЛЕДНИМИ на цене myPrice, нужно "съесть" весь объём перед нами.
 *
 * Алгоритм:
 * 1. Создание (на snapshot):
 *    - myPrice = price(level)
 *    - needToEatQty = sizeAt(myPrice)
 *    - lastBookSizeAtMyPrice = sizeAt(myPrice)
 *
 * 2. На trade (если trade.price подходит):
 *    - consume = min(needToEatQty, trade.size)
 *    - needToEatQty -= consume
 *    - tradeProgressSinceLastBook += consume
 *    - если needToEatQty == 0 → FILL!
 *
 * 3. На следующем snapshot:
 *    - если sizeNow > sizePrev → needToEatQty += (sizeNow - sizePrev)
 *    - если sizeNow < sizePrev:
 *      - credited = min(decrease, tradeProgressSinceLastBook)
 *      - needToEatQty -= credited
 *    - lastBookSizeAtMyPrice = sizeNow
 *    - tradeProgressSinceLastBook = 0
 *
 * @example
 * ```typescript
 * const attempt: AttemptState = {
 *   bucketKey: {
 *     side: 'sell',
 *     level: 2,
 *     volumeMin: 200,
 *     volumeMax: 300
 *   },
 *   t0Ms: 1767300000000,
 *   expiryMs: 1767300120000,  // t0 + 120 sec
 *   myPrice: 0.57,
 *   needToEatQty: 150,
 *   remainingQty: 1,
 *   lastBookSizeAtMyPrice: 150,
 *   tradeProgressSinceLastBook: 0,
 *   filled: false
 * };
 * ```
 */
export interface AttemptState {
  /**
   * Bucket key (side, level, volume bin)
   *
   * @remarks
   * Определяет к какому bucket относится этот attempt.
   * Может быть несколько активных attempts с одним и тем же bucketKey
   * но с разными t0 (несколько наблюдений одной ситуации в разное время).
   */
  bucketKey: BucketKey;

  /**
   * Timestamp начала attempt (мс)
   *
   * @remarks
   * Timestamp OrderBookSnapshot'а который создал этот attempt.
   */
  t0Ms: number;

  /**
   * Timestamp истечения attempt (мс)
   *
   * @remarks
   * expiryMs = t0Ms + maxHorizonMs
   *
   * Когда currentEventTs > expiryMs → attempt закрывается как "not filled"
   * и агрегируется в статистику (attempts++ для всех горизонтов, fills=0).
   */
  expiryMs: number;

  /**
   * Цена уровня на момент создания attempt
   *
   * @remarks
   * Фиксированная цена из OrderBookSnapshot.
   * Attempt отслеживает trades по этой цене (или лучше для соответствующей стороны).
   */
  myPrice: number;

  /**
   * Сколько объёма нужно "съесть" чтобы дойти до нас
   *
   * @remarks
   * Модель "я последний в очереди": перед нами стоит весь объём уровня.
   *
   * Обновляется:
   * - При trade: needToEatQty -= consumed
   * - При snapshot: корректируется на основе изменения size и tradeProgress
   *
   * Когда needToEatQty == 0 → FILL!
   */
  needToEatQty: number;

  /**
   * Размер нашей лимитки (обычно 1)
   *
   * @remarks
   * Пока не используется в логике, но может понадобиться для расширений.
   */
  remainingQty: number;

  /**
   * Последний известный size на myPrice из snapshot
   *
   * @remarks
   * Используется для определения изменения объёма между snapshot'ами.
   */
  lastBookSizeAtMyPrice: number;

  /**
   * Объём подходящих trades с момента последнего snapshot
   *
   * @remarks
   * Накапливается при каждом trade (если trade.price подходит для этого attempt).
   * Сбрасывается в 0 при каждом snapshot.
   *
   * Используется для "кредитования" уменьшения объёма:
   * если size на myPrice уменьшился, и были trades — часть уменьшения
   * можно засчитать как прогресс (а не cancel).
   */
  tradeProgressSinceLastBook: number;

  /**
   * Флаг: был ли fill
   *
   * @remarks
   * true когда needToEatQty достигло 0.
   * После fill attempt удаляется из active set и агрегируется в bucket.
   */
  filled: boolean;

  /**
   * Время fill (мс), если filled = true
   *
   * @remarks
   * fillTimeMs - t0Ms = dt (время до исполнения)
   * Используется для определения для каких горизонтов засчитывать fill.
   */
  fillTimeMs?: number;
}

/**
 * Результат завершения attempt (для агрегации в bucket)
 *
 * @remarks
 * Когда attempt завершается (fill или expire), генерируется AttemptResult
 * для агрегации статистики в bucket.
 *
 * @example
 * ```typescript
 * // Fill за 6 секунд
 * const result: AttemptResult = {
 *   bucketKey: { side: 'sell', level: 2, volumeMin: 200, volumeMax: 300 },
 *   filled: true,
 *   fillTimeSec: 6
 * };
 *
 * // Агрегация:
 * for (const horizon of [5, 10, 15, 30, 60, 120]) {
 *   bucket.data[horizon].attempts++;
 *   if (result.filled && result.fillTimeSec! <= horizon) {
 *     bucket.data[horizon].fills++;
 *   }
 * }
 * ```
 */
export interface AttemptResult {
  /** Bucket key */
  bucketKey: BucketKey;

  /** Был ли fill */
  filled: boolean;

  /**
   * Время до fill (секунды), если filled = true
   *
   * @remarks
   * Используется для определения для каких горизонтов засчитывать fill:
   * - fills++ для всех горизонтов где horizon >= fillTimeSec
   */
  fillTimeSec?: number;

  /**
   * Цена по которой произошёл fill (если filled = true)
   *
   * @remarks
   * Используется для price_fill_distribution.
   */
  fillPrice?: number;
}

/**
 * Конфигурация для AttemptTracker
 */
export interface AttemptTrackerConfig {
  /** Горизонты в секундах */
  horizonsSec: readonly number[];

  /**
   * Максимальный горизонт (секунды)
   *
   * @remarks
   * maxHorizonSec = Math.max(...horizonsSec)
   *
   * Используется для вычисления expiryMs = t0Ms + maxHorizonSec * 1000.
   */
  maxHorizonSec: number;

  /**
   * Конфигурация volume bins (для генерации bucketKey)
   */
  volumeConfig: {
    volumeMin: number;
    volumeMax: number;
    volumeStep: number;
  };

  /**
   * Конфигурация уровней
   */
  levelsConfig: {
    maxLevels: number;
  };
}
