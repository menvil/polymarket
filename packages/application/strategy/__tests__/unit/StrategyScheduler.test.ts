import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Ok, Err } from '@polymarket/result';
import type { AccountId, AssetId, InstrumentId } from '@polymarket/ids';
import { asInstrumentId } from '@polymarket/ids';
import type { IStrategy } from '../../src/IStrategy.js';
import type { StrategySnapshot } from '../../src/types/StrategySnapshot.js';
import type { StrategyIntent } from '../../src/types/StrategyIntent.js';
import type { TriggerReason } from '../../src/types/TriggerReason.js';
import { StrategyScheduler } from '../../src/StrategyScheduler.js';
import type { StrategySchedulerDeps, StrategyRegistration, IMarketDataStore } from '../../src/StrategyScheduler.js';
import { DeterministicSchedulerTimer } from '../../src/ports/SchedulerTimer.js';
import type { IOrderStateStore } from '@polymarket/ports';

// ── Constants ──────────────────────────────────────────────

const ACCOUNT_ID = 'venue:POLYMARKET:test' as unknown as AccountId;
const INSTRUMENT_ID = asInstrumentId('token-1')!;
const COMP_INSTRUMENT_ID = asInstrumentId('token-2')!;
const ASSET_ID = 'asset-1' as unknown as AssetId;
const COMP_ASSET_ID = 'asset-2' as unknown as AssetId;

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
    get currentMs() { return current; },
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
    markOrderFillMatched: fn(),
    clearOrderFillMatched: fn(),
    hasMatchedFills: fn().mockReturnValue(false),
    getMatchedFillIds: fn().mockReturnValue([]),
    markInFlightFill: fn(),
    updateInFlightFillStatus: fn(),
    hasInFlightFills: fn().mockReturnValue(false),
    clearInFlightFill: fn(),
    getInFlightFills: fn().mockReturnValue([]),
    markFillProcessing: fn(),
    updateFillProcessingStatus: fn(),
    clearFillProcessing: fn(),
    hasFillProcessingBlocks: fn().mockReturnValue(false),
    getFillProcessingBlocks: fn().mockReturnValue([]),
    hasUnsettledFills: fn().mockReturnValue(false),
    markManualReconciliationBlock: fn(),
    clearManualReconciliationBlock: fn(),
    hasManualReconciliationBlockForOrder: fn().mockReturnValue(false),
    hasManualReconciliationBlocks: fn().mockReturnValue(false),
    getManualReconciliationBlocks: fn().mockReturnValue([]),
    markTerminalSettlementPending: fn(),
    clearTerminalSettlementPending: fn(),
    hasTerminalSettlementPendingForOrder: fn().mockReturnValue(false),
    hasTerminalSettlementPending: fn().mockReturnValue(false),
    getTerminalSettlementPending: fn().mockReturnValue([]),
  };
}

function emptyReport() {
  return {
    placed: 0, cancelled: 0, skipped: 0, localRejected: 0,
    blockedByUnsafeCancel: 0, failed: 0, errors: [], outcomes: [],
  };
}

function makeExecutionEngine() {
  return {
    execute: fn().mockResolvedValue(emptyReport()),
    clearPostCancelCooldown: fn(),
    clearExchangeRejectionCooldown: fn(),
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
  const timer = new DeterministicSchedulerTimer(clock.currentMs);
  const executionEngine = makeExecutionEngine();
  return {
    deps: {
      marketDataStore,
      orderStateStore: makeOrderStateStore(),
      portfolioStore: makePortfolioStore() as any,
      catalog: makeCatalog() as any,
      executionEngine: executionEngine as any,
      clock: clock as any,
      timer,
      logger: makeLogger() as any,
      ...overrides,
    } as StrategySchedulerDeps,
    marketDataStore,
    clock,
    timer,
    executionEngine,
  };
}

/** Ждём microtask queue (Promise.resolve().then() chains) — БЕЗ реальных sleeps. */
async function flush(count = 8) {
  for (let i = 0; i < count; i++) {
    await Promise.resolve();
  }
}

/** Продвигает clock и deterministic timer синхронно (единая ось времени). */
function advanceTime(clock: ReturnType<typeof makeClock>, timer: DeterministicSchedulerTimer, ms: number) {
  clock.advance(ms);
  timer.advanceTo(clock.currentMs);
}

// ── Tests ──────────────────────────────────────────────────

describe('StrategyScheduler', () => {
  let scheduler: StrategyScheduler;
  let marketDataStore: ReturnType<typeof makeMarketDataStore>;
  let clock: ReturnType<typeof makeClock>;
  let timer: DeterministicSchedulerTimer;
  let executionEngine: ReturnType<typeof makeExecutionEngine>;
  let deps: StrategySchedulerDeps;

  beforeEach(() => {
    const d = makeDeps();
    deps = d.deps;
    marketDataStore = d.marketDataStore;
    clock = d.clock;
    timer = d.timer;
    executionEngine = d.executionEngine;
    scheduler = new StrategyScheduler(deps);
  });

  // ── register ─────────────────────────────────────────

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

    it('duplicate register → Err (не Ok)', async () => {
      const strategy = makeStrategy('s1');
      await scheduler.register(makeRegistration(strategy));
      const result = await scheduler.register(makeRegistration(strategy));

      expect(result.ok).toBe(false);
      expect(strategy.initialize).toHaveBeenCalledTimes(1);
    });

    it('два concurrent register одного ID → initialize вызывается один раз, одна entry', async () => {
      const s1 = makeStrategy('s1');
      const s1dup = makeStrategy('s1');

      const [r1, r2] = await Promise.all([
        scheduler.register(makeRegistration(s1)),
        scheduler.register(makeRegistration(s1dup)),
      ]);

      const okCount = [r1, r2].filter((r) => r.ok).length;
      expect(okCount).toBe(1);
      const initCalls =
        (s1.initialize as any).mock.calls.length + (s1dup.initialize as any).mock.calls.length;
      expect(initCalls).toBe(1);
    });

    it('complementaryInstrumentId без complementaryAsset → Err', async () => {
      const strategy = makeStrategy('s1');
      const result = await scheduler.register(makeRegistration(strategy, {
        complementaryInstrumentId: COMP_INSTRUMENT_ID,
      }));

      expect(result.ok).toBe(false);
      expect(strategy.initialize).not.toHaveBeenCalled();
    });

    describe('ScheduleConfig validation', () => {
      it.each([
        ['minIntervalMs = -1', { minIntervalMs: -1 }],
        ['minIntervalMs = NaN', { minIntervalMs: NaN }],
        ['minIntervalMs = Infinity', { minIntervalMs: Infinity }],
        ['minIntervalMs = 1.5 (fractional)', { minIntervalMs: 1.5 }],
        ['maxIdleMs = 0', { maxIdleMs: 0 }],
        ['maxIdleMs = -5', { maxIdleMs: -5 }],
        ['maxIdleMs = NaN', { maxIdleMs: NaN }],
        ['maxIdleMs = Infinity', { maxIdleMs: Infinity }],
        ['maxIdleMs = 2.5 (fractional)', { maxIdleMs: 2.5 }],
        ['executionTimeoutMs = 0', { executionTimeoutMs: 0 }],
      ])('%s → Err до запуска heartbeat', async (_label, config) => {
        const strategy = makeStrategy('s1');
        const result = await scheduler.register(makeRegistration(strategy, { config: config as any }));

        expect(result.ok).toBe(false);
        // initialize не должен был вызываться — config валидируется раньше.
        expect(strategy.initialize).not.toHaveBeenCalled();
      });

      it('unknown TriggerReason в priorityTriggers → Err', async () => {
        const strategy = makeStrategy('s1');
        const result = await scheduler.register(makeRegistration(strategy, {
          config: { priorityTriggers: new Set(['NOT_A_REASON' as TriggerReason]) },
        }));

        expect(result.ok).toBe(false);
      });

      it('внешний priorityTriggers Set копируется — мутация после register не влияет', async () => {
        const externalSet = new Set<TriggerReason>(['FILL']);
        const strategy = makeStrategy('s1');
        await scheduler.register(makeRegistration(strategy, {
          config: { minIntervalMs: 100, priorityTriggers: externalSet },
        }));
        scheduler.start();

        // Первый tick.
        marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
        await flush();
        expect(strategy.tick).toHaveBeenCalledTimes(1);

        // Мутируем ВНЕШНИЙ Set: BOOK теперь «приоритетный» в внешней копии.
        externalSet.add('BOOK');

        // BOOK в throttle-окне: stored копия НЕ содержит BOOK → должен отложиться.
        advanceTime(clock, timer, 10);
        marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
        await flush();

        expect(strategy.tick).toHaveBeenCalledTimes(1); // deferred, не bypass
      });
    });
  });

  // ── unregister lifecycle ─────────────────────────────

  describe('unregister lifecycle', () => {
    it('should call strategy.stop() and execute final intents', async () => {
      const strategy = makeStrategy('s1');
      await scheduler.register(makeRegistration(strategy));

      await scheduler.unregister('s1');

      expect(strategy.stop).toHaveBeenCalled();
      expect(executionEngine.execute).toHaveBeenCalledWith(
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

    it('unregister ЖДЁТ активный execution; final intents выполняются ПОСЛЕ него', async () => {
      const events: string[] = [];
      const strategy = makeStrategy('s1', {
        tickResult: [{ type: 'PLACE', side: 'BUY', price: {} as any, size: {} as any }],
      });

      let resolveExec: (() => void) | undefined;
      executionEngine.execute.mockImplementationOnce(() => {
        events.push('normal-execution-started');
        return new Promise((resolve) => {
          resolveExec = () => {
            events.push('normal-execution-finished');
            resolve(emptyReport());
          };
        });
      });
      executionEngine.execute.mockImplementationOnce(async () => {
        events.push('final-intents-executed');
        return emptyReport();
      });

      await scheduler.register(makeRegistration(strategy));
      scheduler.start();

      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();
      expect(events).toEqual(['normal-execution-started']);

      // unregister пока PLACE ещё in-flight.
      const unregisterPromise = scheduler.unregister('s1');
      await flush();

      // strategy.stop() НЕ вызывается, пока execution не завершён.
      expect(strategy.stop).not.toHaveBeenCalled();
      expect(events).toEqual(['normal-execution-started']);

      // Завершаем PLACE — после этого stop + final intents.
      resolveExec!();
      await unregisterPromise;

      expect(strategy.stop).toHaveBeenCalledTimes(1);
      expect(events).toEqual([
        'normal-execution-started',
        'normal-execution-finished',
        'final-intents-executed',
      ]);
      expect(scheduler.getMetrics('s1')).toBeUndefined();
    });

    it('два concurrent unregister: stop и final intents ровно один раз, оба caller завершаются', async () => {
      const strategy = makeStrategy('s1');
      await scheduler.register(makeRegistration(strategy));

      const [a, b] = [scheduler.unregister('s1'), scheduler.unregister('s1')];
      await Promise.all([a, b]);

      expect(strategy.stop).toHaveBeenCalledTimes(1);
      // Ровно один вызов executionEngine.execute — final intents.
      expect(executionEngine.execute).toHaveBeenCalledTimes(1);
      expect(scheduler.getMetrics('s1')).toBeUndefined();
    });

    it('события во время STOPPING не запускают новый tick', async () => {
      const strategy = makeStrategy('s1', {
        tickResult: [{ type: 'CANCEL_ALL' }],
      });

      let resolveExec: (() => void) | undefined;
      executionEngine.execute.mockImplementationOnce(() =>
        new Promise((resolve) => {
          resolveExec = () => resolve(emptyReport());
        }),
      );

      await scheduler.register(makeRegistration(strategy));
      scheduler.start();

      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();
      expect(strategy.tick).toHaveBeenCalledTimes(1);

      const unregisterPromise = scheduler.unregister('s1');
      await flush();

      // BOOK/FILL/ORDER_UPDATE во время STOPPING.
      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      scheduler.onOrderChanged('s1', 'ORDER_UPDATE');
      scheduler.onFillReceivedForInstrument(INSTRUMENT_ID);
      await flush();

      resolveExec!();
      await unregisterPromise;
      await flush();

      // Только первый tick — новых нет.
      expect(strategy.tick).toHaveBeenCalledTimes(1);
    });
  });

  // ── Dirty routing → tick ─────────────────────────────

  describe('event-driven tick', () => {
    it('should tick strategy when market data changes', async () => {
      const strategy = makeStrategy('s1', { tickResult: [{ type: 'CANCEL_ALL' }] });
      await scheduler.register(makeRegistration(strategy));
      scheduler.start();

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

      marketDataStore._onChange!(asInstrumentId('token-other')!, 'BOOK');
      await flush();

      expect(strategy.tick).not.toHaveBeenCalled();
    });

    it('should pass accumulated reasons to tick', async () => {
      const strategy = makeStrategy('s1');
      await scheduler.register(makeRegistration(strategy));
      scheduler.start();

      scheduler.onOrderChanged('s1', 'FILL');
      scheduler.onOrderChanged('s1', 'ORDER_UPDATE');

      await flush();

      const reasons = (strategy.tick as any).mock.calls[0][1] as ReadonlySet<TriggerReason>;
      expect(reasons.has('FILL')).toBe(true);
      expect(reasons.has('ORDER_UPDATE')).toBe(true);
    });
  });

  // ── Complementary routing ────────────────────────────

  describe('complementary instrument routing', () => {
    it('события комплементарного инструмента тикают стратегию (без additionalInstrumentIds)', async () => {
      const strategy = makeStrategy('s1');
      await scheduler.register(makeRegistration(strategy, {
        complementaryInstrumentId: COMP_INSTRUMENT_ID,
        complementaryAsset: COMP_ASSET_ID,
      }));
      scheduler.start();

      marketDataStore._onChange!(COMP_INSTRUMENT_ID, 'BOOK');
      await flush();

      expect(strategy.tick).toHaveBeenCalledTimes(1);
    });

    it('fills комплементарного инструмента тикают стратегию', async () => {
      const strategy = makeStrategy('s1');
      await scheduler.register(makeRegistration(strategy, {
        complementaryInstrumentId: COMP_INSTRUMENT_ID,
        complementaryAsset: COMP_ASSET_ID,
      }));
      scheduler.start();

      scheduler.onFillReceivedForInstrument(COMP_INSTRUMENT_ID);
      await flush();

      expect(strategy.tick).toHaveBeenCalledTimes(1);
    });

    it('snapshot содержит complementaryConstraints из каталога', async () => {
      const constraints = { minOrderSize: {}, minOrderValue: {}, tickSize: {} };
      const catalog = makeCatalog();
      (catalog.get as any).mockImplementation((id: InstrumentId) =>
        String(id) === String(COMP_INSTRUMENT_ID) ? constraints : undefined,
      );
      const d = makeDeps({ catalog: catalog as any });
      const s = new StrategyScheduler(d.deps);

      let captured: StrategySnapshot | undefined;
      const strategy = makeStrategy('s1');
      (strategy.tick as any).mockImplementation((snap: StrategySnapshot) => {
        captured = snap;
        return [];
      });

      await s.register(makeRegistration(strategy, {
        complementaryInstrumentId: COMP_INSTRUMENT_ID,
        complementaryAsset: COMP_ASSET_ID,
      }));
      s.start();

      d.marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();

      expect(captured).toBeDefined();
      expect(captured!.complementaryConstraints).toEqual(constraints);
      expect(captured!.constraints).toBeUndefined();

      await s.stopAll();
      s.stop();
    });

    it('unregister удаляет complementary routing', async () => {
      const strategy = makeStrategy('s1');
      await scheduler.register(makeRegistration(strategy, {
        complementaryInstrumentId: COMP_INSTRUMENT_ID,
        complementaryAsset: COMP_ASSET_ID,
      }));
      scheduler.start();
      await scheduler.unregister('s1');

      marketDataStore._onChange!(COMP_INSTRUMENT_ID, 'BOOK');
      await flush();

      expect(strategy.tick).not.toHaveBeenCalled();
    });
  });

  // ── Throttle / priority / heartbeat (deterministic timers) ──

  describe('throttle', () => {
    it('should defer tick when within minIntervalMs (deterministic timer)', async () => {
      const strategy = makeStrategy('s1');
      await scheduler.register(makeRegistration(strategy, { config: { minIntervalMs: 100 } }));
      scheduler.start();

      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();
      expect(strategy.tick).toHaveBeenCalledTimes(1);

      advanceTime(clock, timer, 50);
      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();
      expect(strategy.tick).toHaveBeenCalledTimes(1); // throttled

      // Догоняем остаток интервала — deferred timer срабатывает без wall-clock.
      advanceTime(clock, timer, 50);
      await flush();

      expect(strategy.tick).toHaveBeenCalledTimes(2);
    });
  });

  describe('priority trigger', () => {
    it('should bypass throttle for FILL', async () => {
      const strategy = makeStrategy('s1');
      await scheduler.register(makeRegistration(strategy, {
        config: { minIntervalMs: 100, priorityTriggers: new Set(['FILL']) },
      }));
      scheduler.start();

      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();
      expect(strategy.tick).toHaveBeenCalledTimes(1);

      advanceTime(clock, timer, 10);
      scheduler.onOrderChanged('s1', 'FILL');
      await flush();

      expect(strategy.tick).toHaveBeenCalledTimes(2);
    });
  });

  describe('heartbeat (deterministic)', () => {
    it('advance(maxIdleMs) → TIMER tick без ожидания wall-clock', async () => {
      const strategy = makeStrategy('s1');
      await scheduler.register(makeRegistration(strategy, {
        config: { maxIdleMs: 200 },
      }));
      scheduler.start();

      advanceTime(clock, timer, 200);
      await flush();

      const tickCalls = (strategy.tick as any).mock.calls;
      expect(tickCalls.length).toBeGreaterThanOrEqual(1);
      const reasons = tickCalls[0][1] as ReadonlySet<TriggerReason>;
      expect(reasons.has('TIMER')).toBe(true);
    });
  });

  // ── Queue lifecycle: stop/start ──────────────────────

  describe('queue stop/start', () => {
    it('start() идемпотентен', async () => {
      scheduler.start();
      scheduler.start(); // no-op
      const strategy = makeStrategy('s1');
      await scheduler.register(makeRegistration(strategy));
      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();
      expect(strategy.tick).toHaveBeenCalledTimes(1);
    });

    it('queued стратегия обрабатывается после stop()/start() без нового события', async () => {
      const strategy = makeStrategy('s1');
      await scheduler.register(makeRegistration(strategy));
      scheduler.start();

      // Останавливаем ДО обработки microtask queue: стратегия остаётся в очереди.
      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      scheduler.stop();
      await flush();
      expect(strategy.tick).not.toHaveBeenCalled();

      // start() возобновляет обработку сохранённой queue.
      scheduler.start();
      await flush();

      expect(strategy.tick).toHaveBeenCalledTimes(1);
    });

    it('dirty-но-не-queued стратегия (событие во время паузы) обрабатывается после start()', async () => {
      const strategy = makeStrategy('s1');
      await scheduler.register(makeRegistration(strategy));
      // Событие ДО start(): dirty сохраняется, очередь пуста (enqueue при stopped — no-op).
      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();
      expect(strategy.tick).not.toHaveBeenCalled();

      scheduler.start();
      await flush();

      expect(strategy.tick).toHaveBeenCalledTimes(1);
    });
  });

  // ── Exception isolation ──────────────────────────────

  describe('exception isolation', () => {
    it('snapshot builder стратегии A бросил → стратегия B в той же очереди выполняется', async () => {
      const strategyA = makeStrategy('sA');
      const strategyB = makeStrategy('sB');

      // buildSnapshot для A бросает (первое обращение к store — getOpenOrdersByInstrument).
      (deps.orderStateStore.getOpenOrdersByInstrument as any).mockImplementation(
        (strategyId: string) => {
          if (strategyId === 'sA') throw new Error('snapshot boom');
          return [];
        },
      );

      await scheduler.register(makeRegistration(strategyA));
      await scheduler.register(makeRegistration(strategyB));
      scheduler.start();

      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();

      expect(strategyA.tick).not.toHaveBeenCalled();
      expect(strategyB.tick).toHaveBeenCalledTimes(1);
    });

    it('tick бросил → dirty reasons не теряются, controlled retry с backoff (без tight loop)', async () => {
      const strategy = makeStrategy('s1');
      (strategy.tick as any)
        .mockImplementationOnce(() => { throw new Error('Tick boom'); })
        .mockReturnValue([]);

      await scheduler.register(makeRegistration(strategy));
      scheduler.start();

      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();
      expect(strategy.tick).toHaveBeenCalledTimes(1);

      // Tight loop отсутствует: без продвижения времени retry не происходит.
      await flush(20);
      expect(strategy.tick).toHaveBeenCalledTimes(1);

      // Deferred retry (backoff 100ms) срабатывает через deterministic timer,
      // reasons сохранены (BOOK передан повторно).
      advanceTime(clock, timer, 100);
      await flush();
      expect(strategy.tick).toHaveBeenCalledTimes(2);
      const retryReasons = (strategy.tick as any).mock.calls[1][1] as ReadonlySet<TriggerReason>;
      expect(retryReasons.has('BOOK')).toBe(true);
    });

    it('scheduler остаётся работоспособным после tick throw', async () => {
      const strategy = makeStrategy('s1');
      (strategy.tick as any).mockImplementation(() => { throw new Error('Tick boom'); });

      await scheduler.register(makeRegistration(strategy));
      scheduler.start();

      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();

      expect(scheduler.getMetrics('s1')).toBeDefined();
    });
  });

  // ── FILL received vs confirmed ───────────────────────

  describe('FILL_RECEIVED / FILL_CONFIRMED split', () => {
    it('onFillReceivedForInstrument: dirty+tick, cooldown НЕ снимается', async () => {
      const strategy = makeStrategy('s1');
      await scheduler.register(makeRegistration(strategy));
      scheduler.start();

      scheduler.onFillReceivedForInstrument(INSTRUMENT_ID);
      await flush();

      expect(strategy.tick).toHaveBeenCalledTimes(1);
      const reasons = (strategy.tick as any).mock.calls[0][1] as ReadonlySet<TriggerReason>;
      expect(reasons.has('FILL')).toBe(true);
      expect(executionEngine.clearPostCancelCooldown).not.toHaveBeenCalled();
      expect(executionEngine.clearExchangeRejectionCooldown).not.toHaveBeenCalled();
    });

    it('onFillConfirmedForInstrument: finality cleanup (оба cooldown) + dirty+tick', async () => {
      const strategy = makeStrategy('s1');
      await scheduler.register(makeRegistration(strategy));
      scheduler.start();

      scheduler.onFillConfirmedForInstrument(INSTRUMENT_ID);
      await flush();

      expect(strategy.tick).toHaveBeenCalledTimes(1);
      expect(executionEngine.clearPostCancelCooldown).toHaveBeenCalledWith(INSTRUMENT_ID);
      expect(executionEngine.clearExchangeRejectionCooldown).toHaveBeenCalledWith(INSTRUMENT_ID);
    });
  });

  // ── Watchdog ─────────────────────────────────────────

  describe('execution watchdog', () => {
    it('зависший execute → faulted: новые тики блокируются, unregister не виснет', async () => {
      const strategy = makeStrategy('s1', {
        tickResult: [{ type: 'CANCEL_ALL' }],
      });

      // Execution никогда не завершается (hung).
      executionEngine.execute.mockImplementationOnce(() => new Promise(() => { /* hung */ }));

      await scheduler.register(makeRegistration(strategy, {
        config: { executionTimeoutMs: 1000 },
      }));
      scheduler.start();

      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();
      expect(strategy.tick).toHaveBeenCalledTimes(1);

      // Watchdog срабатывает.
      advanceTime(clock, timer, 1000);
      await flush();

      // Новые события не тикают faulted стратегию.
      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();
      expect(strategy.tick).toHaveBeenCalledTimes(1);

      // Unregister НЕ виснет на hung execution (controlled recovery).
      await scheduler.unregister('s1');
      expect(strategy.stop).toHaveBeenCalledTimes(1);
      expect(scheduler.getMetrics('s1')).toBeUndefined();
    });
  });

  // ── Coalescing (microtask-only, без реальных sleeps) ──

  describe('coalescing', () => {
    it('события во время execution коалесцируются в один rerun', async () => {
      const strategy = makeStrategy('s1', { tickResult: [{ type: 'CANCEL_ALL' }] });

      let resolveExec: (() => void) | undefined;
      let callCount = 0;
      executionEngine.execute.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return new Promise((resolve) => {
            resolveExec = () => resolve(emptyReport());
          });
        }
        return Promise.resolve(emptyReport());
      });

      await scheduler.register(makeRegistration(strategy));
      scheduler.start();

      // Event 1 → tick + начало execution.
      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();
      expect(strategy.tick).toHaveBeenCalledTimes(1);

      // События 2-4 во время execution → коалесцируются.
      marketDataStore._onChange!(INSTRUMENT_ID, 'TRADE');
      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      marketDataStore._onChange!(INSTRUMENT_ID, 'TRADE');
      await flush();
      expect(strategy.tick).toHaveBeenCalledTimes(1); // ещё не rerun

      // Завершение execution → ровно один rerun (за пределами throttle).
      advanceTime(clock, timer, 100);
      resolveExec!();
      await flush(12);

      expect(strategy.tick).toHaveBeenCalledTimes(2);
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
      const { Quantity, Price, Money } = await import('@polymarket/value-objects');
      const { default: Decimal } = await import('decimal.js');

      const minOrderSize = Quantity.of(new Decimal('5'));
      const minOrderValue = Money.of(new Decimal('1'), 'USDC');
      const tickSize = Price.of(new Decimal('0.01'));
      const catalog = makeCatalog();
      (catalog.get as any).mockReturnValue({ minOrderSize, minOrderValue, tickSize });

      const d = makeDeps({ catalog: catalog as any });
      const s = new StrategyScheduler(d.deps);

      let capturedSnapshot: StrategySnapshot | undefined;
      const strategy = makeStrategy('s1');
      (strategy.tick as any).mockImplementation((snap: StrategySnapshot) => {
        capturedSnapshot = snap;
        return [];
      });

      await s.register(makeRegistration(strategy));
      s.start();

      d.clock.advance(100);
      d.marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush(10);

      expect(capturedSnapshot).toBeDefined();
      expect(capturedSnapshot!.constraints).toBeDefined();
      expect(capturedSnapshot!.constraints!.minOrderSize).toBe(minOrderSize);
      expect(capturedSnapshot!.constraints!.minOrderValue).toBe(minOrderValue);
      expect(capturedSnapshot!.constraints!.tickSize).toBe(tickSize);

      await s.stopAll();
      s.stop();
    });

    it('should split orders into openOrders and matchedOrders', async () => {
      const orderMatched = { id: 'order-matched' } as any;
      const orderNormal = { id: 'order-normal' } as any;

      const orderStateStore = makeOrderStateStore();
      (orderStateStore.getOpenOrdersByInstrument as any).mockReturnValue([orderMatched, orderNormal]);
      (orderStateStore.hasMatchedFills as any).mockImplementation(
        (id: any) => String(id) === 'order-matched',
      );

      const d = makeDeps({ orderStateStore });
      const s = new StrategyScheduler(d.deps);

      const strategy = makeStrategy('s1');
      await s.register(makeRegistration(strategy));
      s.start();

      d.clock.advance(100);
      d.marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush(10);

      expect(strategy.tick).toHaveBeenCalled();
      const snapshot: StrategySnapshot = (strategy.tick as any).mock.calls[0][0];
      expect(snapshot.openOrders).toEqual([orderNormal]);
      expect(snapshot.matchedOrders).toEqual([orderMatched]);

      await s.stopAll();
      s.stop();
    });
  });

  // ── ExecutionContext ─────────────────────────────────

  describe('execution context', () => {
    it('allowedInstruments содержит primary + additional + complementary', async () => {
      const strategy = makeStrategy('s1', { tickResult: [{ type: 'CANCEL_ALL' }] });
      const additional = asInstrumentId('token-3')!;
      await scheduler.register(makeRegistration(strategy, {
        complementaryInstrumentId: COMP_INSTRUMENT_ID,
        complementaryAsset: COMP_ASSET_ID,
        additionalInstrumentIds: [additional],
      }));
      scheduler.start();

      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();

      const ctx = executionEngine.execute.mock.calls[0][0] as any;
      expect(ctx.allowedInstruments.has(String(INSTRUMENT_ID))).toBe(true);
      expect(ctx.allowedInstruments.has(String(COMP_INSTRUMENT_ID))).toBe(true);
      expect(ctx.allowedInstruments.has(String(additional))).toBe(true);
    });
  });

  // ── stopAll ──────────────────────────────────────────

  describe('stopAll', () => {
    it('should unregister all strategies via safe flow', async () => {
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

  // ── getMetrics boundary ──────────────────────────────

  describe('getMetrics', () => {
    it('getMetrics() бросил → безопасный {} (scheduler не падает)', async () => {
      const strategy = makeStrategy('s1');
      (strategy.getMetrics as any).mockImplementation(() => { throw new Error('metrics boom'); });

      await scheduler.register(makeRegistration(strategy));

      expect(scheduler.getMetrics('s1')).toEqual({});
    });
  });

  // ── Zero CPU при idle ────────────────────────────────

  describe('zero CPU at idle', () => {
    it('should not tick without dirty events', async () => {
      const strategy = makeStrategy('s1');
      await scheduler.register(makeRegistration(strategy, { config: { maxIdleMs: 999999 } }));
      scheduler.start();

      await flush();

      expect(strategy.tick).not.toHaveBeenCalled();
    });
  });
});
