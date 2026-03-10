/**
 * Тесты CloseMarketUseCase
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { CloseMarketUseCase } from '../src/CloseMarketUseCase.js';
import type { CloseMarketInput } from '../src/CloseMarketUseCase.js';
import type { ILogger } from '@polymarket/logger';
import type { IEventBus } from '@polymarket/event-bus';
import type { IBalanceAllocator, IOrderRepository } from '@polymarket/ports';
import type { CancelOrderUseCase } from '@polymarket/use-cases';
import type { AccountId, MarketId, OrderId, AssetId } from '@polymarket/ids';
import { Money, Price, Quantity } from '@polymarket/value-objects';
import { Ok } from '@polymarket/result';
import { Order } from '@polymarket/order';
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
const ASSET_ID = { type: 'POLYMARKET_CTF_TOKEN', tokenId: 't1' } as unknown as AssetId;

const mockTimestamp = {
  value: () => new Decimal(1000000),
  toNumber: () => 1000000,
  toISO: () => '2024-01-01T00:00:00Z',
} as never;

function makeClock() {
  return { now: () => new Date(1_700_000_000_000) };
}

function makeOpenOrder(id: string): Order {
  const orderId = id as unknown as OrderId;
  const result = Order.create({
    id: orderId,
    asset: ASSET_ID,
    side: 'BUY',
    price: Price.of(new Decimal('0.65')) as never,
    size: Quantity.of(new Decimal('100')) as never,
    timestamp: mockTimestamp,
  });
  if (!result.ok) throw new Error('Failed to create Order');
  const openResult = result.value.accept();
  if (!openResult.ok) throw new Error('Failed to accept Order');
  openResult.value.pullEvents();
  return openResult.value;
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

describe('CloseMarketUseCase', () => {
  let allocator: jest.Mocked<IBalanceAllocator>;
  let orderRepo: jest.Mocked<IOrderRepository>;
  let cancelOrderUseCase: jest.Mocked<Pick<CancelOrderUseCase, 'execute'>>;
  let eventBus: IEventBus;
  let logger: ILogger;
  let useCase: CloseMarketUseCase;

  beforeEach(() => {
    allocator = makeAllocator();
    orderRepo = {
      get: jest.fn<IOrderRepository['get']>(),
      save: jest.fn<IOrderRepository['save']>().mockResolvedValue(undefined),
      delete: jest.fn<IOrderRepository['delete']>().mockResolvedValue(undefined),
      getByStrategyId: jest.fn<IOrderRepository['getByStrategyId']>().mockResolvedValue([]),
      countByStrategyId: jest.fn<IOrderRepository['countByStrategyId']>().mockResolvedValue(0),
      getAll: jest.fn<IOrderRepository['getAll']>().mockResolvedValue([]),
    };
    cancelOrderUseCase = {
      execute: jest.fn<CancelOrderUseCase['execute']>().mockResolvedValue(Ok(undefined)),
    };
    eventBus = makeEventBus();
    logger = makeLogger();

    useCase = new CloseMarketUseCase({
      balanceAllocator: allocator,
      orderRepo,
      cancelOrderUseCase: cancelOrderUseCase as unknown as CancelOrderUseCase,
      eventBus,
      clock: makeClock(),
      logger,
    });
  });

  const baseInput: CloseMarketInput = {
    marketId: MARKET_ID,
    accountId: ACCOUNT_ID,
    reason: 'EXPIRED',
  };

  it('успешно закрывает рынок без ордеров', async () => {
    const result = await useCase.execute(baseInput);

    expect(result.ok).toBe(true);
    expect(allocator.release).toHaveBeenCalledWith(MARKET_ID);
    expect((eventBus.publish as jest.MockedFunction<IEventBus['publish']>)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'MARKET_CLOSED', reason: 'EXPIRED' }),
    );
  });

  it('отменяет открытые ордера рынка перед закрытием', async () => {
    const order1 = makeOpenOrder('order-1');
    const order2 = makeOpenOrder('order-2');
    orderRepo.getByStrategyId.mockResolvedValue([order1, order2]);

    const result = await useCase.execute(baseInput);

    expect(result.ok).toBe(true);
    expect(cancelOrderUseCase.execute).toHaveBeenCalledTimes(2);
  });

  it('использует releaseWithPnL если указан realizedPnL', async () => {
    const pnl = Money.of(new Decimal(200), 'USDC');
    const input: CloseMarketInput = { ...baseInput, realizedPnL: pnl };

    const result = await useCase.execute(input);

    expect(result.ok).toBe(true);
    expect(allocator.releaseWithPnL).toHaveBeenCalledWith(MARKET_ID, pnl);
    expect(allocator.release).not.toHaveBeenCalled();
  });

  it('продолжает если отмена одного ордера не удалась', async () => {
    const order = makeOpenOrder('order-fail');
    orderRepo.getByStrategyId.mockResolvedValue([order]);
    (cancelOrderUseCase.execute as jest.MockedFunction<CancelOrderUseCase['execute']>)
      .mockResolvedValue(Ok(undefined)); // best effort — не важно что вернёт

    const result = await useCase.execute(baseInput);

    expect(result.ok).toBe(true);
    expect((eventBus.publish as jest.MockedFunction<IEventBus['publish']>)).toHaveBeenCalled();
  });

  it('публикует MARKET_CLOSED с reason=MANUAL', async () => {
    const input: CloseMarketInput = { ...baseInput, reason: 'MANUAL' };

    await useCase.execute(input);

    expect((eventBus.publish as jest.MockedFunction<IEventBus['publish']>)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'MARKET_CLOSED', reason: 'MANUAL' }),
    );
  });
});
