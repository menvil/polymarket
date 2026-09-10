/*
 * LEGACY REFERENCE ONLY.
 *
 * Historical implementation of the trading contour, preserved for the
 * new trading runtime.
 *
 * Not built.
 * Not linted.
 * Not runnable against the current repository.
 * Do not import from production code.
 *
 * Source: packages/domain/market-data/trade-tape/src/index.ts
 * Commit: abe9354e07501e87bf8a90fa53cccf6fa1b206a4
 *
 * See README.md for what was preserved and what was extracted to docs/.
 */
/**
 * @polymarket/trade-tape — лента трейдов и метрики потока ордеров
 *
 * @remarks
 * Пакет для накопления рыночных трейдов и вычисления метрик потока ордеров.
 * Часть bounded context: market microstructure (не accounting).
 *
 * ### Экспортируемые модули:
 * - `TapeRecord` — минимальная запись трейда из WS-ленты
 * - `TapeRetentionPolicy` — политика хранения записей
 * - `TradeTape` — append-only лента записей с retention policy
 * - `TradeFlowCalculator` — stateless вычислитель метрик (VWAP, OFI, volume)
 * - `TradeFlowMetrics` — интерфейс агрегированных метрик
 *
 * @packageDocumentation
 */

export type { TapeRecord, TapeRetentionPolicy } from './TapeRecord.js';
export { TradeTape } from './TradeTape.js';
export { TradeFlowCalculator } from './TradeFlowCalculator.js';
export type { TradeFlowMetrics } from './TradeFlowMetrics.js';
