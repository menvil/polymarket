/**
 * Bucket Types and Interfaces
 *
 * @remarks
 * Определяет базовые типы для bucket system.
 *
 * Bucket - это агрегированные данные по определённому ключу (bucket key).
 * Каждый bucket key соответствует уникальной комбинации параметров.
 *
 * Формат bucket key:
 * ```
 * tokenName_side_level_volumeMin_volumeMax
 * ```
 *
 * @example
 * ```
 * YES_BUY_5_0_1000
 * NO_SELL_10_5000_10000
 * ```
 *
 * @module application/services/bucketizer/types
 */

import type { DomainEvent } from '../../../../domain/events/DomainEvent.js';

/**
 * Разобранный bucket key
 *
 * @remarks
 * Структурированное представление bucket key для volume_level_probability_fill.
 *
 * @example
 * ```typescript
 * const key: BucketKey = {
 *   side: 'sell',
 *   level: 2,
 *   volumeMin: 200,
 *   volumeMax: 300
 * };
 * ```
 */
export interface BucketKey {
  /** Сторона: 'buy' (bid) или 'sell' (ask) */
  side: 'buy' | 'sell';

  /** Уровень в ордербуке (1-based: 1 = лучшая цена) */
  level: number;

  /** Минимальный кумулятивный объём (включительно) */
  volumeMin: number;

  /** Максимальный кумулятивный объём (не включая) */
  volumeMax: number;
}

/**
 * Статистика для одного горизонта
 *
 * @remarks
 * Attempts и fills для конкретного временного горизонта.
 *
 * @example
 * ```typescript
 * const stats: HorizonStats = {
 *   attempts: 1000,
 *   fills: 210,
 *   probability: 0.21
 * };
 * ```
 */
export interface HorizonStats {
  /** Количество попыток (attempts) */
  attempts: number;

  /** Количество исполнений (fills) */
  fills: number;

  /** Вероятность исполнения (fills / attempts) */
  probability: number;
}

/**
 * Метаданные bucket
 *
 * @remarks
 * Дополнительная информация о bucket для отладки и анализа.
 *
 * @example
 * ```typescript
 * const meta: BucketMeta = {
 *   horizonsSec: [5, 10, 15, 30, 60, 120],
 *   sourceTimeRange: {
 *     fromTs: 1767300000000,
 *     toTs: 1767386399000
 *   },
 *   includedSnapshotDays: ['2026-01-02', '2026-01-03']
 * };
 * ```
 */
export interface BucketMeta {
  /** Горизонты в секундах */
  horizonsSec: readonly number[];

  /** Временной диапазон исходных данных */
  sourceTimeRange: {
    fromTs: number;
    toTs: number;
  };

  /** Дни snapshot'ов которые были включены */
  includedSnapshotDays: string[];
}

/**
 * Данные bucket для volume_level_probability_fill
 *
 * @remarks
 * Содержит распределение вероятности исполнения по временным горизонтам
 * и распределение по ценам исполнения.
 *
 * @example
 * ```typescript
 * const data: VolumeLevelProbabilityFillData = {
 *   fill_time_distribution: {
 *     5: { attempts: 1000, fills: 210, probability: 0.21 },
 *     10: { attempts: 1000, fills: 280, probability: 0.28 }
 *   },
 *   price_fill_distribution: {
 *     '0.56': 120,
 *     '0.57': 80
 *   }
 * };
 * ```
 */
export interface VolumeLevelProbabilityFillData {
  /**
   * Распределение вероятности исполнения по временным горизонтам
   *
   * @remarks
   * Ключ - горизонт в секундах (5, 10, 15, 30, 60, 120)
   * Значение - статистика (attempts, fills, probability)
   */
  fill_time_distribution: Record<number, HorizonStats>;

  /**
   * Распределение по ценам исполнения
   *
   * @remarks
   * Ключ - цена (строка для точности)
   * Значение - количество исполнений по этой цене
   */
  price_fill_distribution: Record<string, number>;
}

/**
 * Базовый интерфейс Bucket
 *
 * @remarks
 * Bucket содержит агрегированные данные для конкретного bucket key.
 * Структура данных специфична для каждого типа bucket.
 */
export interface Bucket {
  /**
   * Уникальный ключ bucket (строковое представление)
   *
   * @example
   * "sell_2_200_300"
   */
  bucketKey: string;

  /**
   * Тип bucket (например, "volume_level_probability_fill")
   */
  bucketType: string;

  /**
   * Данные bucket (структура зависит от типа)
   *
   * @remarks
   * Для volume_level_probability_fill это будет VolumeLevelProbabilityFillData.
   */
  data: unknown;

  /**
   * Метаданные bucket (опционально)
   *
   * @remarks
   * Используется для отладки и анализа.
   */
  meta?: BucketMeta;
}

/**
 * Интерфейс для bucket type implementations
 *
 * @remarks
 * Определяет контракт для различных типов bucket агрегаций.
 * Каждый тип bucket отвечает за:
 * - Определение bucket keys из событий
 * - Обновление bucket данных
 * - Сериализацию/десериализацию
 *
 * @example
 * ```typescript
 * class MyBucketType implements IBucketType {
 *   getName(): string {
 *     return 'my_bucket_type';
 *   }
 *
 *   getBucketKeys(event: DomainEvent): string[] {
 *     // Вернуть bucket keys, которые затрагивает это событие
 *     return ['YES_BUY_5_0_1000', 'YES_BUY_10_0_1000'];
 *   }
 *
 *   createBucket(bucketKey: string): Bucket {
 *     return { bucketKey, bucketType: this.getName(), data: {} };
 *   }
 *
 *   update(bucket: Bucket, event: DomainEvent): void {
 *     // Обновить bucket данные на основе события
 *   }
 *
 *   serialize(bucket: Bucket): string {
 *     return JSON.stringify(bucket);
 *   }
 *
 *   deserialize(line: string): Bucket | null {
 *     try {
 *       return JSON.parse(line);
 *     } catch {
 *       return null;
 *     }
 *   }
 * }
 * ```
 */
export interface IBucketType {
  /**
   * Получить имя типа bucket
   *
   * @returns Имя типа (например, "volume_level_probability_fill")
   *
   * @remarks
   * Используется для идентификации типа bucket в registry.
   */
  getName(): string;

  /**
   * Получить bucket keys для события
   *
   * @param event - Domain событие
   * @returns Массив bucket keys, которые затрагивает это событие
   *
   * @remarks
   * Возвращает пустой массив если событие не релевантно для этого типа bucket.
   *
   * Например, для volume_level_probability_fill:
   * - TradeExecutedEvent → 1 bucket key (уровень где произошла сделка)
   * - OrderBookSnapshotReceivedEvent → N bucket keys (все уровни в стакане)
   *
   * @example
   * ```typescript
   * const event = new TradeExecutedEvent('0x123', 0.5, 100, 'BUY', new Date());
   * const keys = bucketType.getBucketKeys(event);
   * // → ['YES_BUY_5_0_1000']
   * ```
   */
  getBucketKeys(event: DomainEvent): string[];

  /**
   * Создать новый bucket
   *
   * @param bucketKey - Bucket key
   * @returns Новый bucket с пустыми данными
   *
   * @remarks
   * Вызывается когда bucket key встречается первый раз.
   * Должен инициализировать bucket с корректной структурой данных.
   */
  createBucket(bucketKey: string): Bucket;

  /**
   * Обновить bucket данными из события
   *
   * @param bucket - Bucket для обновления (мутируется)
   * @param event - Domain событие
   *
   * @remarks
   * Мутирует bucket.data.
   * Вызывается для каждого события, которое затрагивает этот bucket.
   *
   * ВАЖНО: Функция должна быть идемпотентной для одного и того же события.
   *
   * @example
   * ```typescript
   * const bucket = { bucketKey: 'YES_BUY_5_0_1000', data: { attempts: 0, fills: 0 } };
   * const event = new TradeExecutedEvent(...);
   * bucketType.update(bucket, event);
   * // bucket.data теперь { attempts: 1, fills: 1 }
   * ```
   */
  update(bucket: Bucket, event: DomainEvent): void;

  /**
   * Сериализовать bucket в JSONL строку
   *
   * @param bucket - Bucket для сериализации
   * @returns JSONL строка (без \n в конце)
   *
   * @remarks
   * Используется для записи bucket в файл.
   * Формат: JSON без переноса строки.
   *
   * @example
   * ```typescript
   * const line = bucketType.serialize(bucket);
   * // → '{"bucketKey":"YES_BUY_5_0_1000","data":{"attempts":100,"fills":75}}'
   * ```
   */
  serialize(bucket: Bucket): string;

  /**
   * Десериализовать JSONL строку в bucket
   *
   * @param line - JSONL строка
   * @returns Bucket или null если невалидно
   *
   * @remarks
   * Используется для чтения bucket из файла (incremental merge).
   * Должен валидировать структуру данных.
   *
   * @example
   * ```typescript
   * const bucket = bucketType.deserialize('{"bucketKey":"YES_BUY_5_0_1000",...}');
   * // → { bucketKey: 'YES_BUY_5_0_1000', data: {...} }
   * ```
   */
  deserialize(line: string): Bucket | null;
}
