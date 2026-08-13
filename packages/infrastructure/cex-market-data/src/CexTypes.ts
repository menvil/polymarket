/**
 * Тип рынка CEX-биржи.
 *
 * - `spot` — спотовый рынок.
 * - `futures` — фьючерсный рынок с датой экспирации.
 * - `swap` — бессрочный своп (perpetual).
 */
export type CexMarketType = 'spot' | 'futures' | 'swap';

/**
 * Сырая запись стакана ордеров от биржи.
 *
 * @remarks
 * Записывается в JSONL-файл как `{ t: "ob", ts: ..., bids: [...], asks: [...] }`.
 */
export interface CexOrderbookRecord {
  /** Дискриминатор записи. */
  readonly t: 'ob';
  /** Timestamp биржи (Unix ms). */
  readonly ts: number;
  /** Уровни bid: [[price, size], ...], отсортированы по убыванию цены. */
  readonly bids: readonly (readonly [number, number])[];
  /** Уровни ask: [[price, size], ...], отсортированы по возрастанию цены. */
  readonly asks: readonly (readonly [number, number])[];
}

/**
 * Сырая запись о сделке от биржи.
 *
 * @remarks
 * Записывается в JSONL-файл как `{ t: "trade", ts: ..., p: ..., sz: ..., side: ... }`.
 */
export interface CexTradeRecord {
  /** Дискриминатор записи. */
  readonly t: 'trade';
  /** Timestamp сделки (Unix ms). */
  readonly ts: number;
  /** Цена сделки. */
  readonly p: number;
  /** Объём сделки в базовом активе. */
  readonly sz: number;
  /** Сторона сделки: buy (taker купил) или sell (taker продал). */
  readonly side?: 'buy' | 'sell';
}

/**
 * Дискриминантный союз сырых CEX-записей.
 */
export type CexRawRecord = CexOrderbookRecord | CexTradeRecord;

/**
 * Нормализованное событие стакана с метаданными биржи и временными метками.
 *
 * @remarks
 * Создаётся из `CexOrderbookRecord` через `normalizeCexRawRecord()`.
 * Передаётся в `CexRecordSink` для downstream потребителей.
 */
export interface CexNormalizedBookEvent {
  /** Дискриминатор нормализованного события. */
  readonly t: 'cex_ob';
  /** Идентификатор биржи (напр. "binance"). */
  readonly venue: string;
  /** Символ торговой пары (напр. "BTC/USD"). */
  readonly symbol: string;
  readonly marketType: CexMarketType;
  /** Timestamp биржи (Unix ms). */
  readonly exchangeTs: number;
  /** Timestamp получения на нашей стороне (Unix ms). */
  readonly receivedTs: number;
  readonly bids: readonly (readonly [number, number])[];
  readonly asks: readonly (readonly [number, number])[];
}

/**
 * Нормализованное событие сделки с метаданными биржи.
 *
 * @remarks
 * Создаётся из `CexTradeRecord` через `normalizeCexRawRecord()`.
 */
export interface CexNormalizedTradeEvent {
  /** Дискриминатор нормализованного события. */
  readonly t: 'cex_trade';
  readonly venue: string;
  readonly symbol: string;
  readonly marketType: CexMarketType;
  readonly exchangeTs: number;
  readonly receivedTs: number;
  readonly price: number;
  readonly size: number;
  readonly side?: 'buy' | 'sell';
}

/**
 * Дискриминантный союз нормализованных CEX-событий.
 */
export type CexNormalizedEvent = CexNormalizedBookEvent | CexNormalizedTradeEvent;

/**
 * Callback для получения нормализованных CEX-событий в реальном времени.
 *
 * @remarks
 * Передаётся в `CexCollectorConfig.sinks[]`.
 * Вызывается при каждой новой записи из любого watcher'а.
 *
 * @param event - Нормализованное событие (стакан или сделка)
 * @param raw - Оригинальная сырая запись (для отладки или архивирования)
 */
export type CexRecordSink = (event: CexNormalizedEvent, raw: CexRawRecord) => void;

/**
 * Нормализует сырую CEX-запись в типизированное событие с метаданными.
 *
 * @remarks
 * Для стакана (`t: "ob"`) проверяет наличие непустых bid/ask и конечный ts.
 * Для сделки (`t: "trade"`) проверяет конечность цены и объёма.
 * Возвращает `undefined` при невалидных данных.
 *
 * @param venue - Идентификатор биржи
 * @param symbol - Символ пары
 * @param marketType - Тип рынка
 * @param raw - Сырая запись
 * @param receivedTs - Локальный timestamp получения. Default: `Date.now()`
 * @returns Нормализованное событие или `undefined` при невалидных данных
 *
 * @example
 * ```typescript
 * const event = normalizeCexRawRecord('binance', 'BTC/USD', 'spot', rawRecord);
 * if (event) sink(event, rawRecord);
 * ```
 */
export function normalizeCexRawRecord(
  venue: string,
  symbol: string,
  marketType: CexMarketType,
  raw: CexRawRecord,
  receivedTs = Date.now(),
): CexNormalizedEvent | undefined {
  if (raw.t === 'ob') {
    if (!Number.isFinite(raw.ts) || raw.bids.length === 0 || raw.asks.length === 0) return undefined;
    return {
      t: 'cex_ob',
      venue,
      symbol,
      marketType,
      exchangeTs: raw.ts,
      receivedTs,
      bids: raw.bids,
      asks: raw.asks,
    };
  }

  if (!Number.isFinite(raw.ts) || !Number.isFinite(raw.p) || !Number.isFinite(raw.sz)) return undefined;
  return {
    t: 'cex_trade',
    venue,
    symbol,
    marketType,
    exchangeTs: raw.ts,
    receivedTs,
    price: raw.p,
    size: raw.sz,
    side: raw.side,
  };
}
