/**
 * Внутренние DTO для парсинга user-channel событий Polymarket WS.
 *
 * @remarks
 * User channel содержит события, специфичные для конкретного трейдера.
 * Подписка на user channel требует аутентификации (L1/L2 подпись).
 *
 * Два типа событий (event_type в WS-сообщении):
 * - `event_type: "trade"` → WsUserFillDto — исполнение ордера (fill)
 * - `event_type: "order"` → WsOrderUpdateDto — lifecycle событие ордера (размещение и т.д.)
 *
 * ВАЖНО: `event_type: "trade"` используется как в market channel (публичные трейды),
 * так и в user channel (fills конкретного трейдера). Различаются по каналу подписки.
 * WsUserFillDto — shape для user-channel `trade` события (имеет taker_order_id, fee_rate_bps и т.д.).
 * WsTradeDto — shape для market-channel `trade` события (только price/size/side).
 */

/**
 * Статусы fill-события из Polymarket user-channel (event_type: "trade").
 *
 * @remarks
 * Жизненный цикл fill на блокчейне:
 * - MATCHED — fill отправлен в executor service (подтверждён матчером)
 * - MINED — транзакция зафиксирована в блоке (on-chain observed)
 * - CONFIRMED — finality достигнута, транзакция успешна
 * - RETRYING — транзакция упала и будет повторена
 * - FAILED — транзакция окончательно упала, повторов не будет
 */
export type WsFillStatus = 'MATCHED' | 'MINED' | 'CONFIRMED' | 'RETRYING' | 'FAILED';

/**
 * Raw DTO fill-события из Polymarket user-channel (event_type: "trade").
 *
 * @remarks
 * Polymarket fill содержит taker-ордер и список maker-ордеров, с которыми он матчился.
 * fill.id + taker_order_id — уникальные идентификаторы для идемпотентности.
 *
 * Отличается от WsTradeDto (market channel): содержит taker_order_id, fee_rate_bps,
 * maker_orders — всё специфично для конкретного трейдера.
 */
export interface WsUserFillDto {
  /** Уникальный ID fill-события */
  readonly id: string;
  /** ID taker-ордера */
  readonly taker_order_id: string;
  /** Сторона taker-трейдера */
  readonly trader_side: 'BUY' | 'SELL';
  /** Цена исполнения (строка для Decimal-точности) */
  readonly price: string;
  /** Объём исполнения (строка для Decimal-точности) */
  readonly size: string;
  /** Ставка комиссии в базисных пунктах (строка) */
  readonly fee_rate_bps: string;
  /** Статус fill (on-chain lifecycle) */
  readonly status: WsFillStatus;
  /** ID токена (UP/DOWN token) */
  readonly asset_id: string;
  /** Список maker-ордеров, участвовавших в матчинге */
  readonly maker_orders: Array<{
    readonly order_id: string;
    readonly matched_amount: string;
  }>;
  /** Timestamp события (Unix ms, строка) */
  readonly timestamp: string;
}

/**
 * Raw DTO lifecycle-события ордера из Polymarket user-channel (event_type: "order").
 *
 * @remarks
 * Polymarket user channel отправляет `event_type: "order"` при lifecycle событиях:
 * - orderEventType: "PLACEMENT" — ордер принят биржей и размещён в стакане
 * - Другие значения возможны при отмене или истечении ордера
 *
 * Поле `orderEventType` соответствует полю `type` в JSON-пейлоаде WS-сообщения
 * (не путать с TypeScript-дискриминантом `type: 'order'` этого DTO).
 */
export interface WsOrderUpdateDto {
  /** TypeScript-дискриминант: соответствует `event_type: "order"` в WS-пейлоаде */
  readonly type: 'order';
  /** Тип lifecycle-события ордера (поле `type` в JSON-пейлоаде): "PLACEMENT" и др. */
  readonly orderEventType: string;
  /** ID ордера */
  readonly order_id: string;
  /** Текущий статус ордера (опционально, зависит от типа события) */
  readonly status?: string;
  /** Причина изменения статуса (опционально) */
  readonly reason?: string;
  /** Timestamp события (Unix ms, строка) */
  readonly timestamp: string;
}
