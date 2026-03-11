/**
 * RecoveryFlow — интеграционные тесты последовательности восстановления на старте
 *
 * @remarks
 * Проверяет end-to-end поток инициализации Portfolio и сверки ордеров при старте системы.
 *
 * ### Реальные компоненты (без моков домена):
 * - `PortfolioReplayService` + `TestPortfolioStore`
 * - `OrderReconciler` + `InMemoryOrderRepository` + `OrderUpdateHandler`
 * - `EventBus`
 *
 * ### Мок только:
 * - `ICurrentBalanceProvider` (внешний REST-вызов к venue)
 * - `IVenueOrderProvider` (внешний REST-вызов к venue)
 *
 * ### Сценарии:
 * 1. Свежий старт: Portfolio создаётся из venue balance
 * 2. Перезапуск: Portfolio уже существует → ICurrentBalanceProvider не вызывается
 * 3. OrderReconciler: OPEN ордер отсутствует на venue → CANCELED
 * 4. Полная startup sequence: PortfolioReplayService → OrderReconciler
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { PortfolioReplayService } from '../../src/PortfolioReplayService.js';
import { OrderReconciler } from '../../src/OrderReconciler.js';
import type { ICurrentBalanceProvider } from '../../src/ICurrentBalanceProvider.js';
import type { IVenueOrderProvider } from '../../src/IVenueOrderProvider.js';
import { OrderUpdateHandler } from '@polymarket/handlers';
import { EventBus } from '@polymarket/event-bus';
import { NoOpLogger } from '@polymarket/logger';
import { Ok } from '@polymarket/result';
import type { Result } from '@polymarket/result';
import {
  accountIdFromVenue,
  accountIdToString,
  KnownVenues,
  asOrderId,
} from '@polymarket/ids';
import type { AccountId, AssetId } from '@polymarket/ids';
import { Price, Quantity, TimestampService } from '@polymarket/value-objects';
import { Order } from '@polymarket/order';
import { Portfolio } from '@polymarket/portfolio';
import type { IPortfolioStore, VersionConflictError } from '@polymarket/ports';
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
const ACCOUNT_ID = unwrap(accountIdFromVenue(VENUE_ID, 'recovery-test-user'));
const TOKEN_ASSET_ID = {
  type: 'POLYMARKET_CTF_TOKEN',
  tokenId: 'token-recovery',
} as unknown as AssetId;
const ORDER_PRICE = Price.of(new Decimal('0.55'));
const ORDER_SIZE = Quantity.of(new Decimal('100'));

// ── Фабрики ───────────────────────────────────────────────────────────────────

/**
 * Создаёт mock ICurrentBalanceProvider.
 *
 * @param balance - Баланс USDC, возвращаемый провайдером
 * @param callCount - Счётчик вызовов (для проверки идемпотентности)
 */
function makeBalanceProvider(
  balance: Decimal,
  callCount: { count: number },
): ICurrentBalanceProvider {
  return {
    getUsdcBalance: async (_accountId: AccountId) => {
      callCount.count++;
      return balance;
    },
  };
}

/**
 * Создаёт mock IVenueOrderProvider.
 *
 * @param openOrderIds - Список ID открытых ордеров на venue
 */
function makeVenueOrderProvider(openOrderIds: readonly string[] = []): IVenueOrderProvider {
  return {
    getOpenOrderIds: async () => openOrderIds,
  };
}

/**
 * Создаёт OPEN ордер.
 *
 * @param orderId - Идентификатор ордера
 */
function makeOpenOrder(orderId = asOrderId('order-recovery-001')!): Order {
  const order = unwrap(Order.create({
    id: orderId,
    asset: TOKEN_ASSET_ID,
    side: 'BUY',
    price: ORDER_PRICE,
    size: ORDER_SIZE,
    timestamp: unwrap(TimestampService.create(Date.now())),
  }));
  const accepted = unwrap(order.accept());
  accepted.pullEvents();
  return accepted;
}

// ── Тесты ─────────────────────────────────────────────────────────────────────

describe('RecoveryFlow (integration)', () => {
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

  // ── Сценарий 1: Fresh start → Portfolio создаётся из venue balance ──────────

  it('Свежий старт: Portfolio создаётся из venue balance ($500)', async () => {
    // Arrange: portfolioStore пуст, BalanceProvider возвращает $500
    const callCount = { count: 0 };
    const replayService = new PortfolioReplayService({
      balanceProvider: makeBalanceProvider(new Decimal('500'), callCount),
      portfolioStore,
      logger: LOGGER,
    });

    // Assert до: Portfolio не существует
    expect(portfolioStore.get(ACCOUNT_ID)).toBeUndefined();

    // Act
    await replayService.replay(ACCOUNT_ID);

    // Assert: Portfolio создан с балансом $500
    const portfolio = portfolioStore.get(ACCOUNT_ID);
    expect(portfolio).toBeDefined();
    expect(portfolio!.balance.available().value().toNumber()).toBeCloseTo(500, 6);

    // Assert: ICurrentBalanceProvider вызван ровно один раз
    expect(callCount.count).toBe(1);
  });

  // ── Сценарий 2: Перезапуск — Portfolio существует → провайдер не вызывается ─

  it('Перезапуск: Portfolio уже существует → ICurrentBalanceProvider не вызывается', async () => {
    // Arrange: сначала создаём Portfolio через первый replay
    const callCount = { count: 0 };
    const replayService = new PortfolioReplayService({
      balanceProvider: makeBalanceProvider(new Decimal('500'), callCount),
      portfolioStore,
      logger: LOGGER,
    });

    await replayService.replay(ACCOUNT_ID); // Первый вызов — создаёт Portfolio
    expect(callCount.count).toBe(1);

    // Act: второй вызов — Portfolio уже существует
    await replayService.replay(ACCOUNT_ID);

    // Assert: ICurrentBalanceProvider НЕ вызван повторно (идемпотентность)
    expect(callCount.count).toBe(1);

    // Assert: Portfolio не изменился (balance остался $500)
    const portfolio = portfolioStore.get(ACCOUNT_ID);
    expect(portfolio!.balance.available().value().toNumber()).toBeCloseTo(500, 6);
  });

  // ── Сценарий 3: OrderReconciler: OPEN ордер отсутствует → CANCELED ──────────

  it('OrderReconciler: OPEN ордер отсутствует на venue → становится CANCELED', async () => {
    // Arrange: 2 ордера локально, venue возвращает только один
    const orderId1 = asOrderId('order-rec-001')!;
    const orderId2 = asOrderId('order-rec-002')!;

    await orderRepo.save(makeOpenOrder(orderId1));
    await orderRepo.save(makeOpenOrder(orderId2));

    // Venue знает только о первом ордере (String(orderId1))
    const venueOrderProvider = makeVenueOrderProvider([String(orderId1)]);
    const orderUpdateHandler = new OrderUpdateHandler(orderRepo, eventBus, LOGGER);

    const reconciler = new OrderReconciler({
      venueOrderProvider,
      orderRepo,
      orderUpdateHandler,
      logger: LOGGER,
    });

    // Act
    await reconciler.reconcile(ACCOUNT_ID);

    // Assert: первый ордер остался OPEN
    const order1 = await orderRepo.get(orderId1);
    expect(order1?.status).toBe('OPEN');

    // Assert: второй ордер стал CANCELED
    const order2 = await orderRepo.get(orderId2);
    expect(order2?.status).toBe('CANCELED');
  });

  // ── Сценарий 4: Полная startup sequence ────────────────────────────────────

  it('Полная startup sequence: PortfolioReplayService → OrderReconciler', async () => {
    // Arrange: пустой старт, один OPEN ордер отсутствует на venue
    const orderId = asOrderId('order-startup-001')!;
    await orderRepo.save(makeOpenOrder(orderId));

    const callCount = { count: 0 };
    const replayService = new PortfolioReplayService({
      balanceProvider: makeBalanceProvider(new Decimal('750'), callCount),
      portfolioStore,
      logger: LOGGER,
    });

    const orderUpdateHandler = new OrderUpdateHandler(orderRepo, eventBus, LOGGER);
    const reconciler = new OrderReconciler({
      venueOrderProvider: makeVenueOrderProvider([]),  // Venue пуст
      orderRepo,
      orderUpdateHandler,
      logger: LOGGER,
    });

    // Act: выполняем startup sequence
    await replayService.replay(ACCOUNT_ID);
    await reconciler.reconcile(ACCOUNT_ID);

    // Assert: Portfolio создан с $750
    const portfolio = portfolioStore.get(ACCOUNT_ID);
    expect(portfolio).toBeDefined();
    expect(portfolio!.balance.available().value().toNumber()).toBeCloseTo(750, 6);

    // Assert: ордер отменён
    const order = await orderRepo.get(orderId);
    expect(order?.status).toBe('CANCELED');
  });
});
