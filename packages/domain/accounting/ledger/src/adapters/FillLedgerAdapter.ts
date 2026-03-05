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
 * **BUY tokenId qty @ price, fee feeAmount:**
 * ```
 * POSITION_DELTA  tokenId         delta = +qty
 * CASH_DELTA      settlementAsset delta = -(price × qty)
 * FEE_DEBIT       fee.asset       delta = -feeAmount  (только если fee > 0)
 * ```
 *
 * **SELL tokenId qty @ price, fee feeAmount:**
 * ```
 * POSITION_DELTA  tokenId         delta = -qty
 * CASH_DELTA      settlementAsset delta = +(price × qty)
 * FEE_DEBIT       fee.asset       delta = -feeAmount  (только если fee > 0)
 * ```
 *
 * ### settlementAssetId:
 * Параметр передаётся явно, потому что Fill — это запись исполнения,
 * а знание о расчётной валюте (USDC) — это рыночное знание (market layer).
 * Для Polymarket это всегда `AssetIdHelpers.USDC`.
 *
 * @example
 * ```typescript
 * import { FillLedgerAdapter } from '@polymarket/ledger';
 * import { AssetIdHelpers } from '@polymarket/ids';
 *
 * const entries = FillLedgerAdapter.toLedgerEntries(fill, AssetIdHelpers.USDC);
 * // entries.length === 2 при нулевой комиссии
 * // entries.length === 3 при ненулевой комиссии
 * ```
 */

import type { AssetId } from '@polymarket/ids';
import type { Fill } from '@polymarket/fill';
import type { LedgerEntry } from '../LedgerEntry.js';

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
   * @param settlementAssetId - Расчётный актив (USDC для Polymarket)
   * @returns Массив LedgerEntry (2 элемента при нулевой комиссии, 3 при ненулевой)
   *
   * @remarks
   * ### Порядок записей:
   * 1. POSITION_DELTA — изменение позиции в токене
   * 2. CASH_DELTA — изменение денежного баланса
   * 3. FEE_DEBIT — списание комиссии (только если fee > 0)
   *
   * @example
   * ```typescript
   * // Fill: BUY YES 10 @ 0.62, fee 0.02 USDC
   * const entries = FillLedgerAdapter.toLedgerEntries(fill, AssetIdHelpers.USDC);
   *
   * entries[0] // POSITION_DELTA YES   delta=+10
   * entries[1] // CASH_DELTA     USDC  delta=-6.20
   * entries[2] // FEE_DEBIT      USDC  delta=-0.02
   * ```
   */
  public static toLedgerEntries(fill: Fill, settlementAssetId: AssetId): LedgerEntry[] {
    const entries: LedgerEntry[] = [
      // 1. Изменение позиции в токене: BUY +qty, SELL -qty
      {
        fillId: fill.id,
        accountId: fill.accountId,
        asset: fill.tokenId,
        delta: fill.getSignedQuantity(),
        type: 'POSITION_DELTA',
        timestamp: fill.timestamp,
      },
      // 2. Изменение денежного баланса: BUY -(price×qty), SELL +(price×qty)
      {
        fillId: fill.id,
        accountId: fill.accountId,
        asset: settlementAssetId,
        delta: fill.getCashFlow(),
        type: 'CASH_DELTA',
        timestamp: fill.timestamp,
      },
    ];

    // 3. Списание комиссии (только если ненулевая)
    if (fill.hasFee()) {
      entries.push({
        fillId: fill.id,
        accountId: fill.accountId,
        asset: fill.fee.asset,
        delta: fill.getFeeFlow(),
        type: 'FEE_DEBIT',
        timestamp: fill.timestamp,
      });
    }

    return entries;
  }
}
