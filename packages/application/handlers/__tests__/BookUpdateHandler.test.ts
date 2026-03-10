import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { BookUpdateHandler } from '../src/BookUpdateHandler.js';
import type { IBookRegistry } from '../src/IBookRegistry.js';
import type { IEventBus } from '@polymarket/event-bus';
import type { IMarketCatalog } from '@polymarket/ports';
import type { ILogger } from '@polymarket/logger';
import type { OrderBook, PriceLevel } from '@polymarket/order-book';
import { TimestampService } from '@polymarket/value-objects';
import type { Price, Quantity, Timestamp } from '@polymarket/value-objects';
import type { InstrumentId, MarketId } from '@polymarket/ids';

/** Создаёт Timestamp VO из миллисекунд (бросает если невалидный) */
function makeTimestamp(ms: number): Timestamp {
  const result = TimestampService.create(ms);
  if (!result.ok) throw new Error(`Invalid timestamp: ${ms}`);
  return result.value;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeLogger(): ILogger {
  return {
    trace: jest.fn() as ILogger['trace'],
    debug: jest.fn() as ILogger['debug'],
    info: jest.fn() as ILogger['info'],
    warn: jest.fn() as ILogger['warn'],
    error: jest.fn() as ILogger['error'],
    fatal: jest.fn() as ILogger['fatal'],
    child: jest.fn() as ILogger['child'],
  };
}

function makeOrderBook(): OrderBook {
  return {
    applyFullState: jest.fn() as unknown as OrderBook['applyFullState'],
    getBestBid: jest.fn<() => PriceLevel | undefined>().mockReturnValue(undefined),
    getBestAsk: jest.fn<() => PriceLevel | undefined>().mockReturnValue(undefined),
    applyDelta: jest.fn() as unknown as OrderBook['applyDelta'],
    getSpread: jest.fn() as unknown as OrderBook['getSpread'],
    getMidPrice: jest.fn() as unknown as OrderBook['getMidPrice'],
    getBids: jest.fn() as unknown as OrderBook['getBids'],
    getAsks: jest.fn() as unknown as OrderBook['getAsks'],
    getImbalance: jest.fn() as unknown as OrderBook['getImbalance'],
    isEmpty: jest.fn() as unknown as OrderBook['isEmpty'],
    toSnapshot: jest.fn() as unknown as OrderBook['toSnapshot'],
  } as unknown as OrderBook;
}

const TOKEN_ID = 'token-abc' as unknown as InstrumentId;
const MARKET_ID = 'market-xyz' as unknown as MarketId;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BookUpdateHandler', () => {
  let books: IBookRegistry;
  let eventBus: IEventBus;
  let catalog: IMarketCatalog;
  let logger: ILogger;
  let handler: BookUpdateHandler;
  let mockBook: OrderBook;

  beforeEach(() => {
    mockBook = makeOrderBook();
    books = {
      get: jest.fn<IBookRegistry['get']>().mockReturnValue(undefined),
      getOrCreate: jest.fn<IBookRegistry['getOrCreate']>().mockReturnValue(mockBook),
      delete: jest.fn<IBookRegistry['delete']>(),
    };
    eventBus = {
      publish: jest.fn<IEventBus['publish']>().mockResolvedValue(undefined),
      publishAll: jest.fn<IEventBus['publishAll']>().mockResolvedValue(undefined),
      subscribe: jest.fn() as IEventBus['subscribe'],
    };
    catalog = {
      get: jest.fn<IMarketCatalog['get']>().mockReturnValue(undefined),
      getAll: jest.fn<IMarketCatalog['getAll']>().mockReturnValue([]),
      getByMarketId: jest.fn<IMarketCatalog['getByMarketId']>().mockReturnValue(undefined),
      register: jest.fn<IMarketCatalog['register']>(),
      remove: jest.fn<IMarketCatalog['remove']>(),
      clear: jest.fn<IMarketCatalog['clear']>(),
    };
    logger = makeLogger();
    handler = new BookUpdateHandler(books, eventBus, catalog, logger);
  });

  it('применяет снапшот к OrderBook и публикует BOOK_UPDATED и BOOK_DEPTH', async () => {
    const ts = makeTimestamp(1000);
    await handler.handleSnapshot(TOKEN_ID, [], [], ts);

    expect(mockBook.applyFullState).toHaveBeenCalledWith([], [], ts);
    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'BOOK_UPDATED' }),
    );
    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'BOOK_DEPTH', timestamp: ts }),
    );
  });

  it('использует marketId из каталога если инструмент найден', async () => {
    (catalog.get as ReturnType<typeof jest.fn>).mockReturnValue({
      instrumentId: TOKEN_ID,
      marketId: MARKET_ID,
      tickSize: {} as Price,
      minOrderSize: {} as Quantity,
      active: true,
    });

    await handler.handleSnapshot(TOKEN_ID, [], [], makeTimestamp(1000));

    expect(books.getOrCreate).toHaveBeenCalledWith(MARKET_ID, TOKEN_ID);
    const published = (eventBus.publish as ReturnType<typeof jest.fn>).mock.calls[0]?.[0];
    expect(published).toMatchObject({ type: 'BOOK_UPDATED', marketId: MARKET_ID });
  });

  it('использует tokenId как marketId если инструмент не найден в каталоге', async () => {
    await handler.handleSnapshot(TOKEN_ID, [], [], makeTimestamp(1000));

    const call = (books.getOrCreate as ReturnType<typeof jest.fn>).mock.calls[0];
    // marketId должен совпадать с tokenId (fallback)
    expect(String(call?.[0])).toBe(String(TOKEN_ID));
  });

  it('логирует warn при stale снапшоте, но всё равно применяет', async () => {
    await handler.handleSnapshot(TOKEN_ID, [], [], makeTimestamp(2000));
    await handler.handleSnapshot(TOKEN_ID, [], [], makeTimestamp(1000)); // stale: 1000 <= 2000

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Stale'),
      expect.any(Object),
    );
    // Второй снапшот всё равно применён
    expect(mockBook.applyFullState).toHaveBeenCalledTimes(2);
  });

  it('логирует warn при равном timestamp (stale: equal не строго больше)', async () => {
    await handler.handleSnapshot(TOKEN_ID, [], [], makeTimestamp(1000));
    await handler.handleSnapshot(TOKEN_ID, [], [], makeTimestamp(1000)); // equal — тоже stale

    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('не логирует warn для первого снапшота', async () => {
    await handler.handleSnapshot(TOKEN_ID, [], [], makeTimestamp(1000));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('передаёт bids/asks и timestamp в applyFullState', async () => {
    const bid = { price: {} as Price, size: {} as Quantity };
    const ask = { price: {} as Price, size: {} as Quantity };
    const ts = makeTimestamp(1000);

    await handler.handleSnapshot(TOKEN_ID, [bid], [ask], ts);

    expect(mockBook.applyFullState).toHaveBeenCalledWith([bid], [ask], ts);
  });

  it('публикует topOfBook из getBestBid/getBestAsk', async () => {
    const bestBid: PriceLevel = { price: {} as Price, size: {} as Quantity };
    const bestAsk: PriceLevel = { price: {} as Price, size: {} as Quantity };
    (mockBook.getBestBid as ReturnType<typeof jest.fn>).mockReturnValue(bestBid);
    (mockBook.getBestAsk as ReturnType<typeof jest.fn>).mockReturnValue(bestAsk);

    await handler.handleSnapshot(TOKEN_ID, [], [], makeTimestamp(1000));

    const event = (eventBus.publish as ReturnType<typeof jest.fn>).mock.calls[0]?.[0] as {
      topOfBook: { bestBid: Price; bestAsk: Price };
    };
    expect(event.topOfBook.bestBid).toBe(bestBid.price);
    expect(event.topOfBook.bestAsk).toBe(bestAsk.price);
  });

  it('onReconnect очищает timestamps — следующий снапшот не считается stale', async () => {
    await handler.handleSnapshot(TOKEN_ID, [], [], makeTimestamp(2000));
    handler.onReconnect();
    await handler.handleSnapshot(TOKEN_ID, [], [], makeTimestamp(1000)); // после reconnect — не stale

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('onReconnect логирует info', () => {
    handler.onReconnect();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('reset'),
      expect.any(Object),
    );
  });
});
