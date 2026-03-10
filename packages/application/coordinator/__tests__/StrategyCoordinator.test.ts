/**
 * Тесты StrategyCoordinator.
 *
 * @remarks
 * Покрывает:
 * - Lifecycle: start(), stop(), повторный start() (no-op)
 * - _discover(): срабатывание каждые discoverEveryNTicks тиков,
 *   фильтрация inactive/уже активных, лимит maxStrategies
 * - _checkPolicy(): срабатывание каждые policyCheckEveryNTicks тиков,
 *   закрытие рынков по политике, обработка ошибок закрытия
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { StrategyCoordinator } from '../src/StrategyCoordinator.js';
import type { StrategyCoordinatorDeps } from '../src/StrategyCoordinator.js';
import type { StrategyCoordinatorConfig } from '../src/StrategyCoordinatorConfig.js';
import type { ILogger } from '@polymarket/logger';
import type { IEventBus, StrategyTickEvent } from '@polymarket/event-bus';
import type {
  IMarketCatalog,
  InstrumentInfo,
  IBalanceAllocator,
  AllocationResult,
} from '@polymarket/ports';
import type {
  OpenMarketUseCase,
  CloseMarketUseCase,
  IRemovalPolicy,
} from '@polymarket/market-lifecycle';
import type { AccountId, MarketId, InstrumentId } from '@polymarket/ids';
import type { IClock } from '@polymarket/time';
import { Money, TimestampService } from '@polymarket/value-objects';
import { Ok, Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';
import Decimal from 'decimal.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ACCOUNT_ID = 'acc-test' as unknown as AccountId;
const MARKET_ID_1 = 'mkt-1' as unknown as MarketId;
const MARKET_ID_2 = 'mkt-2' as unknown as MarketId;
const TOTAL_BALANCE = Money.of(new Decimal(10_000), 'USDC');

function makeTimestamp(ms = 1_700_000_000_000) {
  const r = TimestampService.create(ms);
  if (!r.ok) throw new Error('Failed to create timestamp');
  return r.value;
}

function makeLogger(): ILogger {
  return {
    trace: jest.fn() as ILogger['trace'],
    debug: jest.fn() as ILogger['debug'],
    info: jest.fn() as ILogger['info'],
    warn: jest.fn() as ILogger['warn'],
    error: jest.fn() as ILogger['error'],
    fatal: jest.fn() as ILogger['fatal'],
    child: jest.fn<ILogger['child']>().mockReturnThis() as ILogger['child'],
  };
}

function makeCatalog(): jest.Mocked<IMarketCatalog> {
  return {
    get: jest.fn<IMarketCatalog['get']>(),
    getAll: jest.fn<IMarketCatalog['getAll']>().mockReturnValue([]),
  };
}

function makeAllocator(): jest.Mocked<IBalanceAllocator> {
  return {
    allocateToNewMarkets: jest.fn<IBalanceAllocator['allocateToNewMarkets']>().mockReturnValue([]),
    addMarket: jest.fn<IBalanceAllocator['addMarket']>(),
    releaseWithPnL: jest.fn<IBalanceAllocator['releaseWithPnL']>(),
    release: jest.fn<IBalanceAllocator['release']>(),
    getAllocation: jest.fn<IBalanceAllocator['getAllocation']>(),
    updateTotalBalance: jest.fn<IBalanceAllocator['updateTotalBalance']>(),
    canAddMarket: jest.fn<IBalanceAllocator['canAddMarket']>(),
    getStats: jest.fn<IBalanceAllocator['getStats']>(),
  };
}

function makeOpenMarketUseCase() {
  return {
    execute: jest.fn<OpenMarketUseCase['execute']>(),
  };
}

function makeCloseMarketUseCase() {
  return {
    execute: jest.fn<CloseMarketUseCase['execute']>(),
  };
}

function makeRemovalPolicy(): jest.Mocked<IRemovalPolicy> {
  return {
    evaluate: jest.fn<IRemovalPolicy['evaluate']>().mockReturnValue([]),
  };
}

function makeClock(nowMs = 1_700_000_000_000): IClock {
  return { now: () => new Date(nowMs) };
}

function makeInstrument(marketId: MarketId, active = true): InstrumentInfo {
  return {
    instrumentId: `inst-${String(marketId)}` as unknown as InstrumentId,
    marketId,
    tickSize: {} as any,
    minOrderSize: {} as any,
    active,
  };
}

function makeAllocation(marketId: MarketId): AllocationResult {
  return {
    marketId,
    allocatedAmount: Money.of(new Decimal(500), 'USDC'),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('StrategyCoordinator', () => {
  /**
   * Захваченный обработчик STRATEGY_TICK — для прямого вызова в тестах.
   * discoverEveryNTicks=2, policyCheckEveryNTicks=3:
   *   - Тик 2 → _discover()
   *   - Тик 3 → _checkPolicy()
   *   - Тик 6 → _discover() + _checkPolicy()
   */
  let tickHandler: ((e: StrategyTickEvent) => Promise<void>) | undefined;

  let catalog: jest.Mocked<IMarketCatalog>;
  let allocator: jest.Mocked<IBalanceAllocator>;
  let openMarketUseCase: ReturnType<typeof makeOpenMarketUseCase>;
  let closeMarketUseCase: ReturnType<typeof makeCloseMarketUseCase>;
  let removalPolicy: jest.Mocked<IRemovalPolicy>;
  let eventBus: IEventBus;
  let logger: ILogger;
  let coordinator: StrategyCoordinator;

  const config: StrategyCoordinatorConfig = {
    discoverEveryNTicks: 2,
    policyCheckEveryNTicks: 3,
    maxStrategies: 10,
    accountId: ACCOUNT_ID,
  };

  /** Создаёт зависимости, захватывает tick-обработчик из subscribe. */
  function buildCoordinator(overrideConfig?: Partial<StrategyCoordinatorConfig>): StrategyCoordinator {
    const deps: StrategyCoordinatorDeps = {
      marketCatalog: catalog,
      balanceAllocator: allocator,
      openMarketUseCase: openMarketUseCase as unknown as OpenMarketUseCase,
      closeMarketUseCase: closeMarketUseCase as unknown as CloseMarketUseCase,
      removalPolicy,
      eventBus,
      clock: makeClock(),
      logger,
    };
    return new StrategyCoordinator(deps, { ...config, ...overrideConfig });
  }

  beforeEach(() => {
    tickHandler = undefined;
    catalog = makeCatalog();
    allocator = makeAllocator();
    openMarketUseCase = makeOpenMarketUseCase();
    closeMarketUseCase = makeCloseMarketUseCase();
    removalPolicy = makeRemovalPolicy();
    logger = makeLogger();

    // Захватываем STRATEGY_TICK обработчик при подписке
    eventBus = {
      publish: jest.fn<IEventBus['publish']>().mockResolvedValue(undefined),
      publishAll: jest.fn<IEventBus['publishAll']>().mockResolvedValue(undefined),
      subscribe: jest.fn<IEventBus['subscribe']>().mockImplementation(
        (type: string, handler: unknown) => {
          if (type === 'STRATEGY_TICK') {
            tickHandler = handler as (e: StrategyTickEvent) => Promise<void>;
          }
          return () => {};
        },
      ) as IEventBus['subscribe'],
    };

    coordinator = buildCoordinator();
  });

  /** Отправляет один STRATEGY_TICK, увеличивая внутренний счётчик координатора. */
  async function fireTick(): Promise<void> {
    await tickHandler!({
      type: 'STRATEGY_TICK',
      tickNumber: 0,
      timestamp: makeTimestamp(),
    });
  }

  /** Отправляет n тиков подряд. */
  async function fireNTicks(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await fireTick();
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  describe('start() / stop()', () => {
    it('обновляет баланс аллокатора и подписывается на STRATEGY_TICK', () => {
      coordinator.start(TOTAL_BALANCE);

      expect(allocator.updateTotalBalance).toHaveBeenCalledWith(TOTAL_BALANCE);
      expect(eventBus.subscribe).toHaveBeenCalledWith('STRATEGY_TICK', expect.any(Function));
      expect(tickHandler).toBeDefined();
    });

    it('повторный start() — no-op, предупреждение в лог', () => {
      coordinator.start(TOTAL_BALANCE);
      coordinator.start(TOTAL_BALANCE);

      expect(eventBus.subscribe).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        'StrategyCoordinator already running, ignoring start()',
      );
    });

    it('stop() вызывает функцию отписки', () => {
      const unsubscribeFn = jest.fn();
      (eventBus.subscribe as jest.Mock).mockImplementation(
        (...args: any[]) => {
          const [type, handler] = args;
          if (type === 'STRATEGY_TICK') tickHandler = handler as typeof tickHandler;
          return unsubscribeFn;
        },
      );

      coordinator = buildCoordinator();
      coordinator.start(TOTAL_BALANCE);
      coordinator.stop();

      expect(unsubscribeFn).toHaveBeenCalled();
    });

    it('stop() без предварительного start() — no error', () => {
      expect(() => coordinator.stop()).not.toThrow();
    });
  });

  // ── _discover() ────────────────────────────────────────────────────────────

  describe('_discover()', () => {
    beforeEach(() => {
      coordinator.start(TOTAL_BALANCE);
    });

    it('не вызывает catalog.getAll до discoverEveryNTicks тиков', async () => {
      // discoverEveryNTicks=2, fire only 1 tick
      await fireTick();
      expect(catalog.getAll).not.toHaveBeenCalled();
    });

    it('вызывает catalog.getAll каждые discoverEveryNTicks тиков', async () => {
      await fireNTicks(2); // tick 2 → discover
      expect(catalog.getAll).toHaveBeenCalledTimes(1);

      await fireNTicks(2); // tick 4 → discover
      expect(catalog.getAll).toHaveBeenCalledTimes(2);
    });

    it('пропускает неактивные инструменты', async () => {
      catalog.getAll.mockReturnValue([makeInstrument(MARKET_ID_1, false)]);

      await fireNTicks(2);

      expect(openMarketUseCase.execute).not.toHaveBeenCalled();
    });

    it('открывает новый рынок через openMarketUseCase', async () => {
      catalog.getAll.mockReturnValue([makeInstrument(MARKET_ID_1)]);
      openMarketUseCase.execute.mockResolvedValue(Ok(makeAllocation(MARKET_ID_1)));

      await fireNTicks(2); // trigger discovery

      expect(openMarketUseCase.execute).toHaveBeenCalledWith({
        marketId: MARKET_ID_1,
        strategyId: String(MARKET_ID_1),
        accountId: ACCOUNT_ID,
      });
    });

    it('не открывает рынок повторно если он уже активен', async () => {
      catalog.getAll.mockReturnValue([makeInstrument(MARKET_ID_1)]);
      openMarketUseCase.execute.mockResolvedValue(Ok(makeAllocation(MARKET_ID_1)));

      await fireNTicks(2); // tick 2 → discover → opens MARKET_ID_1
      await fireNTicks(2); // tick 4 → discover → MARKET_ID_1 уже активен

      // execute вызван только один раз (при первом обнаружении)
      expect(openMarketUseCase.execute).toHaveBeenCalledTimes(1);
    });

    it('пропускает discovery если достигнут maxStrategies', async () => {
      coordinator = buildCoordinator({ maxStrategies: 0 });
      coordinator.start(TOTAL_BALANCE);

      catalog.getAll.mockReturnValue([makeInstrument(MARKET_ID_1)]);

      await fireNTicks(2);

      expect(openMarketUseCase.execute).not.toHaveBeenCalled();
    });

    it('ограничивает число новых рынков до remainingSlots (maxStrategies - текущие активные)', async () => {
      coordinator = buildCoordinator({ maxStrategies: 1 });
      coordinator.start(TOTAL_BALANCE);

      catalog.getAll.mockReturnValue([
        makeInstrument(MARKET_ID_1),
        makeInstrument(MARKET_ID_2),
      ]);
      openMarketUseCase.execute.mockResolvedValue(Ok(makeAllocation(MARKET_ID_1)));

      await fireNTicks(2);

      // Только 1 рынок открыт (remainingSlots = 1)
      expect(openMarketUseCase.execute).toHaveBeenCalledTimes(1);
    });

    it('логирует debug при неудачной аллокации (Err от openMarketUseCase)', async () => {
      catalog.getAll.mockReturnValue([makeInstrument(MARKET_ID_1)]);
      openMarketUseCase.execute.mockResolvedValue(
        Err(new TradingError('No free slots')),
      );

      await fireNTicks(2);

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Could not open market'),
        expect.objectContaining({ marketId: String(MARKET_ID_1) }),
      );
    });

    it('добавляет успешно открытый рынок в активные (проверка через последующий policyCheck)', async () => {
      catalog.getAll.mockReturnValue([makeInstrument(MARKET_ID_1)]);
      openMarketUseCase.execute.mockResolvedValue(Ok(makeAllocation(MARKET_ID_1)));
      removalPolicy.evaluate.mockReturnValue([]);

      await fireNTicks(2); // tick 2 → discover → MARKET_ID_1 добавлен
      await fireTick();    // tick 3 → policy check

      // evaluate вызван с MARKET_ID_1 в activeMarkets
      expect(removalPolicy.evaluate).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ marketId: MARKET_ID_1 }),
        ]),
      );
    });
  });

  // ── _checkPolicy() ─────────────────────────────────────────────────────────

  describe('_checkPolicy()', () => {
    beforeEach(() => {
      coordinator.start(TOTAL_BALANCE);
    });

    it('не вызывает removalPolicy.evaluate до policyCheckEveryNTicks тиков', async () => {
      // policyCheckEveryNTicks=3, fires 2 ticks
      await fireNTicks(2);
      expect(removalPolicy.evaluate).not.toHaveBeenCalled();
    });

    it('не вызывает evaluate если нет активных рынков', async () => {
      await fireNTicks(3); // tick 3 → policy, но _activeMarkets пуст
      expect(removalPolicy.evaluate).not.toHaveBeenCalled();
    });

    it('вызывает evaluate с контекстами активных рынков', async () => {
      catalog.getAll.mockReturnValue([makeInstrument(MARKET_ID_1)]);
      openMarketUseCase.execute.mockResolvedValue(Ok(makeAllocation(MARKET_ID_1)));
      removalPolicy.evaluate.mockReturnValue([]);

      await fireNTicks(2); // tick 2 → discover → MARKET_ID_1 добавлен
      await fireTick();    // tick 3 → policy check

      expect(removalPolicy.evaluate).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            marketId: MARKET_ID_1,
            openOrdersCount: 0,
          }),
        ]),
      );
    });

    it('закрывает рынки, отмеченные политикой', async () => {
      catalog.getAll.mockReturnValue([makeInstrument(MARKET_ID_1)]);
      openMarketUseCase.execute.mockResolvedValue(Ok(makeAllocation(MARKET_ID_1)));
      removalPolicy.evaluate.mockReturnValue([MARKET_ID_1]);
      closeMarketUseCase.execute.mockResolvedValue(Ok(undefined));

      await fireNTicks(2); // discover
      await fireTick();    // policy → close

      expect(closeMarketUseCase.execute).toHaveBeenCalledWith({
        marketId: MARKET_ID_1,
        accountId: ACCOUNT_ID,
        reason: 'POLICY',
      });
    });

    it('удаляет рынок из активных после успешного закрытия', async () => {
      catalog.getAll.mockReturnValue([makeInstrument(MARKET_ID_1)]);
      openMarketUseCase.execute.mockResolvedValue(Ok(makeAllocation(MARKET_ID_1)));
      removalPolicy.evaluate
        .mockReturnValueOnce([MARKET_ID_1])
        .mockReturnValue([]);
      closeMarketUseCase.execute.mockResolvedValue(Ok(undefined));

      await fireNTicks(2); // tick 2 → discover → добавляет MARKET_ID_1
      await fireTick();    // tick 3 → policy → закрывает, удаляет MARKET_ID_1

      // Убираем инструмент из каталога, чтобы повторная discovery не добавила его снова
      catalog.getAll.mockReturnValue([]);
      removalPolicy.evaluate.mockClear();

      await fireNTicks(3); // тики 4, 5, 6 — tick 6 → policy check
      // _activeMarkets пуст → evaluate не вызывается
      expect(removalPolicy.evaluate).not.toHaveBeenCalled();
    });

    it('оставляет рынок в активных если закрытие вернуло Err', async () => {
      catalog.getAll.mockReturnValue([makeInstrument(MARKET_ID_1)]);
      openMarketUseCase.execute.mockResolvedValue(Ok(makeAllocation(MARKET_ID_1)));
      removalPolicy.evaluate
        .mockReturnValueOnce([MARKET_ID_1])
        .mockReturnValue([]);
      closeMarketUseCase.execute.mockResolvedValue(
        Err(new TradingError('Cancel failed')),
      );

      await fireNTicks(2); // tick 2 → discover → MARKET_ID_1 добавлен
      await fireTick();    // tick 3 → policy → close fails

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to close market'),
        expect.any(Object),
      );

      // Тик 4: discover, MARKET_ID_1 уже в activeMarkets → не открываем повторно
      // Тик 6: policy → evaluate вызван снова с MARKET_ID_1
      await fireNTicks(3); // тики 4, 5, 6

      expect(removalPolicy.evaluate).toHaveBeenNthCalledWith(
        2,
        expect.arrayContaining([expect.objectContaining({ marketId: MARKET_ID_1 })]),
      );
    });

    it('логирует закрытие нескольких рынков', async () => {
      catalog.getAll.mockReturnValue([
        makeInstrument(MARKET_ID_1),
        makeInstrument(MARKET_ID_2),
      ]);
      openMarketUseCase.execute
        .mockResolvedValueOnce(Ok(makeAllocation(MARKET_ID_1)))
        .mockResolvedValueOnce(Ok(makeAllocation(MARKET_ID_2)));
      removalPolicy.evaluate.mockReturnValue([MARKET_ID_1, MARKET_ID_2]);
      closeMarketUseCase.execute.mockResolvedValue(Ok(undefined));

      await fireNTicks(2); // discover → оба рынка добавлены
      await fireTick();    // policy → закрываем оба

      expect(closeMarketUseCase.execute).toHaveBeenCalledTimes(2);
      expect(closeMarketUseCase.execute).toHaveBeenCalledWith(
        expect.objectContaining({ marketId: MARKET_ID_1, reason: 'POLICY' }),
      );
      expect(closeMarketUseCase.execute).toHaveBeenCalledWith(
        expect.objectContaining({ marketId: MARKET_ID_2, reason: 'POLICY' }),
      );
    });
  });
});
