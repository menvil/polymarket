/**
 * MarketLifecycle — интеграционные тесты жизненного цикла рынка
 *
 * @remarks
 * Проверяет end-to-end поток от открытия рынка до его закрытия с отменой ордеров и учётом PnL.
 *
 * ### Реальные компоненты (без моков):
 * - `OpenMarketUseCase` + `BalanceAllocator`
 * - `CloseMarketUseCase` + `BalanceAllocator` + `CancelOrderUseCase`
 * - `OrderService`, `PortfolioService`
 * - `InMemoryOrderRepository`
 * - `EventBus`
 *
 * ### Мок только:
 * - `IExchangeClient` (внешняя биржа)
 *
 * ### Сценарии:
 * 1. Open market → MARKET_OPENED опубликован, аллокация создана
 * 2. Open при заполненных слотах → Err, событие не публикуется
 * 3. Close с realizedPnL → MARKET_CLOSED, баланс увеличился
 * 4. Close → открытые ордера отменяются перед закрытием
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { OpenMarketUseCase } from '../../src/OpenMarketUseCase.js';
import { CloseMarketUseCase } from '../../src/CloseMarketUseCase.js';
import { BalanceAllocator } from '@polymarket/balance-allocator';
import { CancelOrderUseCase } from '@polymarket/use-cases';
import { OrderService } from '@polymarket/use-cases';
import { PortfolioService } from '@polymarket/use-cases';
import { EventBus } from '@polymarket/event-bus';
import type { ApplicationEvent } from '@polymarket/event-bus';
import { NoOpLogger } from '@polymarket/logger';
import { Ok } from '@polymarket/result';
import type { Result } from '@polymarket/result';
import {
  accountIdFromVenue,
  accountIdToString,
  KnownVenues,
  asMarketId,
  asOrderId,
} from '@polymarket/ids';
import type { AccountId, AssetId } from '@polymarket/ids';
import { Price, Quantity, TimestampService, Money, Ratio } from '@polymarket/value-objects';
import { Order } from '@polymarket/order';
import { Portfolio } from '@polymarket/portfolio';
import type {
  IPortfolioStore,
  IExchangeClient,
  VersionConflictError,
} from '@polymarket/ports';
import Decimal from 'decimal.js';

import { InMemoryOrderRepository } from '../../../../infrastructure/backtesting/src/InMemoryOrderRepository.js';

// ── TestPortfolioStore ────────────────────────────────────────────────────────

class TestPortfolioStore implements IPortfolioStore {
  private readonly _map = new Map<string, Portfolio>();

  get(accountId: AccountId): Portfolio | undefined {
    return this._map.get(accountIdToString(accountId));
  }

  save(portfolio: Portfolio, _expectedVersion: number): Result<void, VersionConflictError> {
    this._map.set(accountIdToString(portfolio.accountId), portfolio);
    return Ok(undefined);
  }

  clear(): void {
    this._map.clear();
  }
}

// ── Утилиты ───────────────────────────────────────────────────────────────────

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw result.error;
  return result.value;
}

// ── Константы тестов ──────────────────────────────────────────────────────────

const LOGGER = new NoOpLogger();
const VENUE_ID = KnownVenues.POLYMARKET;
const ACCOUNT_ID = unwrap(accountIdFromVenue(VENUE_ID, 'lifecycle-test-user'));
const MARKET_ID = asMarketId('market-lc-001')!;
const MARKET_ID_2 = asMarketId('market-lc-002')!;
const STRATEGY_ID = 'strategy-lc-001';
const TOKEN_ASSET_ID = {
  type: 'POLYMARKET_CTF_TOKEN',
  tokenId: 'token-lc',
} as unknown as AssetId;
const ORDER_PRICE = Price.of(new Decimal('0.60'));
const ORDER_SIZE = Quantity.of(new Decimal('100'));

// ── Фабрики ───────────────────────────────────────────────────────────────────

/**
 * Создаёт BalanceAllocator с заданным начальным балансом.
 *
 * @param totalBalance - Начальный баланс в USDC
 * @param maxConcurrentMarkets - Максимальное число одновременных рынков
 */
function makeAllocator(
  totalBalance: number = 1000,
  maxConcurrentMarkets: number = 5,
): BalanceAllocator {
  return new BalanceAllocator(
    {
      tradingBalanceRatio: Ratio.of(new Decimal('1.0')),
      minCapitalPerMarket: Money.of(new Decimal('50'), 'USDC'),
      maxConcurrentMarkets,
    },
    Money.of(new Decimal(String(totalBalance)), 'USDC'),
    LOGGER,
  );
}

/**
 * Создаёт mock IExchangeClient (все методы успешны).
 */
function makeExchangeClient(): IExchangeClient {
  return {
    submitOrder: () => Promise.resolve(Ok(asOrderId('order-mock')!)),
    cancelOrder: () => Promise.resolve(Ok(undefined)),
    getOpenOrders: () => Promise.resolve(Ok([])),
    getTrades: () => Promise.resolve(Ok([])),
  };
}

/**
 * Создаёт OPEN ордер с заданным strategyId для фильтрации в CloseMarketUseCase.
 *
 * @param orderId - Идентификатор ордера
 * @param strategyId - Идентификатор стратегии (должен совпадать с String(marketId))
 */
function makeOpenOrder(
  orderId = asOrderId('order-lc-001')!,
  strategyId = String(MARKET_ID),
): Order {
  const order = unwrap(Order.create({
    id: orderId,
    asset: TOKEN_ASSET_ID,
    side: 'BUY',
    price: ORDER_PRICE,
    size: ORDER_SIZE,
    strategyId,
    timestamp: unwrap(TimestampService.create(Date.now())),
  }));
  const accepted = unwrap(order.accept());
  accepted.pullEvents();
  return accepted;
}

// ── Тесты ─────────────────────────────────────────────────────────────────────

describe('MarketLifecycle (integration)', () => {
  let orderRepo: InMemoryOrderRepository;
  let portfolioStore: TestPortfolioStore;
  let eventBus: EventBus;

  beforeEach(() => {
    orderRepo = new InMemoryOrderRepository();
    portfolioStore = new TestPortfolioStore();
    eventBus = new EventBus(LOGGER);
  });

  afterEach(() => {
    orderRepo.clear();
    portfolioStore.clear();
  });

  // ── Сценарий 1: Open market → MARKET_OPENED + allocation ───────────────────

  it('Open market → MARKET_OPENED опубликован, аллокация создана', async () => {
    // Arrange
    const allocator = makeAllocator(1000, 5);

    const useCase = new OpenMarketUseCase({
      balanceAllocator: allocator,
      eventBus,
      clock: { now: () => new Date() },
      logger: LOGGER,
    });

    const published: ApplicationEvent[] = [];
    eventBus.subscribe('MARKET_OPENED', async (e) => { published.push(e); });

    // Act
    const result = await useCase.execute({
      marketId: MARKET_ID,
      strategyId: STRATEGY_ID,
      accountId: ACCOUNT_ID,
    });

    // Assert: Ok с AllocationResult
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.marketId).toBe(MARKET_ID);
    expect(result.value.allocatedAmount.value().toNumber()).toBeGreaterThan(0);

    // Assert: аллокация в BalanceAllocator
    const allocation = allocator.getAllocation(MARKET_ID);
    expect(allocation).toBeDefined();
    expect(allocation!.value().toNumber()).toBeGreaterThan(0);

    // Assert: MARKET_OPENED опубликован
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ type: 'MARKET_OPENED', marketId: MARKET_ID });
  });

  // ── Сценарий 2: Open при заполненных слотах → Err ──────────────────────────

  it('Open при заполненных слотах → Err, MARKET_OPENED не публикуется', async () => {
    // Arrange: max=1, предзаполняем единственный слот
    const allocator = makeAllocator(1000, 1);
    unwrap(allocator.addMarket(MARKET_ID_2));  // Слот занят

    const useCase = new OpenMarketUseCase({
      balanceAllocator: allocator,
      eventBus,
      clock: { now: () => new Date() },
      logger: LOGGER,
    });

    const published: ApplicationEvent[] = [];
    eventBus.subscribe('MARKET_OPENED', async (e) => { published.push(e); });

    // Act
    const result = await useCase.execute({
      marketId: MARKET_ID,
      strategyId: STRATEGY_ID,
      accountId: ACCOUNT_ID,
    });

    // Assert: Err — нет свободных слотов
    expect(result.ok).toBe(false);

    // Assert: аллокация для нового рынка не создана
    expect(allocator.getAllocation(MARKET_ID)).toBeUndefined();

    // Assert: MARKET_OPENED не опубликован
    expect(published).toHaveLength(0);
  });

  // ── Сценарий 3: Close с realizedPnL → баланс увеличился ───────────────────

  it('Close с realizedPnL → MARKET_CLOSED опубликован, аллокация удалена, баланс вырос', async () => {
    // Arrange: открыть рынок
    const allocator = makeAllocator(1000, 5);
    unwrap(allocator.addMarket(MARKET_ID));

    const initialStats = allocator.getStats();
    const initialBalance = initialStats.totalBalance.value().toNumber();

    const orderService = new OrderService(orderRepo, LOGGER);
    const portfolioService = new PortfolioService(portfolioStore, LOGGER);
    const cancelOrderUseCase = new CancelOrderUseCase({
      orderService,
      portfolioService,
      orderRepo,
      exchangeClient: makeExchangeClient(),
      eventBus,
      logger: LOGGER,
    });

    const useCase = new CloseMarketUseCase({
      balanceAllocator: allocator,
      orderRepo,
      cancelOrderUseCase,
      eventBus,
      clock: { now: () => new Date() },
      logger: LOGGER,
    });

    const published: ApplicationEvent[] = [];
    eventBus.subscribe('MARKET_CLOSED', async (e) => { published.push(e); });

    const realizedPnL = Money.of(new Decimal('20'), 'USDC');

    // Act
    const result = await useCase.execute({
      marketId: MARKET_ID,
      accountId: ACCOUNT_ID,
      reason: 'EXPIRED',
      realizedPnL,
    });

    // Assert: Ok
    expect(result.ok).toBe(true);

    // Assert: аллокация удалена
    expect(allocator.getAllocation(MARKET_ID)).toBeUndefined();

    // Assert: MARKET_CLOSED опубликован
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ type: 'MARKET_CLOSED', marketId: MARKET_ID });

    // Assert: баланс вырос на PnL
    const finalStats = allocator.getStats();
    expect(finalStats.totalBalance.value().toNumber()).toBeCloseTo(
      initialBalance + realizedPnL.value().toNumber(),
      6,
    );
  });

  // ── Сценарий 4: Close → открытые ордера отменяются ─────────────────────────

  it('Close → 2 открытых ордера для рынка становятся CANCELED', async () => {
    // Arrange: создать 2 OPEN ордера с strategyId = String(MARKET_ID)
    const orderId1 = asOrderId('order-lc-close-001')!;
    const orderId2 = asOrderId('order-lc-close-002')!;

    await orderRepo.save(makeOpenOrder(orderId1, String(MARKET_ID)));
    await orderRepo.save(makeOpenOrder(orderId2, String(MARKET_ID)));

    // Arrange: pre-allocate market (CloseMarketUseCase вызывает release/releaseWithPnL)
    const allocator = makeAllocator(1000, 5);
    unwrap(allocator.addMarket(MARKET_ID));

    const orderService = new OrderService(orderRepo, LOGGER);
    const portfolioService = new PortfolioService(portfolioStore, LOGGER);
    const cancelOrderUseCase = new CancelOrderUseCase({
      orderService,
      portfolioService,
      orderRepo,
      exchangeClient: makeExchangeClient(),
      eventBus,
      logger: LOGGER,
    });

    const useCase = new CloseMarketUseCase({
      balanceAllocator: allocator,
      orderRepo,
      cancelOrderUseCase,
      eventBus,
      clock: { now: () => new Date() },
      logger: LOGGER,
    });

    // Act
    const result = await useCase.execute({
      marketId: MARKET_ID,
      accountId: ACCOUNT_ID,
      reason: 'EXPIRED',
    });

    // Assert: Ok
    expect(result.ok).toBe(true);

    // Assert: оба ордера CANCELED
    const order1 = await orderRepo.get(orderId1);
    const order2 = await orderRepo.get(orderId2);
    expect(order1?.status).toBe('CANCELED');
    expect(order2?.status).toBe('CANCELED');
  });
});
