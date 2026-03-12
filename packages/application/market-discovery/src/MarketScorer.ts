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
import Decimal from 'decimal.js';
import type { IClock } from '@polymarket/time';
import type { DiscoveredMarket } from '@polymarket/ports';

/**
 * Скорер и сортировщик кандидатов рынков.
 *
 * @example
 * ```typescript
 * const scorer = new MarketScorer(clock);
 * const scored = scorer.scoreAndSort(filteredMarkets);
 * // scored[0] — рынок с ближайшим истечением (наивысший приоритет)
 * ```
 */
export class MarketScorer {
  /**
   * @param _clock - Источник времени для детерминированного скоринга
   */
  constructor(private readonly _clock: IClock) {}

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
    const nowMs = this._clock.now().getTime();
    const MS_PER_HOUR = 1000 * 60 * 60;

    // Проставляем score = hoursToExpiry.
    // score является единственным источником правды для сортировки:
    // сортировка ниже опирается только на него, а не на expiresAt напрямую.
    const scored = markets.map((market) => {
      const hoursToExpiry = (market.expiresAt.toNumber() - nowMs) / MS_PER_HOUR;
      return { ...market, score: new Decimal(hoursToExpiry) };
    });

    // Сортировка: score ASC → liquidity DESC → marketId ASC (детерминированный порядок).
    // Третий ключ (marketId) гарантирует полный детерминизм: при равных score и liquidity
    // результат воспроизводим независимо от порядка входных данных.
    scored.sort((a, b) => {
      const scoreDiff = a.score.comparedTo(b.score);
      if (scoreDiff !== 0) return scoreDiff;
      const liquidityDiff = b.liquidity.comparedTo(a.liquidity);
      if (liquidityDiff !== 0) return liquidityDiff;
      return String(a.marketId) < String(b.marketId) ? -1 : 1;
    });

    return scored;
  }
}
