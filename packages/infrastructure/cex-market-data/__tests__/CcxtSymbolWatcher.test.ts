import { describe, it, expect, jest } from '@jest/globals';
import type { ILogger } from '@polymarket/logger';
import { CcxtSymbolWatcher } from '../src/CcxtSymbolWatcher.js';
import type { CexRawRecord } from '../src/CexTypes.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeLogger(): ILogger {
  const logger = {
    trace: jest.fn() as ILogger['trace'],
    debug: jest.fn() as ILogger['debug'],
    info: jest.fn() as ILogger['info'],
    warn: jest.fn() as ILogger['warn'],
    error: jest.fn() as ILogger['error'],
    fatal: jest.fn() as ILogger['fatal'],
    child: jest.fn() as unknown as ILogger['child'],
  };
  logger.child = jest.fn(() => logger) as unknown as ILogger['child'];
  return logger;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error('Timed out waiting for condition');
}

describe('CcxtSymbolWatcher supervision', () => {
  it('keeps trades running when the orderbook stream fails', async () => {
    const logger = makeLogger();
    const records: CexRawRecord[] = [];
    const firstTrades = deferred<unknown[]>();
    const secondTrades = deferred<unknown[]>();

    const obInstance = {
      has: { watchOrderBook: true },
      trades: { 'BTC/USD': [] },
      watchOrderBook: jest.fn(async () => {
        throw new Error('ob failed');
      }),
      close: jest.fn(async () => undefined),
    };

    let tradeWatchCalls = 0;
    const tradesInstance = {
      trades: { 'BTC/USD': [] },
      watchTrades: jest.fn(() => {
        tradeWatchCalls++;
        return tradeWatchCalls === 1 ? firstTrades.promise : secondTrades.promise;
      }),
      close: jest.fn(async () => undefined),
    };

    const instances = [obInstance, tradesInstance];
    const watcher = new CcxtSymbolWatcher({
      exchangeId: 'okx',
      exchangeType: 'spot',
      symbol: 'BTC/USD',
      depth: 10,
      watchOrderbook: true,
      watchTrades: true,
      restartIntervalMs: 60_000,
      onRecord: (record) => records.push(record),
      logger,
      exchangeFactory: () => {
        const instance = instances.shift();
        if (!instance) throw new Error('Unexpected exchange instance request');
        return instance;
      },
    });

    watcher.start();

    await waitUntil(() => obInstance.close.mock.calls.length > 0);
    expect(tradesInstance.close).not.toHaveBeenCalled();
    expect(tradesInstance.watchTrades).toHaveBeenCalledTimes(1);

    firstTrades.resolve([{ timestamp: 1, price: 100, amount: 0.5, side: 'buy' }]);
    await waitUntil(() => records.some((record) => record.t === 'trade'));
    await waitUntil(() => tradesInstance.watchTrades.mock.calls.length >= 2);

    expect(tradesInstance.close).not.toHaveBeenCalled();
    expect(records).toContainEqual({
      t: 'trade',
      ts: 1,
      p: 100,
      sz: 0.5,
      side: 'buy',
    });

    await watcher.stop();
    expect(tradesInstance.close).toHaveBeenCalled();
  });

  it('does not emit unhandled rejections for late watch rejections after stop', async () => {
    const logger = makeLogger();
    const lateOrderbook = deferred<unknown>();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };

    const obInstance = {
      has: { watchOrderBook: true },
      trades: { 'BTC/USD': [] },
      watchOrderBook: jest.fn(() => lateOrderbook.promise),
      close: jest.fn(async () => undefined),
    };

    const watcher = new CcxtSymbolWatcher({
      exchangeId: 'okx',
      exchangeType: 'spot',
      symbol: 'BTC/USD',
      depth: 10,
      watchOrderbook: true,
      watchTrades: false,
      restartIntervalMs: 60_000,
      onRecord: jest.fn(),
      logger,
      exchangeFactory: () => obInstance,
    });

    process.on('unhandledRejection', onUnhandled);
    try {
      watcher.start();
      await waitUntil(() => obInstance.watchOrderBook.mock.calls.length > 0);

      const stopPromise = watcher.stop();
      lateOrderbook.reject(new Error('late rejection'));
      await stopPromise;
      await sleep(20);

      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
