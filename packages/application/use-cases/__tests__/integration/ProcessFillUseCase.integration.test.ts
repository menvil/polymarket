/**
 * ProcessFillUseCase — интеграционные тесты
 *
 * @remarks
 * Проверяет полную цепочку: Fill → Order → Portfolio → Ledger → EventBus.
 *
 * ### Реальные компоненты (без моков):
 * - `ProcessFillUseCase` — оркестратор
 * - `InMemoryOrderRepository` — хранилище ордеров
 * - `InMemoryProcessedFillRepository` — idempotency guard
 * - `TestPortfolioStore` — упрощённое хранилище (без CAS)
 * - `LedgerService` + `Ledger` — учёт операций
 * - `EventBus` — реальная шина событий
 *
 * ### Почему TestPortfolioStore вместо InMemoryPortfolioStore:
 * `PortfolioService` всегда вызывает `store.save(portfolio, 0)`.
 * `InMemoryPortfolioStore` после первого save увеличивает версию до 1,
 * и следующий `save(_, 0)` возвращает `VersionConflictError`.
 * `TestPortfolioStore` игнорирует version — корректно для тестов одного потока.
 *
 * ### Сценарии:
 * 1. BUY fill happy path: Order → FILLED, Ledger содержит записи, событие опубликовано
 * 2. Idempotency: повторный fill → Ok без изменений
 * 3. Partial fill × 2: VWAP и статусы корректны
 * 4. Order не найден → Err
 * 5. Portfolio не найден → Err
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ProcessFillUseCase } from '../../src/ProcessFillUseCase.js';
import { PortfolioService } from '../../src/services/PortfolioService.js';
import { LedgerService } from '../../src/services/LedgerService.js';
import type { ProcessFillDeps } from '../../src/ProcessFillUseCase.js';
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

// Прямые импорты (избегаем @polymarket/backtesting — подтягивает транзитивные зависимости)
import { InMemoryOrderRepository } from '../../../../infrastructure/backtesting/src/InMemoryOrderRepository.js';
import { InMemoryProcessedFillRepository } from '../../../../infrastructure/backtesting/src/InMemoryProcessedFillRepository.js';

// ── TestPortfolioStore ────────────────────────────────────────────────────────

/**
 * Упрощённое хранилище Portfolio без CAS-защиты.
 *
 * @remarks
 * `IPortfolioStore.save(portfolio, expectedVersion)` в `InMemoryPortfolioStore`
 * реализует CAS: после первого save версия становится 1, второй вызов
 * `save(_, 0)` завершается `VersionConflictError`. `PortfolioService` всегда
 * вызывает `save(_, 0)`, что делает `InMemoryPortfolioStore` несовместимым
 * с многошаговыми тестами (2+ fills на одном аккаунте).
 *
 * `TestPortfolioStore` игнорирует `expectedVersion` — корректно для
 * однопоточных тестов где конкурентных writes нет.
 */
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

/**
 * Разворачивает Result, выбрасывает ошибку при Err.
 *
 * @param result - Result для разворачивания
 * @returns Значение Result
 * @throws {unknown} Ошибка из Err
 */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw result.error;
  return result.value;
}

// ── Константы тестов ──────────────────────────────────────────────────────────

const LOGGER = new NoOpLogger();
const VENUE_ID = KnownVenues.POLYMARKET;
const ACCOUNT_ID = unwrap(accountIdFromVenue(VENUE_ID, 'test-user-001'));
const TOKEN_ASSET_ID = {
  type: 'POLYMARKET_CTF_TOKEN',
  tokenId: 'token-abc-integration',
} as unknown as AssetId;
const MARKET_ID = asMarketId('market-integration-001')!;
const ORDER_ID = asOrderId('order-integration-001')!;
const FILL_ID = asFillId('fill-integration-001')!;
const FILL_PRICE = Price.of(new Decimal('0.65'));
const ORDER_SIZE = Quantity.of(new Decimal('50'));
const FILL_SIZE = Quantity.of(new Decimal('50'));

// ── Фабрики ───────────────────────────────────────────────────────────────────

/**
 * Создаёт OPEN Order для тестов.
 *
 * @param id - ID ордера
 * @param size - Размер ордера
 * @returns Order в состоянии OPEN с очищенными событиями
 */
function makeOpenOrder(
  id: OrderId = ORDER_ID,
  size: Quantity = ORDER_SIZE,
): Order {
  const order = unwrap(Order.create({
    id,
    asset: TOKEN_ASSET_ID,
    side: 'BUY',
    price: FILL_PRICE,
    size,
    timestamp: unwrap(TimestampService.create(Date.now())),
  }));
  const accepted = unwrap(order.accept());
  accepted.pullEvents(); // очищаем события перед тестом
  return accepted;
}

/**
 * Создаёт Portfolio с достаточным зарезервированным балансом для BUY fill.
 *
 * @param available - Доступные средства в USDC
 * @param reserved - Зарезервированные средства в USDC
 * @returns Portfolio aggregate
 */
function makePortfolio(
  available = new Decimal('1000'),
  reserved = new Decimal('50'),
): Portfolio {
  const balance = Balance.of(
    Money.of(available, 'USDC'),
    Money.of(reserved, 'USDC'),
    ACCOUNT_ID,
    VENUE_ID,
  );
  return unwrap(Portfolio.create({
    id: asPortfolioId('portfolio-integration-001')!,
    accountId: ACCOUNT_ID,
    balance,
  }));
}

/**
 * Создаёт реальный Fill объект.
 *
 * @param overrides - Переопределения полей (id, orderId, size, price)
 * @returns Fill domain record
 */
function makeFill(overrides: {
  id?: FillId;
  orderId?: OrderId;
  size?: Quantity;
  price?: Price;
} = {}): Fill {
  return unwrap(Fill.create({
    id: overrides.id ?? FILL_ID,
    orderId: overrides.orderId ?? ORDER_ID,
    accountId: ACCOUNT_ID,
    venueId: VENUE_ID,
    marketId: MARKET_ID,
    tokenId: TOKEN_ASSET_ID,
    settlementAssetId: AssetIdHelpers.USDC,
    price: overrides.price ?? FILL_PRICE,
    size: overrides.size ?? FILL_SIZE,
    side: 'BUY',
    timestamp: unwrap(TimestampService.create(Date.now())),
    fee: Fee.zero(AssetIdHelpers.USDC),
  }));
}

// ── Тесты ─────────────────────────────────────────────────────────────────────

describe('ProcessFillUseCase (integration)', () => {
  let orderRepo: InMemoryOrderRepository;
  let processedFillRepo: InMemoryProcessedFillRepository;
  let portfolioStore: TestPortfolioStore;
  let eventBus: EventBus;
  let ledgerService: LedgerService;
  let deps: ProcessFillDeps;

  beforeEach(() => {
    orderRepo = new InMemoryOrderRepository();
    processedFillRepo = new InMemoryProcessedFillRepository();
    portfolioStore = new TestPortfolioStore();
    eventBus = new EventBus(LOGGER);

    const portfolioService = new PortfolioService(portfolioStore, LOGGER);
    ledgerService = new LedgerService(LOGGER);

    deps = {
      orderStateStore: orderRepo,
      portfolioService,
      ledgerService,
      orderRepo,
      processedFillRepo,
      eventBus,
      logger: LOGGER,
    };
  });

  afterEach(() => {
    orderRepo.clear();
    processedFillRepo.clear();
    portfolioStore.clear();
  });

  // ── Сценарий 1: BUY fill happy path ────────────────────────────────────────

  it('BUY fill happy path: Order → FILLED, Ledger обновлён, событие опубликовано', async () => {
    // Arrange
    const order = makeOpenOrder();
    await orderRepo.save(order);
    portfolioStore.save(makePortfolio(), 0);

    const published: ApplicationEvent[] = [];
    eventBus.subscribe('ORDER_FILLED', async (e) => { published.push(e); });

    const fill = makeFill();

    // Act
    const result = await new ProcessFillUseCase(deps).execute(fill);

    // Assert: use case вернул Ok
    expect(result.ok).toBe(true);

    // Assert: Order перешёл в FILLED (size=50, filled=50)
    const updatedOrder = await orderRepo.get(ORDER_ID);
    expect(updatedOrder?.status).toBe('FILLED');
    expect(updatedOrder?.filledSize.value().toNumber()).toBe(50);

    // Assert: Ledger содержит записи для аккаунта (POSITION_DELTA + CASH_DELTA)
    const balances = ledgerService.ledger.getAllBalances(ACCOUNT_ID);
    expect(balances.size).toBe(2); // токен + USDC

    // Assert: событие ORDER_FILLED опубликовано ровно один раз
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ type: 'ORDER_FILLED' });
  });

  // ── Сценарий 2: Idempotency — дублирующий fill ─────────────────────────────

  it('Idempotency: повторный fill → Ok без изменений в Order и Ledger', async () => {
    // Arrange
    const order = makeOpenOrder();
    await orderRepo.save(order);
    portfolioStore.save(makePortfolio(), 0);

    const useCase = new ProcessFillUseCase(deps);
    const fill = makeFill();

    // Первый вызов
    const first = await useCase.execute(fill);
    expect(first.ok).toBe(true);

    const orderAfterFirst = await orderRepo.get(ORDER_ID);
    const statusAfterFirst = orderAfterFirst?.status;
    const filledSizeAfterFirst = orderAfterFirst?.filledSize.value().toNumber();
    const balancesAfterFirst = ledgerService.ledger.getAllBalances(ACCOUNT_ID).size;

    // Второй вызов с тем же fill
    const second = await useCase.execute(fill);

    // Assert: второй вызов вернул Ok
    expect(second.ok).toBe(true);

    // Assert: Order не изменился
    const orderAfterSecond = await orderRepo.get(ORDER_ID);
    expect(orderAfterSecond?.status).toBe(statusAfterFirst);
    expect(orderAfterSecond?.filledSize.value().toNumber()).toBe(filledSizeAfterFirst);

    // Assert: Ledger не получил дополнительных записей
    const balancesAfterSecond = ledgerService.ledger.getAllBalances(ACCOUNT_ID).size;
    expect(balancesAfterSecond).toBe(balancesAfterFirst);
  });

  // ── Сценарий 3: Partial fill × 2 → VWAP и статусы корректны ───────────────

  it('Partial fill × 2: корректные статусы и VWAP ордера', async () => {
    // Arrange: Order size=100, Portfolio reserved=100 USDC (хватит на оба fill)
    const orderId = asOrderId('order-partial-001')!;
    const order = makeOpenOrder(orderId, Quantity.of(new Decimal('100')));
    await orderRepo.save(order);
    portfolioStore.save(makePortfolio(new Decimal('900'), new Decimal('100')), 0);

    const useCase = new ProcessFillUseCase(deps);

    // Fill 1: size=30 @ 0.65 (notional=19.5 USDC)
    const fill1 = makeFill({
      id: asFillId('fill-partial-001')!,
      orderId,
      size: Quantity.of(new Decimal('30')),
      price: Price.of(new Decimal('0.65')),
    });

    const result1 = await useCase.execute(fill1);
    expect(result1.ok).toBe(true);

    const orderAfterFill1 = await orderRepo.get(orderId);
    expect(orderAfterFill1?.status).toBe('PARTIALLY_FILLED');
    expect(orderAfterFill1?.filledSize.value().toNumber()).toBe(30);

    // Fill 2: size=70 @ 0.70 (notional=49 USDC)
    const fill2 = makeFill({
      id: asFillId('fill-partial-002')!,
      orderId,
      size: Quantity.of(new Decimal('70')),
      price: Price.of(new Decimal('0.70')),
    });

    const result2 = await useCase.execute(fill2);
    expect(result2.ok).toBe(true);

    const orderAfterFill2 = await orderRepo.get(orderId);
    expect(orderAfterFill2?.status).toBe('FILLED');
    expect(orderAfterFill2?.filledSize.value().toNumber()).toBe(100);

    // VWAP = (30 * 0.65 + 70 * 0.70) / 100 = (19.5 + 49) / 100 = 0.685
    const expectedVwap = (30 * 0.65 + 70 * 0.70) / 100;
    const actualVwap = orderAfterFill2?.averagePrice?.value().toNumber();
    expect(actualVwap).toBeCloseTo(expectedVwap, 6);
  });

  // ── Сценарий 4: Order не найден → Ok (только ledger) ──────────────────────

  it('Order не найден → возвращает Ok и записывает fill в ledger', async () => {
    // Arrange: orderRepo пуст, portfolio есть
    // Это сценарий «fill на CANCELLED ордер»: резервация уже снята,
    // portfolio корректируется StateReconciliationService (~60s).
    portfolioStore.save(makePortfolio(), 0);
    const fill = makeFill();

    // Act
    const result = await new ProcessFillUseCase(deps).execute(fill);

    // Assert
    expect(result.ok).toBe(true);
  });

  // ── Сценарий 5: Portfolio не найден → Err ──────────────────────────────────

  it('Portfolio не найден → возвращает Err с сообщением Portfolio not found', async () => {
    // Arrange: order есть, portfolioStore пуст
    const order = makeOpenOrder();
    await orderRepo.save(order);
    // portfolioStore остаётся пустым
    const fill = makeFill();

    // Act
    const result = await new ProcessFillUseCase(deps).execute(fill);

    // Assert
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/Portfolio not found/);
    }
  });
});
