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
 *   ▼  Ledger.append()
 * Ledger (in-memory источник истины)
 *   │
 *   ▼  getBalance / getAllBalances / replay
 * Portfolio / Position / PnL (проекции)
 * ```
 *
 * ### Ключевые принципы:
 * - Ledger — append-only источник истины
 * - LedgerEntry — неизменяемый факт изменения баланса (class с инвариантами)
 * - Portfolio и Position — проекции над Ledger (не агрегаты)
 * - Replay LedgerEntry → корректное восстановление состояния
 *
 * @packageDocumentation
 */

export { LedgerEntry } from './LedgerEntry.js';
export type { LedgerEntryParams } from './LedgerEntry.js';
export type { LedgerEntryType } from './LedgerEntryType.js';
export { ALL_LEDGER_ENTRY_TYPES } from './LedgerEntryType.js';
export { FillLedgerAdapter } from './adapters/FillLedgerAdapter.js';
export { Ledger } from './Ledger.js';
export type { LedgerFilter } from './Ledger.js';
