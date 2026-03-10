/**
 * Провайдер последних рыночных цен для расчёта unrealized PnL.
 *
 * @remarks
 * Используется DrawdownRiskMonitor для оценки полной стоимости портфеля.
 *
 * ### Реализации:
 * - `BookPricesProvider` — mid-price из IBookRegistry (live, Phase 8)
 * - `HistoricalPricesProvider` — из CSV/DB (для бэктеста)
 *
 * @example
 * ```typescript
 * const prices: IMarkPricesProvider = new BookPricesProvider(bookRegistry);
 * const price = prices.getPrice(instrumentId);
 * if (price) {
 *   console.log(price.value().toString()); // '0.65'
 * }
 * ```
 */
import type { InstrumentId } from '@polymarket/ids';
import type { Price } from '@polymarket/value-objects';

export interface IMarkPricesProvider {
  /**
   * Получить последнюю цену инструмента.
   *
   * @param instrumentId - ID торгового инструмента
   * @returns Price VO или undefined если нет данных
   */
  getPrice(instrumentId: InstrumentId): Price | undefined;

  /**
   * Все доступные цены.
   *
   * @returns ReadonlyMap<InstrumentId, Price> текущих котировок
   *
   * @remarks
   * Используется DrawdownRiskMonitor для расчёта суммарной стоимости портфеля.
   */
  getLatest(): ReadonlyMap<InstrumentId, Price>;
}
