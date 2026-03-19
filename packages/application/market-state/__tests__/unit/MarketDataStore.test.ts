import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { InstrumentId } from '@polymarket/ids';
import { MarketDataStore } from '../../src/MarketDataStore.js';
import type { MarketDataStoreDeps, MarketDataReason } from '../../src/MarketDataStore.js';
import type { TopOfBook } from '@polymarket/event-bus';

// ── Constants ──────────────────────────────────────────────

const INSTRUMENT_1 = 'token-1' as unknown as InstrumentId;
const INSTRUMENT_2 = 'token-2' as unknown as InstrumentId;

// ── Helpers ────────────────────────────────────────────────

type SubscribeCallback = (event: any) => void;

function makeEventBus() {
  const handlers = new Map<string, SubscribeCallback[]>();
  return {
    subscribe: jest.fn((type: string, cb: SubscribeCallback) => {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type)!.push(cb);
      return jest.fn(() => {
        const arr = handlers.get(type) ?? [];
        const idx = arr.indexOf(cb);
        if (idx >= 0) arr.splice(idx, 1);
      });
    }),
    publish: jest.fn(),
    _emit(type: string, event: any) {
      for (const h of handlers.get(type) ?? []) h(event);
    },
    _handlers: handlers,
  };
}

function makeLogger() {
  return {
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn().mockReturnThis(),
  };
}

function makeBookCollector() {
  return {
    getHistory: jest.fn().mockReturnValue(undefined),
    recordDirect: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    clear: jest.fn(),
    instrumentCount: jest.fn().mockReturnValue(0),
  };
}

function makeTapeCollector() {
  return {
    getTape: jest.fn().mockReturnValue(undefined),
    recordDirect: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    clear: jest.fn(),
    instrumentCount: jest.fn().mockReturnValue(0),
  };
}

function makeTopOfBook(): TopOfBook {
  return {
    bestBid: undefined,
    bestAsk: undefined,
    spread: undefined,
    bestBidSize: undefined,
    bestAskSize: undefined,
  };
}

function makeDeps(overrides: Partial<MarketDataStoreDeps> = {}): MarketDataStoreDeps {
  return {
    eventBus: makeEventBus() as any,
    bookCollector: makeBookCollector() as any,
    tapeCollector: makeTapeCollector() as any,
    logger: makeLogger() as any,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────

describe('MarketDataStore', () => {
  let deps: MarketDataStoreDeps;
  let store: MarketDataStore;

  beforeEach(() => {
    deps = makeDeps();
    store = new MarketDataStore(deps);
  });

  // ── Инициализация ────────────────────────────────────

  describe('initialization', () => {
    it('should return undefined for unknown instrumentId', () => {
      expect(store.getTopOfBook(INSTRUMENT_1)).toBeUndefined();
      expect(store.getBookHistory(INSTRUMENT_1)).toBeUndefined();
      expect(store.getTradeTape(INSTRUMENT_1)).toBeUndefined();
    });
  });

  // ── setOnChange ───────────────────────────────────────

  describe('setOnChange', () => {
    it('перезаписывает предыдущий callback — старый не вызывается', () => {
      const first = jest.fn<(id: InstrumentId, reason: MarketDataReason) => void>();
      const second = jest.fn<(id: InstrumentId, reason: MarketDataReason) => void>();

      store.setOnChange(first);
      store.setOnChange(second);
      store.start();

      const eventBus = deps.eventBus as any;
      eventBus._emit('BOOK_UPDATED', {
        type: 'BOOK_UPDATED',
        instrumentId: INSTRUMENT_1,
        topOfBook: makeTopOfBook(),
        marketId: 'market-1',
        sequenceNumber: 1,
        timestamp: { toNumber: () => 1000 },
      });

      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledWith(INSTRUMENT_1, 'BOOK');
    });
  });

  // ── BOOK_UPDATED ─────────────────────────────────────

  describe('BOOK_UPDATED', () => {
    it('should store TopOfBook on BOOK_UPDATED event', () => {
      store.start();

      const topOfBook = makeTopOfBook();
      const eventBus = deps.eventBus as any;
      eventBus._emit('BOOK_UPDATED', {
        type: 'BOOK_UPDATED',
        instrumentId: INSTRUMENT_1,
        topOfBook,
        marketId: 'market-1',
        sequenceNumber: 1,
        timestamp: { toNumber: () => 1000 },
      });

      expect(store.getTopOfBook(INSTRUMENT_1)).toBe(topOfBook);
    });

    it('should call onChange with BOOK reason', () => {
      const onChange = jest.fn<(id: InstrumentId, reason: MarketDataReason) => void>();
      store.setOnChange(onChange);
      store.start();

      const eventBus = deps.eventBus as any;
      eventBus._emit('BOOK_UPDATED', {
        type: 'BOOK_UPDATED',
        instrumentId: INSTRUMENT_1,
        topOfBook: makeTopOfBook(),
        marketId: 'market-1',
        sequenceNumber: 1,
        timestamp: { toNumber: () => 1000 },
      });

      expect(onChange).toHaveBeenCalledWith(INSTRUMENT_1, 'BOOK');
    });

    it('should overwrite TopOfBook on subsequent events', () => {
      store.start();

      const eventBus = deps.eventBus as any;
      const topOfBook1 = makeTopOfBook();
      const topOfBook2 = { ...makeTopOfBook(), bestBid: 'updated' as any };

      eventBus._emit('BOOK_UPDATED', {
        type: 'BOOK_UPDATED',
        instrumentId: INSTRUMENT_1,
        topOfBook: topOfBook1,
        marketId: 'market-1',
        sequenceNumber: 1,
        timestamp: { toNumber: () => 1000 },
      });

      eventBus._emit('BOOK_UPDATED', {
        type: 'BOOK_UPDATED',
        instrumentId: INSTRUMENT_1,
        topOfBook: topOfBook2,
        marketId: 'market-1',
        sequenceNumber: 2,
        timestamp: { toNumber: () => 2000 },
      });

      expect(store.getTopOfBook(INSTRUMENT_1)).toBe(topOfBook2);
    });
  });

  // ── BOOK_DEPTH ───────────────────────────────────────

  describe('BOOK_DEPTH', () => {
    it('should delegate to bookCollector.recordDirect', () => {
      store.start();

      const snapshot = { marketId: 'market-1' } as any;
      const eventBus = deps.eventBus as any;
      eventBus._emit('BOOK_DEPTH', {
        type: 'BOOK_DEPTH',
        instrumentId: INSTRUMENT_1,
        snapshot,
        timestamp: { toNumber: () => 1000 },
      });

      expect((deps.bookCollector as any).recordDirect).toHaveBeenCalledWith(
        INSTRUMENT_1,
        snapshot,
        1000,
      );
    });

    it('should NOT call onChange for BOOK_DEPTH (already called from BOOK_UPDATED)', () => {
      const onChange = jest.fn<(id: InstrumentId, reason: MarketDataReason) => void>();
      store.setOnChange(onChange);
      store.start();

      const eventBus = deps.eventBus as any;
      eventBus._emit('BOOK_DEPTH', {
        type: 'BOOK_DEPTH',
        instrumentId: INSTRUMENT_1,
        snapshot: { marketId: 'market-1' },
        timestamp: { toNumber: () => 1000 },
      });

      expect(onChange).not.toHaveBeenCalled();
    });
  });

  // ── TRADE_RECEIVED ───────────────────────────────────

  describe('TRADE_RECEIVED', () => {
    it('should delegate to tapeCollector.recordDirect', () => {
      store.start();

      const price = { toNumber: () => 0.55 } as any;
      const size = { toNumber: () => 100 } as any;
      const timestamp = { toNumber: () => 1000 } as any;

      const eventBus = deps.eventBus as any;
      eventBus._emit('TRADE_RECEIVED', {
        type: 'TRADE_RECEIVED',
        instrumentId: INSTRUMENT_1,
        price,
        size,
        side: 'BUY',
        timestamp,
      });

      expect((deps.tapeCollector as any).recordDirect).toHaveBeenCalledWith(
        INSTRUMENT_1,
        price,
        size,
        'BUY',
        timestamp,
      );
    });

    it('should call onChange with TRADE reason', () => {
      const onChange = jest.fn<(id: InstrumentId, reason: MarketDataReason) => void>();
      store.setOnChange(onChange);
      store.start();

      const eventBus = deps.eventBus as any;
      eventBus._emit('TRADE_RECEIVED', {
        type: 'TRADE_RECEIVED',
        instrumentId: INSTRUMENT_1,
        price: {} as any,
        size: {} as any,
        side: 'BUY',
        timestamp: {} as any,
      });

      expect(onChange).toHaveBeenCalledWith(INSTRUMENT_1, 'TRADE');
    });
  });

  // ── Delegating reads ─────────────────────────────────

  describe('delegating reads', () => {
    it('should delegate getBookHistory to bookCollector', () => {
      const history = {} as any;
      (deps.bookCollector as any).getHistory.mockReturnValue(history);

      expect(store.getBookHistory(INSTRUMENT_1)).toBe(history);
      expect((deps.bookCollector as any).getHistory).toHaveBeenCalledWith(INSTRUMENT_1);
    });

    it('should delegate getTradeTape to tapeCollector', () => {
      const tape = {} as any;
      (deps.tapeCollector as any).getTape.mockReturnValue(tape);

      expect(store.getTradeTape(INSTRUMENT_1)).toBe(tape);
      expect((deps.tapeCollector as any).getTape).toHaveBeenCalledWith(INSTRUMENT_1);
    });
  });

  // ── start / stop ─────────────────────────────────────

  describe('lifecycle', () => {
    it('should subscribe to 3 event types on start', () => {
      store.start();

      expect(deps.eventBus.subscribe).toHaveBeenCalledTimes(3);
      const types = (deps.eventBus.subscribe as any).mock.calls.map((c: any[]) => c[0]);
      expect(types).toContain('BOOK_UPDATED');
      expect(types).toContain('BOOK_DEPTH');
      expect(types).toContain('TRADE_RECEIVED');
    });

    it('should not process events after stop', () => {
      const onChange = jest.fn<(id: InstrumentId, reason: MarketDataReason) => void>();
      store.setOnChange(onChange);
      store.start();
      store.stop();

      const eventBus = deps.eventBus as any;
      eventBus._emit('BOOK_UPDATED', {
        type: 'BOOK_UPDATED',
        instrumentId: INSTRUMENT_1,
        topOfBook: makeTopOfBook(),
        marketId: 'market-1',
        sequenceNumber: 1,
        timestamp: { toNumber: () => 1000 },
      });

      // Events emitted after stop() must not trigger onChange or update state
      expect(onChange).not.toHaveBeenCalled();
      expect(store.getTopOfBook(INSTRUMENT_1)).toBeUndefined();
    });

    it('should handle double start safely', () => {
      store.start();
      store.start(); // no error

      // Should have called unsubscribe for first set, then subscribe again
      expect(deps.eventBus.subscribe).toHaveBeenCalledTimes(6); // 3 + 3
    });
  });

  // ── clear ────────────────────────────────────────────

  describe('clear', () => {
    it('should clear TopOfBook data', () => {
      store.start();

      const eventBus = deps.eventBus as any;
      eventBus._emit('BOOK_UPDATED', {
        type: 'BOOK_UPDATED',
        instrumentId: INSTRUMENT_1,
        topOfBook: makeTopOfBook(),
        marketId: 'market-1',
        sequenceNumber: 1,
        timestamp: { toNumber: () => 1000 },
      });

      expect(store.getTopOfBook(INSTRUMENT_1)).toBeDefined();

      store.clear();
      expect(store.getTopOfBook(INSTRUMENT_1)).toBeUndefined();
    });
  });

  // ── Множественные инструменты ────────────────────────

  describe('multiple instruments', () => {
    it('should store TopOfBook per instrumentId independently', () => {
      store.start();

      const topOfBook1 = makeTopOfBook();
      const topOfBook2 = { ...makeTopOfBook(), bestBid: 'bid2' as any };

      const eventBus = deps.eventBus as any;
      eventBus._emit('BOOK_UPDATED', {
        type: 'BOOK_UPDATED',
        instrumentId: INSTRUMENT_1,
        topOfBook: topOfBook1,
        marketId: 'market-1',
        sequenceNumber: 1,
        timestamp: { toNumber: () => 1000 },
      });
      eventBus._emit('BOOK_UPDATED', {
        type: 'BOOK_UPDATED',
        instrumentId: INSTRUMENT_2,
        topOfBook: topOfBook2,
        marketId: 'market-1',
        sequenceNumber: 2,
        timestamp: { toNumber: () => 1000 },
      });

      expect(store.getTopOfBook(INSTRUMENT_1)).toBe(topOfBook1);
      expect(store.getTopOfBook(INSTRUMENT_2)).toBe(topOfBook2);
    });
  });
});
