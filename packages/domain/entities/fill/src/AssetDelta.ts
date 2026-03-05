/**
 * AssetDelta — знаковое изменение баланса актива
 *
 * @remarks
 * Минималистичный тип для представления изменения баланса конкретного актива.
 * Используется как тип возврата экономических методов Fill:
 * - getSignedQuantity() → изменение позиции в токене
 * - getCashFlow()       → изменение кэшевого баланса (расчётный актив)
 * - getFeeFlow()        → изменение баланса из-за комиссии
 * - getNetCashFlow()    → итоговое изменение кэшевого баланса с учётом комиссии
 *
 * ### Семантика amount:
 * - (+) положительный → зачисление (credit): актив прибыл
 * - (-) отрицательный → списание (debit): актив ушёл
 *
 * ### Почему Decimal, а не VO:
 * В отличие от Quantity (неотрицательный), AssetDelta предназначен
 * именно для знаковых изменений, поэтому использует Decimal напрямую.
 *
 * @example
 * ```typescript
 * // BUY YES 10 @ 0.62
 * const positionDelta: AssetDelta = fill.getSignedQuantity();
 * console.log(positionDelta.asset);         // YES token AssetId
 * console.log(positionDelta.amount.toNumber()); // +10
 *
 * const cashDelta: AssetDelta = fill.getCashFlow();
 * console.log(cashDelta.asset);             // USDC AssetId
 * console.log(cashDelta.amount.toNumber()); // -6.20
 * ```
 */

import type { AssetId } from '@polymarket/ids';
import type Decimal from 'decimal.js';

/**
 * Знаковое изменение баланса конкретного актива
 *
 * @remarks
 * Все поля readonly — неизменяемый plain object.
 * amount может быть отрицательным (списание) или положительным (зачисление).
 */
export interface AssetDelta {
  /** Актив, баланс которого изменился */
  readonly asset: AssetId;
  /**
   * Знаковое изменение баланса
   * - (+) credit: актив зачислен
   * - (-) debit: актив списан
   */
  readonly amount: Decimal;
}
