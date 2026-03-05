/**
 * LedgerEntryType — тип записи в бухгалтерской книге
 *
 * @remarks
 * Каждый Fill разворачивается в несколько LedgerEntry с разными типами.
 * Тип определяет экономическую природу изменения.
 *
 * ### Типы записей:
 *
 * **POSITION_DELTA** — изменение позиции в токене:
 * - BUY YES 10 → POSITION_DELTA asset=YES delta=+10
 * - SELL YES 10 → POSITION_DELTA asset=YES delta=-10
 *
 * **CASH_DELTA** — изменение денежного баланса:
 * - BUY YES 10 @ 0.62 → CASH_DELTA asset=USDC delta=-6.20
 * - SELL YES 10 @ 0.62 → CASH_DELTA asset=USDC delta=+6.20
 *
 * **FEE_DEBIT** — списание комиссии:
 * - Всегда отрицательный delta
 * - FEE_DEBIT asset=USDC delta=-0.02
 * - Создаётся только при ненулевой комиссии
 *
 * @example
 * ```typescript
 * // Fill: BUY YES 10 @ 0.62, fee 0.02 USDC
 * // Разворачивается в:
 * // { type: 'POSITION_DELTA', asset: YES, delta: +10 }
 * // { type: 'CASH_DELTA',     asset: USDC, delta: -6.20 }
 * // { type: 'FEE_DEBIT',      asset: USDC, delta: -0.02 }
 * ```
 */
export type LedgerEntryType = 'POSITION_DELTA' | 'CASH_DELTA' | 'FEE_DEBIT';

/**
 * Все допустимые значения LedgerEntryType
 */
export const ALL_LEDGER_ENTRY_TYPES: readonly LedgerEntryType[] = Object.freeze([
  'POSITION_DELTA',
  'CASH_DELTA',
  'FEE_DEBIT',
] as const);
