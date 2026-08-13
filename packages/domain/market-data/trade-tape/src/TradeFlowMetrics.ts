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
 * ### Почему VO, а не Decimal (Этап 2 плана миграции):
 * Публичная граница типизирована через VO (`Quantity`/`Ratio`/`Price`/`Money`) —
 * по ADR (`docs/architecture/boundary-contract.md`, Решение 1) `Decimal` легитимен
 * только внутри `value-objects`/`math`. Внутри `TradeFlowCalculator.compute()`
 * промежуточные вычисления остаются на голом `Decimal` — правило касается того, что
 * пересекает публичную границу (сигнатура `compute()`), не внутренней реализации;
 * тот же принцип уже применён к `OrderNotional`-подобной арифметике в `PlaceOrderUseCase`.
 * `totalNotional` — `Money` с валютой `'USDC'` (все рынки Polymarket USDC-settled).
 * Только `tradeCount` — это целый счётчик, ему `number` достаточен.
 */

import type { Quantity, Ratio, Price, Money } from '@polymarket/value-objects';

/**
 * Агрегированные метрики потока ордеров
 *
 * @example
 * ```typescript
 * const metrics = TradeFlowCalculator.compute(trades);
 * console.log(metrics.vwap?.value().toNumber()); // 0.647
 * console.log(metrics.orderFlowImbalance.toNumber()); // 0.25 (больше покупок)
 * ```
 */
export interface TradeFlowMetrics {
  /** Суммарный объём BUY трейдов (aggressorSide === 'BUY') */
  readonly buyVolume: Quantity;
  /** Суммарный объём SELL трейдов (aggressorSide === 'SELL') */
  readonly sellVolume: Quantity;
  /** Суммарный объём всех трейдов (buyVolume + sellVolume + neutral) */
  readonly totalVolume: Quantity;
  /**
   * Дисбаланс потока ордеров
   * Формула: (buy - sell) / (buy + sell)
   * Диапазон: [-1, +1], 0 если нет трейдов
   */
  readonly orderFlowImbalance: Ratio;
  /**
   * Volume Weighted Average Price
   * Формула: сумма(price×size) / сумма(size)
   * undefined если нет трейдов
   */
  readonly vwap: Price | undefined;
  /** Суммарная номинальная стоимость всех трейдов (сумма price×size), валюта USDC */
  readonly totalNotional: Money;
  /** Количество трейдов (целый счётчик, number достаточен) */
  readonly tradeCount: number;
}
