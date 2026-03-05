/**
 * @polymarket/ledger — Ledger layer для accounting
 *
 * @remarks
 * Реализует бухгалтерскую модель для торговой системы.
 *
 * ### Архитектура:
 * ```
 * Fill (исполнение)
 *   │
 *   ▼  FillLedgerAdapter
 * LedgerEntry[] (атомарные записи)
 *   │
 *   ▼  (projection)
 * Portfolio / Position / PnL
 * ```
 *
 * ### Ключевые принципы:
 * - Ledger — append-only источник истины
 * - LedgerEntry — неизменяемый факт изменения баланса
 * - Portfolio и Position — проекции над Ledger (не агрегаты)
 * - Replay LedgerEntry → корректное восстановление состояния
 *
 * @packageDocumentation
 */

export type { LedgerEntry } from './LedgerEntry.js';
export type { LedgerEntryType } from './LedgerEntryType.js';
export { ALL_LEDGER_ENTRY_TYPES } from './LedgerEntryType.js';
export { FillLedgerAdapter } from './adapters/FillLedgerAdapter.js';
