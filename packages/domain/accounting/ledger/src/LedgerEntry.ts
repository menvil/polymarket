/**
 * LedgerEntry — неизменяемая запись в бухгалтерской книге
 *
 * @remarks
 * LedgerEntry — это атомарное изменение баланса актива в результате исполнения.
 *
 * ### Архитектура:
 * Ledger — это append-only источник истины.
 * Portfolio и Position — это проекции (projections) над Ledger.
 *
 * ### Связь с Fill:
 * Каждый Fill разворачивается в 2-3 LedgerEntry через FillLedgerAdapter:
 *
 * ```
 * Fill: BUY YES 10 @ 0.62, fee 0.02 USDC
 *   │
 *   ▼
 * LedgerEntry: POSITION_DELTA  YES   +10.00
 * LedgerEntry: CASH_DELTA      USDC  -6.20
 * LedgerEntry: FEE_DEBIT       USDC  -0.02
 * ```
 *
 * ### Семантика delta:
 * - Положительный delta (+) — актив зачислен (credit)
 * - Отрицательный delta (-) — актив списан (debit)
 *
 * ### Replay:
 * P&L и позиции вычисляются через replay LedgerEntry по accountId и assetId.
 * Это делает систему устойчивой к out-of-order events и gaps.
 *
 * @example
 * ```typescript
 * // После BUY YES 10 @ 0.62:
 * const entry: LedgerEntry = {
 *   fillId: 'fill-123',
 *   accountId: myAccountId,
 *   asset: yesTokenId,
 *   delta: new Decimal('+10'),
 *   type: 'POSITION_DELTA',
 *   timestamp: fillTimestamp,
 * };
 * ```
 */

import type { FillId, AccountId, AssetId } from '@polymarket/ids';
import type { Timestamp } from '@polymarket/value-objects';
import Decimal from 'decimal.js';
import type { LedgerEntryType } from './LedgerEntryType.js';

/**
 * Неизменяемая запись в ledger
 *
 * @remarks
 * Все поля readonly. LedgerEntry создаётся один раз и не изменяется.
 * Является частью append-only Ledger.
 */
export interface LedgerEntry {
  /** ID исполнения, породившего эту запись */
  readonly fillId: FillId;
  /** ID аккаунта, которому принадлежит изменение */
  readonly accountId: AccountId;
  /** Актив, баланс которого изменился */
  readonly asset: AssetId;
  /**
   * Знаковое изменение баланса
   * - (+) credit: актив зачислен
   * - (-) debit: актив списан
   */
  readonly delta: Decimal;
  /** Тип экономической операции */
  readonly type: LedgerEntryType;
  /** Время исполнения (из Fill) */
  readonly timestamp: Timestamp;
}
