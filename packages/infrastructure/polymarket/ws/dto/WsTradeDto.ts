/**
 * Внутренний DTO для парсинга публичных трейдов из Polymarket WS.
 *
 * @remarks
 * Публичные трейды приходят по orderbook channel с type='trade'.
 * Используются для ленты трейдов (TradeTape) — аналитика, VWAP, сигналы.
 * Не содержат orderId — это рыночные принты, не исполнения наших ордеров.
 */

/**
 * Raw DTO публичного трейда из Polymarket WS.
 */
export interface WsTradeDto {
  readonly type: 'trade';
  /** ID токена (YES/NO token) */
  readonly asset_id: string;
  /** Цена трейда (строка для сохранения Decimal-точности) */
  readonly price: string;
  /** Объём трейда (строка для сохранения Decimal-точности) */
  readonly size: string;
  /** Сторона инициатора трейда */
  readonly side: 'BUY' | 'SELL';
  /** Timestamp события (Unix ms, строка) */
  readonly timestamp: string;
}
