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
 * ### Почему SignedQuantity:
 * SignedQuantity — специализированный VO для знаковых количеств:
 * гарантирует конечность значения, нормализует -0 → 0, предоставляет
 * семантические методы (isPositive, isNegative, isZero, neg, abs).
 * Это согласуется с Position.realizedPnL и другими знаковыми полями домена.
 *
 * @example
 * ```typescript
 * // BUY YES 10 @ 0.62
 * const positionDelta: AssetDelta = fill.getSignedQuantity();
 * console.log(positionDelta.asset);              // UP token AssetId
 * console.log(positionDelta.amount.toNumber());  // +10
 * console.log(positionDelta.amount.isPositive()); // true
 *
 * const cashDelta: AssetDelta = fill.getCashFlow();
 * console.log(cashDelta.asset);              // USDC AssetId
 * console.log(cashDelta.amount.toNumber());  // -6.20
 * console.log(cashDelta.amount.isNegative()); // true
 * ```
 */

import type { AssetId } from '@polymarket/ids';
import type { SignedQuantity } from '@polymarket/value-objects/signed-quantity';

/**
 * Знаковое изменение баланса конкретного актива
 *
 * @remarks
 * Все поля readonly — неизменяемый plain object.
 * amount — SignedQuantity VO, может быть отрицательным (списание) или положительным (зачисление).
 */
export interface AssetDelta {
  /** Актив, баланс которого изменился */
  readonly asset: AssetId;
  /**
   * Знаковое изменение баланса (SignedQuantity VO)
   * - (+) credit: актив зачислен
   * - (-) debit: актив списан
   *
   * Для получения числового значения: amount.toNumber()
   * Для Decimal арифметики: amount.value()
   */
  readonly amount: SignedQuantity;
}
