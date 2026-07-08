/**
 * FillOrchestrator — интеграционные тесты цепочки EventBus → Orchestrator → UseCase
 *
 * @remarks
 * Проверяет что `EventBus.publish(FILL_RECEIVED)` → `FillOrchestrator` → `ProcessFillUseCase`
 * работает без потерь событий и без неожиданных крашей.
 *
 * ### Реальные компоненты (без моков):
 * - `FillOrchestrator`
 * - `ProcessFillUseCase` + `OrderService` + `PortfolioService` + `LedgerService`
 * - `EventBus` (реальный)
 * - `InMemoryOrderRepository`, `InMemoryProcessedFillRepository`
 * - `TestPortfolioStore`
 *
 * ### Почему это отличается от unit-тестов:
 * Unit-тест FillOrchestrator мокает ProcessFillUseCase — не проверяет реальную цепочку.
 * Здесь проверяется что EventBus → subscribe → handler → use case работает end-to-end.
 *
 * ### Сценарии:
 * 1. FILL_RECEIVED → ORDER_FILLED публикуется (вся цепочка)
 * 2. Дублирующий FILL_RECEIVED → ORDER_FILLED только один раз (idempotency)
 * 3. FILL_RECEIVED для неизвестного ордера → ошибка логируется, следующий fill обрабатывается
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { FillOrchestrator } from '../../src/FillOrchestrator.js';
import { ProcessFillUseCase } from '@polymarket/use-cases';
// OrderService не нужен — ProcessFillDeps использует orderStateStore напрямую
import { PortfolioService } from '@polymarket/use-cases';
import { LedgerService } from '@polymarket/use-cases';
import { EventBus } from '@polymarket/event-bus';
import type { ApplicationEvent } from '@polymarket/event-bus';
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
import type { AccountId, AssetId, FillId, OrderId } from '@polymarket/ids';
import { Price, Quantity, Fee, TimestampService, Money } from '@polymarket/value-objects';
import { Balance } from '@polymarket/value-objects/balance';
import { Order } from '@polymarket/order';
import { Fill } from '@polymarket/fill';
import { Portfolio, asPortfolioId } from '@polymarket/portfolio';
import type { IPortfolioStore, VersionConflictError } from '@polymarket/ports';
import Decimal from 'decimal.js';

import { InMemoryOrderRepository } from '../../../../infrastructure/in-memory/src/InMemoryOrderRepository.js';
import { InMemoryProcessedFillRepository } from '../../../../infrastructure/in-memory/src/InMemoryProcessedFillRepository.js';
import { InMemoryKeyedMutex } from '../../../../infrastructure/in-memory/src/InMemoryKeyedMutex.js';

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

  /** Всегда 0 — эта тестовая реализация намеренно не поддерживает версионирование. */
  getVersion(_accountId: AccountId): number {
    return 0;
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
const ACCOUNT_ID = unwrap(accountIdFromVenue(VENUE_ID, 'fill-orch-user'));
const TOKEN_ASSET_ID = {
  type: 'POLYMARKET_CTF_TOKEN',
  tokenId: 'token-fill-orch',
} as unknown as AssetId;
const MARKET_ID = asMarketId('market-fill-orch-001')!;
const ORDER_ID = asOrderId('order-fill-orch-001')!;
const FILL_PRICE = Price.of(new Decimal('0.65'));
const ORDER_SIZE = Quantity.of(new Decimal('50'));

// ── Фабрики ───────────────────────────────────────────────────────────────────

function makeOpenOrder(id: OrderId = ORDER_ID, size: Quantity = ORDER_SIZE): Order {
  const order = unwrap(Order.create({
    id,
    asset: TOKEN_ASSET_ID,
    side: 'BUY',
    price: FILL_PRICE,
    size,
    timestamp: unwrap(TimestampService.create(Date.now())),
  }));
  const accepted = unwrap(order.accept());
  accepted.pullEvents();
  return accepted;
}

function makePortfolio(): Portfolio {
  return unwrap(Portfolio.create({
    id: asPortfolioId('portfolio-fill-orch')!,
    accountId: ACCOUNT_ID,
    balance: Balance.of(
      Money.of(new Decimal('1000'), 'USDC'),
      Money.of(new Decimal('50'), 'USDC'),
      ACCOUNT_ID,
      VENUE_ID,
    ),
  }));
}

function makeFill(id: FillId, orderId: OrderId = ORDER_ID, size: Quantity = ORDER_SIZE): Fill {
  return unwrap(Fill.create({
    id,
    orderId,
    accountId: ACCOUNT_ID,
    venueId: VENUE_ID,
    marketId: MARKET_ID,
    tokenId: TOKEN_ASSET_ID,
    settlementAssetId: AssetIdHelpers.USDC,
    price: FILL_PRICE,
    size,
    side: 'BUY',
    timestamp: unwrap(TimestampService.create(Date.now())),
    fee: Fee.zero(AssetIdHelpers.USDC),
  }));
}

// ── Тесты ─────────────────────────────────────────────────────────────────────

describe('FillOrchestrator (integration)', () => {
  let orderRepo: InMemoryOrderRepository;
  let processedFillRepo: InMemoryProcessedFillRepository;
  let keyedMutex: InMemoryKeyedMutex;
  let portfolioStore: TestPortfolioStore;
  let eventBus: EventBus;
  let orchestrator: FillOrchestrator;
  let processFillUseCase: ProcessFillUseCase;

  beforeEach(() => {
    orderRepo = new InMemoryOrderRepository();
    processedFillRepo = new InMemoryProcessedFillRepository();
    keyedMutex = new InMemoryKeyedMutex();
    portfolioStore = new TestPortfolioStore();
    eventBus = new EventBus(LOGGER);

    const portfolioService = new PortfolioService(portfolioStore, LOGGER);
    const ledgerService = new LedgerService(LOGGER);

    processFillUseCase = new ProcessFillUseCase({
      orderStateStore: orderRepo,
      portfolioService,
      ledgerService,
      orderRepo,
      processedFillRepo,
      keyedMutex,
      eventBus,
      logger: LOGGER,
    });

    orchestrator = new FillOrchestrator({
      eventBus,
      processFill: processFillUseCase,
      logger: LOGGER,
      orderStateStore: orderRepo,
      portfolioService,
      processedFillRepo,
    });

    orchestrator.register();
  });

  afterEach(() => {
    orchestrator.unregister();
    orderRepo.clear();
    processedFillRepo.clear();
    portfolioStore.clear();
  });

  // ── Сценарий 1: FILL_RECEIVED → ORDER_FILLED published ─────────────────────

  it('FILL_RECEIVED → вся цепочка: Order FILLED, ORDER_FILLED опубликован', async () => {
    // Arrange
    await orderRepo.save(makeOpenOrder());
    portfolioStore.save(makePortfolio(), 0);

    const fill = makeFill(asFillId('fill-orch-001')!);
    const published: ApplicationEvent[] = [];
    eventBus.subscribe('ORDER_FILLED', async (e) => { published.push(e); });

    // Act: публикуем FILL_RECEIVED — EventBus вызывает FillOrchestrator → ProcessFillUseCase
    await eventBus.publish({
      type: 'FILL_RECEIVED',
      fill,
      receivedAt: unwrap(TimestampService.create(Date.now())),
    });

    // Assert: Order перешёл в FILLED
    const updatedOrder = await orderRepo.get(ORDER_ID);
    expect(updatedOrder?.status).toBe('FILLED');
    expect(updatedOrder?.filledSize.value().toNumber()).toBe(50);

    // Assert: ORDER_FILLED опубликован
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ type: 'ORDER_FILLED' });
  });

  // ── Сценарий 2: Дублирующий FILL_RECEIVED → processed once ─────────────────

  it('Дублирующий FILL_RECEIVED → ORDER_FILLED опубликован ровно один раз', async () => {
    // Arrange
    await orderRepo.save(makeOpenOrder());
    portfolioStore.save(makePortfolio(), 0);

    const fill = makeFill(asFillId('fill-orch-dup-001')!);
    const published: ApplicationEvent[] = [];
    eventBus.subscribe('ORDER_FILLED', async (e) => { published.push(e); });

    // Act: два идентичных FILL_RECEIVED с одним fill
    await eventBus.publish({
      type: 'FILL_RECEIVED',
      fill,
      receivedAt: unwrap(TimestampService.create(Date.now())),
    });

    await eventBus.publish({
      type: 'FILL_RECEIVED',
      fill,
      receivedAt: unwrap(TimestampService.create(Date.now())),
    });

    // Assert: ORDER_FILLED только один раз (идемпотентность)
    expect(published).toHaveLength(1);

    // Assert: Order обновился только один раз
    const updatedOrder = await orderRepo.get(ORDER_ID);
    expect(updatedOrder?.filledSize.value().toNumber()).toBe(50);
  });

  // ── Сценарий 3: FILL_RECEIVED для неизвестного ордера → нет краша ──────────

  it('FILL_RECEIVED для неизвестного ордера → ошибка логируется, следующий fill обрабатывается', async () => {
    // Arrange: второй order существует, первый нет
    const unknownOrderId = asOrderId('order-unknown-99')!;
    const knownOrderId = asOrderId('order-known-01')!;

    await orderRepo.save(makeOpenOrder(knownOrderId));
    portfolioStore.save(makePortfolio(), 0);

    const fillUnknown = makeFill(asFillId('fill-unknown-001')!, unknownOrderId);
    const fillKnown = makeFill(asFillId('fill-known-001')!, knownOrderId);

    const published: ApplicationEvent[] = [];
    eventBus.subscribe('ORDER_FILLED', async (e) => { published.push(e); });

    // Act: сначала fill для неизвестного ордера (должен завершиться с ошибкой, но не крашнуть)
    // FillOrchestrator ловит ошибку и логирует её
    await eventBus.publish({
      type: 'FILL_RECEIVED',
      fill: fillUnknown,
      receivedAt: unwrap(TimestampService.create(Date.now())),
    });

    // Act: затем fill для известного ордера (должен обработаться нормально)
    await eventBus.publish({
      type: 'FILL_RECEIVED',
      fill: fillKnown,
      receivedAt: unwrap(TimestampService.create(Date.now())),
    });

    // Assert: второй fill обработан — ORDER_FILLED для известного ордера
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ type: 'ORDER_FILLED' });

    const updatedOrder = await orderRepo.get(knownOrderId);
    expect(updatedOrder?.status).toBe('FILLED');
  });
});
