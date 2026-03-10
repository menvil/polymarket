/**
 * Фильтрация кандидатов рынков по конфигурации.
 *
 * @remarks
 * `MarketFilter` — stateless pure-функция фильтрации.
 * Не имеет состояния, не производит побочных эффектов.
 * Все фильтры применяются последовательно в порядке убывания стоимости вычисления.
 *
 * ### Порядок фильтрации:
 * 1. Дедупликация по marketId
 * 2. `hoursToExpiry >= minTimeToExpiryHours` — временной фильтр
 * 3. `spread >= minSpread` — фильтр по спреду (только если spread > 0)
 * 4. `liquidity >= minDailyVolume` — фильтр по ликвидности
 * 5. `requiredKeywords` — все слова в question (регистронезависимо)
 * 6. `anyOfKeywords` — хотя бы одно слово в question
 * 7. `excludedKeywords` — ни одного слова из списка в question
 */
import Decimal from 'decimal.js';
import type { DiscoveredMarket, IMarketFilterConfig } from '@polymarket/ports';

/**
 * Stateless фильтр кандидатов рынков.
 *
 * @example
 * ```typescript
 * const filter = new MarketFilter();
 * const config: IMarketFilterConfig = {
 *   minTimeToExpiryHours: 24,
 *   minSpread: 0,
 *   minDailyVolume: 1000,
 *   maxMarketsToReturn: 5,
 * };
 * const filtered = filter.filterCandidates(markets, config, Date.now());
 * ```
 */
export class MarketFilter {
  /**
   * Фильтрует список кандидатов согласно конфигурации.
   *
   * @param markets - Список кандидатов для фильтрации
   * @param config - Параметры фильтрации
   * @param nowMs - Текущее время в миллисекундах (для вычисления hoursToExpiry)
   * @returns Отфильтрованный массив DiscoveredMarket
   *
   * @remarks
   * Порядок применения фильтров:
   * 1. Дедупликация по marketId (последний дубликат выигрывает)
   * 2. Временной фильтр: hoursToExpiry >= minTimeToExpiryHours
   * 3. Спред: market.spread >= minSpread (пропускается если market.spread === 0)
   * 4. Ликвидность: market.liquidity >= minDailyVolume
   * 5. requiredKeywords: все слова должны быть в question (case-insensitive)
   * 6. anyOfKeywords: хотя бы одно слово должно быть в question
   * 7. excludedKeywords: ни одного слова не должно быть в question
   *
   * @example
   * ```typescript
   * const filter = new MarketFilter();
   * const results = filter.filterCandidates(
   *   candidates,
   *   { minTimeToExpiryHours: 24, minSpread: 0, minDailyVolume: 5000, maxMarketsToReturn: 10 },
   *   Date.now(),
   * );
   * console.log(`Filtered: ${results.length} markets`);
   * ```
   */
  public filterCandidates(
    markets: readonly DiscoveredMarket[],
    config: IMarketFilterConfig,
    nowMs: number,
  ): DiscoveredMarket[] {
    // 1. Дедупликация по marketId (последний дубликат побеждает)
    const deduped = this._deduplicateByMarketId(markets);

    return deduped.filter((market) => {
      // 2. Временной фильтр
      if (!this._passesExpiryFilter(market, config.minTimeToExpiryHours, nowMs)) {
        return false;
      }

      // 3. Спред (только если spread > 0 у рынка)
      if (!this._passesSpreadFilter(market, config.minSpread)) {
        return false;
      }

      // 4. Ликвидность
      if (!this._passesLiquidityFilter(market, config.minDailyVolume)) {
        return false;
      }

      // 5. Обязательные ключевые слова
      if (!this._passesRequiredKeywords(market, config.requiredKeywords)) {
        return false;
      }

      // 6. Хотя бы одно ключевое слово из anyOfKeywords
      if (!this._passesAnyOfKeywords(market, config.anyOfKeywords)) {
        return false;
      }

      // 7. Запрещённые ключевые слова
      if (!this._passesExcludedKeywords(market, config.excludedKeywords)) {
        return false;
      }

      return true;
    });
  }

  /**
   * Дедуплицирует рынки по marketId.
   *
   * @param markets - Список рынков с возможными дубликатами
   * @returns Список без дубликатов (последний элемент с одинаковым marketId побеждает)
   */
  private _deduplicateByMarketId(markets: readonly DiscoveredMarket[]): DiscoveredMarket[] {
    const seen = new Map<string, DiscoveredMarket>();
    for (const market of markets) {
      seen.set(String(market.marketId), market);
    }
    return [...seen.values()];
  }

  /**
   * Проверяет, что рынок не истекает раньше порогового значения.
   *
   * @param market - Рынок для проверки
   * @param minHours - Минимальное количество часов до истечения
   * @param nowMs - Текущее время в миллисекундах
   * @returns true если рынок не истекает раньше порогового значения
   */
  private _passesExpiryFilter(
    market: DiscoveredMarket,
    minHours: number,
    nowMs: number,
  ): boolean {
    const expiresMs = market.expiresAt.toNumber();
    const hoursToExpiry = (expiresMs - nowMs) / (1000 * 60 * 60);
    return hoursToExpiry >= minHours;
  }

  /**
   * Проверяет спред рынка.
   *
   * @param market - Рынок для проверки
   * @param minSpread - Минимальный порог спреда
   * @returns true если spread === 0 (данные недоступны) или spread >= minSpread
   */
  private _passesSpreadFilter(market: DiscoveredMarket, minSpread: number): boolean {
    if (market.spread.isZero()) return true;
    return market.spread.greaterThanOrEqualTo(new Decimal(minSpread));
  }

  /**
   * Проверяет ликвидность рынка.
   *
   * @param market - Рынок для проверки
   * @param minDailyVolume - Минимальный порог ликвидности
   * @returns true если ликвидность >= minDailyVolume
   */
  private _passesLiquidityFilter(market: DiscoveredMarket, minDailyVolume: number): boolean {
    return market.liquidity.greaterThanOrEqualTo(new Decimal(minDailyVolume));
  }

  /**
   * Проверяет наличие всех обязательных ключевых слов в question.
   *
   * @param market - Рынок для проверки
   * @param keywords - Список обязательных ключевых слов (или undefined)
   * @returns true если все слова присутствуют, или список пустой/undefined
   */
  private _passesRequiredKeywords(
    market: DiscoveredMarket,
    keywords: readonly string[] | undefined,
  ): boolean {
    if (!keywords || keywords.length === 0) return true;
    const question = market.question.toLowerCase();
    return keywords.every((kw) => question.includes(kw.toLowerCase()));
  }

  /**
   * Проверяет наличие хотя бы одного слова из anyOfKeywords в question.
   *
   * @param market - Рынок для проверки
   * @param keywords - Список ключевых слов «хотя бы одно» (или undefined)
   * @returns true если хотя бы одно слово присутствует, или список пустой/undefined
   */
  private _passesAnyOfKeywords(
    market: DiscoveredMarket,
    keywords: readonly string[] | undefined,
  ): boolean {
    if (!keywords || keywords.length === 0) return true;
    const question = market.question.toLowerCase();
    return keywords.some((kw) => question.includes(kw.toLowerCase()));
  }

  /**
   * Проверяет отсутствие запрещённых ключевых слов в question.
   *
   * @param market - Рынок для проверки
   * @param keywords - Список запрещённых слов (или undefined)
   * @returns true если ни одного слова из списка нет в question, или список пустой/undefined
   */
  private _passesExcludedKeywords(
    market: DiscoveredMarket,
    keywords: readonly string[] | undefined,
  ): boolean {
    if (!keywords || keywords.length === 0) return true;
    const question = market.question.toLowerCase();
    return !keywords.some((kw) => question.includes(kw.toLowerCase()));
  }
}
