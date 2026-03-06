/**
 * Калькулятор метрик потока ордеров
 *
 * @remarks
 * Вычисляет агрегированные метрики из набора трейдов.
 * Stateless — только статические методы.
 *
 * ### Алгоритм compute():
 * 1. Проходим по всем трейдам
 * 2. Суммируем buy/sell объёмы: берём `trade.size.value()` (Decimal из VO),
 *    накапливаем через `addDecimal()` из @polymarket/math — без конвертации в number.
 * 3. Вычисляем totalNotional: `trade.getNotional()` уже Decimal,
 *    накапливаем через `addDecimal()`.
 * 4. OFI = (buy - sell) / (buy + sell): `subtractDecimal`, `divideDecimal`
 * 5. VWAP = totalNotional / totalVolume: `divideDecimal`, `isZeroDecimal`
 *
 * ### Обработка трейдов без aggressorSide:
 * Трейды с aggressorSide === undefined не учитываются в buy/sell volume,
 * но включаются в totalVolume и VWAP (их size идёт в totalVolume).
 */

import Decimal from 'decimal.js';
import { addDecimal, subtractDecimal, divideDecimal, isZeroDecimal } from '@polymarket/math';
import type { Trade } from '@polymarket/trade';
import type { TradeFlowMetrics } from './TradeFlowMetrics.js';

/**
 * Вычислитель метрик потока ордеров
 *
 * @example
 * ```typescript
 * const metrics = TradeFlowCalculator.compute(trades);
 * if (metrics.orderFlowImbalance > 0.3) {
 *   // сильное давление покупателей
 * }
 * ```
 */
export class TradeFlowCalculator {
  /**
   * Вычисляет метрики потока ордеров из набора трейдов
   *
   * @param trades - Массив трейдов для анализа
   * @returns TradeFlowMetrics — агрегированные метрики
   *
   * @remarks
   * Для пустого массива: buyVolume=0, sellVolume=0, totalVolume=0,
   * orderFlowImbalance=0, vwap=undefined, totalNotional=0, tradeCount=0.
   *
   * Трейды с aggressorSide=undefined добавляются в totalVolume (и VWAP),
   * но не учитываются в buyVolume/sellVolume и OFI.
   *
   * @example
   * ```typescript
   * const metrics = TradeFlowCalculator.compute([]);
   * console.log(metrics.vwap); // undefined
   * console.log(metrics.orderFlowImbalance); // 0
   *
   * const metrics2 = TradeFlowCalculator.compute(trades);
   * console.log(metrics2.vwap); // 0.647
   * ```
   */
  public static compute(trades: readonly Trade[]): TradeFlowMetrics {
    if (trades.length === 0) {
      return {
        buyVolume: new Decimal(0),
        sellVolume: new Decimal(0),
        totalVolume: new Decimal(0),
        orderFlowImbalance: new Decimal(0),
        vwap: undefined,
        totalNotional: new Decimal(0),
        tradeCount: 0,
      };
    }

    // Накапливаем через addDecimal из @polymarket/math: берём `.value()` из VO
    let buyVolume = new Decimal(0);
    let sellVolume = new Decimal(0);
    let totalVolume = new Decimal(0);
    let totalNotional = new Decimal(0);

    for (const trade of trades) {
      const size = trade.size.value();       // Decimal из Quantity VO
      const notional = trade.getNotional();  // Decimal из Price × Quantity

      totalVolume = addDecimal(totalVolume, size);
      totalNotional = addDecimal(totalNotional, notional);

      if (trade.isBuy()) {
        buyVolume = addDecimal(buyVolume, size);
      } else if (trade.isSell()) {
        sellVolume = addDecimal(sellVolume, size);
      }
    }

    // OFI: используем только buy+sell (трейды без стороны исключаются)
    const classifiedVolume = addDecimal(buyVolume, sellVolume);
    const orderFlowImbalance = isZeroDecimal(classifiedVolume)
      ? new Decimal(0)
      : divideDecimal(subtractDecimal(buyVolume, sellVolume), classifiedVolume);

    // VWAP: по всем трейдам включая без aggressorSide
    const vwap = isZeroDecimal(totalVolume)
      ? undefined
      : divideDecimal(totalNotional, totalVolume);

    return {
      buyVolume,
      sellVolume,
      totalVolume,
      orderFlowImbalance,
      vwap,
      totalNotional,
      tradeCount: trades.length,
    };
  }
}
