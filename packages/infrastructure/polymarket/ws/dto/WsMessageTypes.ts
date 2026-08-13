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
 * - `book` — полный снапшот стакана (market channel)
 * - `price_change` — batch-уведомление о ценах (НЕ инкрементальная дельта стакана)
 * - `trade` — публичный трейд (market channel) ИЛИ исполнение ордера (user channel).
 *   Различаются по каналу подписки, не по event_type: оба используют `event_type: "trade"`.
 *   В market channel несёт price/size/side публичного маркет-принта.
 *   В user channel несёт fill-информацию (id, taker_order_id, fee_rate_bps и т.д.).
 * - `order` — событие статуса ордера (ТОЛЬКО user channel): `event_type: "order"`.
 *   Используется для подтверждения размещения (PLACEMENT) и других order lifecycle событий.
 * - `last_trade_price` — последняя цена трейда (market channel)
 * - `tick_size_change` — изменение тик-сайза (market channel)
 */
export type WsMessageType =
  | 'book'
  | 'price_change'
  | 'trade'
  | 'order'
  | 'last_trade_price'
  | 'tick_size_change';
