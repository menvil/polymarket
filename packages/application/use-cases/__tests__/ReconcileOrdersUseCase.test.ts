/**
 * Тесты ReconcileOrdersUseCase
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ReconcileOrdersUseCase } from '../src/ReconcileOrdersUseCase.js';
// ReconcileOrdersDeps and ReconcileOrdersInput are exported but not used directly in tests
import type { ILogger } from '@polymarket/logger';
import type { IEventBus } from '@polymarket/event-bus';
import type { IOrderRepository, IExchangeClient, OpenOrderSnapshot } from '@polymarket/ports';
import { ExchangeError } from '@polymarket/ports';
import type { AccountId, AssetId, OrderId } from '@polymarket/ids';
import { Price, Quantity } from '@polymarket/value-objects';
import { Ok, Err } from '@polymarket/result';
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

const ACCOUNT_ID = 'acc-001' as unknown as AccountId;
const ASSET_ID = { type: 'POLYMARKET_CTF_TOKEN', tokenId: 'token-abc' } as unknown as AssetId;

const mockTimestamp = {
  value: () => new Decimal(1000000),
  toNumber: () => 1000000,
  toISO: () => '2024-01-01T00:00:00.000Z',
} as never;

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
  if (!result.ok) throw new Error(`Failed to create Order: ${result.error.message}`);
  // Переводим в OPEN статус (accept = exchange acknowledged the order)
  const openResult = result.value.accept();
  if (!openResult.ok) throw new Error(`Failed to accept Order: ${openResult.error.message}`);
  openResult.value.pullEvents();
  return openResult.value;
}

function makeExchangeSnapshot(orderId: string): OpenOrderSnapshot {
  return {
    orderId: orderId as unknown as OrderId,
    accountId: ACCOUNT_ID,
    asset: ASSET_ID,
    side: 'BUY',
    price: Price.of(new Decimal('0.65')) as never,
    size: Quantity.of(new Decimal('100')) as never,
    filledSize: Quantity.of(new Decimal('0')) as never,
    status: 'OPEN',
    createdAt: mockTimestamp,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ReconcileOrdersUseCase', () => {
  let orderRepo: jest.Mocked<IOrderRepository>;
  let exchangeClient: jest.Mocked<IExchangeClient>;
  let eventBus: IEventBus;
  let logger: ILogger;
  let useCase: ReconcileOrdersUseCase;

  beforeEach(() => {
    orderRepo = {
      get: jest.fn<IOrderRepository['get']>(),
      save: jest.fn<IOrderRepository['save']>().mockResolvedValue(undefined),
      delete: jest.fn<IOrderRepository['delete']>().mockResolvedValue(undefined),
      getByStrategyId: jest.fn<IOrderRepository['getByStrategyId']>().mockResolvedValue([]),
      countByStrategyId: jest.fn<IOrderRepository['countByStrategyId']>().mockResolvedValue(0),
      getAll: jest.fn<IOrderRepository['getAll']>(),
      getByMarketId: jest.fn<IOrderRepository['getByMarketId']>().mockResolvedValue([]),
    };
    exchangeClient = {
      submitOrder: jest.fn() as jest.MockedFunction<IExchangeClient['submitOrder']>,
      cancelOrder: jest.fn() as jest.MockedFunction<IExchangeClient['cancelOrder']>,
      getOpenOrders: jest.fn() as jest.MockedFunction<IExchangeClient['getOpenOrders']>,
      getTrades: jest.fn() as jest.MockedFunction<IExchangeClient['getTrades']>,
    };
    eventBus = makeEventBus();
    logger = makeLogger();

    useCase = new ReconcileOrdersUseCase({ orderRepo, exchangeClient, eventBus, logger });
  });

  it('возвращает пустой отчёт если нет открытых ордеров', async () => {
    orderRepo.getAll.mockResolvedValue([]);

    const result = await useCase.execute({ accountId: ACCOUNT_ID });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.checkedCount).toBe(0);
    expect(result.value.externalCancelCount).toBe(0);
    expect(exchangeClient.getOpenOrders).not.toHaveBeenCalled();
  });

  it('не отменяет ордера, которые есть на бирже', async () => {
    const order = makeOpenOrder('order-1');
    orderRepo.getAll.mockResolvedValue([order]);
    (exchangeClient.getOpenOrders as jest.MockedFunction<IExchangeClient['getOpenOrders']>)
      .mockResolvedValue(Ok([makeExchangeSnapshot('order-1')]));

    const result = await useCase.execute({ accountId: ACCOUNT_ID });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.checkedCount).toBe(1);
    expect(result.value.externalCancelCount).toBe(0);
    expect(orderRepo.save).not.toHaveBeenCalled();
  });

  it('отменяет ордер отсутствующий на бирже (внешняя отмена)', async () => {
    const order = makeOpenOrder('order-missing');
    orderRepo.getAll.mockResolvedValue([order]);
    (exchangeClient.getOpenOrders as jest.MockedFunction<IExchangeClient['getOpenOrders']>)
      .mockResolvedValue(Ok([])); // бирж пуста

    const result = await useCase.execute({ accountId: ACCOUNT_ID });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.checkedCount).toBe(1);
    expect(result.value.externalCancelCount).toBe(1);
    expect(orderRepo.save).toHaveBeenCalledTimes(1);
    expect((eventBus.publishAll as jest.MockedFunction<IEventBus['publishAll']>)).toHaveBeenCalled();
  });

  it('возвращает Err если getOpenOrders упал', async () => {
    const order = makeOpenOrder('order-1');
    orderRepo.getAll.mockResolvedValue([order]);
    (exchangeClient.getOpenOrders as jest.MockedFunction<IExchangeClient['getOpenOrders']>)
      .mockResolvedValue(Err(new ExchangeError('Exchange down')));

    const result = await useCase.execute({ accountId: ACCOUNT_ID });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('Exchange getOpenOrders failed');
  });

  it('частично работает: один ордер есть, второй отсутствует', async () => {
    const order1 = makeOpenOrder('order-keep');
    const order2 = makeOpenOrder('order-cancel');
    orderRepo.getAll.mockResolvedValue([order1, order2]);
    (exchangeClient.getOpenOrders as jest.MockedFunction<IExchangeClient['getOpenOrders']>)
      .mockResolvedValue(Ok([makeExchangeSnapshot('order-keep')]));

    const result = await useCase.execute({ accountId: ACCOUNT_ID });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.checkedCount).toBe(2);
    expect(result.value.externalCancelCount).toBe(1);
    expect(orderRepo.save).toHaveBeenCalledTimes(1);
  });
});
