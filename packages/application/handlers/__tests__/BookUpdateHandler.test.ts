import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { BookUpdateHandler } from '../src/BookUpdateHandler.js';
import type { IBookRegistry } from '../src/IBookRegistry.js';
import type { IEventBus } from '@polymarket/event-bus';
import type { IMarketCatalog } from '@polymarket/ports';
import type { ILogger } from '@polymarket/logger';
import type { OrderBook, PriceLevel } from '@polymarket/order-book';
import { TimestampService, PriceService } from '@polymarket/value-objects';
import type { Price, Quantity, Timestamp } from '@polymarket/value-objects';
import Decimal from 'decimal.js';
import type { InstrumentId, MarketId } from '@polymarket/ids';
import type { InstrumentInfo } from '@polymarket/ports';

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

const TOKEN_ID  = 'token-abc'  as unknown as InstrumentId;
const MARKET_ID = 'market-xyz' as unknown as MarketId;

/** Дефолтная InstrumentInfo для большинства тестов */
function makeInstrumentInfo(): InstrumentInfo {
  return {
    instrumentId: TOKEN_ID,
    marketId:     MARKET_ID,
    tickSize:     {} as Price,
    minOrderSize:  {} as Quantity,
    minOrderValue: {} as Quantity,
    active:        true,
    expiresAt:     {} as Timestamp,
  };
}

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
      deleteMarket: jest.fn<IBookRegistry['deleteMarket']>(),
    };
    eventBus = {
      publish: jest.fn<IEventBus['publish']>().mockResolvedValue(undefined),
      publishAll: jest.fn<IEventBus['publishAll']>().mockResolvedValue(undefined),
      subscribe: jest.fn() as IEventBus['subscribe'],
    };
    catalog = {
      get: jest.fn<IMarketCatalog['get']>().mockReturnValue(makeInstrumentInfo()),
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

  it('использует marketId из каталога для getOrCreate и BOOK_UPDATED', async () => {
    await handler.handleSnapshot(TOKEN_ID, [], [], makeTimestamp(1000));

    expect(books.getOrCreate).toHaveBeenCalledWith(MARKET_ID, TOKEN_ID);
    const published = (eventBus.publish as ReturnType<typeof jest.fn>).mock.calls[0]?.[0];
    expect(published).toMatchObject({ type: 'BOOK_UPDATED', marketId: MARKET_ID });
  });

  it('пропускает снапшот и логирует warn если инструмент не найден в каталоге', async () => {
    (catalog.get as ReturnType<typeof jest.fn>).mockReturnValue(undefined);

    await handler.handleSnapshot(TOKEN_ID, [], [], makeTimestamp(1000));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('unregistered instrument'),
      expect.any(Object),
    );
    expect(books.getOrCreate).not.toHaveBeenCalled();
    expect(eventBus.publish).not.toHaveBeenCalled();
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

  // ── Spread calculation ─────────────────────────────────────────────────────

  it('topOfBook.spread содержит Price если getSpread() > 0 и PriceService.create успешен', async () => {
    const bid: PriceLevel = { price: {} as Price, size: {} as Quantity };
    const ask: PriceLevel = { price: {} as Price, size: {} as Quantity };
    (mockBook.getBestBid as ReturnType<typeof jest.fn>).mockReturnValue(bid);
    (mockBook.getBestAsk as ReturnType<typeof jest.fn>).mockReturnValue(ask);
    (mockBook.getSpread as ReturnType<typeof jest.fn>).mockReturnValue(new Decimal('0.05'));

    await handler.handleSnapshot(TOKEN_ID, [], [], makeTimestamp(1000));

    const event = (eventBus.publish as ReturnType<typeof jest.fn>).mock.calls[0]?.[0] as
      { topOfBook: { spread: Price | undefined } };
    expect(event.topOfBook.spread).toBeDefined();
  });

  it('topOfBook.spread undefined если getSpread() === 0', async () => {
    const bid: PriceLevel = { price: {} as Price, size: {} as Quantity };
    const ask: PriceLevel = { price: {} as Price, size: {} as Quantity };
    (mockBook.getBestBid as ReturnType<typeof jest.fn>).mockReturnValue(bid);
    (mockBook.getBestAsk as ReturnType<typeof jest.fn>).mockReturnValue(ask);
    (mockBook.getSpread as ReturnType<typeof jest.fn>).mockReturnValue(new Decimal('0'));

    await handler.handleSnapshot(TOKEN_ID, [], [], makeTimestamp(1000));

    const event = (eventBus.publish as ReturnType<typeof jest.fn>).mock.calls[0]?.[0] as
      { topOfBook: { spread: Price | undefined } };
    expect(event.topOfBook.spread).toBeUndefined();
  });

  it('topOfBook.spread undefined если PriceService.create() возвращает Err', async () => {
    const bid: PriceLevel = { price: {} as Price, size: {} as Quantity };
    const ask: PriceLevel = { price: {} as Price, size: {} as Quantity };
    (mockBook.getBestBid as ReturnType<typeof jest.fn>).mockReturnValue(bid);
    (mockBook.getBestAsk as ReturnType<typeof jest.fn>).mockReturnValue(ask);
    (mockBook.getSpread as ReturnType<typeof jest.fn>).mockReturnValue(new Decimal('0.05'));

    const spy = jest.spyOn(PriceService, 'create').mockReturnValueOnce(
      { ok: false, error: new Error('mock price error') } as ReturnType<typeof PriceService.create>,
    );

    await handler.handleSnapshot(TOKEN_ID, [], [], makeTimestamp(1000));

    const event = (eventBus.publish as ReturnType<typeof jest.fn>).mock.calls[0]?.[0] as
      { topOfBook: { spread: Price | undefined } };
    expect(event.topOfBook.spread).toBeUndefined();
    spy.mockRestore();
  });

  // ── onMarketClosed ─────────────────────────────────────────────────────────

  it('onMarketClosed очищает timestamps и вызывает deleteMarket для известного marketId', async () => {
    // Зарегистрировать инструмент через снапшот (заполняет _marketToTokens и _lastTimestamps)
    await handler.handleSnapshot(TOKEN_ID, [], [], makeTimestamp(2000));

    handler.onMarketClosed(MARKET_ID);

    expect(books.deleteMarket).toHaveBeenCalledWith(MARKET_ID);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('cleaned up'),
      expect.objectContaining({ marketId: String(MARKET_ID) }),
    );

    // После очистки следующий снапшот с меньшим ts не должен считаться stale
    await handler.handleSnapshot(TOKEN_ID, [], [], makeTimestamp(500));
    // warn не вызывался (warn mocked в beforeEach, проверяем что не было вызова)
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('onMarketClosed не делает ничего если marketId неизвестен', () => {
    const unknownId = 'no-such-market' as unknown as typeof MARKET_ID;

    handler.onMarketClosed(unknownId);

    expect(books.deleteMarket).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });
});
