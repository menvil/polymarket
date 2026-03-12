/**
 * @polymarket/order-book — стакан ордеров и история дисбаланса
 *
 * @remarks
 * Пакет для работы с биржевым стаканом ордеров (order book).
 * Не зависит от domain entities — оперирует только числами.
 *
 * ### Экспортируемые модули:
 * - `OrderBook` — мутабельный стакан с методами applyDelta/applyFullState
 * - `ImbalanceHistory` — rolling-история скалярных значений дисбаланса
 * - `OrderBookHistory` — rolling-история полных снапшотов стакана
 * - `PriceLevel`, `OrderBookDelta`, `OrderBookSnapshot` — типы данных
 *
 * @packageDocumentation
 */

export { OrderBook } from './OrderBook.js';
export type { OrderBookSnapshot } from './OrderBook.js';
export { ImbalanceHistory } from './ImbalanceHistory.js';
export type { ImbalancePoint } from './ImbalanceHistory.js';
export { OrderBookHistory } from './OrderBookHistory.js';
export type { OrderBookRetentionPolicy } from './OrderBookHistory.js';
export type { PriceLevel } from './PriceLevel.js';
export type { OrderBookDelta } from './OrderBookDelta.js';
