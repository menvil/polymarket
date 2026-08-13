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
