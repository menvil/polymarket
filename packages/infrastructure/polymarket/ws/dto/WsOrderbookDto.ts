/**
 * Внутренние DTO для парсинга orderbook WS-сообщений Polymarket.
 *
 * @remarks
 * Polymarket шлёт ТОЛЬКО полные снапшоты ('book' events) — нет инкрементальных дельт.
 * 'price_change' events — batch-уведомления о ценах, не дельты стакана.
 * WsOrderbookDeltaDto отсутствует намеренно — delta-логики нет.
 */

/**
 * Уровень стакана в wire-формате.
 *
 * @remarks
 * Polymarket передаёт цену и размер строками для сохранения точности.
 */
export interface WsRawLevel {
  /** Цена уровня (строка для сохранения Decimal-точности) */
  price: string;
  /** Размер на уровне (строка для сохранения Decimal-точности) */
  size: string;
}

/**
 * Полный снапшот стакана от Polymarket WS.
 *
 * @remarks
 * Polymarket шлёт периодически — это единственный тип обновлений стакана.
 * type='book' соответствует полному снапшоту.
 */
export interface WsOrderbookSnapshotDto {
  readonly type: 'book';
  /** ID токена (UP/DOWN token) */
  readonly asset_id: string;
  /** ID рынка (condition_id) */
  readonly market: string;
  /** Уровни bid (покупка) */
  readonly bids: WsRawLevel[];
  /** Уровни ask (продажа) */
  readonly asks: WsRawLevel[];
  /** Timestamp события (Unix ms, строка) */
  readonly timestamp: string;
  /** Хэш снапшота (опционально) */
  readonly hash?: string;
}
