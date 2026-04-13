export type CexMarketType = 'spot' | 'futures' | 'swap';

export interface CexOrderbookRecord {
  readonly t: 'ob';
  readonly ts: number;
  readonly bids: readonly (readonly [number, number])[];
  readonly asks: readonly (readonly [number, number])[];
}

export interface CexTradeRecord {
  readonly t: 'trade';
  readonly ts: number;
  readonly p: number;
  readonly sz: number;
  readonly side?: 'buy' | 'sell';
}

export type CexRawRecord = CexOrderbookRecord | CexTradeRecord;

export interface CexNormalizedBookEvent {
  readonly t: 'cex_ob';
  readonly venue: string;
  readonly symbol: string;
  readonly marketType: CexMarketType;
  readonly exchangeTs: number;
  readonly receivedTs: number;
  readonly bids: readonly (readonly [number, number])[];
  readonly asks: readonly (readonly [number, number])[];
}

export interface CexNormalizedTradeEvent {
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

export type CexNormalizedEvent = CexNormalizedBookEvent | CexNormalizedTradeEvent;

export type CexRecordSink = (event: CexNormalizedEvent, raw: CexRawRecord) => void;

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
