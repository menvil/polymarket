/**
 * Integration: StrategyScheduler + РЕАЛЬНЫЙ ExecutionEngine (моки на уровне
 * use cases / repo) — сквозные lifecycle и determinism сценарии.
 *
 * Сценарий «Active PLACE + unregister» (P0 regression):
 * 1. tick начал PLACE (venue медленный — Order ещё не сохранён);
 * 2. unregister вызван, ждёт активный execution;
 * 3. PLACE завершился — Order появился в repo;
 * 4. final CANCEL_ALL видит этот Order и отменяет его;
 * 5. после unregister живых ордеров стратегии нет.
 */
import { describe, it, expect, jest } from '@jest/globals';
import Decimal from 'decimal.js';
import { Ok } from '@polymarket/result';
import { asInstrumentId, asPolymarketCtfToken, unsafeStrategyId } from '@polymarket/ids';
import type { AccountId, OrderId } from '@polymarket/ids';

const S1 = unsafeStrategyId('s1');
import { Money, OutcomePrice, Quantity } from '@polymarket/value-objects';
import { ExecutionEngine } from '../../src/ExecutionEngine.js';
import { StrategyScheduler } from '../../src/StrategyScheduler.js';
import type { StrategySchedulerDeps, IMarketDataStore } from '../../src/StrategyScheduler.js';
import type { IStrategy } from '../../src/IStrategy.js';
import { DeterministicSchedulerTimer } from '../../src/ports/SchedulerTimer.js';
import { SequentialOrderIdGenerator } from '../../src/ports/OrderIdGenerator.js';
import type { TriggerReason } from '../../src/types/TriggerReason.js';
import type { IOrderStateStore } from '@polymarket/ports';

const ACCOUNT_ID = 'venue:POLYMARKET:test' as unknown as AccountId;
const PRIMARY_TOKEN = '111';
const INSTRUMENT_ID = asInstrumentId(PRIMARY_TOKEN)!;
const ASSET_ID = asPolymarketCtfToken(PRIMARY_TOKEN)!;

const fn = jest.fn as any;

function makeLogger() {
  return {
    trace: jest.fn(), debug: jest.fn(), info: jest.fn(),
    warn: jest.fn(), error: jest.fn(), fatal: jest.fn(),
    child: jest.fn().mockReturnThis(),
  };
}

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

function makeMarketDataStore(): IMarketDataStore & { _onChange?: (id: any, reason: TriggerReason) => void } {
  const store: any = {
    _onChange: undefined,
    setOnChange(cb: any) { store._onChange = cb; },
    getTopOfBook: jest.fn().mockReturnValue(undefined),
    getBookHistory: jest.fn().mockReturnValue(undefined),
    getTradeTape: jest.fn().mockReturnValue(undefined),
  };
  return store;
}

/** In-memory order repo для ownership/CANCEL_ALL сценариев. */
function makeInMemoryOrderRepo() {
  const orders = new Map<string, any>();
  return {
    orders,
    get: fn().mockImplementation(async (id: OrderId) => orders.get(String(id))),
    getByStrategyId: fn().mockImplementation(async (strategyId: string) =>
      [...orders.values()].filter((o) => o.strategyId === strategyId),
    ),
    countByStrategyId: fn().mockImplementation(async (strategyId: string) =>
      [...orders.values()].filter((o) => o.strategyId === strategyId).length,
    ),
  } as any;
}

function makeCatalogInfo() {
  return {
    minOrderSize: Quantity.of(new Decimal('1')),
    minOrderValue: Money.of(new Decimal('1'), 'USDC'),
    tickSize: OutcomePrice.of(new Decimal('0.01')),
  } as any;
}

async function flush(count = 10) {
  for (let i = 0; i < count; i++) {
    await Promise.resolve();
  }
}

interface Harness {
  scheduler: StrategyScheduler;
  marketDataStore: ReturnType<typeof makeMarketDataStore>;
  orderRepo: ReturnType<typeof makeInMemoryOrderRepo>;
  placeOrderUseCase: any;
  cancelOrderUseCase: any;
  timer: DeterministicSchedulerTimer;
  clock: { now: () => Date; advance: (ms: number) => void };
}

function makeHarness(opts: {
  placeImpl?: (input: any) => Promise<any>;
  idPrefix?: string;
} = {}): Harness {
  let nowMs = 1_000;
  const clock = {
    now: () => new Date(nowMs),
    advance: (ms: number) => { nowMs += ms; },
  };
  const timer = new DeterministicSchedulerTimer(nowMs);
  const logger = makeLogger() as any;
  const orderRepo = makeInMemoryOrderRepo();

  const placeOrderUseCase = {
    execute: fn().mockImplementation(opts.placeImpl ?? (async (input: any) => {
      // Успешный place: сохраняем OPEN Order в repo (эмуляция use case).
      orderRepo.orders.set(String(input.orderId), {
        id: input.orderId,
        strategyId: input.strategyId,
        accountId: input.accountId,
        side: input.side,
        asset: input.asset,
        status: 'OPEN',
      });
      return Ok(input.orderId);
    })),
  };

  const cancelOrderUseCase = {
    execute: fn().mockImplementation(async (input: any) => {
      orderRepo.orders.delete(String(input.orderId));
      return Ok({ status: 'CANCELLED' });
    }),
  };

  const catalog = {
    get: fn().mockImplementation(() => makeCatalogInfo()),
    getByMarketId: fn(), getAll: fn().mockReturnValue([]),
    register: fn(), remove: fn(), clear: fn(),
  } as any;

  const executionEngine = new ExecutionEngine({
    placeOrderUseCase: placeOrderUseCase as any,
    cancelOrderUseCase: cancelOrderUseCase as any,
    orderRepo,
    portfolioStore: { get: fn().mockReturnValue({}) } as any,
    catalog,
    clock: clock as any,
    orderIdGenerator: new SequentialOrderIdGenerator(opts.idPrefix ?? 'it'),
    logger,
  });

  const marketDataStore = makeMarketDataStore();
  const commitmentReader = { getActiveCommitments: fn().mockResolvedValue([]) };
  const deps: StrategySchedulerDeps = {
    marketDataStore,
    orderStateStore: makeOrderStateStore(),
    portfolioStore: { get: fn().mockReturnValue({}) } as any,
    catalog,
    executionEngine,
    clock: clock as any,
    timer,
    commitmentReader: commitmentReader as any,
    logger,
  };

  return {
    scheduler: new StrategyScheduler(deps),
    marketDataStore,
    orderRepo,
    placeOrderUseCase,
    cancelOrderUseCase,
    timer,
    clock,
  };
}

function makeBuyStrategy(id: string): IStrategy {
  return {
    id,
    name: `BuyStrategy-${id}`,
    initialize: fn().mockResolvedValue(Ok(undefined)),
    tick: fn().mockReturnValue([{
      type: 'PLACE',
      side: 'BUY',
      price: OutcomePrice.of(new Decimal('0.55')),
      size: Quantity.of(new Decimal('100')),
    }]),
    stop: fn().mockReturnValue([{ type: 'CANCEL_ALL' }]),
    getMetrics: fn().mockReturnValue({}),
  } as IStrategy;
}

describe('Integration: lifecycle (real ExecutionEngine)', () => {
  it('active PLACE + unregister: поздний Order обнаружен и отменён final CANCEL_ALL', async () => {
    // PLACE «висит» на venue до явного release.
    let releasePlace: (() => void) | undefined;
    const harness = makeHarness({
      placeImpl: (input: any) =>
        new Promise((resolve) => {
          releasePlace = () => {
            // Order сохраняется ТОЛЬКО при завершении venue-вызова.
            harness.orderRepo.orders.set(String(input.orderId), {
              id: input.orderId,
              strategyId: input.strategyId,
              accountId: input.accountId,
              side: input.side,
              asset: input.asset,
              status: 'OPEN',
            });
            resolve(Ok(input.orderId));
          };
        }),
    });

    const strategy = makeBuyStrategy(S1);
    await harness.scheduler.register({
      strategy,
      instrumentId: INSTRUMENT_ID,
      asset: ASSET_ID,
      accountId: ACCOUNT_ID,
      market: {} as any,
    });
    harness.scheduler.start();

    // tick → PLACE начат, Order ещё НЕ сохранён.
    harness.marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
    await flush();
    expect(harness.placeOrderUseCase.execute).toHaveBeenCalledTimes(1);
    expect(harness.orderRepo.orders.size).toBe(0);

    // unregister во время активного PLACE.
    const unregisterPromise = harness.scheduler.unregister(S1);
    await flush();
    expect(strategy.stop).not.toHaveBeenCalled();

    // PLACE завершается — «поздний» OPEN Order появляется в repo.
    releasePlace!();
    await unregisterPromise;

    // Final CANCEL_ALL нашёл и отменил поздний Order.
    expect(strategy.stop).toHaveBeenCalledTimes(1);
    expect(harness.cancelOrderUseCase.execute).toHaveBeenCalledTimes(1);
    // После unregister живых ордеров стратегии нет.
    expect(harness.orderRepo.orders.size).toBe(0);
  });

  it('unregister без активного execution: final CANCEL_ALL отменяет существующие ордера', async () => {
    const harness = makeHarness();
    const strategy = makeBuyStrategy(S1);
    await harness.scheduler.register({
      strategy,
      instrumentId: INSTRUMENT_ID,
      asset: ASSET_ID,
      accountId: ACCOUNT_ID,
      market: {} as any,
    });
    harness.scheduler.start();

    harness.marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
    await flush();
    expect(harness.orderRepo.orders.size).toBe(1);

    await harness.scheduler.unregister(S1);

    expect(harness.orderRepo.orders.size).toBe(0);
  });

  it('replay determinism: одинаковый replay дважды → одинаковые order IDs и отчёты', async () => {
    const runReplay = async () => {
      const harness = makeHarness({ idPrefix: 'replay' });
      const strategy = makeBuyStrategy(S1);
      await harness.scheduler.register({
        strategy,
        instrumentId: INSTRUMENT_ID,
        asset: ASSET_ID,
        accountId: ACCOUNT_ID,
        market: {} as any,
        config: { minIntervalMs: 0 },
      });
      harness.scheduler.start();

      // Детерминированная последовательность событий.
      harness.marketDataStore._onChange!(INSTRUMENT_ID, 'BOOK');
      await flush();
      harness.clock.advance(100);
      harness.timer.advanceTo(1_100);
      harness.marketDataStore._onChange!(INSTRUMENT_ID, 'TRADE');
      await flush();

      await harness.scheduler.unregister(S1);

      const placedIds = harness.placeOrderUseCase.execute.mock.calls.map(
        (c: any[]) => String(c[0].orderId),
      );
      const cancelledIds = harness.cancelOrderUseCase.execute.mock.calls.map(
        (c: any[]) => String(c[0].orderId),
      );
      return { placedIds, cancelledIds };
    };

    const run1 = await runReplay();
    const run2 = await runReplay();

    expect(run1.placedIds.length).toBeGreaterThan(0);
    expect(run2).toEqual(run1);
  });
});
