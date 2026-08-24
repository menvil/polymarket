/**
 * Тесты снапшотов vendor-объектов (payload identity, N-005 PART 9/9.1).
 */
import { describe, it, expect } from '@jest/globals';
import type { CcxtRawOrderBook, CcxtRawTrade } from '../src/index.js';
import { snapshotOrderBook, snapshotTrade } from '../src/index.js';

describe('snapshotOrderBook', () => {
  it('сохраняет vendor-поля as-is, включая неизвестные', () => {
    const raw = {
      symbol: 'BTC/USDT',
      timestamp: 1_756_000_000_000,
      datetime: '2026-08-24T00:00:00.000Z',
      nonce: 7,
      bids: [
        [100, 1],
        [99, 2],
      ],
      asks: [
        [101, 1],
        [102, 2],
      ],
      vendorExtra: { exchangeSpecific: true },
    } as CcxtRawOrderBook;

    const snapshot = snapshotOrderBook(raw, 10);

    expect(snapshot['symbol']).toBe('BTC/USDT');
    expect(snapshot['timestamp']).toBe(1_756_000_000_000);
    expect(snapshot['nonce']).toBe(7);
    expect(snapshot['vendorExtra']).toEqual({ exchangeSpecific: true });
    expect(snapshot.bids).toEqual([
      [100, 1],
      [99, 2],
    ]);
  });

  it('обрезает стороны до depth, не мутируя исходник', () => {
    const raw = {
      symbol: 'BTC/USDT',
      bids: [
        [100, 1],
        [99, 2],
        [98, 3],
      ],
      asks: [
        [101, 1],
        [102, 2],
        [103, 3],
      ],
    } as CcxtRawOrderBook;

    const snapshot = snapshotOrderBook(raw, 1);

    expect(snapshot.bids).toEqual([[100, 1]]);
    expect(snapshot.asks).toEqual([[101, 1]]);
    expect(raw.bids).toHaveLength(3);
    expect(raw.asks).toHaveLength(3);
  });

  it('снапшот независим от последующей мутации исходника (9.1)', () => {
    const raw = {
      symbol: 'BTC/USDT',
      bids: [[100, 1]],
      asks: [[101, 1]],
      nested: { level: [1, 2] },
    } as unknown as { bids: number[][]; asks: number[][]; nested: { level: number[] } };

    const snapshot = snapshotOrderBook(raw as unknown as CcxtRawOrderBook, 10);

    raw.bids[0]![0] = 999;
    raw.nested.level.push(3);
    raw.asks.length = 0;

    expect(snapshot.bids).toEqual([[100, 1]]);
    expect(snapshot.asks).toEqual([[101, 1]]);
    expect(snapshot['nested']).toEqual({ level: [1, 2] });
  });

  it('эквивалентен JSON-представлению: undefined-поля отброшены', () => {
    const raw = {
      symbol: 'BTC/USDT',
      timestamp: undefined,
      bids: [[100, 1]],
      asks: [[101, 1]],
    } as CcxtRawOrderBook;

    const snapshot = snapshotOrderBook(raw, 10);

    expect('timestamp' in snapshot).toBe(false);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it('отбрасывает прототип Array-подклассов ccxt (JSON-совместимость)', () => {
    class VendorSide extends Array<[number, number]> {
      public internalIndex = new Map<number, number>();
    }
    const bids = new VendorSide();
    bids.push([100, 1], [99, 2]);
    const asks = new VendorSide();
    asks.push([101, 1]);

    const raw = { symbol: 'BTC/USDT', bids, asks } as unknown as CcxtRawOrderBook;
    const snapshot = snapshotOrderBook(raw, 10);

    expect(Array.isArray(snapshot.bids)).toBe(true);
    expect(Object.getPrototypeOf(snapshot.bids)).toBe(Array.prototype);
    expect(snapshot.bids).toEqual([
      [100, 1],
      [99, 2],
    ]);
  });
});

describe('snapshotTrade', () => {
  it('сохраняет все vendor-поля сделки, включая info', () => {
    const raw = {
      id: 't-1',
      symbol: 'BTC/USDT',
      timestamp: 1_756_000_000_000,
      side: 'buy',
      price: 100.5,
      amount: 0.25,
      cost: 25.125,
      takerOrMaker: 'taker',
      info: { a: [1, 2], s: 'raw' },
    } as CcxtRawTrade;

    const snapshot = snapshotTrade(raw);

    expect(snapshot.id).toBe('t-1');
    expect(snapshot.price).toBe(100.5);
    expect(snapshot.amount).toBe(0.25);
    expect(snapshot['takerOrMaker']).toBe('taker');
    expect(snapshot.info).toEqual({ a: [1, 2], s: 'raw' });
  });

  it('снапшот независим от мутации исходника', () => {
    const raw = {
      id: 't-1',
      price: 100,
      info: { flags: [1] },
    } as unknown as { price: number; info: { flags: number[] } };

    const snapshot = snapshotTrade(raw as unknown as CcxtRawTrade);
    raw.price = 200;
    raw.info.flags.push(2);

    expect(snapshot.price).toBe(100);
    expect(snapshot.info).toEqual({ flags: [1] });
  });
});
