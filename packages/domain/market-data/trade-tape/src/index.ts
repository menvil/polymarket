/**
 * @polymarket/trade-tape — лента трейдов и метрики потока ордеров
 *
 * @remarks
 * Пакет для накопления рыночных трейдов и вычисления метрик потока ордеров.
 * Часть bounded context: market microstructure (не accounting).
 *
 * ### Экспортируемые модули:
 * - `TradeTape` — append-only лента трейдов с фильтрацией по времени
 * - `TradeFlowCalculator` — stateless вычислитель метрик (VWAP, OFI, volume)
 * - `TradeFlowMetrics` — интерфейс агрегированных метрик
 *
 * @packageDocumentation
 */

export { TradeTape } from './TradeTape.js';
export { TradeFlowCalculator } from './TradeFlowCalculator.js';
export type { TradeFlowMetrics } from './TradeFlowMetrics.js';
