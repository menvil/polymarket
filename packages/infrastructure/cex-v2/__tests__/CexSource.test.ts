/**
 * Тесты CexSource: payload contract, transport modes, restart isolation,
 * shutdown, pipeline failure (матрица N-005 PART 23).
 */
import { describe, it, expect } from '@jest/globals';
import { MessageMetadataGenerator } from '@polymarket/messages';
import { MessageBusClosedError } from '@polymarket/message-bus';
import { LiveClock } from '@polymarket/time';
import type { CcxtRawOrderBook, CcxtRawTrade, CexSourceConfig } from '../src/index.js';
import { CexSource } from '../src/index.js';
import {
  CapturingLogger,
  CapturingPublisher,
  FakeExchangeFactory,
  type FakeExchangeCapabilities,
  type FakeExchangeInstance,
  sleep,
  waitUntil,
} from './helpers/fakes.js';

const SYMBOL = 'BTC/USDT:USDT';
const SYMBOL_B = 'ETH/USDT:USDT';

/** Базовая конфигурация с быстрыми таймингами для тестов. */
function baseConfig(overrides: Partial<CexSourceConfig> = {}): CexSourceConfig {
  return {
    exchangeId: 'testex',
    marketType: 'swap',
    symbols: [SYMBOL],
    watchOrderbook: true,
    watchTrades: false,
    orderbookDepth: 10,
    initialBackoffMs: 5,
    maxBackoffMs: 20,
    ...overrides,
  };
}

interface Harness {
  readonly source: CexSource;
  readonly factory: FakeExchangeFactory;
  readonly publisher: CapturingPublisher;
  readonly logger: CapturingLogger;
}

function makeHarness(
  config: CexSourceConfig,
  capabilities: FakeExchangeCapabilities,
): Harness {
  const factory = new FakeExchangeFactory(capabilities);
  const publisher = new CapturingPublisher();
  const logger = new CapturingLogger();
  const source = new CexSource({
    config,
    bus: publisher,
    metadataGenerator: new MessageMetadataGenerator({ clock: new LiveClock() }),
    logger,
    exchangeFactory: factory.create,
    random: () => 0.5, // jitter = 0: детерминированные интервалы
  });
  return { source, factory, publisher, logger };
}

function makeRawOb(overrides: Record<string, unknown> = {}): CcxtRawOrderBook {
  return {
    symbol: SYMBOL,
    timestamp: 1_756_000_000_000,
    datetime: '2026-08-24T00:00:00.000Z',
    nonce: 42,
    bids: [
      [100, 1],
      [99.5, 2],
      [99, 3],
    ],
    asks: [
      [100.5, 1],
      [101, 2],
      [101.5, 3],
    ],
    ...overrides,
  } as CcxtRawOrderBook;
}

function makeRawTrade(overrides: Record<string, unknown> = {}): CcxtRawTrade {
  return {
    id: 't-1',
    symbol: SYMBOL,
    timestamp: 1_756_000_000_500,
    datetime: '2026-08-24T00:00:00.500Z',
    side: 'buy',
    price: 100.25,
    amount: 0.5,
    cost: 50.125,
    info: { raw: 'vendor-specific' },
    ...overrides,
  } as CcxtRawTrade;
}

const OB_METHODS = new Set(['watchOrderBookForSymbols', 'watchOrderBook', 'fetchOrderBook']);
const TRADES_METHODS = new Set(['watchTradesForSymbols', 'watchTrades']);

/** Инстанс, обслуживающий поток стакана (по факту vendor-вызовов). */
function obInstance(factory: FakeExchangeFactory): FakeExchangeInstance {
  const instance = factory.instances.find((candidate) =>
    candidate.vendorCalls.some((call) => OB_METHODS.has(call.method)),
  );
  if (!instance) throw new Error('No orderbook instance active');
  return instance;
}

/** Инстанс, обслуживающий поток сделок. */
function tradesInstance(factory: FakeExchangeFactory): FakeExchangeInstance {
  const instance = factory.instances.find((candidate) =>
    candidate.vendorCalls.some((call) => TRADES_METHODS.has(call.method)),
  );
  if (!instance) throw new Error('No trades instance active');
  return instance;
}

describe('CexSource: payload contract', () => {
  it('публикует CEX_ORDERBOOK с source-native снапшотом и root-metadata', async () => {
    const { source, factory, publisher } = makeHarness(baseConfig(), {
      watchOrderBookForSymbols: true,
    });
    source.start();
    await waitUntil(() => factory.instances.length === 1 && factory.latest.obMultiplexFeed.hasWaiter);

    factory.latest.obMultiplexFeed.push(makeRawOb());
    await waitUntil(() => publisher.messages.length === 1);

    const message = publisher.ofType('CEX_ORDERBOOK')[0]!;
    expect(message.type).toBe('CEX_ORDERBOOK');
    expect(message.payload.exchangeId).toBe('testex');
    expect(message.payload.marketType).toBe('swap');
    expect(message.payload.symbol).toBe(SYMBOL);
    // Vendor-поля as-is (имена и значения unified-контракта CCXT)
    expect(message.payload.orderBook.symbol).toBe(SYMBOL);
    expect(message.payload.orderBook.timestamp).toBe(1_756_000_000_000);
    expect(message.payload.orderBook.datetime).toBe('2026-08-24T00:00:00.000Z');
    expect(message.payload.orderBook.nonce).toBe(42);
    expect(message.payload.orderBook.bids).toEqual([
      [100, 1],
      [99.5, 2],
      [99, 3],
    ]);
    // Root-metadata: наблюдение начинает новую causal chain
    expect(message.metadata.correlationId).toBe(message.metadata.messageId);
    expect(message.metadata.causationId).toBeUndefined();
    // JSON-сериализуемость снапшота
    expect(() => JSON.stringify(message.payload)).not.toThrow();

    await source.close();
  });

  it('обрезает стороны до эффективной depth, не мутируя vendor-объект', async () => {
    const { source, factory, publisher } = makeHarness(baseConfig({ orderbookDepth: 2 }), {
      watchOrderBookForSymbols: true,
    });
    source.start();
    await waitUntil(() => factory.instances.length === 1 && factory.latest.obMultiplexFeed.hasWaiter);

    const raw = makeRawOb();
    factory.latest.obMultiplexFeed.push(raw);
    await waitUntil(() => publisher.messages.length === 1);

    const { orderBook } = publisher.ofType('CEX_ORDERBOOK')[0]!.payload;
    expect(orderBook.bids).toHaveLength(2);
    expect(orderBook.asks).toHaveLength(2);
    // Vendor-объект не тронут: у него по-прежнему 3 уровня
    expect(raw.bids).toHaveLength(3);
    expect(raw.asks).toHaveLength(3);
    // Depth передана в vendor-вызов
    expect(factory.latest.vendorCalls[0]?.limit).toBe(2);

    await source.close();
  });

  it('опубликованный payload не изменяется при мутации vendor-кэша (9.1)', async () => {
    const { source, factory, publisher } = makeHarness(baseConfig(), {
      watchOrderBookForSymbols: true,
    });
    source.start();
    await waitUntil(() => factory.instances.length === 1 && factory.latest.obMultiplexFeed.hasWaiter);

    const mutable = makeRawOb() as { bids: number[][]; asks: number[][]; nonce: number };
    factory.latest.obMultiplexFeed.push(mutable as unknown as CcxtRawOrderBook);
    await waitUntil(() => publisher.messages.length === 1);

    // CCXT Pro мутирует живой объект кэша после возврата — имитируем
    mutable.bids[0]![0] = 999;
    mutable.asks.length = 0;
    mutable.nonce = 777;

    const { orderBook } = publisher.ofType('CEX_ORDERBOOK')[0]!.payload;
    expect(orderBook.bids?.[0]?.[0]).toBe(100);
    expect(orderBook.asks).toHaveLength(3);
    expect(orderBook.nonce).toBe(42);

    await source.close();
  });

  it('per-symbol режим: routing-символ из подписки, vendor-объект не патчится', async () => {
    const { source, factory, publisher } = makeHarness(baseConfig(), {
      watchOrderBook: true,
    });
    source.start();
    await waitUntil(() => factory.instances.length === 1 && factory.latest.obFeed(SYMBOL).hasWaiter);

    const raw = makeRawOb({ symbol: undefined });
    factory.latest.obFeed(SYMBOL).push(raw);
    await waitUntil(() => publisher.messages.length === 1);

    const message = publisher.ofType('CEX_ORDERBOOK')[0]!;
    expect(message.payload.symbol).toBe(SYMBOL);
    // В отличие от legacy, vendor-объект НЕ мутируется
    expect(raw.symbol).toBeUndefined();
    expect(message.payload.orderBook.symbol).toBeUndefined();

    await source.close();
  });

  it('multiplex-наблюдение без символа пропускается', async () => {
    const { source, factory, publisher } = makeHarness(baseConfig(), {
      watchOrderBookForSymbols: true,
    });
    source.start();
    await waitUntil(() => factory.instances.length === 1 && factory.latest.obMultiplexFeed.hasWaiter);

    factory.latest.obMultiplexFeed.push(makeRawOb({ symbol: undefined }));
    factory.latest.obMultiplexFeed.push(makeRawOb());
    await waitUntil(() => publisher.messages.length === 1);

    expect(publisher.messages).toHaveLength(1);
    expect(publisher.ofType('CEX_ORDERBOOK')[0]!.payload.orderBook.symbol).toBe(SYMBOL);

    await source.close();
  });

  it('пустой стакан пропускается', async () => {
    const { source, factory, publisher } = makeHarness(baseConfig(), {
      watchOrderBookForSymbols: true,
    });
    source.start();
    await waitUntil(() => factory.instances.length === 1 && factory.latest.obMultiplexFeed.hasWaiter);

    factory.latest.obMultiplexFeed.push(makeRawOb({ bids: [] }));
    factory.latest.obMultiplexFeed.push(makeRawOb());
    await waitUntil(() => publisher.messages.length === 1);

    expect(publisher.messages).toHaveLength(1);

    await source.close();
  });

  it('публикует CEX_TRADE на каждую сделку batch-а с root-metadata', async () => {
    const { source, factory, publisher } = makeHarness(
      baseConfig({ watchOrderbook: false, watchTrades: true }),
      { watchTradesForSymbols: true },
    );
    source.start();
    await waitUntil(
      () => factory.instances.length === 1 && factory.latest.tradesMultiplexFeed.hasWaiter,
    );

    factory.latest.tradesMultiplexFeed.push([
      makeRawTrade({ id: 't-1' }),
      makeRawTrade({ id: 't-2', side: 'sell' }),
    ]);
    await waitUntil(() => publisher.messages.length === 2);

    const trades = publisher.ofType('CEX_TRADE');
    expect(trades).toHaveLength(2);
    expect(trades[0]!.payload.trade.id).toBe('t-1');
    expect(trades[0]!.payload.trade.price).toBe(100.25);
    expect(trades[0]!.payload.trade.info).toEqual({ raw: 'vendor-specific' });
    expect(trades[1]!.payload.trade.id).toBe('t-2');
    expect(trades[1]!.payload.trade.side).toBe('sell');
    // Каждая сделка — независимое root-наблюдение
    expect(trades[0]!.metadata.messageId).not.toBe(trades[1]!.metadata.messageId);
    expect(trades[0]!.metadata.correlationId).toBe(trades[0]!.metadata.messageId);
    expect(trades[1]!.metadata.correlationId).toBe(trades[1]!.metadata.messageId);

    await source.close();
  });

  it('не склеивает две легитимные сделки с одинаковыми price/timestamp', async () => {
    const { source, factory, publisher } = makeHarness(
      baseConfig({ watchOrderbook: false, watchTrades: true }),
      { watchTradesForSymbols: true },
    );
    source.start();
    await waitUntil(
      () => factory.instances.length === 1 && factory.latest.tradesMultiplexFeed.hasWaiter,
    );

    // Одинаковые price+timestamp, разные id — обе легитимны
    factory.latest.tradesMultiplexFeed.push([
      makeRawTrade({ id: 'a', price: 100, timestamp: 1_756_000_000_000 }),
      makeRawTrade({ id: 'b', price: 100, timestamp: 1_756_000_000_000 }),
    ]);
    await waitUntil(() => publisher.messages.length === 2);

    expect(publisher.ofType('CEX_TRADE').map((m) => m.payload.trade.id)).toEqual(['a', 'b']);

    await source.close();
  });

  it('каждый batch эмитируется ровно один раз (без повторной эмиссии кэша)', async () => {
    const { source, factory, publisher } = makeHarness(
      baseConfig({ watchOrderbook: false, watchTrades: true }),
      { watchTradesForSymbols: true },
    );
    source.start();
    await waitUntil(
      () => factory.instances.length === 1 && factory.latest.tradesMultiplexFeed.hasWaiter,
    );

    factory.latest.tradesMultiplexFeed.push([makeRawTrade({ id: 't-1' })]);
    await waitUntil(() => publisher.messages.length === 1);
    factory.latest.tradesMultiplexFeed.push([makeRawTrade({ id: 't-2' })]);
    await waitUntil(() => publisher.messages.length === 2);
    await sleep(20);

    // t-1 не переэмитирована при получении t-2
    expect(publisher.ofType('CEX_TRADE').map((m) => m.payload.trade.id)).toEqual(['t-1', 't-2']);

    await source.close();
  });

  it('несериализуемое наблюдение пропускается и УЧИТЫВАЕТСЯ в getStats()', async () => {
    const { source, factory, publisher, logger } = makeHarness(
      baseConfig({ watchTrades: true }),
      { watchOrderBookForSymbols: true, watchTradesForSymbols: true },
    );
    source.start();
    await waitUntil(
      () =>
        factory.instances.length === 2 &&
        factory.instances.some((i) => i.obMultiplexFeed.hasWaiter) &&
        factory.instances.some((i) => i.tradesMultiplexFeed.hasWaiter),
    );

    // Циклическая ссылка → JSON.stringify снапшота бросает
    const circularOb = makeRawOb() as Record<string, unknown>;
    circularOb['self'] = circularOb;
    obInstance(factory).obMultiplexFeed.push(circularOb as unknown as CcxtRawOrderBook);

    const circularTrade = makeRawTrade() as Record<string, unknown>;
    circularTrade['info'] = { parent: circularTrade };
    tradesInstance(factory).tradesMultiplexFeed.push([
      circularTrade as unknown as CcxtRawTrade,
      makeRawTrade({ id: 't-ok' }),
    ]);

    // Потери измеримы, потоки живы: следующее валидное наблюдение публикуется
    await waitUntil(() => source.getStats().orderbookSnapshotFailures === 1);
    await waitUntil(() => source.getStats().tradeSnapshotFailures === 1);
    await waitUntil(() => publisher.ofType('CEX_TRADE').length === 1);
    expect(publisher.ofType('CEX_TRADE')[0]!.payload.trade.id).toBe('t-ok');

    obInstance(factory).obMultiplexFeed.push(makeRawOb());
    await waitUntil(() => publisher.ofType('CEX_ORDERBOOK').length === 1);
    expect(source.getStats()).toEqual({
      orderbookSnapshotFailures: 1,
      tradeSnapshotFailures: 1,
    });
    expect(logger.byLevel('error').filter((e) => e.message.includes('snapshot'))).toHaveLength(2);

    await source.close();
  });

  it('trade без символа в multiplex пропускается, per-symbol получает fallback', async () => {
    const { source, factory, publisher } = makeHarness(
      baseConfig({ watchOrderbook: false, watchTrades: true }),
      { watchTrades: true },
    );
    source.start();
    await waitUntil(
      () => factory.instances.length === 1 && factory.latest.tradesFeed(SYMBOL).hasWaiter,
    );

    const raw = makeRawTrade({ symbol: undefined });
    factory.latest.tradesFeed(SYMBOL).push([raw]);
    await waitUntil(() => publisher.messages.length === 1);

    const message = publisher.ofType('CEX_TRADE')[0]!;
    expect(message.payload.symbol).toBe(SYMBOL);
    expect(message.payload.trade.symbol).toBeUndefined();
    expect(raw.symbol).toBeUndefined();

    await source.close();
  });
});

describe('CexSource: transport modes', () => {
  it('multiplex выбирается при наличии capability', async () => {
    const { source, factory } = makeHarness(
      baseConfig({ symbols: [SYMBOL, SYMBOL_B] }),
      { watchOrderBookForSymbols: true, watchOrderBook: true },
    );
    source.start();
    await waitUntil(() => factory.instances.length === 1 && factory.latest.obMultiplexFeed.hasWaiter);

    expect(factory.latest.vendorCalls[0]?.method).toBe('watchOrderBookForSymbols');
    expect(factory.latest.vendorCalls[0]?.symbols).toEqual([SYMBOL, SYMBOL_B]);

    await source.close();
  });

  it('без multiplex-capability используется watchOrderBook per-symbol (конкурентно)', async () => {
    const { source, factory, publisher } = makeHarness(
      baseConfig({ symbols: [SYMBOL, SYMBOL_B] }),
      { watchOrderBook: true },
    );
    source.start();
    // Петли символов независимы: ОБЕ подписки открыты сразу
    await waitUntil(
      () =>
        factory.instances.length === 1 &&
        factory.latest.obFeed(SYMBOL).hasWaiter &&
        factory.latest.obFeed(SYMBOL_B).hasWaiter,
    );

    factory.latest.obFeed(SYMBOL).push(makeRawOb({ symbol: SYMBOL }));
    factory.latest.obFeed(SYMBOL_B).push(makeRawOb({ symbol: SYMBOL_B }));
    await waitUntil(() => publisher.messages.length === 2);

    const methods = factory.latest.vendorCalls.map((call) => call.method);
    expect(new Set(methods)).toEqual(new Set(['watchOrderBook']));
    const calledSymbols = factory.latest.vendorCalls.map((call) => call.symbols[0]);
    expect(new Set(calledSymbols)).toEqual(new Set([SYMBOL, SYMBOL_B]));
    // Символы не перепутаны между наблюдениями
    expect(new Set(publisher.ofType('CEX_ORDERBOOK').map((m) => m.payload.symbol))).toEqual(
      new Set([SYMBOL, SYMBOL_B]),
    );

    await source.close();
  });

  it('per-symbol: «тихий» символ не блокирует эмиссию остальных (OB)', async () => {
    const { source, factory, publisher } = makeHarness(
      baseConfig({ symbols: [SYMBOL, SYMBOL_B], orderbookStaleTimeoutMs: 2_000 }),
      { watchOrderBook: true },
    );
    source.start();
    await waitUntil(
      () =>
        factory.instances.length === 1 &&
        factory.latest.obFeed(SYMBOL).hasWaiter &&
        factory.latest.obFeed(SYMBOL_B).hasWaiter,
    );

    // SYMBOL_B молчит; SYMBOL эмитирует дважды подряд без ожидания B
    factory.latest.obFeed(SYMBOL).push(makeRawOb({ symbol: SYMBOL, nonce: 1 }));
    await waitUntil(() => publisher.messages.length === 1);
    factory.latest.obFeed(SYMBOL).push(makeRawOb({ symbol: SYMBOL, nonce: 2 }));
    await waitUntil(() => publisher.messages.length === 2);

    expect(publisher.ofType('CEX_ORDERBOOK').map((m) => m.payload.orderBook.nonce)).toEqual([1, 2]);
    // Сессия жива, рестартов не было
    expect(factory.instances).toHaveLength(1);

    await source.close();
  });

  it('per-symbol: stale одного символа рестартует сессию целиком', async () => {
    const { source, factory, logger } = makeHarness(
      baseConfig({ symbols: [SYMBOL, SYMBOL_B], orderbookStaleTimeoutMs: 40 }),
      { watchOrderBook: true },
    );
    source.start();
    await waitUntil(
      () =>
        factory.instances.length === 1 &&
        factory.latest.obFeed(SYMBOL).hasWaiter &&
        factory.latest.obFeed(SYMBOL_B).hasWaiter,
    );

    // Оба символа молчат → stale любого завершает сессию, supervised restart
    await waitUntil(() => factory.instances.length === 2);
    expect(factory.instances[0]!.closeCalls).toBeGreaterThanOrEqual(1);
    expect(
      logger.byLevel('warn').some((entry) => entry.message.includes('session failed')),
    ).toBe(true);

    await source.close();
  });

  it('сконфигурированный fetch-режим использует fetchOrderBook', async () => {
    const { source, factory, publisher } = makeHarness(
      baseConfig({ orderbookMethod: 'fetch', fetchPollIntervalMs: 5 }),
      { watchOrderBookForSymbols: true, watchOrderBook: true, fetchOrderBook: true },
    );
    source.start();
    await waitUntil(() => factory.instances.length === 1 && factory.latest.obFetchFeed.hasWaiter);

    factory.latest.obFetchFeed.push(makeRawOb());
    await waitUntil(() => publisher.messages.length === 1);

    expect(factory.latest.vendorCalls[0]?.method).toBe('fetchOrderBook');
    // WS-методы не вызывались, несмотря на capability
    expect(
      factory.latest.vendorCalls.every((call) => call.method === 'fetchOrderBook'),
    ).toBe(true);

    await source.close();
  });

  it('trades: без multiplex-capability используется watchTrades per-symbol (конкурентно)', async () => {
    const { source, factory, publisher } = makeHarness(
      baseConfig({ watchOrderbook: false, watchTrades: true, symbols: [SYMBOL, SYMBOL_B] }),
      { watchTrades: true },
    );
    source.start();
    await waitUntil(
      () =>
        factory.instances.length === 1 &&
        factory.latest.tradesFeed(SYMBOL).hasWaiter &&
        factory.latest.tradesFeed(SYMBOL_B).hasWaiter,
    );

    factory.latest.tradesFeed(SYMBOL).push([makeRawTrade({ symbol: SYMBOL })]);
    factory.latest.tradesFeed(SYMBOL_B).push([makeRawTrade({ symbol: SYMBOL_B, id: 't-9' })]);
    await waitUntil(() => publisher.messages.length === 2);

    expect(factory.latest.vendorCalls[0]?.method).toBe('watchTrades');
    expect(new Set(publisher.ofType('CEX_TRADE').map((m) => m.payload.symbol))).toEqual(
      new Set([SYMBOL, SYMBOL_B]),
    );

    await source.close();
  });

  it('trades per-symbol: «тихий» символ не блокирует эмиссию остальных', async () => {
    const { source, factory, publisher } = makeHarness(
      baseConfig({
        watchOrderbook: false,
        watchTrades: true,
        symbols: [SYMBOL, SYMBOL_B],
        tradesStaleTimeoutMs: 2_000,
      }),
      { watchTrades: true },
    );
    source.start();
    await waitUntil(
      () =>
        factory.instances.length === 1 &&
        factory.latest.tradesFeed(SYMBOL).hasWaiter &&
        factory.latest.tradesFeed(SYMBOL_B).hasWaiter,
    );

    factory.latest.tradesFeed(SYMBOL).push([makeRawTrade({ id: 't-1' })]);
    await waitUntil(() => publisher.messages.length === 1);
    factory.latest.tradesFeed(SYMBOL).push([makeRawTrade({ id: 't-2' })]);
    await waitUntil(() => publisher.messages.length === 2);

    expect(publisher.ofType('CEX_TRADE').map((m) => m.payload.trade.id)).toEqual(['t-1', 't-2']);
    expect(factory.instances).toHaveLength(1);

    await source.close();
  });

  it('без единой OB-capability поток останавливается PERMANENTLY с понятной ошибкой', async () => {
    const { source, factory, logger } = makeHarness(baseConfig(), {});
    source.start();
    await waitUntil(() =>
      logger
        .byLevel('error')
        .some(
          (entry) =>
            entry.message.includes('failed permanently') &&
            String(entry.context?.['error'] ?? '').includes('supports none of'),
        ),
    );
    await waitUntil(() => !source.isRunning);
    // Никакого retry-loop: одна сессия, один инстанс, закрыт
    expect(factory.instances).toHaveLength(1);
    expect(factory.instances[0]!.closeCalls).toBeGreaterThanOrEqual(1);
    await source.close();
  });

  it('метод существует, но has=false: fetch-fallback НЕ выбирается (permanent stop)', async () => {
    // Реальный контракт CCXT: base-класс определяет fetchOrderBook всегда,
    // has.fetchOrderBook=false означает NotSupported при вызове
    const { source, factory, logger } = makeHarness(baseConfig(), {
      fetchOrderBook: 'unsupported',
    });
    source.start();
    await waitUntil(() =>
      logger.byLevel('error').some((entry) => entry.message.includes('failed permanently')),
    );
    await waitUntil(() => !source.isRunning);
    // Неподдерживаемый метод НЕ вызывался, рестартов нет
    expect(factory.instances).toHaveLength(1);
    expect(factory.latest.vendorCalls).toHaveLength(0);
    await source.close();
  });

  it("явный orderbookMethod='fetch' при has.fetchOrderBook=false → capability error без retry-loop", async () => {
    const { source, factory, logger } = makeHarness(
      baseConfig({ orderbookMethod: 'fetch' }),
      { watchOrderBookForSymbols: true, fetchOrderBook: 'unsupported' },
    );
    source.start();
    await waitUntil(() =>
      logger
        .byLevel('error')
        .some((entry) =>
          String(entry.context?.['error'] ?? '').includes(
            "orderbookMethod 'fetch' is configured but fetchOrderBook is not supported",
          ),
        ),
    );
    await waitUntil(() => !source.isRunning);
    expect(factory.instances).toHaveLength(1);
    // Ни fetch (unsupported), ни multiplex (явный fetch-конфиг) не вызывались
    expect(factory.latest.vendorCalls).toHaveLength(0);
    await source.close();
  });

  it('watchTrades существует, но has=false → trades-поток останавливается permanently', async () => {
    const { source, factory, logger } = makeHarness(
      baseConfig({ watchOrderbook: false, watchTrades: true }),
      { watchTrades: 'unsupported' },
    );
    source.start();
    await waitUntil(() =>
      logger
        .byLevel('error')
        .some((entry) =>
          String(entry.context?.['error'] ?? '').includes('supports neither'),
        ),
    );
    await waitUntil(() => !source.isRunning);
    expect(factory.instances).toHaveLength(1);
    expect(factory.latest.vendorCalls).toHaveLength(0);
    await source.close();
  });

  it("has='emulated' считается поддержкой: REST-fallback используется", async () => {
    const { source, factory, publisher, logger } = makeHarness(
      baseConfig({ fetchPollIntervalMs: 5 }),
      { fetchOrderBook: 'emulated' },
    );
    source.start();
    await waitUntil(() => factory.instances.length === 1 && factory.latest.obFetchFeed.hasWaiter);

    expect(
      logger.byLevel('warn').some((entry) => entry.message.includes('downgrading to REST fetch')),
    ).toBe(true);
    factory.latest.obFetchFeed.push(makeRawOb());
    await waitUntil(() => publisher.messages.length === 1);

    await source.close();
  });

  it('implicit-даунгрейд до REST fetch логируется warn-ом', async () => {
    const { source, factory, publisher, logger } = makeHarness(
      baseConfig({ fetchPollIntervalMs: 5 }),
      { fetchOrderBook: true },
    );
    source.start();
    await waitUntil(() => factory.instances.length === 1 && factory.latest.obFetchFeed.hasWaiter);

    expect(
      logger.byLevel('warn').some((entry) => entry.message.includes('downgrading to REST fetch')),
    ).toBe(true);
    factory.latest.obFetchFeed.push(makeRawOb());
    await waitUntil(() => publisher.messages.length === 1);

    await source.close();
  });

  it('глубина нормализуется по vendor-whitelist (bybit spot 10 → 50)', async () => {
    const { source, factory } = makeHarness(
      baseConfig({ exchangeId: 'bybit', marketType: 'spot', orderbookDepth: 10 }),
      { watchOrderBookForSymbols: true },
    );
    source.start();
    await waitUntil(() => factory.instances.length === 1 && factory.latest.obMultiplexFeed.hasWaiter);

    expect(factory.factoryParams[0]?.depth).toBe(50);
    expect(factory.latest.vendorCalls[0]?.limit).toBe(50);

    await source.close();
  });
});

describe('CexSource: restart isolation', () => {
  it('отказ OB-транспорта рестартует только OB-сессию, trades продолжается', async () => {
    const { source, factory, publisher } = makeHarness(
      baseConfig({ watchTrades: true }),
      { watchOrderBookForSymbols: true, watchTradesForSymbols: true },
    );
    source.start();
    await waitUntil(
      () =>
        factory.instances.length === 2 &&
        factory.instances.some((i) => i.obMultiplexFeed.hasWaiter) &&
        factory.instances.some((i) => i.tradesMultiplexFeed.hasWaiter),
    );

    const obBefore = obInstance(factory);
    const tradesBefore = tradesInstance(factory);

    obBefore.obMultiplexFeed.fail(new Error('ws connection lost'));
    // OB-сессия рестартует: создан третий инстанс
    await waitUntil(() => factory.instances.length === 3);
    await waitUntil(() => factory.instances[2]!.obMultiplexFeed.hasWaiter);

    // Инстанс OB закрыт, инстанс trades жив и работает
    expect(obBefore.closeCalls).toBeGreaterThanOrEqual(1);
    expect(tradesBefore.closeCalls).toBe(0);
    tradesBefore.tradesMultiplexFeed.push([makeRawTrade()]);
    await waitUntil(() => publisher.ofType('CEX_TRADE').length === 1);

    await source.close();
  });

  it('отказ trades-транспорта рестартует только trades, OB продолжается', async () => {
    const { source, factory, publisher } = makeHarness(
      baseConfig({ watchTrades: true }),
      { watchOrderBookForSymbols: true, watchTradesForSymbols: true },
    );
    source.start();
    await waitUntil(
      () =>
        factory.instances.length === 2 &&
        factory.instances.some((i) => i.obMultiplexFeed.hasWaiter) &&
        factory.instances.some((i) => i.tradesMultiplexFeed.hasWaiter),
    );

    const obBefore = obInstance(factory);
    const tradesBefore = tradesInstance(factory);

    tradesBefore.tradesMultiplexFeed.fail(new Error('ws connection lost'));
    await waitUntil(() => factory.instances.length === 3);

    expect(tradesBefore.closeCalls).toBeGreaterThanOrEqual(1);
    expect(obBefore.closeCalls).toBe(0);
    obBefore.obMultiplexFeed.push(makeRawOb());
    await waitUntil(() => publisher.ofType('CEX_ORDERBOOK').length === 1);

    await source.close();
  });

  it('stale-таймаут OB приводит к рестарту сессии', async () => {
    const { source, factory, logger } = makeHarness(
      baseConfig({ orderbookStaleTimeoutMs: 30 }),
      { watchOrderBookForSymbols: true },
    );
    source.start();
    await waitUntil(() => factory.instances.length === 1 && factory.latest.obMultiplexFeed.hasWaiter);

    // Никогда не резолвим watch → stale-таймаут → рестарт с новым инстансом
    await waitUntil(() => factory.instances.length === 2);
    expect(factory.instances[0]!.closeCalls).toBeGreaterThanOrEqual(1);
    expect(
      logger.byLevel('warn').some((entry) => entry.message.includes('session failed')),
    ).toBe(true);

    await source.close();
  });

  it('crossed book → controlled restart OB-сессии', async () => {
    const { source, factory, logger } = makeHarness(baseConfig(), {
      watchOrderBookForSymbols: true,
    });
    source.start();
    await waitUntil(() => factory.instances.length === 1 && factory.latest.obMultiplexFeed.hasWaiter);

    factory.instances[0]!.obMultiplexFeed.push(
      makeRawOb({ bids: [[101, 1]], asks: [[100, 1]] }),
    );
    await waitUntil(() => factory.instances.length === 2);

    expect(
      logger.byLevel('warn').some((entry) => entry.message.includes('Hung orderbook')),
    ).toBe(true);
    expect(factory.instances[0]!.closeCalls).toBeGreaterThanOrEqual(1);

    await source.close();
  });

  it('плановый рестарт заменяет инстанс и продолжает публикацию', async () => {
    const { source, factory, publisher } = makeHarness(
      baseConfig({ restartIntervalMs: 60 }),
      { watchOrderBookForSymbols: true },
    );
    source.start();
    await waitUntil(() => factory.instances.length === 1 && factory.latest.obMultiplexFeed.hasWaiter);

    factory.instances[0]!.obMultiplexFeed.push(makeRawOb());
    await waitUntil(() => publisher.messages.length === 1);

    // После дедлайна следующая итерация завершает сессию (controlled restart)
    await sleep(70);
    factory.instances[0]!.obMultiplexFeed.push(makeRawOb());
    await waitUntil(() => factory.instances.length === 2);
    expect(factory.instances[0]!.closeCalls).toBeGreaterThanOrEqual(1);

    // Новый инстанс продолжает публиковать
    await waitUntil(() => factory.instances[1]!.obMultiplexFeed.hasWaiter);
    factory.instances[1]!.obMultiplexFeed.push(makeRawOb());
    await waitUntil(() => publisher.messages.length >= 3);

    await source.close();
  });
});

describe('CexSource: shutdown', () => {
  it('close абортит pending watch и завершает сессии', async () => {
    const { source, factory } = makeHarness(baseConfig({ watchTrades: true }), {
      watchOrderBookForSymbols: true,
      watchTradesForSymbols: true,
    });
    source.start();
    await waitUntil(
      () =>
        factory.instances.length === 2 &&
        factory.instances.some((i) => i.obMultiplexFeed.hasWaiter) &&
        factory.instances.some((i) => i.tradesMultiplexFeed.hasWaiter),
    );

    await source.close();

    expect(source.isClosed).toBe(true);
    expect(source.isRunning).toBe(false);
    for (const instance of factory.instances) {
      expect(instance.closeCalls).toBeGreaterThanOrEqual(1);
    }
  });

  it('повторный close идемпотентен, инстанс закрывается один раз', async () => {
    const { source, factory } = makeHarness(baseConfig(), { watchOrderBookForSymbols: true });
    source.start();
    await waitUntil(() => factory.instances.length === 1 && factory.latest.obMultiplexFeed.hasWaiter);

    const first = source.close();
    const second = source.close();
    await Promise.all([first, second]);

    // Session once-guard: инстанс закрыт ровно один раз, несмотря на
    // abort-listener + finally + повторный close()
    expect(factory.instances[0]!.closeCalls).toBe(1);
  });

  it('повторный start — no-op (вторые watcher-ы не создаются)', async () => {
    const { source, factory } = makeHarness(baseConfig(), { watchOrderBookForSymbols: true });
    source.start();
    source.start();
    await waitUntil(() => factory.instances.length === 1 && factory.latest.obMultiplexFeed.hasWaiter);
    await sleep(20);

    expect(factory.instances).toHaveLength(1);
    expect(factory.latest.obMultiplexFeed.calls).toBe(1);

    await source.close();
  });

  it('start после close и после failed бросает', async () => {
    const { source } = makeHarness(baseConfig(), { watchOrderBookForSymbols: true });
    await source.close();
    expect(() => source.start()).toThrow('closed');

    const failed = makeHarness(baseConfig(), { watchOrderBookForSymbols: true });
    failed.publisher.failNext(new MessageBusClosedError());
    failed.source.start();
    await waitUntil(
      () => failed.factory.instances.length === 1 && failed.factory.latest.obMultiplexFeed.hasWaiter,
    );
    failed.factory.latest.obMultiplexFeed.push(makeRawOb());
    await waitUntil(() => failed.source.hasFailed);
    await waitUntil(() => !failed.source.isRunning);
    expect(() => failed.source.start()).toThrow('failed');
    await failed.source.close();
  });

  it('после close новых публикаций нет', async () => {
    const { source, factory, publisher } = makeHarness(baseConfig(), {
      watchOrderBookForSymbols: true,
    });
    source.start();
    await waitUntil(() => factory.instances.length === 1 && factory.latest.obMultiplexFeed.hasWaiter);
    await source.close();

    factory.latest.obMultiplexFeed.push(makeRawOb());
    await sleep(30);
    expect(publisher.messages).toHaveLength(0);
  });

  it('close во время backoff завершается быстро', async () => {
    const { source, factory } = makeHarness(
      baseConfig({ initialBackoffMs: 5_000, maxBackoffMs: 5_000 }),
      { watchOrderBookForSymbols: true },
    );
    source.start();
    await waitUntil(() => factory.instances.length === 1 && factory.latest.obMultiplexFeed.hasWaiter);

    factory.latest.obMultiplexFeed.fail(new Error('transport down'));
    await sleep(10); // сессия упала, петля в backoff-паузе

    const closeStart = Date.now();
    await source.close();
    expect(Date.now() - closeStart).toBeLessThan(1_000);
  });
});

describe('CexSource: pipeline failure', () => {
  it('Err от bus.publish → терминальный failed, оба потока остановлены', async () => {
    const { source, factory, publisher, logger } = makeHarness(
      baseConfig({ watchTrades: true }),
      { watchOrderBookForSymbols: true, watchTradesForSymbols: true },
    );
    source.start();
    await waitUntil(
      () =>
        factory.instances.length === 2 &&
        factory.instances.some((i) => i.obMultiplexFeed.hasWaiter) &&
        factory.instances.some((i) => i.tradesMultiplexFeed.hasWaiter),
    );

    publisher.failNext(new MessageBusClosedError());
    obInstance(factory).obMultiplexFeed.push(makeRawOb());

    await waitUntil(() => source.hasFailed);
    await waitUntil(() => !source.isRunning);

    // Отказ наблюдаем: error-лог, оба инстанса закрыты
    expect(
      logger
        .byLevel('error')
        .some((entry) => entry.message.includes('bus rejected publication')),
    ).toBe(true);
    for (const instance of factory.instances) {
      expect(instance.closeCalls).toBeGreaterThanOrEqual(1);
    }

    // Новые наблюдения не публикуются (панель fake-feed уже отклонена,
    // очередь публикаций не растёт)
    const publishedBefore = publisher.messages.length;
    await sleep(30);
    expect(publisher.messages.length).toBe(publishedBefore);

    // Retry поверх failed publish отсутствует: ровно один publish-вызов
    expect(publisher.messages).toHaveLength(1);

    await source.close();
    expect(source.isClosed).toBe(true);
  });
});

describe('CexSource: конфигурация', () => {
  it('невалидная конфигурация отклоняется', () => {
    const factory = new FakeExchangeFactory({ watchOrderBookForSymbols: true });
    const deps = {
      bus: new CapturingPublisher(),
      metadataGenerator: new MessageMetadataGenerator({ clock: new LiveClock() }),
      logger: new CapturingLogger(),
      exchangeFactory: factory.create,
    };

    expect(
      () => new CexSource({ ...deps, config: baseConfig({ symbols: [] }) }),
    ).toThrow('symbols');
    expect(
      () =>
        new CexSource({
          ...deps,
          config: baseConfig({ watchOrderbook: false, watchTrades: false }),
        }),
    ).toThrow('at least one stream');
    expect(
      () => new CexSource({ ...deps, config: baseConfig({ orderbookDepth: 0 }) }),
    ).toThrow('positive integer');
    expect(
      () => new CexSource({ ...deps, config: baseConfig({ exchangeId: '  ' }) }),
    ).toThrow('exchangeId');
  });
});
