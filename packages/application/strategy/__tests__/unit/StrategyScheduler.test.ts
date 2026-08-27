import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import Decimal from 'decimal.js';
import { Ok, Err } from '@polymarket/result';
import type { Result } from '@polymarket/result';
import type { AccountId, InstrumentId } from '@polymarket/ids';
import { asInstrumentId, asPolymarketCtfToken, unsafeStrategyId } from '@polymarket/ids';
import { Quantity, OutcomePrice, Money } from '@polymarket/value-objects';
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

// Числовые CTF tokenId (как в ExecutionEngine.test.ts): assetIdToInstrumentId(asset) === instrument key.
const PRIMARY_TOKEN = '111';
const COMP_TOKEN = '222';

const INSTRUMENT_ID = asInstrumentId(PRIMARY_TOKEN)!;
const ASSET_ID = asPolymarketCtfToken(PRIMARY_TOKEN)!;
const COMP_INSTRUMENT_ID = asInstrumentId(COMP_TOKEN)!;
const COMP_ASSET_ID = asPolymarketCtfToken(COMP_TOKEN)!;

// Strategy id фикстуры — доверенные строковые литералы, используемые по всему файлу.
const S1 = unsafeStrategyId('s1');
const S2 = unsafeStrategyId('s2');
const S3 = unsafeStrategyId('s3');
const S4 = unsafeStrategyId('s4');

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

/** Мок ICryptoMarketDataStore — для тестов crypto-asset routing (CryptoAssetId, Этап 9). */
function makeCryptoMarketDataStore(): { _onChange?: (asset: string, reason: any) => void } {
  const store: any = {
    _onChange: undefined,
    setOnChange(cb: any) { store._onChange = cb; },
    getPriceHistory: jest.fn().mockReturnValue(undefined),
    getVenueState: jest.fn().mockReturnValue(undefined),
    getVenueHistory: jest.fn().mockReturnValue(undefined),
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

/** Authoritative commitment reader — по умолчанию нет unresolved commitments. */
function makeCommitmentReader() {
  return {
    getActiveCommitments: fn().mockResolvedValue([]),
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
    dispose: fn().mockResolvedValue(Ok(undefined)),
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

/** InstrumentInfo с реальными value objects (для constraints/registration identity). */
function makeInstrumentInfo(opts: Partial<{
  minOrderSize: Quantity;
  minOrderValue: Money;
  tickSize: OutcomePrice;
}> = {}) {
  return {
    minOrderSize: opts.minOrderSize ?? Quantity.of(new Decimal('1')),
    minOrderValue: opts.minOrderValue ?? Money.of(new Decimal('1'), 'USDC'),
    tickSize: opts.tickSize ?? OutcomePrice.of(new Decimal('0.01')),
  } as any;
}

/**
 * Каталог: по умолчанию знает PRIMARY и COMPLEMENTARY инструменты — registration-time
 * identity validation (catalog entry + asset↔instrument mapping) требует этого для
 * ЛЮБОЙ успешной регистрации, использующей primary/complementary константы этого файла.
 */
function makeCatalog(known: Record<string, any> = {
  [String(INSTRUMENT_ID)]: makeInstrumentInfo(),
  [String(COMP_INSTRUMENT_ID)]: makeInstrumentInfo(),
}) {
  return {
    get: fn().mockImplementation((id: InstrumentId) => known[String(id)]),
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
  const orderStateStore = makeOrderStateStore();
  const commitmentReader = makeCommitmentReader();
  return {
    deps: {
      marketDataStore,
      orderStateStore,
      portfolioStore: makePortfolioStore() as any,
      catalog: makeCatalog() as any,
      executionEngine: executionEngine as any,
      clock: clock as any,
      timer,
      commitmentReader: commitmentReader as any,
      logger: makeLogger() as any,
      ...overrides,
    } as StrategySchedulerDeps,
    marketDataStore,
    clock,
    timer,
    executionEngine,
    orderStateStore,
    commitmentReader,
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
  let orderStateStore: ReturnType<typeof makeOrderStateStore>;
  let commitmentReader: ReturnType<typeof makeCommitmentReader>;
  let deps: StrategySchedulerDeps;

  beforeEach(() => {
    const d = makeDeps();
    deps = d.deps;
    marketDataStore = d.marketDataStore;
    clock = d.clock;
    timer = d.timer;
    executionEngine = d.executionEngine;
    orderStateStore = d.orderStateStore;
    commitmentReader = d.commitmentReader;
    scheduler = new StrategyScheduler(deps);
  });

  // ── register ─────────────────────────────────────────

  describe('register', () => {
    it('should call strategy.initialize() and register', async () => {
      const strategy = makeStrategy(S1);
      const result = await scheduler.register(makeRegistration(strategy));

      expect(result.ok).toBe(true);
      expect(strategy.initialize).toHaveBeenCalled();
      expect(scheduler.getMetrics(S1)).toEqual({ ticks: 0 });
    });

    it('should return Err if initialize() fails', async () => {
      const strategy = makeStrategy(S1, { initResult: 'err' });
      const result = await scheduler.register(makeRegistration(strategy));

      expect(result.ok).toBe(false);
      expect(scheduler.getMetrics(S1)).toBeUndefined();
    });

    it('should return Err if initialize() throws', async () => {
      const strategy = makeStrategy(S1);
      (strategy.initialize as any).mockRejectedValue(new Error('Boom'));

      const result = await scheduler.register(makeRegistration(strategy));

      expect(result.ok).toBe(false);
    });

    it('duplicate register → Err (не Ok)', async () => {
      const strategy = makeStrategy(S1);
      await scheduler.register(makeRegistration(strategy));
      const result = await scheduler.register(makeRegistration(strategy));

      expect(result.ok).toBe(false);
      expect(strategy.initialize).toHaveBeenCalledTimes(1);
    });

    it('два concurrent register одного ID → initialize вызывается один раз, одна entry', async () => {
      const s1 = makeStrategy(S1);
      const s1dup = makeStrategy(S1);

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
      const strategy = makeStrategy(S1);
      const result = await scheduler.register(makeRegistration(strategy, {
        complementaryInstrumentId: COMP_INSTRUMENT_ID,
      }));

      expect(result.ok).toBe(false);
      expect(strategy.initialize).not.toHaveBeenCalled();
    });

    // ── Primary/complementary identity validation (P0) ──

    describe('target identity validation', () => {
      it('primary instrument отсутствует в каталоге → Err до initialize()', async () => {
        const d = makeDeps({ catalog: makeCatalog({}) as any });
        const s = new StrategyScheduler(d.deps);
        const strategy = makeStrategy(S1);

        const result = await s.register(makeRegistration(strategy));

        expect(result.ok).toBe(false);
        expect(strategy.initialize).not.toHaveBeenCalled();
      });

      it('primary asset не соответствует primary instrument → Err до initialize()', async () => {
        const strategy = makeStrategy(S1);
        // COMP_ASSET_ID маппится на COMP_INSTRUMENT_ID, не на primary INSTRUMENT_ID.
        const result = await scheduler.register(makeRegistration(strategy, { asset: COMP_ASSET_ID }));

        expect(result.ok).toBe(false);
        expect(strategy.initialize).not.toHaveBeenCalled();
      });

      it('complementary instrument отсутствует в каталоге → Err до initialize()', async () => {
        const d = makeDeps({ catalog: makeCatalog({ [String(INSTRUMENT_ID)]: makeInstrumentInfo() }) as any });
        const s = new StrategyScheduler(d.deps);
        const strategy = makeStrategy(S1);

        const result = await s.register(makeRegistration(strategy, {
          complementaryInstrumentId: COMP_INSTRUMENT_ID,
          complementaryAsset: COMP_ASSET_ID,
        }));

        expect(result.ok).toBe(false);
        expect(strategy.initialize).not.toHaveBeenCalled();
      });

      it('complementary asset не соответствует complementary instrument → Err до initialize()', async () => {
        const strategy = makeStrategy(S1);
        const result = await scheduler.register(makeRegistration(strategy, {
          complementaryInstrumentId: COMP_INSTRUMENT_ID,
          complementaryAsset: ASSET_ID, // primary asset, не complementary
        }));

        expect(result.ok).toBe(false);
        expect(strategy.initialize).not.toHaveBeenCalled();
      });

      it('complementary instrument совпадает с primary → Err', async () => {
        const strategy = makeStrategy(S1);
        const result = await scheduler.register(makeRegistration(strategy, {
          complementaryInstrumentId: INSTRUMENT_ID,
          complementaryAsset: ASSET_ID,
        }));

        expect(result.ok).toBe(false);
        expect(strategy.initialize).not.toHaveBeenCalled();
      });

      it('additionalTradableTargets валидируется так же строго (catalog + asset mapping)', async () => {
        const foreignToken = '999';
        const foreignInstrumentId = asInstrumentId(foreignToken)!;
        const foreignAsset = asPolymarketCtfToken(foreignToken)!;
        // foreign НЕ зарегистрирован в каталоге.
        const strategy = makeStrategy(S1);

        const result = await scheduler.register(makeRegistration(strategy, {
          additionalTradableTargets: [{ instrumentId: foreignInstrumentId, asset: foreignAsset }],
        }));

        expect(result.ok).toBe(false);
        expect(strategy.initialize).not.toHaveBeenCalled();
      });
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
        const strategy = makeStrategy(S1);
        const result = await scheduler.register(makeRegistration(strategy, { config: config as any }));

        expect(result.ok).toBe(false);
        // initialize не должен был вызываться — identity/config валидируются раньше.
        expect(strategy.initialize).not.toHaveBeenCalled();
      });

      it('unknown TriggerReason в priorityTriggers → Err', async () => {
        const strategy = makeStrategy(S1);
        const result = await scheduler.register(makeRegistration(strategy, {
          config: { priorityTriggers: new Set(['NOT_A_REASON' as TriggerReason]) },
        }));

        expect(result.ok).toBe(false);
      });

      it('внешний priorityTriggers Set копируется — мутация после register не влияет', async () => {
        const externalSet = new Set<TriggerReason>(['FILL']);
        const strategy = makeStrategy(S1);
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

    describe('pending registration cancellation', () => {
      it('unregister во время strategy.initialize() отменяет публикацию — ACTIVE entry никогда не создаётся', async () => {
        let resolveInit: ((r: Result<void, Error>) => void) | undefined;
        const strategy = makeStrategy(S1);
        (strategy.initialize as any).mockImplementation(
          () => new Promise((resolve) => { resolveInit = resolve; }),
        );

        const registerPromise = scheduler.register(makeRegistration(strategy));
        await flush();

        const unregisterPromise = scheduler.unregister(S1);
        await flush();

        resolveInit!(Ok(undefined));
        const [registerResult, unregisterResult] = await Promise.all([registerPromise, unregisterPromise]);

        expect(registerResult.ok).toBe(false);
        expect(unregisterResult.ok).toBe(false);
        if (!unregisterResult.ok) {
          expect(unregisterResult.error.code).toBe('REGISTRATION_CANCELLED');
        }
        expect(scheduler.getMetrics(S1)).toBeUndefined();
        // dispose() вызван ровно один раз — initialize() успешно завершился,
        // но публикация была отменена ДО того, как entry стала ACTIVE.
        expect(strategy.dispose).toHaveBeenCalledTimes(1);

        // Событие не тикает отменённую стратегию.
        scheduler.start();
        marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
        await flush();
        expect(strategy.tick).not.toHaveBeenCalled();
      });

      it('dispose() возвращает Err → REGISTRATION_CANCELLED заменяется на DISPOSE_FAILED, ресурсы могли остаться открытыми', async () => {
        let resolveInit: ((r: Result<void, Error>) => void) | undefined;
        const strategy = makeStrategy(S1);
        (strategy.initialize as any).mockImplementation(
          () => new Promise((resolve) => { resolveInit = resolve; }),
        );
        (strategy.dispose as any).mockResolvedValue(Err(new Error('dispose boom')));

        void scheduler.register(makeRegistration(strategy));
        await flush();

        const unregPromise = scheduler.unregister(S1);
        await flush();
        resolveInit!(Ok(undefined));

        const unregResult = await unregPromise;
        expect(unregResult.ok).toBe(false);
        if (!unregResult.ok) expect(unregResult.error.code).toBe('DISPOSE_FAILED');
        expect(strategy.dispose).toHaveBeenCalledTimes(1);
      });

      it('dispose() бросает → DISPOSE_FAILED (не проглатывается)', async () => {
        let resolveInit: ((r: Result<void, Error>) => void) | undefined;
        const strategy = makeStrategy(S1);
        (strategy.initialize as any).mockImplementation(
          () => new Promise((resolve) => { resolveInit = resolve; }),
        );
        (strategy.dispose as any).mockImplementation(() => { throw new Error('dispose threw'); });

        void scheduler.register(makeRegistration(strategy));
        await flush();

        const unregPromise = scheduler.unregister(S1);
        await flush();
        resolveInit!(Ok(undefined));

        const unregResult = await unregPromise;
        expect(unregResult.ok).toBe(false);
        if (!unregResult.ok) expect(unregResult.error.code).toBe('DISPOSE_FAILED');
      });

      it('initialize() вернул Err → dispose() НЕ вызывается', async () => {
        const strategy = makeStrategy(S1, { initResult: 'err' });

        await scheduler.register(makeRegistration(strategy));

        expect(strategy.dispose).not.toHaveBeenCalled();
      });

      it('initialize() бросил → dispose() НЕ вызывается', async () => {
        const strategy = makeStrategy(S1);
        (strategy.initialize as any).mockRejectedValue(new Error('init boom'));

        await scheduler.register(makeRegistration(strategy));

        expect(strategy.dispose).not.toHaveBeenCalled();
      });

      it('stopAll возвращает failure и НЕ логирует успех, если dispose() провалился', async () => {
        let resolveInit: ((r: Result<void, Error>) => void) | undefined;
        const strategy = makeStrategy(S1);
        (strategy.initialize as any).mockImplementation(
          () => new Promise((resolve) => { resolveInit = resolve; }),
        );
        (strategy.dispose as any).mockResolvedValue(Err(new Error('dispose boom')));

        void scheduler.register(makeRegistration(strategy));
        await flush();

        const stopAllPromise = scheduler.stopAll();
        await flush();
        resolveInit!(Ok(undefined));

        const stopAllResult = await stopAllPromise;
        expect(stopAllResult.ok).toBe(false);
        if (!stopAllResult.ok) {
          expect(stopAllResult.error.some((e) => e.code === 'DISPOSE_FAILED')).toBe(true);
        }
      });

      it('stopAll ждёт pending registrations и блокирует новые после барьера', async () => {
        let resolveInit: ((r: Result<void, Error>) => void) | undefined;
        const strategy = makeStrategy(S1);
        (strategy.initialize as any).mockImplementation(
          () => new Promise((resolve) => { resolveInit = resolve; }),
        );

        const registerPromise = scheduler.register(makeRegistration(strategy));
        await flush();

        const stopAllPromise = scheduler.stopAll();
        await flush();

        resolveInit!(Ok(undefined));
        const registerResult = await registerPromise;
        const stopAllResult = await stopAllPromise;

        expect(registerResult.ok).toBe(false);
        expect(stopAllResult.ok).toBe(true);
        expect(scheduler.getMetrics(S1)).toBeUndefined();

        // Регистрация ПОСЛЕ stopAll отклоняется (global barrier).
        const strategy2 = makeStrategy(S2);
        const lateResult = await scheduler.register(makeRegistration(strategy2));
        expect(lateResult.ok).toBe(false);
        expect(strategy2.initialize).not.toHaveBeenCalled();
      });
    });
  });

  // ── unregister lifecycle ─────────────────────────────

  describe('unregister lifecycle', () => {
    it('should call strategy.stop() and execute final intents', async () => {
      const strategy = makeStrategy(S1);
      await scheduler.register(makeRegistration(strategy));

      const result = await scheduler.unregister(S1);

      expect(result.ok).toBe(true);
      expect(strategy.stop).toHaveBeenCalled();
      expect(executionEngine.execute).toHaveBeenCalledWith(
        expect.objectContaining({ strategyId: S1 }),
        [{ type: 'CANCEL_ALL' }],
      );
      expect(scheduler.getMetrics(S1)).toBeUndefined();
    });

    it('should be safe for unknown strategy (typed STRATEGY_NOT_FOUND)', async () => {
      const result = await scheduler.unregister(unsafeStrategyId('unknown'));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('STRATEGY_NOT_FOUND');
    });

    it('should handle strategy.stop() throwing (STOP_HOOK_FAILED — NOT treated as successful stop)', async () => {
      const strategy = makeStrategy(S1);
      (strategy.stop as any).mockImplementation(() => { throw new Error('Stop boom'); });

      await scheduler.register(makeRegistration(strategy));
      const result = await scheduler.unregister(S1);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('STOP_HOOK_FAILED');
      expect(executionEngine.execute).not.toHaveBeenCalled();
      expect(scheduler.getMetrics(S1)).toBeDefined();
    });

    it('unregister ЖДЁТ активный execution; final intents выполняются ПОСЛЕ него', async () => {
      const events: string[] = [];
      const strategy = makeStrategy(S1, {
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
      const unregisterPromise = scheduler.unregister(S1);
      await flush();

      // strategy.stop() НЕ вызывается, пока execution не завершён.
      expect(strategy.stop).not.toHaveBeenCalled();
      expect(events).toEqual(['normal-execution-started']);

      // Завершаем PLACE — после этого stop + final intents.
      resolveExec!();
      const result = await unregisterPromise;

      expect(result.ok).toBe(true);
      expect(strategy.stop).toHaveBeenCalledTimes(1);
      expect(events).toEqual([
        'normal-execution-started',
        'normal-execution-finished',
        'final-intents-executed',
      ]);
      expect(scheduler.getMetrics(S1)).toBeUndefined();
    });

    it('два concurrent unregister: stop и final intents ровно один раз, оба caller завершаются', async () => {
      const strategy = makeStrategy(S1);
      await scheduler.register(makeRegistration(strategy));

      const [a, b] = [scheduler.unregister(S1), scheduler.unregister(S1)];
      const [ra, rb] = await Promise.all([a, b]);

      expect(ra.ok).toBe(true);
      expect(rb.ok).toBe(true);
      expect(strategy.stop).toHaveBeenCalledTimes(1);
      // Ровно один вызов executionEngine.execute — final intents.
      expect(executionEngine.execute).toHaveBeenCalledTimes(1);
      expect(scheduler.getMetrics(S1)).toBeUndefined();
    });

    it('события во время STOPPING не запускают новый tick', async () => {
      const strategy = makeStrategy(S1, {
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

      const unregisterPromise = scheduler.unregister(S1);
      await flush();

      // BOOK/FILL/ORDER_UPDATE во время STOPPING.
      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      scheduler.onOrderChanged(S1, 'ORDER_UPDATE');
      scheduler.onFillReceivedForInstrument(INSTRUMENT_ID);
      await flush();

      resolveExec!();
      await unregisterPromise;
      await flush();

      // Только первый tick — новых нет.
      expect(strategy.tick).toHaveBeenCalledTimes(1);
    });

    // ── strategy.stop() safety (P0) ────────────────────

    it('strategy.stop() возвращает PLACE → UNSAFE_FINAL_INTENT, final batch не исполняется, entry не удаляется', async () => {
      const strategy = makeStrategy(S1, {
        stopResult: [{ type: 'PLACE', side: 'BUY', price: {} as any, size: {} as any }],
      });
      await scheduler.register(makeRegistration(strategy));

      const result = await scheduler.unregister(S1);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('UNSAFE_FINAL_INTENT');
      expect(executionEngine.execute).not.toHaveBeenCalled();
      expect(scheduler.getMetrics(S1)).toBeDefined();
    });

    // ── Final cleanup verification (P0) ────────────────

    it('final execution с blockedByUnsafeCancel > 0 → FINAL_CLEANUP_UNCONFIRMED, entry не удаляется', async () => {
      const strategy = makeStrategy(S1);
      await scheduler.register(makeRegistration(strategy));

      executionEngine.execute.mockResolvedValueOnce({
        ...emptyReport(),
        blockedByUnsafeCancel: 1,
        skipped: 1,
        outcomes: [{ intent: { type: 'CANCEL_ALL' }, kind: 'CANCEL_PENDING' }],
      });

      const result = await scheduler.unregister(S1);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('FINAL_CLEANUP_UNCONFIRMED');
      expect(scheduler.getMetrics(S1)).toBeDefined();
    });

    it('final execution с failed > 0 (CANCEL_FAILED) → FINAL_CLEANUP_UNCONFIRMED, entry не удаляется', async () => {
      const strategy = makeStrategy(S1);
      await scheduler.register(makeRegistration(strategy));

      executionEngine.execute.mockResolvedValueOnce({
        ...emptyReport(),
        failed: 1,
        errors: [{ intent: { type: 'CANCEL_ALL' }, error: new Error('cancel failed') }],
        outcomes: [{ intent: { type: 'CANCEL_ALL' }, kind: 'CANCEL_FAILED' }],
      });

      const result = await scheduler.unregister(S1);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('FINAL_CLEANUP_UNCONFIRMED');
      expect(scheduler.getMetrics(S1)).toBeDefined();
    });

    it('authoritative post-check находит живые ордера стратегии → FINAL_CLEANUP_UNCONFIRMED', async () => {
      const strategy = makeStrategy(S1);
      await scheduler.register(makeRegistration(strategy));
      (deps.orderStateStore.getOpenOrders as any).mockReturnValue([{ id: 'still-open' }]);

      const result = await scheduler.unregister(S1);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('FINAL_CLEANUP_UNCONFIRMED');
      expect(scheduler.getMetrics(S1)).toBeDefined();
    });

    it('успешный final cleanup (CONFIRMED, authoritative post-check пуст) → STOPPED, entry удалена', async () => {
      const strategy = makeStrategy(S1);
      await scheduler.register(makeRegistration(strategy));
      executionEngine.execute.mockResolvedValueOnce({ ...emptyReport(), cancelled: 1 });

      const result = await scheduler.unregister(S1);

      expect(result.ok).toBe(true);
      expect(scheduler.getMetrics(S1)).toBeUndefined();
    });

    // ── Authoritative commitment post-check (P0) ────────

    it('commitmentReader возвращает UNKNOWN_SUBMISSION → entry не удаляется, FINAL_CLEANUP_UNCONFIRMED', async () => {
      const strategy = makeStrategy(S1);
      await scheduler.register(makeRegistration(strategy));
      commitmentReader.getActiveCommitments.mockResolvedValueOnce([
        { kind: 'UNKNOWN_SUBMISSION', id: 'client-order-1', instrumentId: INSTRUMENT_ID },
      ]);

      const result = await scheduler.unregister(S1);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('FINAL_CLEANUP_UNCONFIRMED');
      expect(scheduler.getMetrics(S1)).toBeDefined();
      expect(commitmentReader.getActiveCommitments).toHaveBeenCalledWith(
        expect.objectContaining({ strategyId: S1, accountId: ACCOUNT_ID }),
      );
    });

    it('commitmentReader возвращает VENUE_ACCEPTED_SUBMISSION → entry не удаляется', async () => {
      const strategy = makeStrategy(S1);
      await scheduler.register(makeRegistration(strategy));
      commitmentReader.getActiveCommitments.mockResolvedValueOnce([
        { kind: 'VENUE_ACCEPTED_SUBMISSION', id: 'client-order-1', instrumentId: INSTRUMENT_ID },
      ]);

      const result = await scheduler.unregister(S1);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('FINAL_CLEANUP_UNCONFIRMED');
      expect(scheduler.getMetrics(S1)).toBeDefined();
    });

    it('commitmentReader бросает exception → fail-closed, entry не удаляется', async () => {
      const strategy = makeStrategy(S1);
      await scheduler.register(makeRegistration(strategy));
      commitmentReader.getActiveCommitments.mockRejectedValueOnce(new Error('journal unavailable'));

      const result = await scheduler.unregister(S1);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('FINAL_CLEANUP_UNCONFIRMED');
      expect(scheduler.getMetrics(S1)).toBeDefined();
    });

    it('openOrders пуст и commitments пусты → strategy удаляется (commitmentReader вызван)', async () => {
      const strategy = makeStrategy(S1);
      await scheduler.register(makeRegistration(strategy));
      (orderStateStore.getOpenOrders as any).mockReturnValueOnce([]);
      commitmentReader.getActiveCommitments.mockResolvedValueOnce([]);

      const result = await scheduler.unregister(S1);

      expect(result.ok).toBe(true);
      expect(scheduler.getMetrics(S1)).toBeUndefined();
      // Вызывается ДВАЖДЫ: pre-dispose post-check (шаги 7-8) + post-dispose
      // re-check (шаги 10-11) — dispose() мог занять время, за которое могли
      // появиться поздние ордера/commitments (см. _attemptStop 13-шаговый порядок).
      expect(commitmentReader.getActiveCommitments).toHaveBeenCalledTimes(2);
    });

    // ── Fresh CANCEL_ALL on every retry (P1) ─────────────

    it('каждый retry final cleanup выполняет fresh CANCEL_ALL — strategy.stop() вызывается один раз', async () => {
      const strategy = makeStrategy(S1, { stopResult: [] }); // stop() НЕ возвращает CANCEL_ALL сам
      await scheduler.register(makeRegistration(strategy));

      // Первая попытка небезопасна (authoritative post-check находит живой ордер).
      (orderStateStore.getOpenOrders as any).mockReturnValueOnce([{ id: 'still-open' }]);
      const first = await scheduler.unregister(S1);
      expect(first.ok).toBe(false);
      expect(strategy.stop).toHaveBeenCalledTimes(1);
      // finalBatch на первой попытке = [] + fresh CANCEL_ALL = [{type:'CANCEL_ALL'}]
      expect(executionEngine.execute).toHaveBeenCalledWith(
        expect.objectContaining({ strategyId: S1 }),
        [{ type: 'CANCEL_ALL' }],
      );

      // Вторая попытка — safe. strategy.stop() НЕ вызывается повторно
      // (кэширован), но CANCEL_ALL снова присутствует в batch.
      const second = await scheduler.unregister(S1);
      expect(second.ok).toBe(true);
      expect(strategy.stop).toHaveBeenCalledTimes(1);
      expect(executionEngine.execute).toHaveBeenLastCalledWith(
        expect.objectContaining({ strategyId: S1 }),
        [{ type: 'CANCEL_ALL' }],
      );
    });

    it('strategy.stop() уже вернул CANCEL_ALL — retry не дублирует его', async () => {
      const strategy = makeStrategy(S1, { stopResult: [{ type: 'CANCEL_ALL' }] });
      await scheduler.register(makeRegistration(strategy));

      const result = await scheduler.unregister(S1);
      expect(result.ok).toBe(true);
      const batch = (executionEngine.execute as any).mock.calls[0][1];
      expect(batch.filter((i: any) => i.type === 'CANCEL_ALL')).toHaveLength(1);
    });

    // ── strategy.stop() exception (P1) ──────────────────

    it('strategy.stop() бросает → STOP_HOOK_FAILED, final execute НЕ вызывается, entry остаётся, retry вызывает stop() заново', async () => {
      const strategy = makeStrategy(S1);
      (strategy.stop as any)
        .mockImplementationOnce(() => { throw new Error('stop hook boom'); })
        .mockReturnValue([{ type: 'CANCEL_ALL' }]);
      await scheduler.register(makeRegistration(strategy));

      const first = await scheduler.unregister(S1);
      expect(first.ok).toBe(false);
      if (!first.ok) {
        expect(first.error.code).toBe('STOP_HOOK_FAILED');
        expect(first.error.metadata?.cause).toBeInstanceOf(Error);
      }
      expect(executionEngine.execute).not.toHaveBeenCalled();
      expect(scheduler.getMetrics(S1)).toBeDefined();

      // Retry вызывает strategy.stop() ЗАНОВО (не кэшировано после исключения).
      const second = await scheduler.unregister(S1);
      expect(second.ok).toBe(true);
      expect(strategy.stop).toHaveBeenCalledTimes(2);
      expect(scheduler.getMetrics(S1)).toBeUndefined();
    });
  });

  // ── Dirty routing → tick ─────────────────────────────

  describe('event-driven tick', () => {
    it('should tick strategy when market data changes', async () => {
      const strategy = makeStrategy(S1, { tickResult: [{ type: 'CANCEL_ALL' }] });
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
      const strategy = makeStrategy(S1);
      await scheduler.register(makeRegistration(strategy));
      // NOT calling scheduler.start()

      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();

      expect(strategy.tick).not.toHaveBeenCalled();
    });

    it('should not tick strategy for different instrument', async () => {
      const strategy = makeStrategy(S1);
      await scheduler.register(makeRegistration(strategy));
      scheduler.start();

      marketDataStore._onChange!(asInstrumentId('token-other')!, 'BOOK');
      await flush();

      expect(strategy.tick).not.toHaveBeenCalled();
    });

    it('should pass accumulated reasons to tick', async () => {
      const strategy = makeStrategy(S1);
      await scheduler.register(makeRegistration(strategy));
      scheduler.start();

      scheduler.onOrderChanged(S1, 'FILL');
      scheduler.onOrderChanged(S1, 'ORDER_UPDATE');

      await flush();

      const reasons = (strategy.tick as any).mock.calls[0][1] as ReadonlySet<TriggerReason>;
      expect(reasons.has('FILL')).toBe(true);
      expect(reasons.has('ORDER_UPDATE')).toBe(true);
    });
  });

  // ── Crypto-asset routing (CryptoAssetId, Этап 9) ─────

  describe('crypto-asset routing', () => {
    it('should tick strategy when its normalized cryptoSymbol asset changes', async () => {
      const cryptoMarketDataStore = makeCryptoMarketDataStore();
      const d = makeDeps({ cryptoMarketDataStore: cryptoMarketDataStore as any });
      const localScheduler = new StrategyScheduler(d.deps);
      const strategy = makeStrategy(S1);
      await localScheduler.register(makeRegistration(strategy, { cryptoSymbol: 'BTCUSDT' }));
      localScheduler.start();

      cryptoMarketDataStore._onChange!('btc', 'CRYPTO_PRICE');
      await flush();

      expect(strategy.tick).toHaveBeenCalled();
    });

    it('should not tick strategy for a different crypto asset', async () => {
      const cryptoMarketDataStore = makeCryptoMarketDataStore();
      const d = makeDeps({ cryptoMarketDataStore: cryptoMarketDataStore as any });
      const localScheduler = new StrategyScheduler(d.deps);
      const strategy = makeStrategy(S1);
      await localScheduler.register(makeRegistration(strategy, { cryptoSymbol: 'BTCUSDT' }));
      localScheduler.start();

      cryptoMarketDataStore._onChange!('eth', 'CRYPTO_PRICE');
      await flush();

      expect(strategy.tick).not.toHaveBeenCalled();
    });

    it('should normalize cryptoSymbol variants (slash/dash/usd-suffix) to the same asset', async () => {
      const cryptoMarketDataStore = makeCryptoMarketDataStore();
      const d = makeDeps({ cryptoMarketDataStore: cryptoMarketDataStore as any });
      const localScheduler = new StrategyScheduler(d.deps);
      const strategy = makeStrategy(S1);
      await localScheduler.register(makeRegistration(strategy, { cryptoSymbol: 'BTC/USD' }));
      localScheduler.start();

      cryptoMarketDataStore._onChange!('btc', 'CRYPTO_MARKET_DATA');
      await flush();

      expect(strategy.tick).toHaveBeenCalled();
    });
  });

  // ── Complementary routing ────────────────────────────

  describe('complementary instrument routing', () => {
    it('события комплементарного инструмента тикают стратегию (без additionalInstrumentIds)', async () => {
      const strategy = makeStrategy(S1);
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
      const strategy = makeStrategy(S1);
      await scheduler.register(makeRegistration(strategy, {
        complementaryInstrumentId: COMP_INSTRUMENT_ID,
        complementaryAsset: COMP_ASSET_ID,
      }));
      scheduler.start();

      scheduler.onFillReceivedForInstrument(COMP_INSTRUMENT_ID);
      await flush();

      expect(strategy.tick).toHaveBeenCalledTimes(1);
    });

    it('snapshot содержит РАЗНЫЕ constraints и complementaryConstraints из каталога', async () => {
      const primaryInfo = makeInstrumentInfo();
      const compInfo = makeInstrumentInfo({ minOrderSize: Quantity.of(new Decimal('7')) });
      const catalog = makeCatalog();
      (catalog.get as any).mockImplementation((id: InstrumentId) => {
        if (String(id) === String(INSTRUMENT_ID)) return primaryInfo;
        if (String(id) === String(COMP_INSTRUMENT_ID)) return compInfo;
        return undefined;
      });
      const d = makeDeps({ catalog: catalog as any });
      const s = new StrategyScheduler(d.deps);

      let captured: StrategySnapshot | undefined;
      const strategy = makeStrategy(S1);
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

      // _constraintsFor() строит новый объект из полей catalog entry — сравниваем
      // по value-object ссылкам полей, а не по identity целого объекта.
      expect(captured).toBeDefined();
      expect(captured!.constraints?.minOrderSize).toBe(primaryInfo.minOrderSize);
      expect(captured!.complementaryConstraints?.minOrderSize).toBe(compInfo.minOrderSize);
      expect(captured!.constraints?.minOrderSize).not.toBe(captured!.complementaryConstraints?.minOrderSize);

      await s.stopAll();
      s.stop();
    });

    it('unregister удаляет complementary routing', async () => {
      const strategy = makeStrategy(S1);
      await scheduler.register(makeRegistration(strategy, {
        complementaryInstrumentId: COMP_INSTRUMENT_ID,
        complementaryAsset: COMP_ASSET_ID,
      }));
      scheduler.start();
      await scheduler.unregister(S1);

      marketDataStore._onChange!(COMP_INSTRUMENT_ID, 'BOOK');
      await flush();

      expect(strategy.tick).not.toHaveBeenCalled();
    });
  });

  // ── Throttle / priority / heartbeat (deterministic timers) ──

  describe('throttle', () => {
    it('should defer tick when within minIntervalMs (deterministic timer)', async () => {
      const strategy = makeStrategy(S1);
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
      const strategy = makeStrategy(S1);
      await scheduler.register(makeRegistration(strategy, {
        config: { minIntervalMs: 100, priorityTriggers: new Set(['FILL']) },
      }));
      scheduler.start();

      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();
      expect(strategy.tick).toHaveBeenCalledTimes(1);

      advanceTime(clock, timer, 10);
      scheduler.onOrderChanged(S1, 'FILL');
      await flush();

      expect(strategy.tick).toHaveBeenCalledTimes(2);
    });
  });

  describe('heartbeat (deterministic)', () => {
    it('advance(maxIdleMs) → TIMER tick без ожидания wall-clock', async () => {
      const strategy = makeStrategy(S1);
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
      const strategy = makeStrategy(S1);
      await scheduler.register(makeRegistration(strategy));
      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();
      expect(strategy.tick).toHaveBeenCalledTimes(1);
    });

    it('queued стратегия обрабатывается после stop()/start() без нового события', async () => {
      const strategy = makeStrategy(S1);
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
      const strategy = makeStrategy(S1);
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
      const strategy = makeStrategy(S1);
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
      const strategy = makeStrategy(S1);
      (strategy.tick as any).mockImplementation(() => { throw new Error('Tick boom'); });

      await scheduler.register(makeRegistration(strategy));
      scheduler.start();

      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();

      expect(scheduler.getMetrics(S1)).toBeDefined();
    });
  });

  // ── FILL received vs confirmed ───────────────────────

  describe('FILL_RECEIVED / FILL_CONFIRMED split', () => {
    it('onFillReceivedForInstrument: dirty+tick, cooldown НЕ снимается', async () => {
      const strategy = makeStrategy(S1);
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
      const strategy = makeStrategy(S1);
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
    it('watchdog → FAULTED: тики блокированы; unregister во время hung execution НЕ запускает final intents параллельно; после завершения — fresh cleanup', async () => {
      const strategy = makeStrategy(S1, {
        tickResult: [{ type: 'CANCEL_ALL' }],
      });

      // Execution зависает управляемо (можно разрешить позже).
      let resolveExec: (() => void) | undefined;
      executionEngine.execute.mockImplementationOnce(() => new Promise((resolve) => {
        resolveExec = () => resolve(emptyReport());
      }));

      await scheduler.register(makeRegistration(strategy, {
        config: { executionTimeoutMs: 1000 },
      }));
      scheduler.start();

      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();
      expect(strategy.tick).toHaveBeenCalledTimes(1);

      // Watchdog срабатывает → FAULTED.
      advanceTime(clock, timer, 1000);
      await flush();

      // Новые события не тикают faulted стратегию.
      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();
      expect(strategy.tick).toHaveBeenCalledTimes(1);

      // unregister пока hung execution ЕЩЁ НЕ завершилась: НЕ запускает
      // strategy.stop()/final intents параллельно с ordinary execution —
      // typed retryable error, entry остаётся tracked.
      const blockedResult = await scheduler.unregister(S1);
      expect(blockedResult.ok).toBe(false);
      if (!blockedResult.ok) expect(blockedResult.error.code).toBe('EXECUTION_TIMED_OUT');
      expect(strategy.stop).not.toHaveBeenCalled();
      expect(executionEngine.execute).toHaveBeenCalledTimes(1); // только исходный hung execute
      expect(scheduler.getMetrics(S1)).toBeDefined();

      // Hung execution наконец завершается.
      resolveExec!();
      await flush();

      // Повторный (явный) unregister теперь продолжает fresh cleanup.
      const finalResult = await scheduler.unregister(S1);
      expect(finalResult.ok).toBe(true);
      expect(strategy.stop).toHaveBeenCalledTimes(1);
      expect(scheduler.getMetrics(S1)).toBeUndefined();
    });

    it('unregister() ДО watchdog (lifecycle уже STOPPING) — watchdog всё равно срабатывает и unregister не зависает навсегда', async () => {
      const strategy = makeStrategy(S1, { tickResult: [{ type: 'CANCEL_ALL' }] });

      // Execution зависает навсегда (никогда не resolve) — имитирует по-настоящему
      // зависший venue call. Watchdog — единственный способ вырваться из ожидания.
      executionEngine.execute.mockImplementationOnce(() => new Promise(() => { /* never resolves */ }));

      await scheduler.register(makeRegistration(strategy, { config: { executionTimeoutMs: 1000 } }));
      scheduler.start();

      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();
      expect(strategy.tick).toHaveBeenCalledTimes(1);

      // unregister() вызван ДО того, как watchdog успел сработать: lifecycle
      // ACTIVE → STOPPING немедленно (в старой реализации это приводило к
      // тому, что watchdog-guard `lifecycle !== 'ACTIVE'` навсегда пропускал
      // срабатывание — execution.promise никогда не резолвится, unregister()
      // зависал бы навсегда). unregister() запускается, НЕ дожидаясь ответа
      // сразу — начинаем ждать результат гонки.
      const unregisterPromise = scheduler.unregister(S1);
      await flush();

      // К этому моменту watchdog ЕЩЁ не сработал (executionTimeoutMs не истёк) —
      // unregister ещё не разрешился.
      let settled = false;
      void unregisterPromise.then(() => { settled = true; });
      await flush();
      expect(settled).toBe(false);

      // Watchdog срабатывает, ПОКА lifecycle уже STOPPING.
      advanceTime(clock, timer, 1000);
      await flush();

      const result = await unregisterPromise;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('EXECUTION_TIMED_OUT');
      expect(strategy.stop).not.toHaveBeenCalled();
      expect(scheduler.getMetrics(S1)).toBeDefined();
    });

    it('stopAll() с одной зависшей execution не зависает навсегда — aggregate error с EXECUTION_TIMED_OUT', async () => {
      const strategy = makeStrategy(S1, { tickResult: [{ type: 'CANCEL_ALL' }] });
      executionEngine.execute.mockImplementationOnce(() => new Promise(() => { /* never resolves */ }));

      await scheduler.register(makeRegistration(strategy, { config: { executionTimeoutMs: 1000 } }));
      scheduler.start();

      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();
      expect(strategy.tick).toHaveBeenCalledTimes(1);

      const stopAllPromise = scheduler.stopAll();
      await flush();

      advanceTime(clock, timer, 1000);
      await flush();

      const result = await stopAllPromise;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.some((e) => e.code === 'EXECUTION_TIMED_OUT')).toBe(true);
      }
      expect(scheduler.getMetrics(S1)).toBeDefined();
    });
  });

  // ── Coalescing (microtask-only, без реальных sleeps) ──

  describe('coalescing', () => {
    it('события во время execution коалесцируются в один rerun', async () => {
      const strategy = makeStrategy(S1, { tickResult: [{ type: 'CANCEL_ALL' }] });

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
      const strategy = makeStrategy(S1);
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
      // Каталог по умолчанию (makeCatalog()) знает INSTRUMENT_ID — registration
      // identity validation этого требует — поэтому constraints ОПРЕДЕЛЕНЫ.
      expect(capturedSnapshot!.constraints).toBeDefined();
      expect(capturedSnapshot!.portfolio).toBe(portfolio);
      expect(typeof capturedSnapshot!.nowMs).toBe('number');
    });

    it('should populate constraints from catalog when available', async () => {
      const minOrderSize = Quantity.of(new Decimal('5'));
      const minOrderValue = Money.of(new Decimal('1'), 'USDC');
      const tickSize = OutcomePrice.of(new Decimal('0.01'));
      const catalog = makeCatalog();
      (catalog.get as any).mockReturnValue({ minOrderSize, minOrderValue, tickSize });

      const d = makeDeps({ catalog: catalog as any });
      const s = new StrategyScheduler(d.deps);

      let capturedSnapshot: StrategySnapshot | undefined;
      const strategy = makeStrategy(S1);
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

      const strategy = makeStrategy(S1);
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

  // ── ExecutionContext: routing vs tradable ────────────

  describe('execution context', () => {
    it('tradableInstrumentKeys содержит primary + complementary, НО НЕ routing-only additional', async () => {
      const strategy = makeStrategy(S1, { tickResult: [{ type: 'CANCEL_ALL' }] });
      const additional = asInstrumentId('token-3')!;
      await scheduler.register(makeRegistration(strategy, {
        complementaryInstrumentId: COMP_INSTRUMENT_ID,
        complementaryAsset: COMP_ASSET_ID,
        additionalInstrumentIds: [additional],
      }));
      scheduler.start();

      // additionalInstrumentIds триггерит tick (routing) даже не будучи tradable.
      marketDataStore._onChange!(additional, 'BOOK');
      await flush();
      expect(strategy.tick).toHaveBeenCalledTimes(1);

      const ctx = executionEngine.execute.mock.calls[0][0] as any;
      expect(ctx.tradableInstrumentKeys.has(String(INSTRUMENT_ID))).toBe(true);
      expect(ctx.tradableInstrumentKeys.has(String(COMP_INSTRUMENT_ID))).toBe(true);
      expect(ctx.tradableInstrumentKeys.has(String(additional))).toBe(false);
    });

    it('additionalTradableTargets становятся разрешёнными tradable-таргетами', async () => {
      const extraToken = '777';
      const extraInstrumentId = asInstrumentId(extraToken)!;
      const extraAsset = asPolymarketCtfToken(extraToken)!;
      const catalog = makeCatalog({
        [String(INSTRUMENT_ID)]: makeInstrumentInfo(),
        [String(extraInstrumentId)]: makeInstrumentInfo(),
      });
      const d = makeDeps({ catalog: catalog as any });
      const s = new StrategyScheduler(d.deps);

      const strategy = makeStrategy(S1, { tickResult: [{ type: 'CANCEL_ALL' }] });
      await s.register(makeRegistration(strategy, {
        additionalTradableTargets: [{ instrumentId: extraInstrumentId, asset: extraAsset }],
      }));
      s.start();

      d.marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();

      const ctx = d.executionEngine.execute.mock.calls[0][0] as any;
      expect(ctx.tradableInstrumentKeys.has(String(extraInstrumentId))).toBe(true);

      await s.stopAll();
      s.stop();
    });

    it('additionalTradableTargets автоматически входят в ROUTING (без additionalInstrumentIds) — BOOK/FILL на target вызывает tick', async () => {
      const extraToken = '888';
      const extraInstrumentId = asInstrumentId(extraToken)!;
      const extraAsset = asPolymarketCtfToken(extraToken)!;
      const catalog = makeCatalog({
        [String(INSTRUMENT_ID)]: makeInstrumentInfo(),
        [String(extraInstrumentId)]: makeInstrumentInfo(),
      });
      const d = makeDeps({ catalog: catalog as any });
      const s = new StrategyScheduler(d.deps);

      const strategy = makeStrategy(S1);
      // Только additionalTradableTargets — БЕЗ additionalInstrumentIds.
      await s.register(makeRegistration(strategy, {
        additionalTradableTargets: [{ instrumentId: extraInstrumentId, asset: extraAsset }],
      }));
      s.start();

      d.marketDataStore._onChange!(extraInstrumentId, 'BOOK');
      await flush();
      expect(strategy.tick).toHaveBeenCalledTimes(1);

      s.onFillReceivedForInstrument(extraInstrumentId);
      await flush();
      expect(strategy.tick).toHaveBeenCalledTimes(2);

      await s.stopAll();
      s.stop();
    });
  });

  // ── stopAll ──────────────────────────────────────────

  describe('stopAll', () => {
    it('should unregister all strategies via safe flow', async () => {
      const s1 = makeStrategy(S1);
      const s2 = makeStrategy(S2);
      await scheduler.register(makeRegistration(s1));
      await scheduler.register(makeRegistration(s2, {
        instrumentId: COMP_INSTRUMENT_ID,
        asset: COMP_ASSET_ID,
      }));

      const result = await scheduler.stopAll();

      expect(result.ok).toBe(true);
      expect(s1.stop).toHaveBeenCalled();
      expect(s2.stop).toHaveBeenCalled();
      expect(scheduler.getMetrics(S1)).toBeUndefined();
      expect(scheduler.getMetrics(S2)).toBeUndefined();
    });

    it('stopAll возвращает aggregate Err, если хотя бы одна стратегия не остановлена подтверждённо', async () => {
      const s1 = makeStrategy(S1);
      const s2 = makeStrategy(S2);
      await scheduler.register(makeRegistration(s1));
      await scheduler.register(makeRegistration(s2, {
        instrumentId: COMP_INSTRUMENT_ID,
        asset: COMP_ASSET_ID,
      }));

      // s2 cleanup небезопасен.
      executionEngine.execute.mockImplementation(async (ctx: any) => {
        if (ctx.strategyId === S2) {
          return { ...emptyReport(), failed: 1, errors: [{ intent: { type: 'CANCEL_ALL' }, error: new Error('x') }] };
        }
        return emptyReport();
      });

      const result = await scheduler.stopAll();

      expect(result.ok).toBe(false);
      expect(scheduler.getMetrics(S1)).toBeUndefined();
      expect(scheduler.getMetrics(S2)).toBeDefined();
    });
  });

  // ── getMetrics boundary ──────────────────────────────

  describe('getMetrics', () => {
    it('getMetrics() бросил → безопасный {} (scheduler не падает)', async () => {
      const strategy = makeStrategy(S1);
      (strategy.getMetrics as any).mockImplementation(() => { throw new Error('metrics boom'); });

      await scheduler.register(makeRegistration(strategy));

      expect(scheduler.getMetrics(S1)).toEqual({});
    });
  });

  // ── Zero CPU при idle ────────────────────────────────

  describe('zero CPU at idle', () => {
    it('should not tick without dirty events', async () => {
      const strategy = makeStrategy(S1);
      await scheduler.register(makeRegistration(strategy, { config: { maxIdleMs: 999999 } }));
      scheduler.start();

      await flush();

      expect(strategy.tick).not.toHaveBeenCalled();
    });
  });

  // ── final cleanup lifecycle (P0: bounded, retryable final cleanup) ──

  describe('final cleanup lifecycle', () => {
    it('hung final execute() → timeout → Err(FINAL_CLEANUP_TIMED_OUT), entry остаётся, dispose/post-check НЕ запускаются', async () => {
      const strategy = makeStrategy(S1);
      executionEngine.execute.mockImplementationOnce(() => new Promise(() => { /* never resolves */ }));
      await scheduler.register(makeRegistration(strategy, { config: { finalCleanupTimeoutMs: 1000 } }));

      const unregPromise = scheduler.unregister(S1);
      await flush();
      advanceTime(clock, timer, 1000);
      await flush();

      const result = await unregPromise;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('FINAL_CLEANUP_TIMED_OUT');
      expect(strategy.stop).toHaveBeenCalledTimes(1);
      expect(strategy.dispose).not.toHaveBeenCalled();
      expect(commitmentReader.getActiveCommitments).not.toHaveBeenCalled();
      expect(scheduler.getMetrics(S1)).toBeDefined();
    });

    it('repeated unregister() пока final cleanup ещё зависший — НЕ запускает второй параллельный execute()', async () => {
      const strategy = makeStrategy(S1);
      executionEngine.execute.mockImplementationOnce(() => new Promise(() => { /* never resolves */ }));
      await scheduler.register(makeRegistration(strategy, { config: { finalCleanupTimeoutMs: 1000 } }));

      const first = scheduler.unregister(S1);
      await flush();
      advanceTime(clock, timer, 1000);
      await flush();
      const firstResult = await first;
      expect(firstResult.ok).toBe(false);

      const second = await scheduler.unregister(S1);
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.error.code).toBe('FINAL_CLEANUP_TIMED_OUT');

      // execute() вызван РОВНО ОДИН раз за оба unregister — retry коалесцируется
      // на ТУ ЖЕ tracked-операцию вместо второго параллельного запуска.
      expect(executionEngine.execute).toHaveBeenCalledTimes(1);
      expect(strategy.stop).toHaveBeenCalledTimes(1);
    });

    it('поздний БЕЗОПАСНЫЙ результат ПОСЛЕ timeout → следующий unregister() использует его и завершает stop', async () => {
      const strategy = makeStrategy(S1);
      let resolveExec: (() => void) | undefined;
      executionEngine.execute.mockImplementationOnce(() => new Promise((resolve) => {
        resolveExec = () => resolve(emptyReport());
      }));
      await scheduler.register(makeRegistration(strategy, { config: { finalCleanupTimeoutMs: 1000 } }));

      const first = scheduler.unregister(S1);
      await flush();
      advanceTime(clock, timer, 1000);
      await flush();
      const firstResult = await first;
      expect(firstResult.ok).toBe(false);
      if (!firstResult.ok) expect(firstResult.error.code).toBe('FINAL_CLEANUP_TIMED_OUT');

      // Hung execute() наконец завершается БЕЗОПАСНО.
      resolveExec!();
      await flush();

      const second = await scheduler.unregister(S1);
      expect(second.ok).toBe(true);
      expect(scheduler.getMetrics(S1)).toBeUndefined();
      expect(executionEngine.execute).toHaveBeenCalledTimes(1); // не перезапускался — использован поздний результат
    });

    it('поздний НЕБЕЗОПАСНЫЙ результат ПОСЛЕ timeout → обрабатывающий вызов возвращает FINAL_CLEANUP_UNCONFIRMED, следующий ОТДЕЛЬНЫЙ attempt делает fresh CANCEL_ALL', async () => {
      const strategy = makeStrategy(S1);
      let resolveExec: ((report: any) => void) | undefined;
      executionEngine.execute.mockImplementationOnce(() => new Promise((resolve) => {
        resolveExec = resolve;
      }));
      await scheduler.register(makeRegistration(strategy, { config: { finalCleanupTimeoutMs: 1000 } }));

      const first = scheduler.unregister(S1);
      await flush();
      advanceTime(clock, timer, 1000);
      await flush();
      const firstResult = await first;
      expect(firstResult.ok).toBe(false);
      if (!firstResult.ok) expect(firstResult.error.code).toBe('FINAL_CLEANUP_TIMED_OUT');

      // Hung execute() завершается, но НЕБЕЗОПАСНО (failed > 0).
      resolveExec!({
        ...emptyReport(),
        failed: 1,
        errors: [{ intent: { type: 'CANCEL_ALL' }, error: new Error('x') }],
      });
      await flush();

      // Обрабатывающий вызов: видит поздний (небезопасный) результат зависшей операции.
      const processing = await scheduler.unregister(S1);
      expect(processing.ok).toBe(false);
      if (!processing.ok) expect(processing.error.code).toBe('FINAL_CLEANUP_UNCONFIRMED');
      expect(executionEngine.execute).toHaveBeenCalledTimes(1); // всё ещё только исходный hung

      // Следующий ОТДЕЛЬНЫЙ attempt — fresh CANCEL_ALL (новый execute()).
      executionEngine.execute.mockResolvedValueOnce(emptyReport());
      const retry = await scheduler.unregister(S1);
      expect(retry.ok).toBe(true);
      expect(executionEngine.execute).toHaveBeenCalledTimes(2);
    });

    it('stopAll() с зависшим final cleanup → aggregate FINAL_CLEANUP_TIMED_OUT, не зависает навсегда', async () => {
      const strategy = makeStrategy(S1);
      executionEngine.execute.mockImplementationOnce(() => new Promise(() => { /* never resolves */ }));
      await scheduler.register(makeRegistration(strategy, { config: { finalCleanupTimeoutMs: 1000 } }));

      const stopAllPromise = scheduler.stopAll();
      await flush();
      advanceTime(clock, timer, 1000);
      await flush();

      const result = await stopAllPromise;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.some((e) => e.code === 'FINAL_CLEANUP_TIMED_OUT')).toBe(true);
      }
      expect(scheduler.getMetrics(S1)).toBeDefined();
    });
  });

  // ── disposal lifecycle (P1: bounded, non-reentrant ACTIVE dispose) ──

  describe('disposal lifecycle', () => {
    it('dispose() успешен → Ok, entry удалена, dispose() вызван ровно один раз', async () => {
      const strategy = makeStrategy(S1);
      await scheduler.register(makeRegistration(strategy));

      const result = await scheduler.unregister(S1);

      expect(result.ok).toBe(true);
      expect(strategy.dispose).toHaveBeenCalledTimes(1);
      expect(scheduler.getMetrics(S1)).toBeUndefined();
    });

    it('dispose() возвращает Err → DISPOSE_FAILED, entry остаётся, retry вызывает dispose() снова', async () => {
      const strategy = makeStrategy(S1);
      await scheduler.register(makeRegistration(strategy));
      (strategy.dispose as any).mockResolvedValueOnce(Err(new Error('dispose boom')));

      const first = await scheduler.unregister(S1);
      expect(first.ok).toBe(false);
      if (!first.ok) expect(first.error.code).toBe('DISPOSE_FAILED');
      expect(scheduler.getMetrics(S1)).toBeDefined();
      expect(strategy.dispose).toHaveBeenCalledTimes(1);

      const second = await scheduler.unregister(S1);
      expect(second.ok).toBe(true);
      expect(strategy.dispose).toHaveBeenCalledTimes(2);
      expect(scheduler.getMetrics(S1)).toBeUndefined();
    });

    it('dispose() бросает исключение (ACTIVE shutdown) → DISPOSE_FAILED, не проглатывается', async () => {
      const strategy = makeStrategy(S1);
      await scheduler.register(makeRegistration(strategy));
      (strategy.dispose as any).mockRejectedValueOnce(new Error('dispose threw'));

      const result = await scheduler.unregister(S1);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('DISPOSE_FAILED');
      expect(scheduler.getMetrics(S1)).toBeDefined();
    });

    it('dispose() зависает → DISPOSE_TIMED_OUT, entry остаётся, retry коалесцируется (НЕ второй параллельный dispose)', async () => {
      const strategy = makeStrategy(S1);
      let resolveDispose: ((r: Result<void, Error>) => void) | undefined;
      (strategy.dispose as any).mockImplementationOnce(() => new Promise((resolve) => { resolveDispose = resolve; }));
      await scheduler.register(makeRegistration(strategy, { config: { disposeTimeoutMs: 1000 } }));

      // Больше итераций flush: перед dispose() (шаг 9) должны фактически
      // ЗАВЕРШИТЬСЯ final cleanup (шаг 5) и pre-dispose commitment-check (шаг
      // 8) — каждый из них сам по себе цепочка из нескольких microtask-хопов
      // (tracked-operation promise chain + Promise.race), поэтому watchdog
      // dispose() регистрируется НЕ сразу после вызова unregister().
      const first = scheduler.unregister(S1);
      await flush(30);
      advanceTime(clock, timer, 1000);
      await flush();

      const firstResult = await first;
      expect(firstResult.ok).toBe(false);
      if (!firstResult.ok) expect(firstResult.error.code).toBe('DISPOSE_TIMED_OUT');
      expect(strategy.dispose).toHaveBeenCalledTimes(1);

      const second = await scheduler.unregister(S1);
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.error.code).toBe('DISPOSE_TIMED_OUT');
      expect(strategy.dispose).toHaveBeenCalledTimes(1); // не второй параллельный вызов

      resolveDispose!(Ok(undefined));
    });

    it('поздний Ok ПОСЛЕ dispose timeout → следующий unregister() видит завершённую операцию (disposed=true), продолжает', async () => {
      const strategy = makeStrategy(S1);
      let resolveDispose: ((r: Result<void, Error>) => void) | undefined;
      (strategy.dispose as any).mockImplementationOnce(() => new Promise((resolve) => { resolveDispose = resolve; }));
      await scheduler.register(makeRegistration(strategy, { config: { disposeTimeoutMs: 1000 } }));

      const first = scheduler.unregister(S1);
      await flush(30);
      advanceTime(clock, timer, 1000);
      await flush();
      const firstResult = await first;
      expect(firstResult.ok).toBe(false);
      if (!firstResult.ok) expect(firstResult.error.code).toBe('DISPOSE_TIMED_OUT');

      resolveDispose!(Ok(undefined));
      await flush();

      const second = await scheduler.unregister(S1);
      expect(second.ok).toBe(true);
      expect(strategy.dispose).toHaveBeenCalledTimes(1); // не вызван повторно
      expect(scheduler.getMetrics(S1)).toBeUndefined();
    });

    it('пост-dispose recheck небезопасен → entry остаётся, disposed=true (dispose НЕ вызывается повторно), следующий retry делает fresh CANCEL_ALL', async () => {
      const strategy = makeStrategy(S1);
      await scheduler.register(makeRegistration(strategy));

      commitmentReader.getActiveCommitments
        .mockResolvedValueOnce([]) // pre-dispose (шаг 8) — чисто
        .mockResolvedValueOnce([{ kind: 'UNKNOWN_SUBMISSION', id: 'x', instrumentId: INSTRUMENT_ID }]); // post-dispose (шаг 11)

      const first = await scheduler.unregister(S1);
      expect(first.ok).toBe(false);
      if (!first.ok) expect(first.error.code).toBe('FINAL_CLEANUP_UNCONFIRMED');
      expect(strategy.dispose).toHaveBeenCalledTimes(1);
      expect(scheduler.getMetrics(S1)).toBeDefined();

      commitmentReader.getActiveCommitments.mockResolvedValue([]);
      const second = await scheduler.unregister(S1);
      expect(second.ok).toBe(true);
      expect(strategy.dispose).toHaveBeenCalledTimes(1); // всё ещё один раз — disposed=true, не переисполняется
      expect(executionEngine.execute).toHaveBeenCalledTimes(2); // fresh CANCEL_ALL на retry
    });
  });

  // ── pending registration disposal (persistent tombstone) ──

  describe('pending registration disposal', () => {
    it('retry после dispose() Err успевает — tombstone удаляется, повторный unregister ПОСЛЕ этого возвращает STRATEGY_NOT_FOUND', async () => {
      let resolveInit: ((r: Result<void, Error>) => void) | undefined;
      const strategy = makeStrategy(S1);
      (strategy.initialize as any).mockImplementation(() => new Promise((resolve) => { resolveInit = resolve; }));
      (strategy.dispose as any).mockResolvedValueOnce(Err(new Error('dispose boom')));

      void scheduler.register(makeRegistration(strategy));
      await flush();

      const firstUnreg = scheduler.unregister(S1);
      await flush();
      resolveInit!(Ok(undefined));
      const firstResult = await firstUnreg;

      expect(firstResult.ok).toBe(false);
      if (!firstResult.ok) expect(firstResult.error.code).toBe('DISPOSE_FAILED');
      expect(strategy.dispose).toHaveBeenCalledTimes(1);

      const retryResult = await scheduler.unregister(S1);
      expect(retryResult.ok).toBe(true);
      expect(strategy.dispose).toHaveBeenCalledTimes(2);

      const afterResult = await scheduler.unregister(S1);
      expect(afterResult.ok).toBe(false);
      if (!afterResult.ok) expect(afterResult.error.code).toBe('STRATEGY_NOT_FOUND');
    });

    it('зависший dispose() (PendingDisposal) блокирует новую регистрацию с тем же ID', async () => {
      let resolveInit: ((r: Result<void, Error>) => void) | undefined;
      const strategy = makeStrategy(S1);
      (strategy.initialize as any).mockImplementation(() => new Promise((resolve) => { resolveInit = resolve; }));
      (strategy.dispose as any).mockImplementationOnce(() => new Promise(() => { /* never resolves */ }));

      void scheduler.register(makeRegistration(strategy, { config: { disposeTimeoutMs: 1000 } }));
      await flush();

      const unregPromise = scheduler.unregister(S1);
      await flush();
      resolveInit!(Ok(undefined));
      await flush();
      advanceTime(clock, timer, 1000);
      await flush();

      const unregResult = await unregPromise;
      expect(unregResult.ok).toBe(false);
      if (!unregResult.ok) expect(unregResult.error.code).toBe('DISPOSE_TIMED_OUT');

      const strategy2 = makeStrategy(S1);
      const registerResult = await scheduler.register(makeRegistration(strategy2));
      expect(registerResult.ok).toBe(false);
    });

    it('stopAll видит PendingDisposal (dispose() Err) и возвращает aggregate DISPOSE_FAILED', async () => {
      let resolveInit: ((r: Result<void, Error>) => void) | undefined;
      const strategy = makeStrategy(S1);
      (strategy.initialize as any).mockImplementation(() => new Promise((resolve) => { resolveInit = resolve; }));
      (strategy.dispose as any).mockResolvedValue(Err(new Error('dispose boom')));

      void scheduler.register(makeRegistration(strategy));
      await flush();

      const unregPromise = scheduler.unregister(S1);
      await flush();
      resolveInit!(Ok(undefined));
      const unregResult = await unregPromise;
      expect(unregResult.ok).toBe(false);
      if (!unregResult.ok) expect(unregResult.error.code).toBe('DISPOSE_FAILED');

      const stopAllResult = await scheduler.stopAll();
      expect(stopAllResult.ok).toBe(false);
      if (!stopAllResult.ok) {
        expect(stopAllResult.error.some((e) => e.code === 'DISPOSE_FAILED')).toBe(true);
      }
    });

    it('после успешного retry dispose() — новая регистрация с тем же ID снова разрешена', async () => {
      let resolveInit: ((r: Result<void, Error>) => void) | undefined;
      const strategy = makeStrategy(S1);
      (strategy.initialize as any).mockImplementation(() => new Promise((resolve) => { resolveInit = resolve; }));
      (strategy.dispose as any).mockResolvedValueOnce(Err(new Error('dispose boom')));

      void scheduler.register(makeRegistration(strategy));
      await flush();
      const unregPromise = scheduler.unregister(S1);
      await flush();
      resolveInit!(Ok(undefined));
      await unregPromise;

      const retryResult = await scheduler.unregister(S1);
      expect(retryResult.ok).toBe(true);

      const strategy2 = makeStrategy(S1);
      const registerResult = await scheduler.register(makeRegistration(strategy2));
      expect(registerResult.ok).toBe(true);
    });
  });

  // ── additional tradable snapshots (end-to-end additionalTradableTargets) ──

  describe('additional tradable snapshots', () => {
    it('snapshot.additionalTradableInstruments содержит корректный per-инструмент срез', async () => {
      const extraToken = '999';
      const extraInstrumentId = asInstrumentId(extraToken)!;
      const extraAsset = asPolymarketCtfToken(extraToken)!;
      const extraConstraints = makeInstrumentInfo();
      const catalog = makeCatalog({
        [String(INSTRUMENT_ID)]: makeInstrumentInfo(),
        [String(extraInstrumentId)]: extraConstraints,
      });
      const d = makeDeps({ catalog: catalog as any });
      const s = new StrategyScheduler(d.deps);

      const extraOrder = { id: 'order-extra-1' } as any;
      (d.orderStateStore.getOpenOrdersByInstrument as any).mockImplementation(
        (_sid: string, instrId: InstrumentId) => (String(instrId) === String(extraInstrumentId) ? [extraOrder] : []),
      );
      (d.orderStateStore.hasUnsettledFills as any).mockImplementation(
        (instrId: InstrumentId) => String(instrId) === String(extraInstrumentId),
      );

      const strategy = makeStrategy(S1, { tickResult: [] });
      await s.register(makeRegistration(strategy, {
        additionalTradableTargets: [{ instrumentId: extraInstrumentId, asset: extraAsset }],
      }));
      s.start();

      d.marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();

      const snapshot = (strategy.tick as any).mock.calls[0][0] as StrategySnapshot;
      const extraSnapshot = snapshot.additionalTradableInstruments.get(String(extraInstrumentId));
      expect(extraSnapshot).toBeDefined();
      expect(extraSnapshot?.instrumentId).toBe(extraInstrumentId);
      expect(extraSnapshot?.asset).toBe(extraAsset);
      expect(extraSnapshot?.openOrders).toEqual([extraOrder]);
      expect(extraSnapshot?.hasUnsettledFills).toBe(true);
      expect(extraSnapshot?.constraints).toEqual({
        minOrderSize: extraConstraints.minOrderSize,
        minOrderValue: extraConstraints.minOrderValue,
        tickSize: extraConstraints.tickSize,
      });

      await s.stopAll();
      s.stop();
    });

    it('commitmentReader получает additional instrumentId в instrumentIds', async () => {
      const extraToken = '555';
      const extraInstrumentId = asInstrumentId(extraToken)!;
      const extraAsset = asPolymarketCtfToken(extraToken)!;
      const catalog = makeCatalog({
        [String(INSTRUMENT_ID)]: makeInstrumentInfo(),
        [String(extraInstrumentId)]: makeInstrumentInfo(),
      });
      const d = makeDeps({ catalog: catalog as any });
      const s = new StrategyScheduler(d.deps);

      const strategy = makeStrategy(S1);
      await s.register(makeRegistration(strategy, {
        additionalTradableTargets: [{ instrumentId: extraInstrumentId, asset: extraAsset }],
      }));

      await s.unregister(S1);

      expect(d.commitmentReader.getActiveCommitments).toHaveBeenCalledWith(
        expect.objectContaining({
          instrumentIds: expect.arrayContaining([INSTRUMENT_ID, extraInstrumentId]),
        }),
      );
    });

    it('unresolved commitment на additional target блокирует удаление (FINAL_CLEANUP_UNCONFIRMED)', async () => {
      const extraToken = '444';
      const extraInstrumentId = asInstrumentId(extraToken)!;
      const extraAsset = asPolymarketCtfToken(extraToken)!;
      const catalog = makeCatalog({
        [String(INSTRUMENT_ID)]: makeInstrumentInfo(),
        [String(extraInstrumentId)]: makeInstrumentInfo(),
      });
      const d = makeDeps({ catalog: catalog as any });
      const s = new StrategyScheduler(d.deps);

      d.commitmentReader.getActiveCommitments.mockResolvedValueOnce([
        { kind: 'UNKNOWN_SUBMISSION', id: 'x', instrumentId: extraInstrumentId },
      ]);

      const strategy = makeStrategy(S1);
      await s.register(makeRegistration(strategy, {
        additionalTradableTargets: [{ instrumentId: extraInstrumentId, asset: extraAsset }],
      }));

      const result = await s.unregister(S1);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('FINAL_CLEANUP_UNCONFIRMED');

      d.commitmentReader.getActiveCommitments.mockResolvedValue([]);
      await s.stopAll();
      s.stop();
    });

    it('additionalTradableTargets: совпадение с primary instrumentId отклоняется при регистрации', async () => {
      const strategy = makeStrategy(S1);
      const result = await scheduler.register(makeRegistration(strategy, {
        additionalTradableTargets: [{ instrumentId: INSTRUMENT_ID, asset: ASSET_ID }],
      }));
      expect(result.ok).toBe(false);
    });

    it('additionalTradableTargets: дубликат ТОЙ ЖЕ пары молча схлопывается (не Err)', async () => {
      const extraToken = '222999';
      const extraInstrumentId = asInstrumentId(extraToken)!;
      const extraAsset = asPolymarketCtfToken(extraToken)!;
      const catalog = makeCatalog({
        [String(INSTRUMENT_ID)]: makeInstrumentInfo(),
        [String(extraInstrumentId)]: makeInstrumentInfo(),
      });
      const d = makeDeps({ catalog: catalog as any });
      const s = new StrategyScheduler(d.deps);

      const strategy = makeStrategy(S1, { tickResult: [] });
      const result = await s.register(makeRegistration(strategy, {
        additionalTradableTargets: [
          { instrumentId: extraInstrumentId, asset: extraAsset },
          { instrumentId: extraInstrumentId, asset: extraAsset },
        ],
      }));

      expect(result.ok).toBe(true);

      await s.stopAll();
      s.stop();
    });

    it('additionalTradableTargets: дубликат instrumentId с несовпадающим (невалидным для него) asset отклоняется при регистрации', async () => {
      const extraToken = '333';
      const extraInstrumentId = asInstrumentId(extraToken)!;
      const extraAsset = asPolymarketCtfToken(extraToken)!;
      const otherAsset = asPolymarketCtfToken('333999')!; // валиден, но НЕ соответствует extraInstrumentId
      const catalog = makeCatalog({
        [String(INSTRUMENT_ID)]: makeInstrumentInfo(),
        [String(extraInstrumentId)]: makeInstrumentInfo(),
      });
      const d = makeDeps({ catalog: catalog as any });
      const s = new StrategyScheduler(d.deps);

      const strategy = makeStrategy(S1);
      const result = await s.register(makeRegistration(strategy, {
        additionalTradableTargets: [
          { instrumentId: extraInstrumentId, asset: extraAsset },
          { instrumentId: extraInstrumentId, asset: otherAsset },
        ],
      }));

      expect(result.ok).toBe(false);
    });
  });

  // ── shutdown timeouts (bounded pending-initialize wait + bounded commitment reader) ──

  describe('shutdown timeouts', () => {
    it('unregister() во время hung initialize() превышает cancellationTimeoutMs → Err(INITIALIZATION_CANCELLATION_TIMED_OUT), initialize() продолжает выполняться', async () => {
      let resolveInit: ((r: Result<void, Error>) => void) | undefined;
      const strategy = makeStrategy(S1);
      (strategy.initialize as any).mockImplementation(() => new Promise((resolve) => { resolveInit = resolve; }));

      const registerPromise = scheduler.register(makeRegistration(strategy, {
        config: { initializationCancellationTimeoutMs: 1000 },
      }));
      await flush();

      const unregPromise = scheduler.unregister(S1);
      await flush();
      advanceTime(clock, timer, 1000);
      await flush();

      const unregResult = await unregPromise;
      expect(unregResult.ok).toBe(false);
      if (!unregResult.ok) expect(unregResult.error.code).toBe('INITIALIZATION_CANCELLATION_TIMED_OUT');

      // initialize() НЕ отменяется — завершаем его штатно.
      resolveInit!(Ok(undefined));
      const registerResult = await registerPromise;
      expect(registerResult.ok).toBe(false); // регистрация всё равно отменена (cancelled=true)
      expect(scheduler.getMetrics(S1)).toBeUndefined(); // ACTIVE entry никогда не публикуется
    });

    it('repeated unregister() пока initialize() ещё hung — не дублирует; после завершения создаётся PendingDisposal и вызывается dispose()', async () => {
      let resolveInit: ((r: Result<void, Error>) => void) | undefined;
      const strategy = makeStrategy(S1);
      (strategy.initialize as any).mockImplementation(() => new Promise((resolve) => { resolveInit = resolve; }));

      void scheduler.register(makeRegistration(strategy, {
        config: { initializationCancellationTimeoutMs: 1000 },
      }));
      await flush();

      const first = scheduler.unregister(S1);
      await flush();
      advanceTime(clock, timer, 1000);
      await flush();
      const firstResult = await first;
      expect(firstResult.ok).toBe(false);
      if (!firstResult.ok) expect(firstResult.error.code).toBe('INITIALIZATION_CANCELLATION_TIMED_OUT');

      const second = scheduler.unregister(S1);
      await flush();
      advanceTime(clock, timer, 1000);
      await flush();
      const secondResult = await second;
      expect(secondResult.ok).toBe(false);
      if (!secondResult.ok) expect(secondResult.error.code).toBe('INITIALIZATION_CANCELLATION_TIMED_OUT');

      expect(strategy.initialize).toHaveBeenCalledTimes(1); // не перезапущен

      resolveInit!(Ok(undefined));
      await flush();

      expect(strategy.dispose).toHaveBeenCalledTimes(1);
      expect(scheduler.getMetrics(S1)).toBeUndefined();
    });

    it('stopAll() с зависшим initialize() → aggregate INITIALIZATION_CANCELLATION_TIMED_OUT, не зависает', async () => {
      let resolveInit: ((r: Result<void, Error>) => void) | undefined;
      const strategy = makeStrategy(S1);
      (strategy.initialize as any).mockImplementation(() => new Promise((resolve) => { resolveInit = resolve; }));

      void scheduler.register(makeRegistration(strategy, {
        config: { initializationCancellationTimeoutMs: 1000 },
      }));
      await flush();

      const stopAllPromise = scheduler.stopAll();
      await flush();
      advanceTime(clock, timer, 1000);
      await flush();

      const result = await stopAllPromise;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.some((e) => e.code === 'INITIALIZATION_CANCELLATION_TIMED_OUT')).toBe(true);
      }

      resolveInit!(Ok(undefined));
      await flush();
    });

    it('зависший commitmentReader.getActiveCommitments() → timeout → Err(COMMITMENT_CHECK_TIMED_OUT), entry остаётся', async () => {
      const strategy = makeStrategy(S1);
      commitmentReader.getActiveCommitments.mockImplementationOnce(() => new Promise(() => { /* never resolves */ }));
      await scheduler.register(makeRegistration(strategy, { config: { commitmentCheckTimeoutMs: 1000 } }));

      // Больше итераций flush: перед commitment-check (шаг 8) должен фактически
      // ЗАВЕРШИТЬСЯ final cleanup (шаг 5) — сам по себе цепочка из нескольких
      // microtask-хопов (tracked-operation promise chain + Promise.race).
      const unregPromise = scheduler.unregister(S1);
      await flush(30);
      advanceTime(clock, timer, 1000);
      await flush();

      const result = await unregPromise;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('COMMITMENT_CHECK_TIMED_OUT');
      expect(strategy.dispose).not.toHaveBeenCalled();
      expect(scheduler.getMetrics(S1)).toBeDefined();
    });

    it('repeated unregister() пока commitmentReader ещё hung — не дублирует вызов', async () => {
      const strategy = makeStrategy(S1);
      commitmentReader.getActiveCommitments.mockImplementationOnce(() => new Promise(() => { /* never resolves */ }));
      await scheduler.register(makeRegistration(strategy, { config: { commitmentCheckTimeoutMs: 1000 } }));

      const first = scheduler.unregister(S1);
      await flush(30);
      advanceTime(clock, timer, 1000);
      await flush();
      const firstResult = await first;
      expect(firstResult.ok).toBe(false);

      const second = await scheduler.unregister(S1);
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.error.code).toBe('COMMITMENT_CHECK_TIMED_OUT');

      expect(commitmentReader.getActiveCommitments).toHaveBeenCalledTimes(1);
    });

    it('поздний safe результат ПОСЛЕ commitment-check timeout → следующий unregister() обрабатывает его и продолжает', async () => {
      const strategy = makeStrategy(S1);
      let resolveCommitments: ((r: unknown[]) => void) | undefined;
      commitmentReader.getActiveCommitments.mockImplementationOnce(() => new Promise((resolve) => { resolveCommitments = resolve; }));
      await scheduler.register(makeRegistration(strategy, { config: { commitmentCheckTimeoutMs: 1000 } }));

      const first = scheduler.unregister(S1);
      await flush(30);
      advanceTime(clock, timer, 1000);
      await flush();
      const firstResult = await first;
      expect(firstResult.ok).toBe(false);
      if (!firstResult.ok) expect(firstResult.error.code).toBe('COMMITMENT_CHECK_TIMED_OUT');

      resolveCommitments!([]);
      await flush();

      const second = await scheduler.unregister(S1);
      expect(second.ok).toBe(true);
      // 2 вызова: исходный (поздно обработанный на шаге pre-dispose post-check) +
      // fresh на post-dispose re-check (см. _attemptStop 13-шаговый порядок).
      expect(commitmentReader.getActiveCommitments).toHaveBeenCalledTimes(2);
      expect(scheduler.getMetrics(S1)).toBeUndefined();
    });
  });

  // ── stopAll immediate detach (P0) ─────────────────────

  describe('stopAll immediate detach', () => {
    it('stopAll() детачит ACTIVE entry СИНХРОННО — до ожидания зависшего pending initialize() другой стратегии', async () => {
      const strategy1 = makeStrategy(S1);
      await scheduler.register(makeRegistration(strategy1));
      scheduler.start();

      // Отдельная pending registration с зависшим initialize() — раньше
      // stopAll() ждал бы ЕЁ completion ПЕРЕД тем как вообще начать
      // unregister() существующих ACTIVE entries.
      let resolveInit: ((r: Result<void, Error>) => void) | undefined;
      const strategy2 = makeStrategy(S2);
      (strategy2.initialize as any).mockImplementation(() => new Promise((resolve) => { resolveInit = resolve; }));
      void scheduler.register(makeRegistration(strategy2, {
        instrumentId: COMP_INSTRUMENT_ID,
        asset: COMP_ASSET_ID,
      }));
      await flush();

      const stopAllPromise = scheduler.stopAll();

      // Никакого timer advance — initialize() s2 всё ещё висит. Проверяем
      // НЕМЕДЛЕННО, что s1 уже detached: события её больше не тикают.
      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();
      expect(strategy1.tick).not.toHaveBeenCalled();

      scheduler.onOrderChanged(S1, 'ORDER_UPDATE');
      await flush();
      expect(strategy1.tick).not.toHaveBeenCalled();

      scheduler.onFillReceivedForInstrument(INSTRUMENT_ID);
      await flush();
      expect(strategy1.tick).not.toHaveBeenCalled();

      // heartbeat: продвигаем время ЗА s1.config.maxIdleMs (default 5000), но
      // СИЛЬНО МЕНЬШЕ default cancellationTimeoutMs (30000) — иначе s2's
      // pending-init wait сам истёк бы раньше, чем мы успеем разрешить
      // initialize() вручную. Если heartbeat не был очищен при detach — TIMER
      // поставил бы s1 обратно в очередь.
      advanceTime(clock, timer, 6000);
      await flush();
      expect(strategy1.tick).not.toHaveBeenCalled();

      resolveInit!(Ok(undefined));
      const result = await stopAllPromise;
      expect(result.ok).toBe(true);
    });

    it('stopAll(): ACTIVE entry с уже идущим ordinary execution немедленно STOPPING+detached; stopAll ждёт его через существующий bounded stop-flow; второй ordinary execution не запускается', async () => {
      const strategy = makeStrategy(S1, { tickResult: [{ type: 'CANCEL_ALL' }] });
      let resolveExec: (() => void) | undefined;
      executionEngine.execute.mockImplementationOnce(() => new Promise((resolve) => {
        resolveExec = () => resolve(emptyReport());
      }));
      await scheduler.register(makeRegistration(strategy));
      scheduler.start();

      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();
      expect(strategy.tick).toHaveBeenCalledTimes(1);
      expect(executionEngine.execute).toHaveBeenCalledTimes(1); // ordinary execution зависла

      const stopAllPromise = scheduler.stopAll();
      await flush();

      // Detach уже произошёл — новые события больше не тикают s1.
      marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();
      expect(strategy.tick).toHaveBeenCalledTimes(1); // не увеличилось

      // execute() всё ещё вызван только один раз — stopAll НЕ запускает
      // второй (ordinary) execute параллельно зависшему.
      expect(executionEngine.execute).toHaveBeenCalledTimes(1);

      resolveExec!();
      const result = await stopAllPromise;
      expect(result.ok).toBe(true);
    });

    it('stopAll(): несколько ACTIVE strategies + pending registration + pre-existing PendingDisposal — ACTIVE entries детачатся немедленно, дальше все bounded operations ждутся параллельно', async () => {
      const tok3 = '777001';
      const tok4 = '777002';
      const id3 = asInstrumentId(tok3)!;
      const asset3 = asPolymarketCtfToken(tok3)!;
      const id4 = asInstrumentId(tok4)!;
      const asset4 = asPolymarketCtfToken(tok4)!;
      const catalog = makeCatalog({
        [String(INSTRUMENT_ID)]: makeInstrumentInfo(),
        [String(COMP_INSTRUMENT_ID)]: makeInstrumentInfo(),
        [String(id3)]: makeInstrumentInfo(),
        [String(id4)]: makeInstrumentInfo(),
      });
      const d = makeDeps({ catalog: catalog as any });
      const s = new StrategyScheduler(d.deps);

      const s1 = makeStrategy(S1);
      const s2 = makeStrategy(S2);
      await s.register(makeRegistration(s1));
      await s.register(makeRegistration(s2, { instrumentId: COMP_INSTRUMENT_ID, asset: COMP_ASSET_ID }));
      s.start();

      // Pre-existing PendingDisposal (создан ДО вызова stopAll — предыдущая
      // неудачная попытка dispose() отменённой регистрации s3).
      let resolveInit3: ((r: Result<void, Error>) => void) | undefined;
      const s3 = makeStrategy(S3);
      (s3.initialize as any).mockImplementation(() => new Promise((resolve) => { resolveInit3 = resolve; }));
      (s3.dispose as any).mockResolvedValueOnce(Err(new Error('dispose boom')));
      void s.register(makeRegistration(s3, { instrumentId: id3, asset: asset3 }));
      await flush();
      const unreg3 = s.unregister(S3);
      await flush();
      resolveInit3!(Ok(undefined));
      const unreg3Result = await unreg3;
      expect(unreg3Result.ok).toBe(false);
      if (!unreg3Result.ok) expect(unreg3Result.error.code).toBe('DISPOSE_FAILED');

      // Отдельная pending registration с зависшим initialize() (s4).
      let resolveInit4: ((r: Result<void, Error>) => void) | undefined;
      const s4 = makeStrategy(S4);
      (s4.initialize as any).mockImplementation(() => new Promise((resolve) => { resolveInit4 = resolve; }));
      void s.register(makeRegistration(s4, { instrumentId: id4, asset: asset4 }));
      await flush();

      const stopAllPromise = s.stopAll();
      await flush();

      // ACTIVE entries (s1/s2) уже detached — немедленно, до разрешения
      // pending initialize s4 и pending disposal s3.
      d.marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      d.marketDataStore._onChange!(COMP_INSTRUMENT_ID, 'BOOK');
      await flush();
      expect(s1.tick).not.toHaveBeenCalled();
      expect(s2.tick).not.toHaveBeenCalled();

      // Разрешаем зависший initialize s4 — stopAll может продолжить.
      resolveInit4!(Ok(undefined));
      const result = await stopAllPromise;

      expect(result.ok).toBe(true);
      // s3's dispose() retried и на этот раз успел (default mock Ok) — как
      // часть stopAll's disposal-aggregation шага.
      expect(s3.dispose).toHaveBeenCalledTimes(2);

      s.stop();
    });
  });

  // ── strategy.stop() runtime intent validation (P1) ────

  describe('strategy.stop() runtime intent validation', () => {
    const malformedStopResults: readonly (readonly [string, unknown])[] = [
      ['undefined', undefined],
      ['null', null],
      ['number (42)', 42],
      ['empty object ({})', {}],
      ['string ("cancel")', 'cancel'],
      ['[null]', [null]],
      ['[42]', [42]],
      ['[{}]', [{}]],
      ['[{ type: PLACE, ... }]', [{ type: 'PLACE', side: 'BUY', price: 1, size: 1 }]],
      ['[{ type: CANCEL }] (без orderId)', [{ type: 'CANCEL' }]],
      ['[{ type: CANCEL, orderId: undefined }]', [{ type: 'CANCEL', orderId: undefined }]],
      ['[{ type: CANCEL, orderId: "" }]', [{ type: 'CANCEL', orderId: '' }]],
      ['[{ type: UNKNOWN }]', [{ type: 'UNKNOWN' }]],
    ];

    it.each(malformedStopResults)(
      'malformed strategy.stop() результат (%s) → Err(UNSAFE_FINAL_INTENT), unregister() НЕ rejects',
      async (_label, malformed) => {
        const strategy = makeStrategy(S1);
        // Симуляция стратегии, пришедшей из JavaScript/повреждённого plugin-а —
        // TypeScript-контракт `stop(): StrategyStopIntent[]` здесь намеренно
        // обходится unsafe cast ТОЛЬКО в тесте (не в production-коде), чтобы
        // проверить runtime boundary на реально произвольном значении.
        (strategy.stop as any).mockReturnValue(malformed);
        await scheduler.register(makeRegistration(strategy));

        const result = await scheduler.unregister(S1);

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe('UNSAFE_FINAL_INTENT');
        expect(executionEngine.execute).not.toHaveBeenCalled();
        expect(strategy.dispose).not.toHaveBeenCalled();
        expect(scheduler.getMetrics(S1)).toBeDefined();
      },
    );

    it('getter, бросающий при чтении type → Err(UNSAFE_FINAL_INTENT), unregister() НЕ rejects', async () => {
      const strategy = makeStrategy(S1);
      const malformed = {
        get type(): never {
          throw new Error('getter failure');
        },
      };
      (strategy.stop as any).mockReturnValue([malformed]);
      await scheduler.register(makeRegistration(strategy));

      const result = await scheduler.unregister(S1);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('UNSAFE_FINAL_INTENT');
      expect(scheduler.getMetrics(S1)).toBeDefined();
    });

    it('корректный CANCEL_ALL → validation проходит, final cleanup исполняется', async () => {
      const strategy = makeStrategy(S1, { stopResult: [{ type: 'CANCEL_ALL' }] });
      await scheduler.register(makeRegistration(strategy));

      const result = await scheduler.unregister(S1);

      expect(result.ok).toBe(true);
      expect(executionEngine.execute).toHaveBeenCalledTimes(1);
    });

    it('корректный CANCEL с валидным orderId → validation проходит, orderId сохраняется в final batch', async () => {
      const strategy = makeStrategy(S1);
      (strategy.stop as any).mockReturnValue([{ type: 'CANCEL', orderId: 'order-abc-123' }]);
      await scheduler.register(makeRegistration(strategy));

      const result = await scheduler.unregister(S1);

      expect(result.ok).toBe(true);
      const finalBatch = (executionEngine.execute as any).mock.calls[0][1];
      expect(finalBatch).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'CANCEL', orderId: 'order-abc-123' }),
        expect.objectContaining({ type: 'CANCEL_ALL' }),
      ]));
    });
  });

  // ── stopAll pending disposal error dedup (P2) ─────────

  describe('stopAll pending disposal error dedup', () => {
    it('PendingDisposal dispose() timeout → stopAll возвращает РОВНО ОДНУ ошибку для strategyId (DISPOSE_TIMED_OUT, без дублирующего generic DISPOSE_FAILED)', async () => {
      let resolveInit: ((r: Result<void, Error>) => void) | undefined;
      const strategy = makeStrategy(S1);
      (strategy.initialize as any).mockImplementation(() => new Promise((resolve) => { resolveInit = resolve; }));
      (strategy.dispose as any).mockImplementationOnce(() => new Promise(() => { /* never resolves */ }));

      void scheduler.register(makeRegistration(strategy, { config: { disposeTimeoutMs: 1000 } }));
      await flush();

      const unregPromise = scheduler.unregister(S1);
      await flush();
      resolveInit!(Ok(undefined));
      await flush();
      advanceTime(clock, timer, 1000);
      await flush();
      const unregResult = await unregPromise;
      expect(unregResult.ok).toBe(false);
      if (!unregResult.ok) expect(unregResult.error.code).toBe('DISPOSE_TIMED_OUT');

      const stopAllResult = await scheduler.stopAll();
      expect(stopAllResult.ok).toBe(false);
      if (!stopAllResult.ok) {
        const s1Errors = stopAllResult.error.filter((e) => e.strategyId === S1);
        expect(s1Errors).toHaveLength(1);
        expect(s1Errors[0].code).toBe('DISPOSE_TIMED_OUT');
      }
    });

    it('PendingDisposal dispose() Err → stopAll возвращает РОВНО ОДНУ DISPOSE_FAILED для strategyId', async () => {
      let resolveInit: ((r: Result<void, Error>) => void) | undefined;
      const strategy = makeStrategy(S1);
      (strategy.initialize as any).mockImplementation(() => new Promise((resolve) => { resolveInit = resolve; }));
      (strategy.dispose as any).mockResolvedValue(Err(new Error('dispose boom')));

      void scheduler.register(makeRegistration(strategy));
      await flush();
      const unregPromise = scheduler.unregister(S1);
      await flush();
      resolveInit!(Ok(undefined));
      const unregResult = await unregPromise;
      expect(unregResult.ok).toBe(false);
      if (!unregResult.ok) expect(unregResult.error.code).toBe('DISPOSE_FAILED');

      const stopAllResult = await scheduler.stopAll();
      expect(stopAllResult.ok).toBe(false);
      if (!stopAllResult.ok) {
        const s1Errors = stopAllResult.error.filter((e) => e.strategyId === S1);
        expect(s1Errors).toHaveLength(1);
        expect(s1Errors[0].code).toBe('DISPOSE_FAILED');
      }
    });
  });

  // ── concurrent stopAll() consistency ──────────────────

  describe('concurrent stopAll()', () => {
    it('два одновременных stopAll(): strategy.stop()/final cleanup/dispose вызываются РОВНО один раз (не дублируются)', async () => {
      const strategy = makeStrategy(S1);
      await scheduler.register(makeRegistration(strategy));

      const [r1, r2] = await Promise.all([scheduler.stopAll(), scheduler.stopAll()]);

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(strategy.stop).toHaveBeenCalledTimes(1);
      expect(executionEngine.execute).toHaveBeenCalledTimes(1);
      expect(strategy.dispose).toHaveBeenCalledTimes(1);
    });
  });
});
