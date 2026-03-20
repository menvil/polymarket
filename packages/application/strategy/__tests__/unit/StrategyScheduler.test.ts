import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { Ok, Err } from '@polymarket/result';
import type { AccountId, AssetId, InstrumentId } from '@polymarket/ids';
import type { IStrategy } from '../../src/IStrategy.js';
import type { StrategySnapshot } from '../../src/types/StrategySnapshot.js';
import type { StrategyIntent } from '../../src/types/StrategyIntent.js';
import type { TriggerReason } from '../../src/types/TriggerReason.js';
import { StrategyScheduler } from '../../src/StrategyScheduler.js';
import type { StrategySchedulerDeps, StrategyRegistration, IMarketDataStore } from '../../src/StrategyScheduler.js';
import type { IOrderStateStore } from '@polymarket/ports';

// ── Constants ──────────────────────────────────────────────

const ACCOUNT_ID = 'venue:POLYMARKET:test' as unknown as AccountId;
const INSTRUMENT_ID = 'token-1' as unknown as InstrumentId;
const ASSET_ID = 'asset-1' as unknown as AssetId;

// ── Helpers ────────────────────────────────────────────────

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

function makeClock(nowMs = 1000) {
  let current = nowMs;
  return {
    now: jest.fn(() => new Date(current)) as any,
    advance(ms: number) { current += ms; },
    set(ms: number) { current = ms; },
  };
}

function makeMarketDataStore(): IMarketDataStore & { _onChange?: (id: InstrumentId, reason: TriggerReason) => void } {
  const store: any = {
    _onChange: undefined,
    setOnChange(cb: any) { store._onChange = cb; },
    getTopOfBook: jest.fn().mockReturnValue(undefined),
    getBookHistory: jest.fn().mockReturnValue(undefined),
    getTradeTape: jest.fn().mockReturnValue(undefined),
  };
  return store;
}

const fn = jest.fn as any;

function makeOrderStateStore(): IOrderStateStore {
  return {
    getOpenOrders: fn().mockReturnValue([]),
    getOpenOrdersByInstrument: fn().mockReturnValue([]),
    getOrder: fn().mockReturnValue(undefined),
    saveSync: fn(),
    markMatchedOnExchange: fn(),
    clearMatchedOnExchange: fn(),
    isMatchedOnExchange: fn().mockReturnValue(false),
  };
}

function makeExecutionEngine() {
  return {
    execute: fn().mockResolvedValue({ placed: 0, cancelled: 0, skipped: 0, errors: [] }),
  };
}

function makePortfolioStore() {
  return {
    get: fn().mockReturnValue(undefined),
    save: fn().mockReturnValue(Ok(undefined)),
  };
}

function makeStrategy(id: string, opts: {
  initResult?: 'ok' | 'err';
  tickResult?: StrategyIntent[];
  stopResult?: StrategyIntent[];
} = {}): IStrategy {
  return {
    id,
    name: `Strategy-${id}`,
    initialize: fn().mockResolvedValue(
      opts.initResult === 'err' ? Err(new Error('Init failed')) : Ok(undefined),
    ),
    tick: fn().mockReturnValue(opts.tickResult ?? []),
    stop: fn().mockReturnValue(opts.stopResult ?? [{ type: 'CANCEL_ALL' }]),
    getMetrics: fn().mockReturnValue({ ticks: 0 }),
  } as IStrategy;
}

function makeRegistration(strategy: IStrategy, overrides: Partial<StrategyRegistration> = {}): StrategyRegistration {
  return {
    strategy,
    instrumentId: INSTRUMENT_ID,
    asset: ASSET_ID,
    accountId: ACCOUNT_ID,
    market: {} as any,
    ...overrides,
  };
}

function makeCatalog() {
  return {
    get: fn().mockReturnValue(undefined),
    getByMarketId: fn().mockReturnValue(undefined),
    getAll: fn().mockReturnValue([]),
    register: fn(),
    remove: fn(),
    clear: fn(),
  };
}

function makeDeps(overrides: Partial<StrategySchedulerDeps> = {}) {
  const marketDataStore = makeMarketDataStore();
  const clock = makeClock();
  return {
    deps: {
      marketDataStore,
      orderStateStore: makeOrderStateStore(),
      portfolioStore: makePortfolioStore() as any,
      catalog: makeCatalog() as any,
      executionEngine: makeExecutionEngine() as any,
      clock: clock as any,
      logger: makeLogger() as any,
      ...overrides,
    } as StrategySchedulerDeps,
    marketDataStore,
    clock,
  };
}

/** Ждём microtask queue (Promise.resolve().then() chains) */
async function flush(count = 5) {
  for (let i = 0; i < count; i++) {
    await Promise.resolve();
  }
}

// ── Tests ──────────────────────────────────────────────────

describe('StrategyScheduler', () => {
  let scheduler: StrategyScheduler;
  let marketDataStore: ReturnType<typeof makeMarketDataStore>;
  let clock: ReturnType<typeof makeClock>;
  let deps: StrategySchedulerDeps;

  beforeEach(() => {
    jest.useFakeTimers();
    const d = makeDeps();
    deps = d.deps;
    marketDataStore = d.marketDataStore;
    clock = d.clock;
    scheduler = new StrategyScheduler(deps);
  });

  afterEach(async () => {
    await scheduler.stopAll();
    scheduler.stop();
    jest.useRealTimers();
  });

  // ── register / unregister ────────────────────────────

  describe('register', () => {
    it('should call strategy.initialize() and register', async () => {
      const strategy = makeStrategy('s1');
      const result = await scheduler.register(makeRegistration(strategy));

      expect(result.ok).toBe(true);
      expect(strategy.initialize).toHaveBeenCalled();
      expect(scheduler.getMetrics('s1')).toEqual({ ticks: 0 });
    });

    it('should return Err if initialize() fails', async () => {
      const strategy = makeStrategy('s1', { initResult: 'err' });
      const result = await scheduler.register(makeRegistration(strategy));

      expect(result.ok).toBe(false);
      expect(scheduler.getMetrics('s1')).toBeUndefined();
    });

    it('should return Err if initialize() throws', async () => {
      const strategy = makeStrategy('s1');
      (strategy.initialize as any).mockRejectedValue(new Error('Boom'));

      const result = await scheduler.register(makeRegistration(strategy));

      expect(result.ok).toBe(false);
    });

    it('should skip duplicate registration', async () => {
      const strategy = makeStrategy('s1');
      await scheduler.register(makeRegistration(strategy));
      const result = await scheduler.register(makeRegistration(strategy));

      expect(result.ok).toBe(true);
      expect(strategy.initialize).toHaveBeenCalledTimes(1);
    });
  });

  describe('unregister', () => {
    it('should call strategy.stop() and execute final intents', async () => {
      const strategy = makeStrategy('s1');
      await scheduler.register(makeRegistration(strategy));

      await scheduler.unregister('s1');

      expect(strategy.stop).toHaveBeenCalled();
      expect(deps.executionEngine.execute).toHaveBeenCalledWith(
        expect.objectContaining({ strategyId: 's1' }),
        [{ type: 'CANCEL_ALL' }],
      );
      expect(scheduler.getMetrics('s1')).toBeUndefined();
    });

    it('should be safe for unknown strategy', async () => {
      await expect(scheduler.unregister('unknown')).resolves.toBeUndefined();
    });

    it('should handle strategy.stop() throwing', async () => {
      const strategy = makeStrategy('s1');
      (strategy.stop as any).mockImplementation(() => { throw new Error('Stop boom'); });

      await scheduler.register(makeRegistration(strategy));
      await expect(scheduler.unregister('s1')).resolves.toBeUndefined();
      expect(scheduler.getMetrics('s1')).toBeUndefined();
    });
  });

  // ── Dirty routing → tick ─────────────────────────────

  describe('event-driven tick', () => {
    it('should tick strategy when market data changes', async () => {
      const strategy = makeStrategy('s1', { tickResult: [{ type: 'CANCEL_ALL' }] });
      await scheduler.register(makeRegistration(strategy));
      scheduler.start();

      // Simulate market data change
      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');

      await flush();

      expect(strategy.tick).toHaveBeenCalledWith(
        expect.objectContaining({ instrumentId: INSTRUMENT_ID }),
        expect.any(Set),
      );
    });

    it('should not tick when scheduler is stopped', async () => {
      const strategy = makeStrategy('s1');
      await scheduler.register(makeRegistration(strategy));
      // NOT calling scheduler.start()

      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();

      expect(strategy.tick).not.toHaveBeenCalled();
    });

    it('should not tick strategy for different instrument', async () => {
      const strategy = makeStrategy('s1');
      await scheduler.register(makeRegistration(strategy));
      scheduler.start();

      const otherInstrument = 'token-other' as unknown as InstrumentId;
      marketDataStore._onChange!(otherInstrument, 'BOOK');
      await flush();

      expect(strategy.tick).not.toHaveBeenCalled();
    });

    it('should pass accumulated reasons to tick', async () => {
      const strategy = makeStrategy('s1');
      await scheduler.register(makeRegistration(strategy));
      scheduler.start();

      // Multiple reasons before processing
      scheduler.onOrderChanged('s1', 'FILL');
      scheduler.onOrderChanged('s1', 'ORDER_UPDATE');

      await flush();

      const reasons = (strategy.tick as any).mock.calls[0][1] as ReadonlySet<TriggerReason>;
      expect(reasons.has('FILL')).toBe(true);
      expect(reasons.has('ORDER_UPDATE')).toBe(true);
    });
  });

  // ── Throttle ─────────────────────────────────────────

  describe('throttle', () => {
    it('should defer tick when within minIntervalMs', async () => {
      const strategy = makeStrategy('s1');
      await scheduler.register(makeRegistration(strategy, { config: { minIntervalMs: 100 } }));
      scheduler.start();

      // First tick
      clock.set(1000);
      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();
      expect(strategy.tick).toHaveBeenCalledTimes(1);

      // Second event within 100ms
      clock.set(1050); // only 50ms passed
      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();

      // Should NOT have ticked again (throttled)
      expect(strategy.tick).toHaveBeenCalledTimes(1);

      // After deferred timer fires (remaining ~50ms)
      clock.set(1100);
      jest.advanceTimersByTime(50);
      await flush();

      expect(strategy.tick).toHaveBeenCalledTimes(2);
    });
  });

  // ── Priority trigger ─────────────────────────────────

  describe('priority trigger', () => {
    it('should bypass throttle for FILL', async () => {
      const strategy = makeStrategy('s1');
      await scheduler.register(makeRegistration(strategy, {
        config: { minIntervalMs: 100, priorityTriggers: new Set(['FILL']) },
      }));
      scheduler.start();

      // First tick
      clock.set(1000);
      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();
      expect(strategy.tick).toHaveBeenCalledTimes(1);

      // FILL within throttle window — should bypass
      clock.set(1010); // only 10ms passed
      scheduler.onOrderChanged('s1', 'FILL');
      await flush();

      expect(strategy.tick).toHaveBeenCalledTimes(2);
    });
  });

  // ── Heartbeat ────────────────────────────────────────

  describe('heartbeat', () => {
    it('should tick with TIMER reason after maxIdleMs', async () => {
      const strategy = makeStrategy('s1');
      await scheduler.register(makeRegistration(strategy, {
        config: { maxIdleMs: 200 },
      }));
      scheduler.start();

      // Advance past maxIdleMs
      jest.advanceTimersByTime(200);
      await flush();

      const tickCalls = (strategy.tick as any).mock.calls;
      expect(tickCalls.length).toBeGreaterThanOrEqual(1);
      const reasons = tickCalls[0][1] as ReadonlySet<TriggerReason>;
      expect(reasons.has('TIMER')).toBe(true);
    });
  });

  // ── Coalescing ───────────────────────────────────────

  describe('coalescing', () => {
    it('should set rerunRequested when event arrives during execution', async () => {
      jest.useRealTimers();

      const localClock = makeClock();
      const localDeps = { ...deps, clock: localClock as any };
      const localScheduler = new StrategyScheduler(localDeps);
      const localStore = localDeps.marketDataStore as ReturnType<typeof makeMarketDataStore>;

      const tickResults: number[] = [];

      const strategy = makeStrategy('s1');
      (strategy.tick as any).mockImplementation(() => {
        tickResults.push(Date.now());
        return [{ type: 'CANCEL_ALL' }];
      });

      // First call: controlled execution. Subsequent calls: immediate resolve.
      let resolveExec: (() => void) | undefined;
      let callCount = 0;
      (localDeps.executionEngine as any).execute.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return new Promise((resolve) => {
            resolveExec = () => resolve({ placed: 0, cancelled: 0, skipped: 0, errors: [] });
          });
        }
        return Promise.resolve({ placed: 0, cancelled: 0, skipped: 0, errors: [] });
      });

      await localScheduler.register(makeRegistration(strategy));
      localScheduler.start();

      // Event 1 → tick + start execution
      localStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await new Promise<void>((r) => setTimeout(r, 20));
      expect(tickResults.length).toBe(1);

      // Event 2 while executing → coalescing
      localStore._onChange!(INSTRUMENT_ID, 'TRADE');
      await new Promise<void>((r) => setTimeout(r, 20));
      expect(tickResults.length).toBe(1); // NOT 2 — coalesced

      // Finish first execution → rerun with fresh data
      localClock.advance(100); // Past throttle window
      resolveExec!();
      await new Promise<void>((r) => setTimeout(r, 50));
      expect(tickResults.length).toBe(2); // Rerun happened

      localScheduler.stop();
      jest.useFakeTimers();
    });

    it('should coalesce multiple events during execution into single rerun', async () => {
      jest.useRealTimers();

      const localClock = makeClock();
      const localDeps = { ...deps, clock: localClock as any };
      const localScheduler = new StrategyScheduler(localDeps);
      const localStore = localDeps.marketDataStore as ReturnType<typeof makeMarketDataStore>;

      let tickCount = 0;
      let callCount = 0;
      let resolveExec: (() => void) | undefined;

      const strategy = makeStrategy('s1');
      (strategy.tick as any).mockImplementation(() => {
        tickCount++;
        return [{ type: 'CANCEL_ALL' }];
      });

      (localDeps.executionEngine as any).execute.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return new Promise((resolve: any) => {
            resolveExec = () => resolve({ placed: 0, cancelled: 0, skipped: 0, errors: [] });
          });
        }
        return Promise.resolve({ placed: 0, cancelled: 0, skipped: 0, errors: [] });
      });

      await localScheduler.register(makeRegistration(strategy));
      localScheduler.start();

      // Event 1 → tick
      localStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await new Promise<void>((r) => setTimeout(r, 20));

      // Events 2, 3, 4 while executing → all coalesce into 1 rerun
      localStore._onChange!(INSTRUMENT_ID, 'TRADE');
      localStore._onChange!(INSTRUMENT_ID, 'BOOK');
      localStore._onChange!(INSTRUMENT_ID, 'TRADE');
      await new Promise<void>((r) => setTimeout(r, 20));
      expect(tickCount).toBe(1); // Still 1

      localClock.advance(100);
      resolveExec!();
      await new Promise<void>((r) => setTimeout(r, 50));

      // Exactly 1 rerun (not 3)
      expect(tickCount).toBe(2);

      localScheduler.stop();
      jest.useFakeTimers();
    });
  });

  // ── Snapshot building ────────────────────────────────

  describe('snapshot', () => {
    it('should include all stores data in snapshot', async () => {
      const topOfBook = { bestBid: 0.5, bestAsk: 0.6 } as any;
      const bookHistory = { getLatest: jest.fn() } as any;
      const tradeTape = { getRecent: jest.fn() } as any;
      const openOrders = [{ id: 'o1' }] as any;
      const portfolio = { balance: {} } as any;
      const market = { expiresAt: {} } as any;

      (deps.marketDataStore as any).getTopOfBook.mockReturnValue(topOfBook);
      (deps.marketDataStore as any).getBookHistory.mockReturnValue(bookHistory);
      (deps.marketDataStore as any).getTradeTape.mockReturnValue(tradeTape);
      (deps.orderStateStore as any).getOpenOrdersByInstrument.mockReturnValue(openOrders);
      (deps.portfolioStore as any).get.mockReturnValue(portfolio);

      let capturedSnapshot: StrategySnapshot | undefined;
      const strategy = makeStrategy('s1');
      (strategy.tick as any).mockImplementation((snap: StrategySnapshot) => {
        capturedSnapshot = snap;
        return [];
      });

      await scheduler.register(makeRegistration(strategy, { market }));
      scheduler.start();

      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();

      expect(capturedSnapshot).toBeDefined();
      expect(capturedSnapshot!.instrumentId).toBe(INSTRUMENT_ID);
      expect(capturedSnapshot!.market).toBe(market);
      expect(capturedSnapshot!.topOfBook).toBe(topOfBook);
      expect(capturedSnapshot!.bookHistory).toBe(bookHistory);
      expect(capturedSnapshot!.tradeTape).toBe(tradeTape);
      expect(capturedSnapshot!.openOrders).toStrictEqual(openOrders);
      expect(capturedSnapshot!.matchedOrders).toEqual([]);
      expect(capturedSnapshot!.constraints).toBeUndefined();
      expect(capturedSnapshot!.portfolio).toBe(portfolio);
      expect(typeof capturedSnapshot!.nowMs).toBe('number');
    });

    it('should populate constraints from catalog when available', async () => {
      const { Quantity } = await import('@polymarket/value-objects');
      const { Price } = await import('@polymarket/value-objects');
      const { default: Decimal } = await import('decimal.js');

      const minOrderSize = Quantity.of(new Decimal('5'));
      const minOrderValue = Quantity.of(new Decimal('1'));
      const tickSize = Price.of(new Decimal('0.01'));
      const catalog = makeCatalog();
      (catalog.get as any).mockReturnValue({ minOrderSize, minOrderValue, tickSize });

      const { deps: d, marketDataStore: mds, clock: clk } = makeDeps({ catalog: catalog as any });
      const s = new StrategyScheduler(d);

      let capturedSnapshot: StrategySnapshot | undefined;
      const strategy = makeStrategy('s1');
      (strategy.tick as any).mockImplementation((snap: StrategySnapshot) => {
        capturedSnapshot = snap;
        return [];
      });

      await s.register(makeRegistration(strategy));
      s.start();

      clk.advance(100);
      mds._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush(10);

      expect(capturedSnapshot).toBeDefined();
      expect(capturedSnapshot!.constraints).toBeDefined();
      expect(capturedSnapshot!.constraints!.minOrderSize).toBe(minOrderSize);
      expect(capturedSnapshot!.constraints!.minOrderValue).toBe(minOrderValue);
      expect(capturedSnapshot!.constraints!.tickSize).toBe(tickSize);

      await s.stopAll();
      s.stop();
    });
  });

  // ── stopAll ──────────────────────────────────────────

  describe('stopAll', () => {
    it('should unregister all strategies', async () => {
      const s1 = makeStrategy('s1');
      const s2 = makeStrategy('s2');
      await scheduler.register(makeRegistration(s1));
      await scheduler.register(makeRegistration(s2));

      await scheduler.stopAll();

      expect(s1.stop).toHaveBeenCalled();
      expect(s2.stop).toHaveBeenCalled();
      expect(scheduler.getMetrics('s1')).toBeUndefined();
      expect(scheduler.getMetrics('s2')).toBeUndefined();
    });
  });

  // ── onRiskBreached ───────────────────────────────────

  describe('onRiskBreached', () => {
    it('should unregister specific strategy on targeted risk breach', async () => {
      const s1 = makeStrategy('s1');
      await scheduler.register(makeRegistration(s1));

      await scheduler.onRiskBreached({
        type: 'RISK_LIMIT_BREACHED',
        violationType: 'MAX_DRAWDOWN',
        violation: 'Exceeded',
        strategyId: 's1',
        timestamp: {} as any,
      } as any);

      expect(scheduler.getMetrics('s1')).toBeUndefined();
    });

    it('should stop all strategies on system-wide risk breach', async () => {
      const s1 = makeStrategy('s1');
      const s2 = makeStrategy('s2');
      await scheduler.register(makeRegistration(s1));
      await scheduler.register(makeRegistration(s2));

      await scheduler.onRiskBreached({
        type: 'RISK_LIMIT_BREACHED',
        violationType: 'MAX_DRAWDOWN',
        violation: 'Exceeded',
        strategyId: undefined,
        timestamp: {} as any,
      } as any);

      expect(scheduler.getMetrics('s1')).toBeUndefined();
      expect(scheduler.getMetrics('s2')).toBeUndefined();
    });
  });

  // ── tick() error handling ────────────────────────────

  describe('tick error handling', () => {
    it('should not crash when strategy.tick() throws', async () => {
      const strategy = makeStrategy('s1');
      (strategy.tick as any).mockImplementation(() => { throw new Error('Tick boom'); });

      await scheduler.register(makeRegistration(strategy));
      scheduler.start();

      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();

      // Scheduler should still be operational
      expect(scheduler.getMetrics('s1')).toBeDefined();
    });
  });

  // ── Zero CPU при idle ────────────────────────────────

  describe('zero CPU at idle', () => {
    it('should not tick without dirty events', async () => {
      const strategy = makeStrategy('s1');
      await scheduler.register(makeRegistration(strategy, { config: { maxIdleMs: 999999 } }));
      scheduler.start();

      // No events triggered
      await flush();

      expect(strategy.tick).not.toHaveBeenCalled();
    });
  });

  // ── Snapshot: MATCHED ордера скрыты ────────────────

  describe('snapshot: MATCHED orders separated', () => {
    it('should split orders into openOrders and matchedOrders', async () => {
      const orderMatched = { id: 'order-matched' } as any;
      const orderNormal = { id: 'order-normal' } as any;

      const orderStateStore = makeOrderStateStore();
      (orderStateStore.getOpenOrdersByInstrument as any).mockReturnValue([orderMatched, orderNormal]);
      (orderStateStore.isMatchedOnExchange as any).mockImplementation(
        (id: any) => String(id) === 'order-matched',
      );

      const { deps: d, marketDataStore: mds, clock: clk } = makeDeps({ orderStateStore });
      const s = new StrategyScheduler(d);

      const strategy = makeStrategy('s1');
      await s.register(makeRegistration(strategy));
      s.start();

      // Trigger tick
      clk.advance(100);
      mds._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush(10);

      expect(strategy.tick).toHaveBeenCalled();
      const snapshot: StrategySnapshot = (strategy.tick as any).mock.calls[0][0];
      expect(snapshot.openOrders).toEqual([orderNormal]);
      expect(snapshot.openOrders).not.toContainEqual(orderMatched);
      expect(snapshot.matchedOrders).toEqual([orderMatched]);
      expect(snapshot.matchedOrders).not.toContainEqual(orderNormal);

      await s.stopAll();
      s.stop();
    });
  });
});
