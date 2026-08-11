import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Ok } from '@polymarket/result';
import { BookUpdateHandler } from '../src/BookUpdateHandler.js';
import type { IBookRegistry } from '../src/IBookRegistry.js';
import type { IEventBus } from '@polymarket/event-bus';
import type { IMarketCatalog } from '@polymarket/ports';
import type { ILogger } from '@polymarket/logger';
import { Orderbook, OrderbookLevel } from '@polymarket/orderbook';
import { Price, Quantity, TimestampService, PriceService } from '@polymarket/value-objects';
import type { Money, Timestamp } from '@polymarket/value-objects';
import Decimal from 'decimal.js';
import type { InstrumentId, MarketId } from '@polymarket/ids';
import type { InstrumentInfo } from '@polymarket/ports';

/** Создаёт Timestamp VO из миллисекунд (бросает если невалидный) */
function makeTimestamp(ms: number): Timestamp {
  const result = TimestampService.create(ms);
  if (!result.ok) throw new Error(`Invalid timestamp: ${ms}`);
  return result.value;
}

/** Создаёт OrderbookLevel из строковых price/quantity (реальные VO, не моки). */
function level(price: string, qty: string): OrderbookLevel {
  return OrderbookLevel.create(Price.of(new Decimal(price)), Quantity.of(new Decimal(qty)));
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

const TOKEN_ID  = 'token-abc'  as unknown as InstrumentId;
const MARKET_ID = 'market-xyz' as unknown as MarketId;

/** Дефолтная InstrumentInfo для большинства тестов */
function makeInstrumentInfo(): InstrumentInfo {
  return {
    instrumentId: TOKEN_ID,
    marketId:     MARKET_ID,
    tickSize:     {} as Price,
    minOrderSize:  {} as Quantity,
    minOrderValue: {} as Money,
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

  beforeEach(() => {
    books = {
      get: jest.fn<IBookRegistry['get']>().mockReturnValue(undefined),
      getOrCreate: jest.fn<IBookRegistry['getOrCreate']>().mockReturnValue(
        Orderbook.empty(MARKET_ID as unknown as InstrumentId, TOKEN_ID),
      ),
      set: jest.fn<IBookRegistry['set']>(),
      delete: jest.fn<IBookRegistry['delete']>(),
      deleteMarket: jest.fn<IBookRegistry['deleteMarket']>(),
    };
    eventBus = {
      publish: jest.fn<IEventBus['publish']>().mockResolvedValue(Ok(undefined)),
      publishAll: jest.fn<IEventBus['publishAll']>().mockResolvedValue(Ok(undefined)),
      publishOrThrow: jest.fn<IEventBus['publishOrThrow']>().mockResolvedValue(undefined),
      publishAllOrThrow: jest.fn<IEventBus['publishAllOrThrow']>().mockResolvedValue(undefined),
      subscribe: jest.fn() as IEventBus['subscribe'],
    };
    catalog = {
      get: jest.fn<IMarketCatalog['get']>().mockReturnValue(makeInstrumentInfo()),
      getAll: jest.fn<IMarketCatalog['getAll']>().mockReturnValue([]),
      getByMarketId: jest.fn<IMarketCatalog['getByMarketId']>().mockReturnValue(undefined),
      getAnyInstrumentByMarketIdForMetadataOnly: jest.fn<IMarketCatalog['getAnyInstrumentByMarketIdForMetadataOnly']>().mockReturnValue(undefined),
      getAllByMarketId: jest.fn<IMarketCatalog['getAllByMarketId']>().mockReturnValue([]),
      register: jest.fn<IMarketCatalog['register']>(),
      registerMarket: jest.fn<IMarketCatalog['registerMarket']>(),
      removeMarket: jest.fn<IMarketCatalog['removeMarket']>(),
      remove: jest.fn<IMarketCatalog['remove']>(),
      clear: jest.fn<IMarketCatalog['clear']>(),
    };
    logger = makeLogger();
    handler = new BookUpdateHandler(books, eventBus, catalog, logger);
  });

  it('строит Orderbook из снапшота, кладёт в реестр и публикует BOOK_UPDATED и BOOK_DEPTH', async () => {
    const ts = makeTimestamp(1000);
    await handler.handleSnapshot(TOKEN_ID, [], [], ts);

    expect(books.set).toHaveBeenCalledWith(MARKET_ID, TOKEN_ID, expect.any(Orderbook));
    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'BOOK_UPDATED' }),
    );
    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'BOOK_DEPTH', timestamp: ts }),
    );
  });

  it('использует marketId из каталога для set() и BOOK_UPDATED', async () => {
    await handler.handleSnapshot(TOKEN_ID, [], [], makeTimestamp(1000));

    expect(books.set).toHaveBeenCalledWith(MARKET_ID, TOKEN_ID, expect.any(Orderbook));
    const published = (eventBus.publish as ReturnType<typeof jest.fn>).mock.calls[0]?.[0];
    expect(published).toMatchObject({ type: 'BOOK_UPDATED', marketId: MARKET_ID });
  });

  it('пропускает снапшот и логирует debug если инструмент не найден в каталоге', async () => {
    // warn → debug понижен намеренно (см. историю BookUpdateHandler.ts) — отсутствие
    // инструмента в каталоге при старте/ретрансляции не редкость и не заслуживает warn.
    (catalog.get as ReturnType<typeof jest.fn>).mockReturnValue(undefined);

    await handler.handleSnapshot(TOKEN_ID, [], [], makeTimestamp(1000));

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('unregistered instrument'),
      expect.any(Object),
    );
    expect(books.set).not.toHaveBeenCalled();
    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  it('логирует debug при stale снапшоте, но всё равно применяет', async () => {
    // warn → debug понижен намеренно — stale-снапшоты при reconnect/replay штатны.
    await handler.handleSnapshot(TOKEN_ID, [], [], makeTimestamp(2000));
    await handler.handleSnapshot(TOKEN_ID, [], [], makeTimestamp(1000)); // stale: 1000 <= 2000

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('Stale'),
      expect.any(Object),
    );
    // Второй снапшот всё равно применён (положен в реестр)
    expect(books.set).toHaveBeenCalledTimes(2);
  });

  it('логирует debug при равном timestamp (stale: equal не строго больше)', async () => {
    await handler.handleSnapshot(TOKEN_ID, [], [], makeTimestamp(1000));
    await handler.handleSnapshot(TOKEN_ID, [], [], makeTimestamp(1000)); // equal — тоже stale

    const staleDebugCalls = (logger.debug as ReturnType<typeof jest.fn>).mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.includes('Stale'),
    );
    expect(staleDebugCalls).toHaveLength(1);
  });

  it('не логирует warn для первого снапшота', async () => {
    await handler.handleSnapshot(TOKEN_ID, [], [], makeTimestamp(1000));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('передаёт bids/asks в построенный Orderbook', async () => {
    const bid = level('0.40', '10');
    const ask = level('0.60', '20');
    const ts = makeTimestamp(1000);

    await handler.handleSnapshot(TOKEN_ID, [bid], [ask], ts);

    const [, , book] = (books.set as ReturnType<typeof jest.fn>).mock.calls[0] as [MarketId, InstrumentId, Orderbook];
    expect(book.bids).toEqual([bid]);
    expect(book.asks).toEqual([ask]);
  });

  it('публикует topOfBook из реальных лучших уровней', async () => {
    const bestBid = level('0.40', '10');
    const bestAsk = level('0.60', '20');

    await handler.handleSnapshot(TOKEN_ID, [bestBid], [bestAsk], makeTimestamp(1000));

    const event = (eventBus.publish as ReturnType<typeof jest.fn>).mock.calls[0]?.[0] as {
      topOfBook: { bestBid: Price | undefined; bestAsk: Price | undefined };
    };
    expect(event.topOfBook.bestBid?.equals(bestBid.price)).toBe(true);
    expect(event.topOfBook.bestAsk?.equals(bestAsk.price)).toBe(true);
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

  it('topOfBook.spread содержит Price если спред положительный и PriceService.create успешен', async () => {
    const bid = level('0.40', '10');
    const ask = level('0.60', '20');

    await handler.handleSnapshot(TOKEN_ID, [bid], [ask], makeTimestamp(1000));

    const event = (eventBus.publish as ReturnType<typeof jest.fn>).mock.calls[0]?.[0] as
      { topOfBook: { spread: Price | undefined } };
    expect(event.topOfBook.spread).toBeDefined();
  });

  it('topOfBook.spread undefined если книга однобокая (getSpread() возвращает Err)', async () => {
    const bid = level('0.40', '10');

    await handler.handleSnapshot(TOKEN_ID, [bid], [], makeTimestamp(1000));

    const event = (eventBus.publish as ReturnType<typeof jest.fn>).mock.calls[0]?.[0] as
      { topOfBook: { spread: Price | undefined } };
    expect(event.topOfBook.spread).toBeUndefined();
  });

  it('topOfBook.spread undefined если PriceService.create() возвращает Err', async () => {
    const bid = level('0.40', '10');
    const ask = level('0.60', '20');

    const spy = jest.spyOn(PriceService, 'create').mockReturnValueOnce(
      { ok: false, error: new Error('mock price error') } as ReturnType<typeof PriceService.create>,
    );

    await handler.handleSnapshot(TOKEN_ID, [bid], [ask], makeTimestamp(1000));

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
