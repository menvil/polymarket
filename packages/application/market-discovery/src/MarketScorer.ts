/**
 * Скоринг и сортировка кандидатов рынков.
 *
 * @remarks
 * `MarketScorer` — stateless pure-функция скоринга и сортировки.
 * Не имеет состояния, не производит побочных эффектов.
 *
 * ### Алгоритм скоринга:
 * - `score = hoursToExpiry` (ближайшее истечение → меньший score → выше приоритет)
 *
 * ### Алгоритм сортировки:
 * 1. По `expiresAt` ASC (ближайшее истечение первым)
 * 2. При равных `expiresAt` — по `liquidity` DESC (больше ликвидность → выше приоритет)
 *
 * ### Обоснование решения:
 * Рынки с ближайшим истечением торгуются активнее и имеют более чёткий исход.
 * При прочих равных предпочитаем более ликвидные рынки для лучшего исполнения ордеров.
 */
import type { DiscoveredMarket } from '@polymarket/ports';

/**
 * Stateless скорер и сортировщик кандидатов рынков.
 *
 * @example
 * ```typescript
 * const scorer = new MarketScorer();
 * const scored = scorer.scoreAndSort(filteredMarkets);
 * // scored[0] — рынок с ближайшим истечением (наивысший приоритет)
 * ```
 */
export class MarketScorer {
  /**
   * Проставляет score каждому рынку и сортирует список по приоритету.
   *
   * @param markets - Список кандидатов для скоринга и сортировки
   * @returns Новый массив с проставленными score, отсортированный по приоритету
   *
   * @remarks
   * ### Алгоритм:
   * 1. Для каждого рынка вычисляем `score = hoursToExpiry` от текущего момента
   * 2. Сортируем по `expiresAt` ASC (меньший score = ближе истечение = выше приоритет)
   * 3. При равных `expiresAt` сортируем по `liquidity` DESC
   *
   * Входной массив не мутируется — возвращается новый массив.
   *
   * @example
   * ```typescript
   * const scorer = new MarketScorer();
   *
   * const markets = [
   *   { ...market1, expiresAt: in48hours, liquidity: 5000 },
   *   { ...market2, expiresAt: in24hours, liquidity: 3000 },
   *   { ...market3, expiresAt: in24hours, liquidity: 8000 },
   * ];
   *
   * const sorted = scorer.scoreAndSort(markets);
   * // sorted[0] = market3 (24h, liquidity 8000)
   * // sorted[1] = market2 (24h, liquidity 3000)
   * // sorted[2] = market1 (48h)
   * ```
   */
  public scoreAndSort(markets: readonly DiscoveredMarket[]): DiscoveredMarket[] {
    const nowMs = Date.now();

    // Проставляем score = hoursToExpiry
    const scored = markets.map((market) => {
      const expiresMs = market.expiresAt.toNumber();
      const hoursToExpiry = (expiresMs - nowMs) / (1000 * 60 * 60);
      return { ...market, score: hoursToExpiry };
    });

    // Сортировка: expiresAt ASC, при равных — liquidity DESC
    scored.sort((a, b) => {
      const expiryDiff = a.expiresAt.toNumber() - b.expiresAt.toNumber();
      if (expiryDiff !== 0) return expiryDiff;
      return b.liquidity - a.liquidity;
    });

    return scored;
  }
}
