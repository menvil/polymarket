/**
 * @polymarket/handlers — Application-layer handlers для WS-событий.
 *
 * @remarks
 * ### Содержимое пакета:
 * - `BookUpdateHandler` — обрабатывает полные снапшоты стакана (Polymarket type='book')
 * - `FillEventHandler` — обрабатывает fill-события из user-channel
 * - `OrderUpdateHandler` — применяет venue-обновления статуса к Order entity
 * - `IBookRegistry` — интерфейс реестра OrderBook экземпляров
 * - `VenueOrderUpdate` — discriminated union venue-обновлений статуса ордера
 *
 * @example
 * ```typescript
 * import {
 *   BookUpdateHandler,
 *   FillEventHandler,
 *   OrderUpdateHandler,
 *   type IBookRegistry,
 *   type VenueOrderUpdate,
 * } from '@polymarket/handlers';
 * ```
 */
export { BookUpdateHandler } from './BookUpdateHandler.js';
export { FillEventHandler } from './FillEventHandler.js';
export { OrderUpdateHandler } from './OrderUpdateHandler.js';
export type { VenueOrderUpdate } from './OrderUpdateHandler.js';
export type { IBookRegistry } from './IBookRegistry.js';
export { BookDepthCollector } from './BookDepthCollector.js';
export type { BookDepthCollectorDeps, BookDepthCollectorConfig } from './BookDepthCollector.js';
