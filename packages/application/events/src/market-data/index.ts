/**
 * Рыночные application-события — стакан, трейды, параметры торговли и
 * референсные цены внешних активов.
 *
 * @remarks
 * BookUpdatedEvent — высокочастотное событие (изменение верхушки стакана).
 * BookDepthEvent — низкочастотный полный стакан. TradeReceivedEvent — маркет-принт.
 * TickSizeChangedEvent — venue сменил шаг цены инструмента.
 * ReferencePriceUpdatedEvent — цена ВНЕШНЕГО актива (BTC/USD), source-agnostic.
 */
export type { TopOfBook } from './TopOfBook.js';
export type { BookUpdatedEvent } from './BookUpdatedEvent.js';
export type { BookDepthEvent } from './BookDepthEvent.js';
export type { TradeReceivedEvent } from './TradeReceivedEvent.js';
export type { TickSizeChangedEvent } from './TickSizeChangedEvent.js';
export type {
  ReferencePriceFeed,
  ReferencePriceUpdatedEvent,
} from './ReferencePriceUpdatedEvent.js';
