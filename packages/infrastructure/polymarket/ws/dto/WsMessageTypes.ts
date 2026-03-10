/**
 * Внутренние типы WS-сообщений Polymarket.
 *
 * @remarks
 * Используются только для парсинга и маршрутизации сообщений внутри инфраструктурного слоя.
 * Не экспортируются из пакета — внутренние DTO.
 */

/**
 * Типы WS-сообщений Polymarket.
 *
 * @remarks
 * - `book` — полный снапшот стакана (orderbook channel)
 * - `price_change` — batch-уведомление о ценах (НЕ инкрементальная дельта стакана)
 * - `trade` — публичный трейд
 * - `user_fill` — исполнение ордера (user channel)
 * - `order_update` — обновление статуса ордера (user channel)
 * - `last_trade_price` — последняя цена трейда
 * - `tick_size_change` — изменение тик-сайза
 */
export type WsMessageType =
  | 'book'
  | 'price_change'
  | 'trade'
  | 'user_fill'
  | 'order_update'
  | 'last_trade_price'
  | 'tick_size_change';
