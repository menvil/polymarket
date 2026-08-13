/**
 * Внутренние WS DTO пакета @polymarket/exchange.
 *
 * @remarks
 * INTERNAL — не экспортируются из пакета через package.json exports.
 * Используются только для парсинга и маршрутизации WS-сообщений внутри инфраструктурного слоя.
 * Bridge-адаптеры (MarketDataFeedAdapter, UserEventFeedAdapter) получают эти DTO
 * и преобразуют их в ApplicationEvent через Handlers.
 */

export type { WsMessageType } from './WsMessageTypes.js';
export type { WsRawLevel, WsOrderbookSnapshotDto } from './WsOrderbookDto.js';
export type { WsTradeDto } from './WsTradeDto.js';
export type { WsFillStatus, WsUserFillDto, WsOrderUpdateDto } from './WsUserEventDto.js';
