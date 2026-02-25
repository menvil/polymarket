/**
 * NormalizationPolicy - политика нормализации Raw Orderbook
 *
 * @remarks
 * Определяет как обрабатывать сырые данные от exchange:
 * - Фильтровать ли нулевые quantity
 * - Агрегировать ли одинаковые price
 * - Допускать ли crossed book
 * - Ограничивать ли количество уровней
 *
 * Разные venues и use cases могут требовать разной политики.
 *
 * @example
 * ```typescript
 * // Conservative policy для production trading
 * const conservativePolicy: NormalizationPolicy = {
 *   dropZeroQty: true,
 *   aggregateSamePrice: true,
 *   allowCrossed: false,
 *   maxLevelsPerSide: 100,
 * };
 *
 * // Permissive policy для тестов/анализа
 * const permissivePolicy: NormalizationPolicy = {
 *   dropZeroQty: false,
 *   aggregateSamePrice: false,
 *   allowCrossed: true,
 * };
 * ```
 */

/**
 * Политика нормализации orderbook
 */
export interface NormalizationPolicy {
  /**
   * Удалять ли уровни с quantity = 0
   *
   * @remarks
   * true: фильтровать нулевые уровни (рекомендуется)
   * false: оставлять нулевые уровни как есть
   *
   * Нулевые уровни могут появляться:
   * - После отмены всех заявок на price level
   * - В incremental updates (delete level)
   * - Из-за багов exchange API
   *
   * @default true
   */
  readonly dropZeroQty: boolean;

  /**
   * Агрегировать ли уровни с одинаковой ценой
   *
   * @remarks
   * true: суммировать quantity для дублирующихся price (рекомендуется)
   * false: оставлять дубликаты как есть
   *
   * Дубликаты могут появляться:
   * - В некоторых exchange protocols (multiple orders per level)
   * - Из-за race conditions в updates
   * - При мерже данных из разных источников
   *
   * @default true
   */
  readonly aggregateSamePrice: boolean;

  /**
   * Допускать ли crossed book (bid >= ask)
   *
   * @remarks
   * false: вернуть ошибку если best bid >= best ask (рекомендуется для trading)
   * true: разрешить crossed book (для анализа/тестов)
   *
   * Crossed book означает:
   * - Некорректные данные от exchange
   * - Race condition в updates
   * - Арбитражная возможность (если реальный)
   *
   * Для production trading должно быть false - торговать по crossed book опасно.
   *
   * @default false
   */
  readonly allowCrossed: boolean;

  /**
   * Максимальное количество уровней на сторону (bid/ask)
   *
   * @remarks
   * undefined: без ограничений
   * N: оставлять только top N уровней (closest to best price)
   *
   * Используется для:
   * - Ограничения памяти
   * - Фильтрации шумовых уровней (far from best price)
   * - Фокуса на near-touch liquidity
   *
   * @default undefined (без ограничений)
   */
  readonly maxLevelsPerSide?: number;
}

/**
 * Default (conservative) normalization policy
 *
 * @remarks
 * Рекомендуется для production trading:
 * - Фильтрует нулевые уровни
 * - Агрегирует дубликаты
 * - Не допускает crossed book
 * - Без ограничения уровней
 */
export const DEFAULT_NORMALIZATION_POLICY: NormalizationPolicy = {
  dropZeroQty: true,
  aggregateSamePrice: true,
  allowCrossed: false,
  maxLevelsPerSide: undefined,
};

/**
 * Permissive normalization policy
 *
 * @remarks
 * Для анализа/тестов:
 * - Оставляет всё как есть
 * - Допускает crossed book
 */
export const PERMISSIVE_NORMALIZATION_POLICY: NormalizationPolicy = {
  dropZeroQty: false,
  aggregateSamePrice: false,
  allowCrossed: true,
  maxLevelsPerSide: undefined,
};

/**
 * Топ-уровневая политика (Top-of-Book only)
 *
 * @remarks
 * Только лучшие bid/ask для fast processing:
 * - Только 1 уровень на сторону
 * - Агрегация и фильтрация включены
 */
export const TOP_OF_BOOK_POLICY: NormalizationPolicy = {
  dropZeroQty: true,
  aggregateSamePrice: true,
  allowCrossed: false,
  maxLevelsPerSide: 1,
};
