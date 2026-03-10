/**
 * Внутренние DTO для парсинга user-channel событий Polymarket WS.
 *
 * @remarks
 * User channel содержит события, специфичные для конкретного трейдера:
 * - WsUserFillDto — исполнение ордера (fill)
 * - WsOrderUpdateDto — обновление статуса ордера
 */

/**
 * Статусы fill-события от Polymarket user-channel.
 *
 * @remarks
 * - MATCHED — fill подтверждён
 * - UNMATCHED — fill отменён
 * - DELAYED — fill задержан (временно)
 */
export type WsFillStatus = 'MATCHED' | 'UNMATCHED' | 'DELAYED';

/**
 * Raw DTO fill-события из Polymarket user-channel.
 *
 * @remarks
 * Polymarket fill содержит taker-ордер и список maker-ордеров, с которыми он матчился.
 * fill.id + taker_order_id — уникальные идентификаторы для идемпотентности.
 */
export interface WsUserFillDto {
  readonly type: 'user_fill';
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
  /** Статус fill */
  readonly status: WsFillStatus;
  /** ID токена (YES/NO token) */
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
 * Raw DTO обновления статуса ордера из Polymarket user-channel.
 */
export interface WsOrderUpdateDto {
  readonly type: 'order_update';
  /** ID ордера */
  readonly order_id: string;
  /** Новый статус ордера */
  readonly status: 'MATCHED' | 'OPEN' | 'CANCELED' | 'DELAYED' | 'UNMATCHED';
  /** Причина изменения статуса (опционально) */
  readonly reason?: string;
  /** Timestamp события (Unix ms, строка) */
  readonly timestamp: string;
}
