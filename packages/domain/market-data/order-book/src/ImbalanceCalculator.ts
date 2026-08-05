/**
 * Калькулятор дисбаланса стакана ордеров
 *
 * @remarks
 * Stateless-вычислитель дисбаланса с поддержкой нескольких режимов.
 * Предназначен для работы с сырыми уровнями стакана (`PriceLevel[]`),
 * не зависит от `OrderBook` и может использоваться с историческими снапшотами.
 *
 * ### Режимы вычисления:
 *
 * - `ALL_LEVELS` — суммируются объёмы всех уровней (аналог `OrderBook.getImbalance()`)
 * - `TOP_N` — только N уровней от лучшей цены с каждой стороны
 * - `PRICE_RANGE` — только уровни в пределах X% от средней цены (mid price)
 * - `WEIGHTED` — гармоническое убывание веса по рангу: `size × (1 / (rank + 1))`
 * - `NOTIONAL` — нотиональный имбаланс: `price × size` вместо просто `size`
 *
 * ### Формула (общая):
 * ```
 * imbalance = (bidMetric - askMetric) / (bidMetric + askMetric)
 * ```
 * Диапазон: `[-1, +1]`, возвращает `Decimal(0)` если нет данных.
 *
 * ### Почему отдельный класс, а не метод OrderBook:
 * `OrderBook.getImbalance()` — удобный shortcut для живого стакана.
 * `ImbalanceCalculator` работает с `PriceLevel[]` — подходит для
 * исторических снапшотов (`OrderBookHistory`) и backtesting-а.
 * Caller сам выбирает режим, результат передаёт в `ImbalanceHistory.record()`.
 *
 * @example
 * ```typescript
 * // Из живого стакана:
 * const bidsResult = book.getBids();
 * const asksResult = book.getAsks();
 * if (bidsResult.ok && asksResult.ok) {
 *   const imbalanceResult = ImbalanceCalculator.calculate(
 *     bidsResult.value,
 *     asksResult.value,
 *     { type: 'WEIGHTED' }
 *   );
 *   if (imbalanceResult.ok) history.record(imbalanceResult.value, Date.now());
 * }
 *
 * // Из исторического снапшота:
 * const snapshot = bookHistory.getLatest();
 * if (snapshot) {
 *   const imbalanceResult = ImbalanceCalculator.calculate(
 *     snapshot.bids,
 *     snapshot.asks,
 *     { type: 'TOP_N', levels: 5 }
 *   );
 * }
 * ```
 */

import Decimal from 'decimal.js';
import { addDecimal, subtractDecimal, divideDecimal, isZeroDecimal } from '@polymarket/math';
import { Result, Ok, Err } from '@polymarket/result';
import { ValidationError } from '@polymarket/errors';
import type { PriceLevel } from './PriceLevel.js';

/**
 * Режим вычисления дисбаланса.
 *
 * @remarks
 * Каждый режим определяет способ агрегации уровней стакана.
 * Биды должны быть отсортированы по убыванию цены (best bid первый),
 * аски — по возрастанию (best ask первый).
 */
export type ImbalanceMode =
  /**
   * Все уровни с каждой стороны.
   * Эквивалент `OrderBook.getImbalance()`.
   */
  | { readonly type: 'ALL_LEVELS' }
  /**
   * Только топ N уровней от лучшей цены.
   * Эквивалент `OrderBook.getImbalance(levels)`.
   */
  | { readonly type: 'TOP_N'; readonly levels: number }
  /**
   * Только уровни в пределах `rangePercent` от mid price.
   * Например, `rangePercent: 0.05` — в пределах ±5% от mid.
   * Если mid не определён (пустой стакан) — возвращает 0.
   */
  | { readonly type: 'PRICE_RANGE'; readonly rangePercent: number }
  /**
   * Гармоническое убывание веса по рангу.
   * Лучший уровень (rank=0) получает вес 1/(0+1)=1, следующий 1/2, 1/3 и т.д.
   * Подчёркивает значимость ликвидности вблизи лучшей цены.
   */
  | { readonly type: 'WEIGHTED' }
  /**
   * Нотиональный (dollar-weighted) дисбаланс.
   * Метрика = `price × size`, а не просто `size`.
   * Учитывает реальный долларовый вес каждого уровня.
   */
  | { readonly type: 'NOTIONAL' };

/**
 * Stateless-калькулятор дисбаланса стакана ордеров.
 *
 * @remarks
 * Все методы статические — инстанцирование не нужно.
 * Работает с `readonly PriceLevel[]` — не мутирует входные данные.
 *
 * @example
 * ```typescript
 * const result = ImbalanceCalculator.calculate(bids, asks, { type: 'WEIGHTED' });
 * if (result.ok) console.log(result.value.toNumber());
 * ```
 */
export class ImbalanceCalculator {
  /**
   * Вычисляет дисбаланс стакана в заданном режиме.
   *
   * @param bids - Уровни покупки, отсортированные по убыванию цены (best bid первый)
   * @param asks - Уровни продажи, отсортированные по возрастанию цены (best ask первый)
   * @param mode - Режим вычисления дисбаланса
   * @returns `Result` со значением дисбаланса в диапазоне `[-1, +1]` (`Decimal(0)` если данных
   *   нет) либо `ValidationError`, если параметры режима невалидны (`TOP_N.levels <= 0`,
   *   `PRICE_RANGE.rangePercent <= 0` и т.д.)
   *
   * @example
   * ```typescript
   * // Нотиональный имбаланс по топ-5 уровням:
   * const result = ImbalanceCalculator.calculate(bids, asks, { type: 'TOP_N', levels: 5 });
   * if (result.ok) console.log(result.value.toNumber());
   * ```
   */
  public static calculate(
    bids: readonly PriceLevel[],
    asks: readonly PriceLevel[],
    mode: ImbalanceMode,
  ): Result<Decimal, ValidationError> {
    switch (mode.type) {
      case 'ALL_LEVELS':
        return Ok(ImbalanceCalculator._volumeImbalance(bids, asks));

      case 'TOP_N':
        if (!Number.isInteger(mode.levels) || mode.levels <= 0) {
          return Err(
            new ValidationError(
              `ImbalanceCalculator: TOP_N.levels must be a positive integer, got ${mode.levels}`,
              { context: { levels: mode.levels } },
            ),
          );
        }
        return Ok(
          ImbalanceCalculator._volumeImbalance(
            bids.slice(0, mode.levels),
            asks.slice(0, mode.levels),
          ),
        );

      case 'PRICE_RANGE':
        if (!Number.isFinite(mode.rangePercent) || mode.rangePercent <= 0) {
          return Err(
            new ValidationError(
              `ImbalanceCalculator: PRICE_RANGE.rangePercent must be a positive number, got ${mode.rangePercent}`,
              { context: { rangePercent: mode.rangePercent } },
            ),
          );
        }
        return Ok(ImbalanceCalculator._priceRangeImbalance(bids, asks, mode.rangePercent));

      case 'WEIGHTED':
        return Ok(ImbalanceCalculator._weightedImbalance(bids, asks));

      case 'NOTIONAL':
        return Ok(ImbalanceCalculator._notionalImbalance(bids, asks));
    }
  }

  // ── Приватные вычислители ──────────────────────────────────────────────────

  /**
   * Объёмный дисбаланс: `(Σbid.size - Σask.size) / (Σbid.size + Σask.size)`
   *
   * @param bids - Уровни покупки
   * @param asks - Уровни продажи
   * @returns Decimal в диапазоне [-1, +1]
   */
  private static _volumeImbalance(
    bids: readonly PriceLevel[],
    asks: readonly PriceLevel[],
  ): Decimal {
    const bidSum = bids.reduce((s, l) => addDecimal(s, l.size.value()), new Decimal(0));
    const askSum = asks.reduce((s, l) => addDecimal(s, l.size.value()), new Decimal(0));
    return ImbalanceCalculator._ratio(bidSum, askSum);
  }

  /**
   * Нотиональный дисбаланс: `(Σbid.price×size - Σask.price×size) / total`
   *
   * @param bids - Уровни покупки
   * @param asks - Уровни продажи
   * @returns Decimal в диапазоне [-1, +1]
   */
  private static _notionalImbalance(
    bids: readonly PriceLevel[],
    asks: readonly PriceLevel[],
  ): Decimal {
    const bidNotional = bids.reduce(
      (s, l) => addDecimal(s, l.price.value().mul(l.size.value())),
      new Decimal(0),
    );
    const askNotional = asks.reduce(
      (s, l) => addDecimal(s, l.price.value().mul(l.size.value())),
      new Decimal(0),
    );
    return ImbalanceCalculator._ratio(bidNotional, askNotional);
  }

  /**
   * Гармонически взвешенный дисбаланс.
   *
   * @remarks
   * Уровень с рангом `i` (0 = лучшая цена) получает вес `1 / (i + 1)`.
   * Итоговая метрика = `Σ (size × weight)`.
   * Подчёркивает значимость уровней вблизи лучшей цены (best bid/ask).
   *
   * @param bids - Уровни покупки (best bid первый)
   * @param asks - Уровни продажи (best ask первый)
   * @returns Decimal в диапазоне [-1, +1]
   */
  private static _weightedImbalance(
    bids: readonly PriceLevel[],
    asks: readonly PriceLevel[],
  ): Decimal {
    const bidWeighted = bids.reduce((s, l, i) => {
      const weight = new Decimal(1).div(i + 1);
      return addDecimal(s, l.size.value().mul(weight));
    }, new Decimal(0));

    const askWeighted = asks.reduce((s, l, i) => {
      const weight = new Decimal(1).div(i + 1);
      return addDecimal(s, l.size.value().mul(weight));
    }, new Decimal(0));

    return ImbalanceCalculator._ratio(bidWeighted, askWeighted);
  }

  /**
   * Дисбаланс только по уровням в пределах `rangePercent` от mid price.
   *
   * @remarks
   * Mid price = (bestBid + bestAsk) / 2.
   * Уровень включается если `|price - mid| / mid <= rangePercent`.
   * Если mid не определён (пустой стакан с одной стороны) — возвращает 0.
   *
   * @param bids - Уровни покупки
   * @param asks - Уровни продажи
   * @param rangePercent - Относительный диапазон от mid (0.05 = ±5%)
   * @returns Decimal в диапазоне [-1, +1]
   */
  private static _priceRangeImbalance(
    bids: readonly PriceLevel[],
    asks: readonly PriceLevel[],
    rangePercent: number,
  ): Decimal {
    const bestBid = bids[0]?.price.value();
    const bestAsk = asks[0]?.price.value();

    if (bestBid === undefined || bestAsk === undefined) return new Decimal(0);

    const mid = bestBid.add(bestAsk).div(2);
    const range = mid.mul(rangePercent);

    const filteredBids = bids.filter((l) =>
      l.price.value().sub(mid).abs().lte(range),
    );
    const filteredAsks = asks.filter((l) =>
      l.price.value().sub(mid).abs().lte(range),
    );

    return ImbalanceCalculator._volumeImbalance(filteredBids, filteredAsks);
  }

  /**
   * Вычисляет нормализованное соотношение: `(bid - ask) / (bid + ask)`
   *
   * @param bidMetric - Агрегированная метрика bid-стороны
   * @param askMetric - Агрегированная метрика ask-стороны
   * @returns Decimal в диапазоне [-1, +1], или 0 если обе метрики нулевые
   */
  private static _ratio(bidMetric: Decimal, askMetric: Decimal): Decimal {
    const total = addDecimal(bidMetric, askMetric);
    if (isZeroDecimal(total)) return new Decimal(0);
    return divideDecimal(subtractDecimal(bidMetric, askMetric), total);
  }
}
