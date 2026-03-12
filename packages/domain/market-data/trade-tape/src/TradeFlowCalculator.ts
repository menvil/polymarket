/**
 * Калькулятор метрик потока ордеров
 *
 * @remarks
 * Вычисляет агрегированные метрики из набора записей ленты трейдов.
 * Stateless — только статические методы.
 *
 * ### Алгоритм compute():
 * 1. Проходим по всем записям
 * 2. Суммируем buy/sell объёмы: `record.size.value()` (Decimal из VO),
 *    накапливаем через `addDecimal()` из @polymarket/math — без конвертации в number.
 * 3. Вычисляем totalNotional: `record.price.value().mul(record.size.value())`,
 *    накапливаем через `addDecimal()`.
 * 4. OFI = (buy - sell) / (buy + sell): `subtractDecimal`, `divideDecimal`
 * 5. VWAP = totalNotional / totalVolume: `divideDecimal`, `isZeroDecimal`
 *
 * ### Обработка записей без side:
 * Записи с `side === undefined` не учитываются в buy/sell volume,
 * но включаются в totalVolume и VWAP (их size идёт в totalVolume).
 */

import Decimal from 'decimal.js';
import { addDecimal, subtractDecimal, divideDecimal, isZeroDecimal } from '@polymarket/math';
import type { TapeRecord } from './TapeRecord.js';
import type { TradeFlowMetrics } from './TradeFlowMetrics.js';

/**
 * Вычислитель метрик потока ордеров
 *
 * @example
 * ```typescript
 * const metrics = TradeFlowCalculator.compute(tape.getRecent(60_000));
 * if (metrics.orderFlowImbalance.toNumber() > 0.3) {
 *   // сильное давление покупателей
 * }
 * ```
 */
export class TradeFlowCalculator {
  /**
   * Вычисляет метрики потока ордеров из набора записей ленты
   *
   * @param records - Массив записей трейдов для анализа
   * @returns TradeFlowMetrics — агрегированные метрики
   *
   * @remarks
   * Для пустого массива: buyVolume=0, sellVolume=0, totalVolume=0,
   * orderFlowImbalance=0, vwap=undefined, totalNotional=0, tradeCount=0.
   *
   * Записи с side=undefined добавляются в totalVolume (и VWAP),
   * но не учитываются в buyVolume/sellVolume и OFI.
   *
   * @example
   * ```typescript
   * const metrics = TradeFlowCalculator.compute([]);
   * console.log(metrics.vwap); // undefined
   * console.log(metrics.orderFlowImbalance.toNumber()); // 0
   *
   * const metrics2 = TradeFlowCalculator.compute(tape.getRecent(60_000));
   * console.log(metrics2.vwap?.toNumber()); // 0.647
   * ```
   */
  public static compute(records: readonly TapeRecord[]): TradeFlowMetrics {
    if (records.length === 0) {
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

    for (const record of records) {
      const size = record.size.value();                            // Decimal из Quantity VO
      const notional = record.price.value().mul(record.size.value()); // price × size

      totalVolume = addDecimal(totalVolume, size);
      totalNotional = addDecimal(totalNotional, notional);

      if (record.side === 'BUY') {
        buyVolume = addDecimal(buyVolume, size);
      } else if (record.side === 'SELL') {
        sellVolume = addDecimal(sellVolume, size);
      }
    }

    // OFI: используем только buy+sell (записи без стороны исключаются)
    const classifiedVolume = addDecimal(buyVolume, sellVolume);
    const orderFlowImbalance = isZeroDecimal(classifiedVolume)
      ? new Decimal(0)
      : divideDecimal(subtractDecimal(buyVolume, sellVolume), classifiedVolume);

    // VWAP: по всем записям включая без side
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
      tradeCount: records.length,
    };
  }
}
