/**
 * Метрики потока ордеров (Order Flow Metrics)
 *
 * @remarks
 * Агрегированные метрики, вычисляемые из набора трейдов:
 * - VWAP (Volume Weighted Average Price)
 * - OFI (Order Flow Imbalance)
 * - Buy/Sell volume breakdown
 *
 * ### Определения:
 * - buyVolume: суммарный объём трейдов с aggressorSide === 'BUY'
 * - sellVolume: суммарный объём трейдов с aggressorSide === 'SELL'
 * - orderFlowImbalance: (buy - sell) / (buy + sell), [-1, +1]
 * - vwap: сумма(price×size) / сумма(size), undefined если нет трейдов
 * - totalNotional: сумма всех price×size
 *
 * ### Почему Decimal, а не number:
 * Финансовые вычисления требуют точной арифметики. Decimal сохраняет
 * точность из VO (Price, Quantity) без потерь при конвертации в number.
 * Только `tradeCount` — это целый счётчик, ему number достаточен.
 */

import type Decimal from 'decimal.js';

/**
 * Агрегированные метрики потока ордеров
 *
 * @example
 * ```typescript
 * const metrics = TradeFlowCalculator.compute(trades);
 * console.log(metrics.vwap?.toNumber()); // 0.647
 * console.log(metrics.orderFlowImbalance.toNumber()); // 0.25 (больше покупок)
 * ```
 */
export interface TradeFlowMetrics {
  /** Суммарный объём BUY трейдов (aggressorSide === 'BUY') */
  readonly buyVolume: Decimal;
  /** Суммарный объём SELL трейдов (aggressorSide === 'SELL') */
  readonly sellVolume: Decimal;
  /** Суммарный объём всех трейдов (buyVolume + sellVolume + neutral) */
  readonly totalVolume: Decimal;
  /**
   * Дисбаланс потока ордеров
   * Формула: (buy - sell) / (buy + sell)
   * Диапазон: [-1, +1], 0 если нет трейдов
   */
  readonly orderFlowImbalance: Decimal;
  /**
   * Volume Weighted Average Price
   * Формула: сумма(price×size) / сумма(size)
   * undefined если нет трейдов
   */
  readonly vwap: Decimal | undefined;
  /** Суммарная номинальная стоимость всех трейдов (сумма price×size) */
  readonly totalNotional: Decimal;
  /** Количество трейдов (целый счётчик, number достаточен) */
  readonly tradeCount: number;
}
