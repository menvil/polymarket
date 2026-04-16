/**
 * Тесты MarketDiscoveryPublisher.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { MarketDiscoveryPublisher } from '../src/MarketDiscoveryPublisher.js';
import type { MarketDiscoveryPublisherDeps, MarketDiscoveryPublisherConfig } from '../src/MarketDiscoveryPublisher.js';
import type { ILogger } from '@polymarket/logger';
import type { IEventBus, MarketOpenedEvent, MarketClosedEvent } from '@polymarket/event-bus';
import type {
  IMarketCatalog,
  IMarketDiscoveryService,
  IBalanceAllocator,
  InstrumentInfo,
  AllocationResult,
} from '@polymarket/ports';
import type { IClock } from '@polymarket/time';
import type { AccountId, MarketId, InstrumentId } from '@polymarket/ids';
import { Money, TimestampService } from '@polymarket/value-objects';
import { Ok, Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';
import Decimal from 'decimal.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

const ACCOUNT_ID = 'acc-test' as unknown as AccountId;
const MARKET_ID_1 = 'mkt-1' as unknown as MarketId;
const MARKET_ID_2 = 'mkt-2' as unknown as MarketId;
const INSTR_ID_1 = 'inst-1' as unknown as InstrumentId;
const INSTR_ID_2 = 'inst-2' as unknown as InstrumentId;

function makeTimestamp(ms = Date.now() + 48 * 60 * 60 * 1000) {
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
    getByMarketId: jest.fn<IMarketCatalog['getByMarketId']>().mockReturnValue(undefined),
    register: jest.fn<IMarketCatalog['register']>(),
    remove: jest.fn<IMarketCatalog['remove']>(),
    clear: jest.fn<IMarketCatalog['clear']>(),
  };
}

function makeDiscoveryService(): jest.Mocked<IMarketDiscoveryService> {
  return {
    findCandidates: jest.fn<IMarketDiscoveryService['findCandidates']>().mockResolvedValue([]),
    refresh: jest.fn<IMarketDiscoveryService['refresh']>().mockResolvedValue(undefined),
  };
}

function makeAllocator(): jest.Mocked<IBalanceAllocator> {
  return {
    allocateToNewMarkets: jest.fn<IBalanceAllocator['allocateToNewMarkets']>(),
    addMarket: jest.fn<IBalanceAllocator['addMarket']>(),
    releaseWithPnL: jest.fn<IBalanceAllocator['releaseWithPnL']>(),
    release: jest.fn<IBalanceAllocator['release']>(),
    getAllocation: jest.fn<IBalanceAllocator['getAllocation']>().mockReturnValue(undefined),
    updateTotalBalance: jest.fn<IBalanceAllocator['updateTotalBalance']>(),
    canAddMarket: jest.fn<IBalanceAllocator['canAddMarket']>(),
    getStats: jest.fn<IBalanceAllocator['getStats']>(),
    restoreAllocations: jest.fn<IBalanceAllocator['restoreAllocations']>(),
  };
}

function makeClock(): IClock {
  return { now: () => new Date(1_700_000_000_000) };
}

function makeInstrument(marketId: MarketId, instrumentId: InstrumentId, active = true): InstrumentInfo {
  return {
    instrumentId,
    marketId,
    tickSize: {} as any,
    minOrderSize: {} as any,
    minOrderValue: {} as any,
    expiresAt: makeTimestamp(),
    active,
  };
}

function makeAllocation(marketId: MarketId): AllocationResult {
  return { marketId, allocatedAmount: Money.of(new Decimal(500), 'USDC') };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('MarketDiscoveryPublisher', () => {
  let catalog: jest.Mocked<IMarketCatalog>;
  let discoveryService: jest.Mocked<IMarketDiscoveryService>;
  let allocator: jest.Mocked<IBalanceAllocator>;
  let logger: ILogger;
  let publisher: MarketDiscoveryPublisher;

  let openedHandler: ((e: MarketOpenedEvent) => Promise<void>) | undefined;
  let closedHandler: ((e: MarketClosedEvent) => Promise<void>) | undefined;
  let unsubscribeOpenedFn: jest.Mock;
  let unsubscribeClosedFn: jest.Mock;
  let eventBus: IEventBus;

  const config: MarketDiscoveryPublisherConfig = {
    accountId: ACCOUNT_ID,
    maxStrategies: 10,
    scanPauseMs: 30_000,
  };

  function buildPublisher(cfg?: Partial<MarketDiscoveryPublisherConfig>): MarketDiscoveryPublisher {
    const deps: MarketDiscoveryPublisherDeps = {
      discoveryService,
      marketCatalog: catalog,
      balanceAllocator: allocator,
      eventBus,
      clock: makeClock(),
      logger,
    };
    return new MarketDiscoveryPublisher(deps, { ...config, ...cfg });
  }

  beforeEach(() => {
    jest.useFakeTimers();
    catalog = makeCatalog();
    discoveryService = makeDiscoveryService();
    allocator = makeAllocator();
    logger = makeLogger();
    openedHandler = undefined;
    closedHandler = undefined;
    unsubscribeOpenedFn = jest.fn().mockReturnValue(undefined);
    unsubscribeClosedFn = jest.fn().mockReturnValue(undefined);

    eventBus = {
      publish: jest.fn<IEventBus['publish']>().mockResolvedValue(undefined),
      publishAll: jest.fn<IEventBus['publishAll']>().mockResolvedValue(undefined),
      subscribe: jest.fn<IEventBus['subscribe']>().mockImplementation(
        (type: string, handler: unknown) => {
          if (type === 'MARKET_OPENED') {
            openedHandler = handler as (e: MarketOpenedEvent) => Promise<void>;
            return unsubscribeOpenedFn;
          }
          if (type === 'MARKET_CLOSED') {
            closedHandler = handler as (e: MarketClosedEvent) => Promise<void>;
            return unsubscribeClosedFn;
          }
          return () => {};
        },
      ) as IEventBus['subscribe'],
    };

    publisher = buildPublisher();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  describe('start() / stop()', () => {
    it('подписывается на MARKET_OPENED и MARKET_CLOSED', () => {
      publisher.start();

      expect(eventBus.subscribe).toHaveBeenCalledWith('MARKET_OPENED', expect.any(Function));
      expect(eventBus.subscribe).toHaveBeenCalledWith('MARKET_CLOSED', expect.any(Function));
    });

    it('повторный start() — no-op с предупреждением', () => {
      publisher.start();
      publisher.start();

      expect(eventBus.subscribe).toHaveBeenCalledTimes(2);
      expect(logger.warn).toHaveBeenCalledWith(
        'MarketDiscoveryPublisher already running, ignoring start()',
      );
    });

    it('stop() отписывается от событий', () => {
      publisher.start();
      publisher.stop();

      expect(unsubscribeOpenedFn).toHaveBeenCalled();
      expect(unsubscribeClosedFn).toHaveBeenCalled();
    });

    it('stop() очищает таймер', async () => {
      publisher.start();
      await flushMicrotasks();

      publisher.stop();

      discoveryService.findCandidates.mockClear();
      await jest.runAllTimersAsync();
      expect(discoveryService.findCandidates).not.toHaveBeenCalled();
    });

    it('stop() без предварительного start() — no error', () => {
      expect(() => publisher.stop()).not.toThrow();
    });
  });

  // ── _discover() ───────────────────────────────────────────────────────────

  describe('_discover()', () => {
    it('вызывает findCandidates() при первом запуске', async () => {
      publisher.start();
      await flushMicrotasks();

      expect(discoveryService.findCandidates).toHaveBeenCalledTimes(1);
    });

    it('регистрирует кандидатов в каталоге', async () => {
      const candidate = {
        marketId: MARKET_ID_1,
        instrumentId: INSTR_ID_1,
        question: 'Will BTC hit 100k?',
        expiresAt: makeTimestamp(),
        tickSize: {} as any,
        minOrderSize: {} as any,
        minOrderValue: {} as any,
        active: true as true,
        spread: new Decimal('0.05'),
        liquidity: new Decimal('10000'),
        score: new Decimal('20'),
      };
      discoveryService.findCandidates.mockResolvedValue([candidate]);

      publisher.start();
      await flushMicrotasks();

      expect(catalog.register).toHaveBeenCalledWith(candidate);
    });

    it('аллоцирует баланс и публикует MARKET_OPENED для нового рынка', async () => {
      catalog.getAll.mockReturnValue([makeInstrument(MARKET_ID_1, INSTR_ID_1)]);
      allocator.addMarket.mockReturnValue(Ok(makeAllocation(MARKET_ID_1)));

      publisher.start();
      await flushMicrotasks();

      expect(allocator.addMarket).toHaveBeenCalledWith(MARKET_ID_1);
      expect(eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'MARKET_OPENED', marketId: MARKET_ID_1 }),
      );
    });

    it('пропускает неактивные инструменты', async () => {
      catalog.getAll.mockReturnValue([makeInstrument(MARKET_ID_1, INSTR_ID_1, false)]);

      publisher.start();
      await flushMicrotasks();

      expect(allocator.addMarket).not.toHaveBeenCalled();
    });

    it('не открывает рынок если он уже в _openMarkets', async () => {
      catalog.getAll.mockReturnValue([makeInstrument(MARKET_ID_1, INSTR_ID_1)]);
      allocator.addMarket.mockReturnValue(Ok(makeAllocation(MARKET_ID_1)));

      publisher.start();
      await flushMicrotasks();

      await openedHandler!({
        type: 'MARKET_OPENED',
        marketId: MARKET_ID_1,
        accountId: ACCOUNT_ID,
        strategyId: String(MARKET_ID_1),
        allocatedAmount: Money.of(new Decimal(500), 'USDC'),
        timestamp: makeTimestamp(),
      } as any);

      allocator.addMarket.mockClear();

      await jest.advanceTimersByTimeAsync(config.scanPauseMs);
      await flushMicrotasks();

      expect(allocator.addMarket).not.toHaveBeenCalled();
    });

    it('соблюдает лимит maxStrategies', async () => {
      publisher = buildPublisher({ maxStrategies: 1 });
      catalog.getAll.mockReturnValue([
        makeInstrument(MARKET_ID_1, INSTR_ID_1),
        makeInstrument(MARKET_ID_2, INSTR_ID_2),
      ]);
      allocator.addMarket.mockReturnValue(Ok(makeAllocation(MARKET_ID_1)));

      publisher.start();
      await flushMicrotasks();

      expect(allocator.addMarket).toHaveBeenCalledTimes(1);
    });

    it('не открывает рынки если слоты заняты', async () => {
      publisher = buildPublisher({ maxStrategies: 1 });

      publisher.start();
      await flushMicrotasks();

      await openedHandler!({ type: 'MARKET_OPENED', marketId: MARKET_ID_1 } as any);

      catalog.getAll.mockReturnValue([makeInstrument(MARKET_ID_2, INSTR_ID_2)]);

      await jest.advanceTimersByTimeAsync(config.scanPauseMs);
      await flushMicrotasks();

      expect(allocator.addMarket).not.toHaveBeenCalled();
    });

    it('прекращает открытие рынков при Err от addMarket', async () => {
      catalog.getAll.mockReturnValue([
        makeInstrument(MARKET_ID_1, INSTR_ID_1),
        makeInstrument(MARKET_ID_2, INSTR_ID_2),
      ]);
      allocator.addMarket.mockReturnValue(Err(new TradingError('No free slots')));

      publisher.start();
      await flushMicrotasks();

      expect(allocator.addMarket).toHaveBeenCalledTimes(1);
    });

    it('логирует debug при Err от addMarket', async () => {
      catalog.getAll.mockReturnValue([makeInstrument(MARKET_ID_1, INSTR_ID_1)]);
      allocator.addMarket.mockReturnValue(Err(new TradingError('No balance')));

      publisher.start();
      await flushMicrotasks();

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Could not open market'),
        expect.objectContaining({ marketId: String(MARKET_ID_1) }),
      );
    });

    it('логирует ошибку если findCandidates бросает', async () => {
      discoveryService.findCandidates.mockRejectedValue(new Error('Network error'));

      publisher.start();
      await flushMicrotasks();

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to fetch discovery candidates'),
        expect.any(Object),
      );
      expect(catalog.register).not.toHaveBeenCalled();
    });
  });

  // ── Loop scheduling ───────────────────────────────────────────────────────

  describe('планирование цикла', () => {
    it('планирует следующий цикл через scanPauseMs после завершения discover', async () => {
      publisher.start();
      await flushMicrotasks();

      expect(discoveryService.findCandidates).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(config.scanPauseMs);
      await flushMicrotasks();

      expect(discoveryService.findCandidates).toHaveBeenCalledTimes(2);
    });

    it('не планирует следующий цикл если stopped', async () => {
      publisher.start();
      await flushMicrotasks();

      publisher.stop();
      discoveryService.findCandidates.mockClear();

      await jest.runAllTimersAsync();
      expect(discoveryService.findCandidates).not.toHaveBeenCalled();
    });
  });

  // ── MARKET_OPENED / MARKET_CLOSED ─────────────────────────────────────────

  describe('обновление _openMarkets через события', () => {
    it('добавляет marketId в _openMarkets при MARKET_OPENED', async () => {
      publisher = buildPublisher({ maxStrategies: 1 });
      publisher.start();
      await flushMicrotasks();

      await openedHandler!({ type: 'MARKET_OPENED', marketId: MARKET_ID_1 } as any);

      catalog.getAll.mockReturnValue([makeInstrument(MARKET_ID_2, INSTR_ID_2)]);
      allocator.addMarket.mockClear();

      await jest.advanceTimersByTimeAsync(config.scanPauseMs);
      await flushMicrotasks();

      expect(allocator.addMarket).not.toHaveBeenCalled();
    });

    it('удаляет marketId из _openMarkets при MARKET_CLOSED', async () => {
      publisher = buildPublisher({ maxStrategies: 1 });
      publisher.start();
      await flushMicrotasks();

      await openedHandler!({ type: 'MARKET_OPENED', marketId: MARKET_ID_1 } as any);
      await closedHandler!({ type: 'MARKET_CLOSED', marketId: MARKET_ID_1 } as any);

      catalog.getAll.mockReturnValue([makeInstrument(MARKET_ID_2, INSTR_ID_2)]);
      allocator.addMarket.mockReturnValue(Ok(makeAllocation(MARKET_ID_2)));

      await jest.advanceTimersByTimeAsync(config.scanPauseMs);
      await flushMicrotasks();

      expect(allocator.addMarket).toHaveBeenCalledWith(MARKET_ID_2);
    });
  });
});
