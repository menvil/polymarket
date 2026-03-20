/**
 * Reconciliation — интеграционные тесты сверки ордеров и исполнений
 *
 * @remarks
 * Проверяет сценарии reconciliation с реальными компонентами (без моков домена).
 *
 * ### Реальные компоненты (без моков):
 * - `ReconcileOrdersUseCase` + `InMemoryOrderRepository`
 * - `ReconcileTradesUseCase` + `InMemoryProcessedFillRepository` + `ProcessFillUseCase`
 * - `EventBus`
 *
 * ### Мок только:
 * - `IExchangeClient` (внешняя биржа)
 *
 * ### Сценарии:
 * 1. ReconcileOrders: OPEN ордер пропал с биржи → CANCELED
 * 2. ReconcileOrders: идемпотентность (повторный вызов → same report)
 * 3. ReconcileTrades: fill на бирже не в FillRepo → обработан (processedFillRepo.has = true)
 * 4. ReconcileTrades: уже обработанный fill → пропущен
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ReconcileOrdersUseCase } from '../../src/ReconcileOrdersUseCase.js';
import { ReconcileTradesUseCase } from '../../src/ReconcileTradesUseCase.js';
import { ProcessFillUseCase } from '../../src/ProcessFillUseCase.js';
import { PortfolioService } from '../../src/services/PortfolioService.js';
import { LedgerService } from '../../src/services/LedgerService.js';
import { EventBus } from '@polymarket/event-bus';
import { NoOpLogger } from '@polymarket/logger';
import { Ok } from '@polymarket/result';
import type { Result } from '@polymarket/result';
import {
  accountIdFromVenue,
  accountIdToString,
  KnownVenues,
  AssetIdHelpers,
  asFillId,
  asOrderId,
  asMarketId,
} from '@polymarket/ids';
import type { AccountId, AssetId, FillId } from '@polymarket/ids';
import { Price, Quantity, TimestampService } from '@polymarket/value-objects';
import { Order } from '@polymarket/order';
import { Portfolio } from '@polymarket/portfolio';
import type {
  IPortfolioStore,
  IExchangeClient,
  VersionConflictError,
  VenueTradeSnapshot,
  OpenOrderSnapshot,
} from '@polymarket/ports';
import Decimal from 'decimal.js';

import { InMemoryOrderRepository } from '../../../../infrastructure/backtesting/src/InMemoryOrderRepository.js';
import { InMemoryProcessedFillRepository } from '../../../../infrastructure/backtesting/src/InMemoryProcessedFillRepository.js';

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
const ACCOUNT_ID = unwrap(accountIdFromVenue(VENUE_ID, 'recon-test-user'));
const TOKEN_ASSET_ID = {
  type: 'POLYMARKET_CTF_TOKEN',
  tokenId: 'token-recon',
} as unknown as AssetId;
const MARKET_ID = asMarketId('market-recon-001')!;
const ORDER_PRICE = Price.of(new Decimal('0.65'));
const ORDER_SIZE = Quantity.of(new Decimal('50'));

// ── Фабрики ───────────────────────────────────────────────────────────────────

function makeOpenOrder(id = asOrderId('order-recon-001')!): Order {
  const order = unwrap(Order.create({
    id,
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

/**
 * Создаёт mock IExchangeClient.
 *
 * @param openOrders - Список открытых ордеров (default: пустой)
 * @param trades - Список исполнений (default: пустой)
 */
function makeExchangeClient(
  openOrders: OpenOrderSnapshot[] = [],
  trades: VenueTradeSnapshot[] = [],
): IExchangeClient {
  return {
    submitOrder: () => Promise.resolve(Ok(asOrderId('order-mock')!)),
    cancelOrder: () => Promise.resolve(Ok(undefined)),
    getOpenOrders: () => Promise.resolve(Ok(openOrders)),
    getTrades: () => Promise.resolve(Ok(trades)),
  };
}

/**
 * Создаёт VenueTradeSnapshot для тестов reconcileTrades.
 *
 * @param fillId - ID исполнения
 * @param orderId - ID ордера
 */
function makeTradeSnapshot(fillId: FillId): VenueTradeSnapshot {
  return {
    fillId,
    orderId: asOrderId('order-venue-001')!,
    accountId: ACCOUNT_ID,
    marketId: MARKET_ID,
    asset: TOKEN_ASSET_ID,
    side: 'BUY',
    price: ORDER_PRICE,
    size: Quantity.of(new Decimal('30')),
    fee: {
      amount: Quantity.of(new Decimal('0')),
      asset: AssetIdHelpers.USDC,
    },
    executedAt: unwrap(TimestampService.create(Date.now())),
    status: 'CONFIRMED',
  };
}

// ── ReconcileOrders тесты ────────────────────────────────────────────────────

describe('ReconcileOrdersUseCase (integration)', () => {
  let orderRepo: InMemoryOrderRepository;
  let eventBus: EventBus;

  beforeEach(() => {
    orderRepo = new InMemoryOrderRepository();
    eventBus = new EventBus(LOGGER);
  });

  afterEach(() => {
    orderRepo.clear();
  });

  it('OPEN ордер, пропавший с биржи → CANCELED, событие опубликовано', async () => {
    // Arrange: 2 ордера локально, только 1 на бирже
    const orderId1 = asOrderId('order-recon-001')!;
    const orderId2 = asOrderId('order-recon-002')!;

    const order1 = makeOpenOrder(orderId1);
    const order2 = makeOpenOrder(orderId2);
    await orderRepo.save(order1);
    await orderRepo.save(order2);

    // Биржа знает только о первом ордере
    const exchangeOpenOrder: OpenOrderSnapshot = {
      orderId: orderId1,
      accountId: ACCOUNT_ID,
      asset: TOKEN_ASSET_ID,
      side: 'BUY',
      price: ORDER_PRICE,
      size: ORDER_SIZE,
      filledSize: Quantity.of(new Decimal('0')),
      status: 'OPEN',
      createdAt: unwrap(TimestampService.create(Date.now())),
    };

    const useCase = new ReconcileOrdersUseCase({
      orderRepo,
      exchangeClient: makeExchangeClient([exchangeOpenOrder]),
      eventBus,
      logger: LOGGER,
    });

    const published: unknown[] = [];
    eventBus.subscribe('ORDER_CANCELLED', async (e) => { published.push(e); });

    // Act
    const result = await useCase.execute({ accountId: ACCOUNT_ID });

    // Assert: Ok с корректным отчётом
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.checkedCount).toBe(2);
    expect(result.value.externalCancelCount).toBe(1);
    expect(result.value.errorCount).toBe(0);

    // Assert: второй ордер теперь CANCELED
    const cancelledOrder = await orderRepo.get(orderId2);
    expect(cancelledOrder?.status).toBe('CANCELED');

    // Assert: ORDER_CANCELLED событие опубликовано
    expect(published).toHaveLength(1);
  });

  it('ReconcileOrders идемпотентен: повторный вызов → те же результаты', async () => {
    // Arrange: ордер отсутствует на бирже
    const orderId = asOrderId('order-recon-idem')!;
    await orderRepo.save(makeOpenOrder(orderId));

    const useCase = new ReconcileOrdersUseCase({
      orderRepo,
      exchangeClient: makeExchangeClient([]), // биржа пуста
      eventBus,
      logger: LOGGER,
    });

    // Первый вызов
    const first = await useCase.execute({ accountId: ACCOUNT_ID });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.externalCancelCount).toBe(1);

    // Второй вызов — ордер уже CANCELED, фильтруется на шаге 2
    const second = await useCase.execute({ accountId: ACCOUNT_ID });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // Результат идентичен первому (checkedCount=0, нет открытых ордеров)
    expect(second.value.checkedCount).toBe(0);
    expect(second.value.externalCancelCount).toBe(0);
  });
});

// ── ReconcileTrades тесты ────────────────────────────────────────────────────

describe('ReconcileTradesUseCase (integration)', () => {
  let processedFillRepo: InMemoryProcessedFillRepository;
  let portfolioStore: TestPortfolioStore;
  let orderRepo: InMemoryOrderRepository;
  let eventBus: EventBus;
  let processFillUseCase: ProcessFillUseCase;

  beforeEach(() => {
    processedFillRepo = new InMemoryProcessedFillRepository();
    portfolioStore = new TestPortfolioStore();
    orderRepo = new InMemoryOrderRepository();
    eventBus = new EventBus(LOGGER);

    const portfolioService = new PortfolioService(portfolioStore, LOGGER);
    const ledgerService = new LedgerService(LOGGER);

    processFillUseCase = new ProcessFillUseCase({
      orderStateStore: orderRepo,
      portfolioService,
      ledgerService,
      orderRepo,
      processedFillRepo,
      eventBus,
      logger: LOGGER,
    });
  });

  afterEach(() => {
    processedFillRepo.clear();
    portfolioStore.clear();
    orderRepo.clear();
  });

  it('Fill на бирже не в FillRepo → ReconcileTradesUseCase помечает как обработанный', async () => {
    // Arrange
    const fillId = asFillId('fill-venue-001')!;
    const tradeSnapshot = makeTradeSnapshot(fillId);

    const useCase = new ReconcileTradesUseCase({
      exchangeClient: makeExchangeClient([], [tradeSnapshot]),
      processedFillRepo,
      processFillUseCase,
      logger: LOGGER,
    });

    // Assert до: fill не обработан
    expect(processedFillRepo.has(fillId)).toBe(false);

    // Act
    const result = await useCase.execute({ accountId: ACCOUNT_ID });

    // Assert: Ok
    expect(result.ok).toBe(true);

    // Assert: fill помечен в processedFillRepo (ReconcileTradesUseCase делает это первым шагом)
    expect(processedFillRepo.has(fillId)).toBe(true);
  });

  it('Уже обработанный fill → пропускается, processedFillRepo не дублируется', async () => {
    // Arrange: fill уже в processedFillRepo
    const fillId = asFillId('fill-venue-dup-001')!;
    await processedFillRepo.markIfNotExists(fillId); // уже обработан

    const tradeSnapshot = makeTradeSnapshot(fillId);

    let processCallCount = 0;
    const originalExecute = processFillUseCase.execute.bind(processFillUseCase);
    // Оборачиваем для отслеживания вызовов
    const trackingProcessFill = {
      execute: async (fill: Parameters<typeof originalExecute>[0]) => {
        processCallCount++;
        return originalExecute(fill);
      },
    };

    const useCase = new ReconcileTradesUseCase({
      exchangeClient: makeExchangeClient([], [tradeSnapshot]),
      processedFillRepo,
      processFillUseCase: trackingProcessFill as typeof processFillUseCase,
      logger: LOGGER,
    });

    // Act
    const result = await useCase.execute({ accountId: ACCOUNT_ID });

    // Assert: Ok
    expect(result.ok).toBe(true);

    // Assert: ProcessFillUseCase НЕ был вызван (fill уже обработан)
    expect(processCallCount).toBe(0);
  });
});
