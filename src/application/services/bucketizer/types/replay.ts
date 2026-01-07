/**
 * Replay Runner Types
 *
 * @remarks
 * Типы для ReplayRunner - компонента для воспроизведения событий из snapshot файлов.
 *
 * Режимы:
 * - MAX: Воспроизведение без задержек (максимальная скорость)
 * - SCALED: Воспроизведение с масштабированными задержками (реалистичное время)
 *
 * @module application/services/bucketizer/types
 */

import type { ScanOptions } from '../../../../infrastructure/persistence/snapshot-readers/SnapshotScanner.js';

/**
 * Режим воспроизведения событий
 */
export type ReplayMode = 'MAX' | 'SCALED';

/**
 * Конфигурация ReplayRunner
 *
 * @remarks
 * Определяет поведение воспроизведения событий из snapshot файлов.
 *
 * @example
 * ```typescript
 * // MAX режим - максимальная скорость
 * const maxConfig: ReplayConfig = {
 *   mode: 'MAX',
 *   scanOptions: { fromDate: '2026-01-01', toDate: '2026-01-05' }
 * };
 *
 * // SCALED режим - реалистичное время (100x быстрее)
 * const scaledConfig: ReplayConfig = {
 *   mode: 'SCALED',
 *   scale: 0.01,                      // 100x faster
 *   maxCatchupDelayMs: 200,           // Max 200ms delay
 *   scanOptions: { fromDate: '2026-01-01' }
 * };
 * ```
 */
export interface ReplayConfig {
  /**
   * Режим воспроизведения
   *
   * @remarks
   * - MAX: Без задержек, обрабатывает события как можно быстрее
   * - SCALED: С масштабированными задержками для реалистичного временного потока
   */
  mode: ReplayMode;

  /**
   * Коэффициент масштабирования времени (для SCALED режима)
   *
   * @remarks
   * Определяет насколько быстрее/медленнее воспроизводится время.
   * - scale = 1.0: реальное время (1 секунда в snapshot = 1 секунда replay)
   * - scale = 0.01: 100x быстрее (1 секунда в snapshot = 10ms replay)
   * - scale = 0.001: 1000x быстрее (1 секунда в snapshot = 1ms replay)
   *
   * Игнорируется в MAX режиме.
   *
   * @default 1.0
   */
  scale?: number;

  /**
   * Максимальная задержка при catchup (для SCALED режима)
   *
   * @remarks
   * Ограничивает максимальную задержку между событиями.
   * Полезно если в данных есть большие паузы (например, ночью маркет не торговался).
   *
   * Алгоритм:
   * ```
   * timeDiff = event2.timestamp - event1.timestamp
   * scaledDelay = timeDiff * scale
   * actualDelay = Math.min(scaledDelay, maxCatchupDelayMs)
   * ```
   *
   * Игнорируется в MAX режиме.
   *
   * @default Infinity (без ограничений)
   */
  maxCatchupDelayMs?: number;

  /**
   * Опции сканирования snapshot файлов
   *
   * @remarks
   * Позволяет фильтровать файлы по датам.
   * - fromDate: начальная дата (включительно)
   * - toDate: конечная дата (включительно)
   *
   * @example
   * ```typescript
   * {
   *   fromDate: '2026-01-01',
   *   toDate: '2026-01-05'
   * }
   * ```
   */
  scanOptions?: ScanOptions;
}

/**
 * Статистика воспроизведения
 *
 * @remarks
 * Содержит метрики о процессе воспроизведения событий.
 */
export interface ReplayStats {
  /** Всего прочитано событий из файлов */
  totalEvents: number;

  /** Успешно обработано событий (через callback) */
  processedEvents: number;

  /** Пропущено событий (normalizer вернул null) */
  skippedEvents: number;

  /** Ошибки при обработке событий (callback threw) */
  errorEvents: number;

  /** Количество обработанных файлов */
  filesProcessed: number;

  /** Время начала воспроизведения */
  startTime: Date;

  /** Время окончания воспроизведения */
  endTime: Date;

  /** Длительность воспроизведения (мс) */
  durationMs: number;

  /**
   * Распределение событий по типам
   *
   * @example
   * ```typescript
   * {
   *   'book': 1500,
   *   'trade': 350,
   *   'last_trade_price': 50
   * }
   * ```
   */
  eventsByType: Record<string, number>;

  /**
   * Общее время задержек в SCALED режиме (мс)
   *
   * @remarks
   * Сумма всех sleep() задержек.
   * В MAX режиме всегда 0.
   */
  totalDelayMs: number;
}
