/**
 * FillLedgerAdapter — преобразует Fill в LedgerEntry[]
 *
 * @remarks
 * Отвечает за разворачивание экономического факта исполнения (Fill)
 * в атомарные записи бухгалтерской книги (LedgerEntry[]).
 *
 * ### Почему это отдельный класс (SRP):
 * Fill знает об экономике исполнения (getCashFlow, getSignedQuantity).
 * FillLedgerAdapter знает о структуре Ledger и о том, как Fill → LedgerEntry[].
 * Fill не должен зависеть от Ledger.
 *
 * ### Алгоритм разворачивания:
 *
 * **BUY tokenId qty @ price:**
 * ```
 * POSITION_DELTA  tokenId         balanceDelta.amount = +qty
 * CASH_DELTA      settlementAsset balanceDelta.amount = -(price × qty)
 * FEE_DEBIT       fee.asset       balanceDelta.amount = -feeAmount  (только если fee > 0)
 * ```
 *
 * **SELL tokenId qty @ price:**
 * ```
 * POSITION_DELTA  tokenId         balanceDelta.amount = -qty
 * CASH_DELTA      settlementAsset balanceDelta.amount = +(price × qty)
 * FEE_DEBIT       fee.asset       balanceDelta.amount = -feeAmount  (только если fee > 0)
 * ```
 *
 * ### Почему нет параметра settlementAssetId:
 * Fill теперь содержит settlementAssetId и возвращает его в AssetDelta из getCashFlow().
 * Адаптеру не нужно знать расчётную валюту — она уже встроена в Fill.
 *
 * @example
 * ```typescript
 * import { FillLedgerAdapter } from '@polymarket/ledger';
 *
 * const entries = FillLedgerAdapter.toLedgerEntries(fill);
 * // entries.length === 2 при нулевой комиссии
 * // entries.length === 3 при ненулевой комиссии
 * ```
 */

import type { Fill } from '@polymarket/fill';
import { LedgerEntry } from '../LedgerEntry.js';
import type { LedgerEntryParams } from '../LedgerEntry.js';

/**
 * Вспомогательная функция для создания LedgerEntry из параметров
 *
 * @param params - Параметры создания записи
 * @returns LedgerEntry
 * @throws {Error} Если нарушены инварианты (программная ошибка — не должно происходить для валидных Fill)
 * @internal
 */
function createEntry(params: LedgerEntryParams): LedgerEntry {
  const result = LedgerEntry.create(params);
  if (!result.ok) {
    throw new Error(`Internal: LedgerEntry invariant violated: ${result.error.message}`);
  }
  return result.value;
}

/**
 * Адаптер для преобразования Fill в LedgerEntry[]
 *
 * @remarks
 * Статический класс без состояния.
 */
export class FillLedgerAdapter {
  /**
   * Разворачивает Fill в атомарные записи Ledger
   *
   * @param fill - Запись исполнения ордера
   * @returns Массив LedgerEntry (2 элемента при нулевой комиссии, 3 при ненулевой)
   *
   * @remarks
   * ### Порядок записей:
   * 1. POSITION_DELTA — изменение позиции в токене (из fill.getSignedQuantity())
   * 2. CASH_DELTA — изменение денежного баланса (из fill.getCashFlow())
   * 3. FEE_DEBIT — списание комиссии (только если fee > 0, из fill.getFeeFlow())
   *
   * Активы встроены в возвращаемые AssetDelta объекты:
   * - POSITION_DELTA.asset = fill.tokenId
   * - CASH_DELTA.asset = fill.settlementAssetId
   * - FEE_DEBIT.asset = fill.fee.asset (= settlementAssetId по Fill инварианту)
   *
   * @example
   * ```typescript
   * // Fill: BUY YES 10 @ 0.62, fee 0.02 USDC
   * const entries = FillLedgerAdapter.toLedgerEntries(fill);
   *
   * entries[0] // POSITION_DELTA YES   balanceDelta.amount=+10
   * entries[1] // CASH_DELTA     USDC  balanceDelta.amount=-6.20
   * entries[2] // FEE_DEBIT      USDC  balanceDelta.amount=-0.02
   * ```
   */
  public static toLedgerEntries(fill: Fill): LedgerEntry[] {
    const entries: LedgerEntry[] = [
      // 1. Изменение позиции в токене: BUY +qty, SELL -qty
      createEntry({
        fillId: fill.id,
        accountId: fill.accountId,
        balanceDelta: fill.getSignedQuantity(),
        type: 'POSITION_DELTA',
        timestamp: fill.timestamp,
      }),
      // 2. Изменение денежного баланса: BUY -(price×qty), SELL +(price×qty)
      createEntry({
        fillId: fill.id,
        accountId: fill.accountId,
        balanceDelta: fill.getCashFlow(),
        type: 'CASH_DELTA',
        timestamp: fill.timestamp,
      }),
    ];

    // 3. Списание комиссии (только если ненулевая)
    if (fill.hasFee()) {
      entries.push(
        createEntry({
          fillId: fill.id,
          accountId: fill.accountId,
          balanceDelta: fill.getFeeFlow(),
          type: 'FEE_DEBIT',
          timestamp: fill.timestamp,
        })
      );
    }

    return entries;
  }
}
