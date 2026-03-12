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
 * 5. `requiredKeywords` — все слова в question (по границам слов, регистронезависимо)
 * 6. `anyOfKeywords` — хотя бы одно слово в question
 * 7. `excludedKeywords` — ни одного слова из списка в question
 *
 * ### Поиск ключевых слов:
 * Используется `\bkeyword\b` (word-boundary regex), что предотвращает ложные срабатывания.
 * Например, `excludedKeywords: ['war']` не будет матчить `'reward'` или `'forward'`.
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

    // Компилируем регексы один раз для всего прохода фильтра.
    // Поиск с \b-границами слов предотвращает ложные срабатывания
    // (например, 'war' не матчит 'reward' или 'forward').
    const requiredRegexes = this._compileKeywords(config.requiredKeywords);
    const anyOfRegexes    = this._compileKeywords(config.anyOfKeywords);
    const excludedRegexes = this._compileKeywords(config.excludedKeywords);

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

      // toLowerCase() вычисляется один раз на рынок — только если нужны keyword-фильтры
      if (requiredRegexes.length > 0 || anyOfRegexes.length > 0 || excludedRegexes.length > 0) {
        const question = market.question.toLowerCase();

        // 5. Обязательные ключевые слова
        if (!this._passesRequiredKeywords(question, requiredRegexes)) {
          return false;
        }

        // 6. Хотя бы одно ключевое слово из anyOfKeywords
        if (!this._passesAnyOfKeywords(question, anyOfRegexes)) {
          return false;
        }

        // 7. Запрещённые ключевые слова
        if (!this._passesExcludedKeywords(question, excludedRegexes)) {
          return false;
        }
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
   * Компилирует список ключевых слов в регулярные выражения с `\b`-границами слов.
   *
   * @param keywords - Список ключевых слов (или undefined)
   * @returns Массив скомпилированных RegExp (case-insensitive)
   *
   * @remarks
   * `\b`-границы предотвращают ложные срабатывания: `'war'` не матчит `'reward'`.
   * Специальные символы regex в ключевых словах экранируются автоматически,
   * что делает поиск безопасным для слов вроде `'$50'` или `'c++'`.
   *
   * @example
   * ```typescript
   * const regexes = this._compileKeywords(['war', 'bitcoin']);
   * // regexes[0] === /\bwar\b/i
   * // regexes[1] === /\bbitcoin\b/i
   * ```
   */
  private _compileKeywords(keywords: readonly string[] | undefined): RegExp[] {
    if (!keywords || keywords.length === 0) return [];
    return keywords.map((kw) => {
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`, 'i');
    });
  }

  /**
   * Проверяет наличие всех обязательных ключевых слов в question.
   *
   * @param question - Вопрос рынка в нижнем регистре
   * @param regexes - Предскомпилированные `\b`-регексы обязательных слов
   * @returns true если все регексы дают совпадение, или список пустой
   */
  private _passesRequiredKeywords(question: string, regexes: RegExp[]): boolean {
    if (regexes.length === 0) return true;
    return regexes.every((re) => re.test(question));
  }

  /**
   * Проверяет наличие хотя бы одного слова из anyOfKeywords в question.
   *
   * @param question - Вопрос рынка в нижнем регистре
   * @param regexes - Предскомпилированные `\b`-регексы слов «хотя бы одно»
   * @returns true если хотя бы один регекс даёт совпадение, или список пустой
   */
  private _passesAnyOfKeywords(question: string, regexes: RegExp[]): boolean {
    if (regexes.length === 0) return true;
    return regexes.some((re) => re.test(question));
  }

  /**
   * Проверяет отсутствие запрещённых ключевых слов в question.
   *
   * @param question - Вопрос рынка в нижнем регистре
   * @param regexes - Предскомпилированные `\b`-регексы запрещённых слов
   * @returns true если ни один регекс не даёт совпадение, или список пустой
   */
  private _passesExcludedKeywords(question: string, regexes: RegExp[]): boolean {
    if (regexes.length === 0) return true;
    return !regexes.some((re) => re.test(question));
  }
}
