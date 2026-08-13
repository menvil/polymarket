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
/** Реэкспорт типа venue-обновления (см. OrderUpdateHandler.ts). */
export type { VenueOrderUpdate } from './OrderUpdateHandler.js';
/** Реэкспорт порта реестра стаканов (см. IBookRegistry.ts). */
export type { IBookRegistry } from './IBookRegistry.js';
