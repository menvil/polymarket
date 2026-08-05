import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import Decimal from 'decimal.js';
import type { InstrumentId } from '@polymarket/ids';
import { asInstrumentId } from '@polymarket/ids';
import { Price, Quantity, Timestamp } from '@polymarket/value-objects';
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
    clearMarket: jest.fn(),
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
    clearMarket: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    clear: jest.fn(),
    instrumentCount: jest.fn().mockReturnValue(0),
  };
}

function makeTradeIndex() {
  return {
    record: jest.fn(),
    get: jest.fn().mockReturnValue(undefined),
    size: jest.fn().mockReturnValue(0),
    isEmpty: jest.fn().mockReturnValue(true),
  };
}

/** Валидный numeric CTF token ID — parseAssetId() распознаёт как POLYMARKET_CTF_TOKEN. */
const REAL_INSTRUMENT_1 = asInstrumentId('62305814799875783974460176688386847666394972778903073967664089920408777315323')!;

function makeRealTradeEvent(overrides?: { instrumentId?: InstrumentId; timestampMs?: number }) {
  return {
    type: 'TRADE_RECEIVED' as const,
    instrumentId: overrides?.instrumentId ?? REAL_INSTRUMENT_1,
    price: Price.of(new Decimal(0.6)),
    size: Quantity.of(new Decimal(50)),
    side: 'BUY' as const,
    timestamp: Timestamp.of(new Decimal(overrides?.timestampMs ?? 1_700_000_000_000)),
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
    tradeIndex: makeTradeIndex() as any,
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

    it('вызывает onChange(BOOK) для BOOK_DEPTH (#2)', () => {
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

      expect(onChange).toHaveBeenCalledWith(INSTRUMENT_1, 'BOOK');
    });

    it('depth-only апдейт (без BOOK_UPDATED) теперь будит стратегию (#2)', () => {
      // Раньше depth-only изменения терялись (known limitation). Теперь BOOK_DEPTH
      // вызывает onChange('BOOK') — стенки/ликвидность не пропадают для стратегии.
      const onChange = jest.fn<(id: InstrumentId, reason: MarketDataReason) => void>();
      store.setOnChange(onChange);
      store.start();

      const eventBus = deps.eventBus as any;
      eventBus._emit('BOOK_DEPTH', {
        type: 'BOOK_DEPTH',
        instrumentId: INSTRUMENT_1,
        snapshot: { marketId: 'market-1' } as any,
        timestamp: { toNumber: () => 1000 },
      });

      expect((deps.bookCollector as any).recordDirect).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith(INSTRUMENT_1, 'BOOK');
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
        undefined, // marketId — нет предшествующего BOOK_UPDATED для инструмента
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

  // ── Trade construction (Этап 2.5) ────────────────────

  describe('TRADE_RECEIVED → Trade construction (TradeMapper.fromParsedTrade)', () => {
    function depth(eventBus: any, id: InstrumentId, marketId: string): void {
      eventBus._emit('BOOK_DEPTH', {
        type: 'BOOK_DEPTH', instrumentId: id,
        snapshot: { marketId } as any, timestamp: { toNumber: () => 1000 },
      });
    }

    it('строит Trade и индексирует в tradeIndex, когда marketId уже известен', () => {
      store.start();
      const eventBus = deps.eventBus as any;

      depth(eventBus, REAL_INSTRUMENT_1, 'market-1');
      eventBus._emit('TRADE_RECEIVED', makeRealTradeEvent());

      expect((deps.tradeIndex as any).record).toHaveBeenCalledTimes(1);
      const trade = (deps.tradeIndex as any).record.mock.calls[0][0];
      expect(trade.marketId).toBe('market-1');
      expect(trade.aggressorSide).toBe('BUY');
      expect(trade.price.value().toNumber()).toBeCloseTo(0.6, 5);
      expect(trade.size.value().toNumber()).toBeCloseTo(50, 5);
    });

    it('не строит Trade и не логирует warn, когда marketId ещё неизвестен (лог debug)', () => {
      store.start();
      const eventBus = deps.eventBus as any;

      eventBus._emit('TRADE_RECEIVED', makeRealTradeEvent());

      expect((deps.tradeIndex as any).record).not.toHaveBeenCalled();
      expect((deps.logger as any).warn).not.toHaveBeenCalled();
      expect((deps.logger as any).debug).toHaveBeenCalled();
    });

    it('не падает и логирует warn, если fromParsedTrade возвращает Err (невалидный instrumentId)', () => {
      store.start();
      const eventBus = deps.eventBus as any;

      // INSTRUMENT_1 = 'token-1' — не numeric CTF token, parseAssetId() вернёт undefined
      depth(eventBus, INSTRUMENT_1, 'market-1');

      expect(() => {
        eventBus._emit('TRADE_RECEIVED', makeRealTradeEvent({ instrumentId: INSTRUMENT_1 }));
      }).not.toThrow();

      expect((deps.tradeIndex as any).record).not.toHaveBeenCalled();
      expect((deps.logger as any).warn).toHaveBeenCalled();
    });

    it('onChange(TRADE) вызывается независимо от результата построения Trade', () => {
      const onChange = jest.fn<(id: InstrumentId, reason: MarketDataReason) => void>();
      store.setOnChange(onChange);
      store.start();
      const eventBus = deps.eventBus as any;

      eventBus._emit('TRADE_RECEIVED', makeRealTradeEvent());

      expect(onChange).toHaveBeenCalledWith(REAL_INSTRUMENT_1, 'TRADE');
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

    it('should delegate getTradeByVenueId to tradeIndex', () => {
      const trade = {} as any;
      (deps.tradeIndex as any).get.mockReturnValue(trade);

      const id = 'venue-trade-1' as any;
      expect(store.getTradeByVenueId(id)).toBe(trade);
      expect((deps.tradeIndex as any).get).toHaveBeenCalledWith(id);
    });
  });

  // ── start / stop ─────────────────────────────────────

  describe('lifecycle', () => {
    it('should subscribe to 4 event types on start', () => {
      store.start();

      expect(deps.eventBus.subscribe).toHaveBeenCalledTimes(4);
      const types = (deps.eventBus.subscribe as any).mock.calls.map((c: any[]) => c[0]);
      expect(types).toContain('BOOK_UPDATED');
      expect(types).toContain('BOOK_DEPTH');
      expect(types).toContain('TRADE_RECEIVED');
      expect(types).toContain('MARKET_CLOSED');
    });

    it('after stop(): BOOK_UPDATED не обновляет state и не вызывает onChange', () => {
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

      expect(onChange).not.toHaveBeenCalled();
      expect(store.getTopOfBook(INSTRUMENT_1)).toBeUndefined();
    });

    it('after stop(): BOOK_DEPTH не доходит до bookCollector', () => {
      store.start();
      store.stop();

      const eventBus = deps.eventBus as any;
      eventBus._emit('BOOK_DEPTH', {
        type: 'BOOK_DEPTH',
        instrumentId: INSTRUMENT_1,
        snapshot: { marketId: 'market-1' } as any,
        timestamp: { toNumber: () => 1000 },
      });

      expect((deps.bookCollector as any).recordDirect).not.toHaveBeenCalled();
    });

    it('after stop(): TRADE_RECEIVED не доходит до tapeCollector', () => {
      store.start();
      store.stop();

      const eventBus = deps.eventBus as any;
      eventBus._emit('TRADE_RECEIVED', {
        type: 'TRADE_RECEIVED',
        instrumentId: INSTRUMENT_1,
        price: {} as any,
        size: {} as any,
        side: 'BUY',
        timestamp: {} as any,
      });

      expect((deps.tapeCollector as any).recordDirect).not.toHaveBeenCalled();
    });

    it('should handle double start safely', () => {
      store.start();
      store.start(); // no error

      // Should have called unsubscribe for first set, then subscribe again
      expect(deps.eventBus.subscribe).toHaveBeenCalledTimes(8); // 4 + 4
    });
  });

  // ── #2 marketId из BOOK_DEPTH ────────────────────────

  describe('#2 marketId из BOOK_DEPTH для ленты', () => {
    it('TRADE после BOOK_DEPTH (без BOOK_UPDATED) получает marketId из snapshot', () => {
      store.start();
      const eventBus = deps.eventBus as any;

      // Только BOOK_DEPTH — BOOK_UPDATED ещё не приходил
      eventBus._emit('BOOK_DEPTH', {
        type: 'BOOK_DEPTH',
        instrumentId: INSTRUMENT_1,
        snapshot: { marketId: 'market-1' } as any,
        timestamp: { toNumber: () => 1000 },
      });
      eventBus._emit('TRADE_RECEIVED', {
        type: 'TRADE_RECEIVED',
        instrumentId: INSTRUMENT_1,
        price: {} as any, size: {} as any, side: 'BUY', timestamp: {} as any,
      });

      const call = (deps.tapeCollector as any).recordDirect.mock.calls.at(-1);
      expect(call[5]).toBe('market-1'); // marketId прокинут из BOOK_DEPTH
    });
  });

  // ── Порядок событий (lifecycle) ──────────────────────

  describe('порядок событий', () => {
    function trade(eventBus: any, id: InstrumentId): void {
      eventBus._emit('TRADE_RECEIVED', {
        type: 'TRADE_RECEIVED', instrumentId: id,
        price: {} as any, size: {} as any, side: 'BUY', timestamp: {} as any,
      });
    }
    function depth(eventBus: any, id: InstrumentId, marketId: string): void {
      eventBus._emit('BOOK_DEPTH', {
        type: 'BOOK_DEPTH', instrumentId: id,
        snapshot: { marketId } as any, timestamp: { toNumber: () => 1000 },
      });
    }
    function bookUpdated(eventBus: any, id: InstrumentId, marketId: string): void {
      eventBus._emit('BOOK_UPDATED', {
        type: 'BOOK_UPDATED', instrumentId: id, topOfBook: makeTopOfBook(),
        marketId, sequenceNumber: 1, timestamp: { toNumber: () => 1000 },
      });
    }
    function closed(eventBus: any, marketId: string): void {
      eventBus._emit('MARKET_CLOSED', {
        type: 'MARKET_CLOSED', marketId, reason: 'RESOLVED',
        realizedPnL: {} as any, timestamp: { toNumber: () => 2000 },
      });
    }
    function lastTradeMarketId(deps: MarketDataStoreDeps): unknown {
      return (deps.tapeCollector as any).recordDirect.mock.calls.at(-1)?.[5];
    }

    it('TRADE → BOOK_DEPTH → MARKET_CLOSED', () => {
      store.start();
      const eb = deps.eventBus as any;
      trade(eb, INSTRUMENT_1);                          // marketId неизвестен
      expect(lastTradeMarketId(deps)).toBeUndefined();
      depth(eb, INSTRUMENT_1, 'market-1');              // marketId стал известен
      trade(eb, INSTRUMENT_1);
      expect(lastTradeMarketId(deps)).toBe('market-1'); // прокинут в ленту
      closed(eb, 'market-1');
      expect((deps.tapeCollector as any).clearMarket).toHaveBeenCalledWith('market-1');
    });

    it('BOOK_DEPTH → TRADE → MARKET_CLOSED', () => {
      store.start();
      const eb = deps.eventBus as any;
      depth(eb, INSTRUMENT_1, 'market-1');
      trade(eb, INSTRUMENT_1);
      expect(lastTradeMarketId(deps)).toBe('market-1');
      closed(eb, 'market-1');
      expect((deps.tapeCollector as any).clearMarket).toHaveBeenCalledWith('market-1');
    });

    it('BOOK_UPDATED → TRADE → MARKET_CLOSED', () => {
      store.start();
      const eb = deps.eventBus as any;
      bookUpdated(eb, INSTRUMENT_1, 'market-1');
      trade(eb, INSTRUMENT_1);
      expect(lastTradeMarketId(deps)).toBe('market-1');
      closed(eb, 'market-1');
      expect(store.getTopOfBook(INSTRUMENT_1)).toBeUndefined(); // cleanup
      expect((deps.tapeCollector as any).clearMarket).toHaveBeenCalledWith('market-1');
    });

    it('TRADE → BOOK_UPDATED → MARKET_CLOSED очищает ленту рынка', () => {
      store.start();
      const eb = deps.eventBus as any;
      trade(eb, INSTRUMENT_1);                          // marketId неизвестен
      expect(lastTradeMarketId(deps)).toBeUndefined();
      bookUpdated(eb, INSTRUMENT_1, 'market-1');        // marketId стал известен
      trade(eb, INSTRUMENT_1);
      expect(lastTradeMarketId(deps)).toBe('market-1');
      closed(eb, 'market-1');
      expect((deps.tapeCollector as any).clearMarket).toHaveBeenCalledWith('market-1');
    });
  });

  // ── MARKET_CLOSED cleanup ────────────────────────────

  describe('MARKET_CLOSED cleanup', () => {
    function emitBookUpdated(eventBus: any, instrumentId: InstrumentId, marketId: string): void {
      eventBus._emit('BOOK_UPDATED', {
        type: 'BOOK_UPDATED',
        instrumentId,
        topOfBook: makeTopOfBook(),
        marketId,
        sequenceNumber: 1,
        timestamp: { toNumber: () => 1000 },
      });
    }

    it('удаляет TopOfBook инструментов закрытого рынка и делегирует коллекторам', () => {
      store.start();
      const eventBus = deps.eventBus as any;

      emitBookUpdated(eventBus, INSTRUMENT_1, 'market-1');
      emitBookUpdated(eventBus, INSTRUMENT_2, 'market-1');
      expect(store.getTopOfBook(INSTRUMENT_1)).toBeDefined();
      expect(store.getTopOfBook(INSTRUMENT_2)).toBeDefined();

      eventBus._emit('MARKET_CLOSED', {
        type: 'MARKET_CLOSED',
        marketId: 'market-1',
        reason: 'RESOLVED',
        realizedPnL: {} as any,
        timestamp: { toNumber: () => 2000 },
      });

      expect(store.getTopOfBook(INSTRUMENT_1)).toBeUndefined();
      expect(store.getTopOfBook(INSTRUMENT_2)).toBeUndefined();
      expect((deps.bookCollector as any).clearMarket).toHaveBeenCalledWith('market-1');
      expect((deps.tapeCollector as any).clearMarket).toHaveBeenCalledWith('market-1');
    });

    it('не трогает TopOfBook другого рынка', () => {
      store.start();
      const eventBus = deps.eventBus as any;

      emitBookUpdated(eventBus, INSTRUMENT_1, 'market-1');
      emitBookUpdated(eventBus, INSTRUMENT_2, 'market-2');

      eventBus._emit('MARKET_CLOSED', {
        type: 'MARKET_CLOSED',
        marketId: 'market-1',
        reason: 'RESOLVED',
        realizedPnL: {} as any,
        timestamp: { toNumber: () => 2000 },
      });

      expect(store.getTopOfBook(INSTRUMENT_1)).toBeUndefined();
      expect(store.getTopOfBook(INSTRUMENT_2)).toBeDefined();
    });

    it('делегирует cleanup коллекторам даже без накопленного TopOfBook', () => {
      store.start();
      const eventBus = deps.eventBus as any;

      eventBus._emit('MARKET_CLOSED', {
        type: 'MARKET_CLOSED',
        marketId: 'market-unknown',
        reason: 'RESOLVED',
        realizedPnL: {} as any,
        timestamp: { toNumber: () => 2000 },
      });

      expect((deps.bookCollector as any).clearMarket).toHaveBeenCalledWith('market-unknown');
      expect((deps.tapeCollector as any).clearMarket).toHaveBeenCalledWith('market-unknown');
    });
  });

  // ── freshness API (#3) ───────────────────────────────

  describe('getTopOfBookState / areBooksSynchronized', () => {
    function emitBook(eventBus: any, instrumentId: InstrumentId, tsMs: number): void {
      eventBus._emit('BOOK_UPDATED', {
        type: 'BOOK_UPDATED',
        instrumentId,
        topOfBook: makeTopOfBook(),
        marketId: 'market-1',
        sequenceNumber: 1,
        timestamp: { toNumber: () => tsMs },
      });
    }

    it('getTopOfBookState возвращает undefined без данных', () => {
      store.start();
      expect(store.getTopOfBookState(INSTRUMENT_1, 1000, 2000)).toBeUndefined();
    });

    it('getTopOfBookState считает ageMs и stale от nowMs', () => {
      store.start();
      const eventBus = deps.eventBus as any;
      emitBook(eventBus, INSTRUMENT_1, 1000);

      const fresh = store.getTopOfBookState(INSTRUMENT_1, 1500, 2000);
      expect(fresh).toBeDefined();
      expect(fresh!.eventTsMs).toBe(1000);
      expect(fresh!.ageMs).toBe(500);
      expect(fresh!.stale).toBe(false);

      const stale = store.getTopOfBookState(INSTRUMENT_1, 5000, 2000);
      expect(stale!.ageMs).toBe(4000);
      expect(stale!.stale).toBe(true);
    });

    it('areBooksSynchronized: true при малом разрыве, false при большом/отсутствии', () => {
      store.start();
      const eventBus = deps.eventBus as any;
      emitBook(eventBus, INSTRUMENT_1, 1000);
      emitBook(eventBus, INSTRUMENT_2, 1080);

      expect(store.areBooksSynchronized(INSTRUMENT_1, INSTRUMENT_2, 100)).toBe(true);
      expect(store.areBooksSynchronized(INSTRUMENT_1, INSTRUMENT_2, 50)).toBe(false);
      expect(store.areBooksSynchronized(INSTRUMENT_1, 'token-x' as any, 100)).toBe(false);
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
