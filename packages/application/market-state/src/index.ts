/**
 * @polymarket/market-state — аккумуляторы рыночного состояния
 *
 * @remarks
 * Application-layer пакет для накопления рыночных данных из WS-потока.
 * Коллекторы подписываются на события шины, накапливают данные per tokenId
 * и предоставляют доступ стратегиям.
 *
 * ### Принцип: только запись, стратегия считает сама.
 * Коллекторы не вычисляют сигналы. Они хранят данные.
 * Стратегия забирает нужный срез и применяет нужный алгоритм.
 *
 * ### Содержимое пакета:
 * - `BookDepthCollector` — накапливает снапшоты стакана (BOOK_DEPTH events)
 *   в `OrderBookHistory` per tokenId
 * - `TradeTapeCollector` — накапливает ленту трейдов (TRADE_RECEIVED events)
 *   в `TradeTape` per tokenId
 *
 * @example
 * ```typescript
 * import { BookDepthCollector, TradeTapeCollector } from '@polymarket/market-state';
 *
 * const bookCollector = new BookDepthCollector(deps, { maxCount: 500 });
 * const tapeCollector = new TradeTapeCollector(deps, { maxAgeMs: 300_000 });
 *
 * bookCollector.start();
 * tapeCollector.start();
 * ```
 */

export { BookDepthCollector } from './BookDepthCollector.js';
export type { BookDepthCollectorDeps, BookDepthCollectorConfig } from './BookDepthCollector.js';

export { TradeTapeCollector } from './TradeTapeCollector.js';
export type { TradeTapeCollectorDeps, TradeTapeCollectorConfig } from './TradeTapeCollector.js';
