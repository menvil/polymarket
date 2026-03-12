/**
 * Порт: конфигурация фильтрации рынков.
 *
 * @remarks
 * `IMarketFilterConfig` определяет параметры для `MarketFilter.filterCandidates()`.
 * Передаётся как зависимость в `PolymarketMarketDiscoveryAdapter` при создании.
 *
 * ### Порядок применения фильтров в MarketFilter:
 * 1. Дедупликация по marketId
 * 2. `hoursToExpiry >= minTimeToExpiryHours`
 * 3. `spread >= minSpread` (только если spread !== undefined)
 * 4. `liquidity >= minLiquidity`
 * 5. `requiredKeywords` — все слова должны присутствовать в question
 * 6. `anyOfKeywords` — хотя бы одно слово должно присутствовать
 * 7. `excludedKeywords` — ни одного из слов не должно быть в question
 *
 * @example
 * ```typescript
 * const config: IMarketFilterConfig = {
 *   minTimeToExpiryHours: 24,
 *   minSpread: 0.02,
 *   minLiquidity: 10000,
 *   maxMarketsToReturn: 10,
 *   requiredKeywords: ['bitcoin'],
 *   anyOfKeywords: ['price', 'value'],
 *   excludedKeywords: ['test', 'demo'],
 * };
 * ```
 */
export interface IMarketFilterConfig {
  /**
   * Минимальное количество часов до истечения рынка.
   *
   * @remarks
   * Рынки, истекающие раньше чем через `minTimeToExpiryHours` часов — исключаются.
   * Например: 24 означает исключить рынки, истекающие в течение суток.
   */
  readonly minTimeToExpiryHours: number;

  /**
   * Минимальный bid-ask спред для включения рынка.
   *
   * @remarks
   * Фильтр применяется только если `market.spread !== undefined`.
   * Если `market.spread === undefined` (данные недоступны) — рынок проходит фильтр.
   * Пример: 0.02 означает спред не менее 2%.
   */
  readonly minSpread: number;

  /**
   * Минимальная ликвидность рынка.
   *
   * @remarks
   * Соответствует полю `liquidity` из Gamma API — глубина рынка, а не дневной объём
   * (дневной объём доступен в отдельном поле `volume`).
   * Рынки с `liquidity < minLiquidity` исключаются.
   * Пример: 10000 означает минимум $10,000 ликвидности.
   */
  readonly minLiquidity: number;

  /**
   * Максимальное количество рынков для возврата.
   *
   * @remarks
   * После фильтрации и скоринга берём только первые `maxMarketsToReturn` рынков.
   * Применяется через `Array.slice(0, maxMarketsToReturn)`.
   */
  readonly maxMarketsToReturn: number;

  /**
   * Обязательные ключевые слова — все должны присутствовать в question.
   *
   * @remarks
   * Поиск регистронезависимый. Если массив пустой или undefined — фильтр пропускается.
   * Пример: `['bitcoin', 'price']` — question должен содержать оба слова.
   */
  readonly requiredKeywords?: readonly string[];

  /**
   * Ключевые слова «хотя бы одно» — хотя бы одно должно присутствовать в question.
   *
   * @remarks
   * Поиск регистронезависимый. Если массив пустой или undefined — фильтр пропускается.
   * Пример: `['up', 'down']` — question должен содержать 'up' или 'down'.
   */
  readonly anyOfKeywords?: readonly string[];

  /**
   * Запрещённые ключевые слова — ни одно не должно присутствовать в question.
   *
   * @remarks
   * Поиск регистронезависимый. Если массив пустой или undefined — фильтр пропускается.
   * Пример: `['test', 'demo']` — исключить тестовые рынки.
   */
  readonly excludedKeywords?: readonly string[];
}
