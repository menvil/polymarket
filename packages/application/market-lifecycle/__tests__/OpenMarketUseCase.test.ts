/**
 * Тесты OpenMarketUseCase
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { OpenMarketUseCase } from '../src/OpenMarketUseCase.js';
import type { OpenMarketInput } from '../src/OpenMarketUseCase.js';
import type { ILogger } from '@polymarket/logger';
import type { IEventBus } from '@polymarket/event-bus';
import type { IBalanceAllocator, AllocationResult } from '@polymarket/ports';
import type { AccountId, MarketId } from '@polymarket/ids';
import { Money } from '@polymarket/value-objects';
import { Ok, Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';
import Decimal from 'decimal.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function makeEventBus(): IEventBus {
  return {
    publish: jest.fn<IEventBus['publish']>().mockResolvedValue(undefined),
    publishAll: jest.fn<IEventBus['publishAll']>().mockResolvedValue(undefined),
    subscribe: jest.fn<IEventBus['subscribe']>().mockReturnValue(() => {}),
  };
}

const ACCOUNT_ID = 'acc-1' as unknown as AccountId;
const MARKET_ID = 'mkt-abc' as unknown as MarketId;

function makeClock() {
  return { now: () => new Date(1_700_000_000_000) };
}

function makeAllocator(): jest.Mocked<IBalanceAllocator> {
  return {
    allocateToNewMarkets: jest.fn<IBalanceAllocator['allocateToNewMarkets']>(),
    addMarket: jest.fn<IBalanceAllocator['addMarket']>(),
    releaseWithPnL: jest.fn<IBalanceAllocator['releaseWithPnL']>(),
    release: jest.fn<IBalanceAllocator['release']>(),
    getAllocation: jest.fn<IBalanceAllocator['getAllocation']>(),
    updateTotalBalance: jest.fn<IBalanceAllocator['updateTotalBalance']>(),
    canAddMarket: jest.fn<IBalanceAllocator['canAddMarket']>(),
    getStats: jest.fn<IBalanceAllocator['getStats']>(),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OpenMarketUseCase', () => {
  let allocator: jest.Mocked<IBalanceAllocator>;
  let eventBus: IEventBus;
  let logger: ILogger;
  let useCase: OpenMarketUseCase;

  const input: OpenMarketInput = {
    marketId: MARKET_ID,
    strategyId: 'strategy-1',
    accountId: ACCOUNT_ID,
  };

  beforeEach(() => {
    allocator = makeAllocator();
    eventBus = makeEventBus();
    logger = makeLogger();

    useCase = new OpenMarketUseCase({
      balanceAllocator: allocator,
      eventBus,
      clock: makeClock(),
      logger,
    });
  });

  it('успешно открывает рынок и публикует MARKET_OPENED', async () => {
    const allocation: AllocationResult = {
      marketId: MARKET_ID,
      allocatedAmount: Money.of(new Decimal(1000), 'USDC'),
    };
    allocator.addMarket.mockReturnValue(Ok(allocation));

    const result = await useCase.execute(input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.marketId).toBe(MARKET_ID);
    expect(result.value.allocatedAmount.toNumber()).toBe(1000);
    expect((eventBus.publish as jest.MockedFunction<IEventBus['publish']>)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'MARKET_OPENED', marketId: MARKET_ID }),
    );
  });

  it('возвращает Err если аллокация не удалась', async () => {
    allocator.addMarket.mockReturnValue(
      Err(new TradingError('No available slots')),
    );

    const result = await useCase.execute(input);

    expect(result.ok).toBe(false);
    expect((eventBus.publish as jest.MockedFunction<IEventBus['publish']>)).not.toHaveBeenCalled();
  });

  it('продолжает работу если publish бросил исключение', async () => {
    const allocation: AllocationResult = {
      marketId: MARKET_ID,
      allocatedAmount: Money.of(new Decimal(500), 'USDC'),
    };
    allocator.addMarket.mockReturnValue(Ok(allocation));
    (eventBus.publish as jest.MockedFunction<IEventBus['publish']>)
      .mockRejectedValue(new Error('EventBus down'));

    const result = await useCase.execute(input);

    // Аллокация прошла успешно — возвращаем Ok несмотря на ошибку publish
    expect(result.ok).toBe(true);
  });
});
