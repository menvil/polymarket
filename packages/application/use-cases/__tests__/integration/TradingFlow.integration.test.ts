/**
 * TradingFlow — интеграционные тесты цепочки Place → Fill / Cancel
 *
 * @remarks
 * Проверяет end-to-end поток от размещения ордера до его исполнения или отмены.
 *
 * ### Реальные компоненты (без моков):
 * - `PlaceOrderUseCase`, `ProcessFillUseCase`, `CancelOrderUseCase`
 * - `PortfolioService`, `LedgerService`
 * - `InMemoryOrderRepository`, `InMemoryProcessedFillRepository`
 * - `TestPortfolioStore` (упрощённое хранилище без CAS-проверки — удобство
 *   фикстур, НЕ обход несовместимости; см. отдельный describe-блок ниже с
 *   настоящим `InMemoryPortfolioStore` и реальным CAS)
 * - `EventBus`
 *
 * ### Мок только:
 * - `IExchangeClient` — внешняя биржа
 * - `IOrderRiskChecker` — всегда пропускает
 * - `IClock` — фиксированное время
 *
 * ### Сценарии:
 * 1. Place → Fill: ордер размещён, исполнен, portfolio.reserved = 0
 * 2. Place → Exchange rejected: резервация откатилась, orderRepo пуст
 * 3. Place → Cancel: ордер отменён, portfolio.reserved = 0
 * 4. CAS Portfolio (отдельный describe): Place → partial Fill → second Fill,
 *    и Place → partial Fill → Cancel remaining — на РЕАЛЬНОМ
 *    `InMemoryPortfolioStore`, version увеличивается корректно на каждом шаге
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { PlaceOrderUseCase } from '../../src/PlaceOrderUseCase.js';
import { ProcessFillUseCase } from '../../src/ProcessFillUseCase.js';
import { CancelOrderUseCase } from '../../src/CancelOrderUseCase.js';
import { PortfolioService } from '../../src/services/PortfolioService.js';
import { LedgerService } from '../../src/services/LedgerService.js';
import type { PlaceOrderDeps, PlaceOrderInput } from '../../src/PlaceOrderUseCase.js';
import type { ProcessFillDeps } from '../../src/ProcessFillUseCase.js';
import type { CancelOrderDeps } from '../../src/CancelOrderUseCase.js';
import { EventBus } from '@polymarket/event-bus';
import { NoOpLogger } from '@polymarket/logger';
import { Ok, Err } from '@polymarket/result';
import type { Result } from '@polymarket/result';
import {
  accountIdFromVenue,
  accountIdToString,
  KnownVenues,
  AssetIdHelpers,
  asFillId,
  asOrderId,
  asMarketId,
  assetIdToInstrumentId,
} from '@polymarket/ids';
import type { AccountId, AssetId, OrderId } from '@polymarket/ids';
import { Price, Quantity, Fee, TimestampService, Money } from '@polymarket/value-objects';
import { Balance } from '@polymarket/value-objects/balance';
import { Fill } from '@polymarket/fill';
import { Portfolio, asPortfolioId } from '@polymarket/portfolio';
import type { IPortfolioStore, IExchangeClient, VersionConflictError, IKeyedMutex } from '@polymarket/ports';
import { ExchangeError } from '@polymarket/ports';
import type { IOrderRiskChecker } from '@polymarket/risk';
import type { IClock } from '@polymarket/time';
import Decimal from 'decimal.js';

import { InMemoryOrderRepository } from '../../../../infrastructure/in-memory/src/InMemoryOrderRepository.js';
import { InMemoryProcessedFillRepository } from '../../../../infrastructure/in-memory/src/InMemoryProcessedFillRepository.js';
import { InMemoryKeyedMutex } from '../../../../infrastructure/in-memory/src/InMemoryKeyedMutex.js';
import { InMemoryOrderedEventOutbox } from '../../../../infrastructure/in-memory/src/InMemoryOrderedEventOutbox.js';
import { InMemoryOrderSubmissionRepository } from '../../../../infrastructure/in-memory/src/InMemoryOrderSubmissionRepository.js';
import { InMemoryPortfolioStore } from '../../../../infrastructure/in-memory/src/InMemoryPortfolioStore.js';

// ── TestPortfolioStore ────────────────────────────────────────────────────────

/**
 * Упрощённое хранилище Portfolio без CAS-проверки.
 *
 * @remarks
 * Раньше здесь была причина «PortfolioService всегда вызывает save(_, 0),
 * что несовместимо с InMemoryPortfolioStore» — это устарело: `PortfolioService`
 * читает `store.getVersion(accountId)` свежим значением перед каждым `save()`,
 * реальный CAS работает корректно на протяжении многошаговых flow (см. отдельный
 * describe-блок ниже — `TradingFlow (integration) — CAS Portfolio`, где те же
 * сценарии проходят на настоящем `InMemoryPortfolioStore` без единого
 * `VersionConflictError`). `TestPortfolioStore` здесь остаётся исключительно
 * ради простоты существующих фикстур (не нужно синхронизировать version
 * вручную при ручных `portfolioStore.save(portfolio, 0)` в Arrange-блоках).
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
const ACCOUNT_ID = unwrap(accountIdFromVenue(VENUE_ID, 'trading-flow-user'));
const TOKEN_ASSET_ID = {
  type: 'POLYMARKET_CTF_TOKEN',
  tokenId: 'token-trading-flow',
} as unknown as AssetId;
const INSTRUMENT_ID = assetIdToInstrumentId(TOKEN_ASSET_ID)!;
const MARKET_ID = asMarketId('market-trading-flow-001')!;
const ORDER_ID = asOrderId('order-trading-flow-001')!;
const ORDER_PRICE = Price.of(new Decimal('0.65'));
const ORDER_SIZE = Quantity.of(new Decimal('50'));

// Notional: 50 * 0.65 = 32.5 USDC
const NOTIONAL = ORDER_PRICE.value().times(ORDER_SIZE.value());

/**
 * Создаёт Portfolio с 1000 USDC available и 0 reserved.
 */
function makeInitialPortfolio(): Portfolio {
  return unwrap(Portfolio.create({
    id: asPortfolioId('portfolio-trading-flow')!,
    accountId: ACCOUNT_ID,
    balance: Balance.withZeroReserved(
      Money.of(new Decimal('1000'), 'USDC'),
      ACCOUNT_ID,
      VENUE_ID,
    ),
  }));
}

/**
 * Создаёт mock IClock, возвращающий текущее время.
 */
function makeClock(): IClock {
  return { now: () => new Date() };
}

/**
 * Создаёт mock IOrderRiskChecker, всегда пропускающий ордер.
 */
function makePassRiskChecker(): IOrderRiskChecker {
  return {
    checkBeforeOrder: () => Ok(undefined),
  };
}

/**
 * Создаёт mock IExchangeClient.
 *
 * @param submitResult - Результат submitOrder (по умолчанию Ok(ORDER_ID))
 */
function makeExchangeClient(
  submitResult: Result<import('@polymarket/ports').SubmitOrderResult, ExchangeError> = Ok({
    status: 'OPEN',
    orderId: ORDER_ID,
    effectiveSize: ORDER_SIZE,
    remainingSize: ORDER_SIZE,
  }),
): IExchangeClient {
  return {
    submitOrder: () => Promise.resolve(submitResult),
    cancelOrder: () => Promise.resolve(Ok({ status: 'CANCELLED' })),
    getOpenOrders: () => Promise.resolve(Ok([])),
    getTrades: () => Promise.resolve(Ok([])),
  };
}

/**
 * Создаёт Fill для существующего ордера.
 *
 * @param orderId - ID ордера (по умолчанию ORDER_ID)
 * @param overrides - `size`/`fillId` для partial-fill сценариев (несколько
 *   fill-ов одного ордера требуют РАЗНЫЕ fillId — idempotency guard иначе
 *   счёл бы второй fill дубликатом первого)
 */
function makeFill(
  orderId: OrderId = ORDER_ID,
  overrides: { readonly size?: Quantity; readonly fillId?: string } = {},
): Fill {
  return unwrap(Fill.create({
    id: asFillId(overrides.fillId ?? 'fill-trading-flow-001')!,
    orderId,
    accountId: ACCOUNT_ID,
    venueId: VENUE_ID,
    marketId: MARKET_ID,
    tokenId: TOKEN_ASSET_ID,
    settlementAssetId: AssetIdHelpers.USDC,
    price: ORDER_PRICE,
    size: overrides.size ?? ORDER_SIZE,
    side: 'BUY',
    timestamp: unwrap(TimestampService.create(Date.now())),
    fee: Fee.zero(AssetIdHelpers.USDC),
  }));
}

// ── Тесты ─────────────────────────────────────────────────────────────────────

describe('TradingFlow (integration)', () => {
  let orderRepo: InMemoryOrderRepository;
  let processedFillRepo: InMemoryProcessedFillRepository;
  let keyedMutex: InMemoryKeyedMutex;
  let portfolioStore: TestPortfolioStore;
  let eventBus: EventBus;
  let portfolioService: PortfolioService;
  let ledgerService: LedgerService;
  let orderedEventOutbox: InMemoryOrderedEventOutbox;
  let orderSubmissionRepo: InMemoryOrderSubmissionRepository;

  beforeEach(() => {
    orderRepo = new InMemoryOrderRepository();
    processedFillRepo = new InMemoryProcessedFillRepository();
    keyedMutex = new InMemoryKeyedMutex();
    portfolioStore = new TestPortfolioStore();
    eventBus = new EventBus(LOGGER);
    portfolioService = new PortfolioService(portfolioStore, LOGGER);
    ledgerService = new LedgerService(LOGGER);
    // Единый ordered outbox (Place↔Fill per-order FIFO), публикует в реальный EventBus.
    orderedEventOutbox = new InMemoryOrderedEventOutbox({
      publish: (events) => eventBus.publishAll(events as Parameters<typeof eventBus.publishAll>[0]),
      logger: LOGGER,
    });
    orderSubmissionRepo = new InMemoryOrderSubmissionRepository();
  });

  afterEach(() => {
    orderRepo.clear();
    processedFillRepo.clear();
    portfolioStore.clear();
  });

  // ── Сценарий 1: Place → Fill → Portfolio reconciled ────────────────────────

  it('Place → Fill: ордер FILLED, portfolio.reserved = 0, Ledger содержит записи', async () => {
    // Arrange
    const portfolio = makeInitialPortfolio();
    portfolioStore.save(portfolio, 0);

    const placeDeps: PlaceOrderDeps = {
      riskChecker: makePassRiskChecker(),
      orderRepo,
      portfolioService,
      keyedMutex,
      exchangeClient: makeExchangeClient(),
      orderStateStore: orderRepo,
      orderedEventOutbox,
      submissions: orderSubmissionRepo,
      clock: makeClock(),
      logger: LOGGER,
    };

    const processDeps: ProcessFillDeps = {
      orderStateStore: orderRepo,
      portfolioService,
      ledgerService,
      orderRepo,
      processedFillRepo,
      keyedMutex,
      eventBus,
      orderedEventOutbox,
      submissions: orderSubmissionRepo,
      logger: LOGGER,
    };

    const input: PlaceOrderInput = {
      orderId: ORDER_ID,
      accountId: ACCOUNT_ID,
      asset: TOKEN_ASSET_ID,
      instrumentId: INSTRUMENT_ID,
      side: 'BUY',
      price: ORDER_PRICE,
      size: ORDER_SIZE,
      portfolio,
      openOrdersCount: 0,
    };

    // Act: PlaceOrder
    const placeResult = await new PlaceOrderUseCase(placeDeps).execute(input);
    expect(placeResult.ok).toBe(true);

    // Assert: ордер в репозитории, баланс зарезервирован
    const openOrder = await orderRepo.get(ORDER_ID);
    expect(openOrder?.status).toBe('OPEN');

    const portfolioAfterPlace = portfolioStore.get(ACCOUNT_ID)!;
    expect(portfolioAfterPlace.balance.reserved().value().toNumber()).toBeCloseTo(
      NOTIONAL.toNumber(),
      6,
    );

    // Act: ProcessFill (полное исполнение)
    const fillResult = await new ProcessFillUseCase(processDeps).execute(makeFill());
    expect(fillResult.ok).toBe(true);

    // Assert: Order → FILLED
    const filledOrder = await orderRepo.get(ORDER_ID);
    expect(filledOrder?.status).toBe('FILLED');

    // Assert: portfolio.reserved = 0 (средства полностью списаны через applyDebit)
    const portfolioAfterFill = portfolioStore.get(ACCOUNT_ID)!;
    expect(portfolioAfterFill.balance.reserved().value().toNumber()).toBeCloseTo(0, 6);

    // Assert: Ledger содержит записи (POSITION_DELTA + CASH_DELTA)
    const ledgerBalances = ledgerService.ledger.getAllBalances(ACCOUNT_ID);
    expect(ledgerBalances.size).toBe(2);
  });

  // ── Сценарий 2: Place → Exchange rejected → rollback ───────────────────────

  it('Place → Exchange rejected: Err возвращён, portfolio.reserved = 0, orderRepo пуст', async () => {
    // Arrange
    const portfolio = makeInitialPortfolio();
    portfolioStore.save(portfolio, 0);

    // DEFINITELY_NOT_SUBMITTED — ордер точно НЕ создан на venue (preflight/reject),
    // поэтому Place делает чистый rollback резервации. (MAY_HAVE_BEEN_SUBMITTED,
    // напротив, удержал бы резервацию до reconciliation — см. отдельный тест.)
    const exchangeError = new ExchangeError('Exchange connectivity error', {
      submitOutcome: 'DEFINITELY_NOT_SUBMITTED',
    });

    const placeDeps: PlaceOrderDeps = {
      riskChecker: makePassRiskChecker(),
      orderRepo,
      portfolioService,
      keyedMutex,
      exchangeClient: makeExchangeClient(Err(exchangeError)),
      orderStateStore: orderRepo,
      orderedEventOutbox,
      submissions: orderSubmissionRepo,
      clock: makeClock(),
      logger: LOGGER,
    };

    const input: PlaceOrderInput = {
      orderId: ORDER_ID,
      accountId: ACCOUNT_ID,
      asset: TOKEN_ASSET_ID,
      instrumentId: INSTRUMENT_ID,
      side: 'BUY',
      price: ORDER_PRICE,
      size: ORDER_SIZE,
      portfolio,
      openOrdersCount: 0,
    };

    // Act
    const result = await new PlaceOrderUseCase(placeDeps).execute(input);

    // Assert: PlaceOrder вернул Err
    expect(result.ok).toBe(false);

    // Assert: portfolio.reserved = 0 (резервация откатилась)
    const portfolioAfterError = portfolioStore.get(ACCOUNT_ID)!;
    expect(portfolioAfterError.balance.reserved().value().toNumber()).toBeCloseTo(0, 6);

    // Assert: ордер НЕ сохранён в репозиторий
    const order = await orderRepo.get(ORDER_ID);
    expect(order).toBeUndefined();
  });

  // ── Сценарий 3: Place → Cancel → баланс освобождён ─────────────────────────

  it('Place → Cancel: ордер CANCELED, portfolio.reserved = 0', async () => {
    // Arrange
    const portfolio = makeInitialPortfolio();
    portfolioStore.save(portfolio, 0);

    const placeDeps: PlaceOrderDeps = {
      riskChecker: makePassRiskChecker(),
      orderRepo,
      portfolioService,
      keyedMutex,
      exchangeClient: makeExchangeClient(),
      orderStateStore: orderRepo,
      orderedEventOutbox,
      submissions: orderSubmissionRepo,
      clock: makeClock(),
      logger: LOGGER,
    };

    const cancelDeps: CancelOrderDeps = {
      portfolioService,
      orderRepo,
      orderStateStore: orderRepo,
      keyedMutex,
      exchangeClient: makeExchangeClient(),
      orderedEventOutbox,
      submissions: orderSubmissionRepo,
      logger: LOGGER,
    };

    const input: PlaceOrderInput = {
      orderId: ORDER_ID,
      accountId: ACCOUNT_ID,
      asset: TOKEN_ASSET_ID,
      instrumentId: INSTRUMENT_ID,
      side: 'BUY',
      price: ORDER_PRICE,
      size: ORDER_SIZE,
      portfolio,
      openOrdersCount: 0,
    };

    // Act: PlaceOrder
    const placeResult = await new PlaceOrderUseCase(placeDeps).execute(input);
    expect(placeResult.ok).toBe(true);

    // Verify: баланс зарезервирован
    const portfolioAfterPlace = portfolioStore.get(ACCOUNT_ID)!;
    expect(portfolioAfterPlace.balance.reserved().value().toNumber()).toBeGreaterThan(0);

    // Act: CancelOrder
    const cancelResult = await new CancelOrderUseCase(cancelDeps).execute({
      orderId: ORDER_ID,
      accountId: ACCOUNT_ID,
      reason: 'Integration test cancel',
    });
    expect(cancelResult.ok).toBe(true);

    // Assert: Order → CANCELED
    const cancelledOrder = await orderRepo.get(ORDER_ID);
    expect(cancelledOrder?.status).toBe('CANCELED');

    // Assert: portfolio.reserved = 0 (резервация освобождена)
    const portfolioAfterCancel = portfolioStore.get(ACCOUNT_ID)!;
    expect(portfolioAfterCancel.balance.reserved().value().toNumber()).toBeCloseTo(0, 6);
  });

  // ── Конкурентность Fill vs Cancel: см. отдельный describe ниже ─────────────
  // ("TradingFlow (integration) — CAS Portfolio", два детерминированных
  // сценария Fill-first/Cancel-first с promise-защёлками вместо setTimeout
  // и полными accounting-инвариантами вместо только maxActive+status).

  // ── Сценарий A (P0): ambiguous submit → held reservation → Fill ─────────────

  it('Сценарий A: ambiguous submit (held reservation, no local Order) → Fill потребляет reserved БЕЗ двойного debit', async () => {
    const portfolio = makeInitialPortfolio();
    portfolioStore.save(portfolio, 0);

    // 1. Reserve NOTIONAL (как PlaceOrderUseCase перед submit).
    expect(portfolioService.reserveForOrder(ACCOUNT_ID, NOTIONAL).ok).toBe(true);
    const availableAfterReserve = portfolioStore.get(ACCOUNT_ID)!.balance.available().value().toNumber();

    // 2. Ambiguous submit с известным venue ID: journal HELD + venueAccepted, БЕЗ local Order.
    const CLIENT = asOrderId('client-ambiguous-A')!;
    await orderSubmissionRepo.begin({
      clientOrderId: CLIENT, accountId: ACCOUNT_ID, instrumentId: INSTRUMENT_ID,
      fingerprint: 'fp-A', side: 'BUY', orderPrice: ORDER_PRICE.value().toString(),
      requestedSize: ORDER_SIZE.value().toString(), now: new Date(),
    });
    await orderSubmissionRepo.markReservationHeld(CLIENT, NOTIONAL.toString(), new Date());
    await orderSubmissionRepo.markVenueAccepted(CLIENT, ORDER_ID, new Date());
    expect(await orderRepo.get(ORDER_ID)).toBeUndefined(); // 3. local Order отсутствует

    // 4. Fill приходит на venueOrderId=ORDER_ID.
    const processFillUseCase = new ProcessFillUseCase({
      orderStateStore: orderRepo, portfolioService, ledgerService, orderRepo, processedFillRepo,
      keyedMutex, eventBus, orderedEventOutbox, submissions: orderSubmissionRepo, logger: LOGGER,
    });
    const fillResult = await processFillUseCase.execute(makeFill());
    expect(fillResult.ok).toBe(true);

    // 5. Проверки:
    const after = portfolioStore.get(ACCOUNT_ID)!;
    // available НЕ списан второй раз (held-path потребил reserved, не available).
    expect(after.balance.available().value().toNumber()).toBeCloseTo(availableAfterReserve, 6);
    // reserved = 0 (полностью потреблено).
    expect(after.balance.reserved().value().toNumber()).toBeCloseTo(0, 6);
    // Позиция создана.
    expect(after.getPosition(INSTRUMENT_ID)?.quantity.value().toNumber()).toBeGreaterThan(0);
    // journal SETTLED.
    expect((await orderSubmissionRepo.get(CLIENT))?.reservation.status).toBe('SETTLED');
  });

  // ── Сценарий B (P0): cancel → ALREADY_FILLED → Fill (normal path) ───────────

  it('Сценарий B: cancel → ALREADY_FILLED → Order не отменён, резервация held, Fill потребляет ровно один раз', async () => {
    const portfolio = makeInitialPortfolio();
    portfolioStore.save(portfolio, 0);

    // 1. Place order нормально (Order saved, reserved).
    const placeDeps: PlaceOrderDeps = {
      riskChecker: makePassRiskChecker(),
      orderRepo, portfolioService, keyedMutex,
      exchangeClient: makeExchangeClient(),
      orderStateStore: orderRepo,
      orderedEventOutbox, submissions: orderSubmissionRepo,
      clock: makeClock(), logger: LOGGER,
    };
    const placeResult = await new PlaceOrderUseCase(placeDeps).execute({
      orderId: ORDER_ID, accountId: ACCOUNT_ID, asset: TOKEN_ASSET_ID, instrumentId: INSTRUMENT_ID,
      side: 'BUY', price: ORDER_PRICE, size: ORDER_SIZE, portfolio, openOrdersCount: 0,
    });
    expect(placeResult.ok).toBe(true);
    expect(portfolioStore.get(ACCOUNT_ID)!.balance.reserved().value().toNumber()).toBeCloseTo(NOTIONAL.toNumber(), 6);

    // 2. Cancel → venue вернул ALREADY_FILLED.
    const alreadyFilledExchange: IExchangeClient = {
      ...makeExchangeClient(),
      cancelOrder: () => Promise.resolve(Ok({ status: 'ALREADY_FILLED', reason: 'matched' })),
    };
    const cancelDeps: CancelOrderDeps = {
      portfolioService, orderRepo, orderStateStore: orderRepo, keyedMutex,
      exchangeClient: alreadyFilledExchange, orderedEventOutbox, submissions: orderSubmissionRepo, logger: LOGGER,
    };
    const cancelResult = await new CancelOrderUseCase(cancelDeps).execute({ orderId: ORDER_ID, accountId: ACCOUNT_ID });
    expect(cancelResult.ok).toBe(true);
    if (cancelResult.ok) expect(cancelResult.value.status).toBe('FILL_PENDING');

    // 3. Order НЕ terminal, резервация held.
    expect((await orderRepo.get(ORDER_ID))?.isTerminal).toBe(false);
    expect(portfolioStore.get(ACCOUNT_ID)!.balance.reserved().value().toNumber()).toBeCloseTo(NOTIONAL.toNumber(), 6);

    // 4. Fill приходит → normal path (Order всё ещё OPEN) → consume резервации.
    const processFillUseCase = new ProcessFillUseCase({
      orderStateStore: orderRepo, portfolioService, ledgerService, orderRepo, processedFillRepo,
      keyedMutex, eventBus, orderedEventOutbox, submissions: orderSubmissionRepo, logger: LOGGER,
    });
    const fillResult = await processFillUseCase.execute(makeFill());
    expect(fillResult.ok).toBe(true);

    // 5. reserved → 0 (потреблено РОВНО один раз), позиция создана.
    expect(portfolioStore.get(ACCOUNT_ID)!.balance.reserved().value().toNumber()).toBeCloseTo(0, 6);
    expect(portfolioStore.get(ACCOUNT_ID)!.getPosition(INSTRUMENT_ID)?.quantity.value().toNumber()).toBeGreaterThan(0);
  });
});

// ── CAS Portfolio: реальный InMemoryPortfolioStore (не TestPortfolioStore) ────

/**
 * @remarks
 * `TestPortfolioStore` выше (и в `ProcessFillUseCase.integration.test.ts`)
 * документирован как обход несовместимости с CAS: «PortfolioService всегда
 * вызывает save(_, 0)». Это устарело — `PortfolioService` читает
 * `store.getVersion(accountId)` СВЕЖИМ значением непосредственно перед КАЖДЫМ
 * `save()` (см. `reserveForOrder`/`applyFill`/`releaseReservation` и т.д.), а
 * не хардкодит версию. Эти тесты используют РЕАЛЬНЫЙ `InMemoryPortfolioStore`
 * (с настоящим CAS: конфликт версии → `VersionConflictError`) через полный
 * многошаговый flow, чтобы эмпирически подтвердить это — а не полагаться на
 * статическое чтение кода.
 */
describe('TradingFlow (integration) — CAS Portfolio (реальный InMemoryPortfolioStore)', () => {
  let orderRepo: InMemoryOrderRepository;
  let processedFillRepo: InMemoryProcessedFillRepository;
  let keyedMutex: InMemoryKeyedMutex;
  let realPortfolioStore: InMemoryPortfolioStore;
  let eventBus: EventBus;
  let portfolioService: PortfolioService;
  let ledgerService: LedgerService;
  let orderedEventOutbox: InMemoryOrderedEventOutbox;
  let orderSubmissionRepo: InMemoryOrderSubmissionRepository;

  beforeEach(() => {
    orderRepo = new InMemoryOrderRepository();
    processedFillRepo = new InMemoryProcessedFillRepository();
    keyedMutex = new InMemoryKeyedMutex();
    realPortfolioStore = new InMemoryPortfolioStore();
    eventBus = new EventBus(LOGGER);
    portfolioService = new PortfolioService(realPortfolioStore, LOGGER);
    ledgerService = new LedgerService(LOGGER);
    orderedEventOutbox = new InMemoryOrderedEventOutbox({
      publish: (events) => eventBus.publishAll(events as Parameters<typeof eventBus.publishAll>[0]),
      logger: LOGGER,
    });
    orderSubmissionRepo = new InMemoryOrderSubmissionRepository();
  });

  afterEach(() => {
    orderRepo.clear();
    processedFillRepo.clear();
    realPortfolioStore.clear();
  });

  it('Place → partial Fill → second Fill: версия увеличивается на каждом шаге (без VersionConflictError), reserved=0, position/available корректны', async () => {
    const portfolio = makeInitialPortfolio();
    expect(realPortfolioStore.save(portfolio, 0).ok).toBe(true);
    let version = realPortfolioStore.getVersion(ACCOUNT_ID);
    expect(version).toBe(1);

    const placeDeps: PlaceOrderDeps = {
      riskChecker: makePassRiskChecker(),
      orderRepo,
      portfolioService,
      keyedMutex,
      exchangeClient: makeExchangeClient(),
      orderStateStore: orderRepo,
      orderedEventOutbox,
      submissions: orderSubmissionRepo,
      clock: makeClock(),
      logger: LOGGER,
    };
    const input: PlaceOrderInput = {
      orderId: ORDER_ID,
      accountId: ACCOUNT_ID,
      asset: TOKEN_ASSET_ID,
      instrumentId: INSTRUMENT_ID,
      side: 'BUY',
      price: ORDER_PRICE,
      size: ORDER_SIZE,
      portfolio,
      openOrdersCount: 0,
    };

    // Place: reserve NOTIONAL под CAS.
    const placeResult = await new PlaceOrderUseCase(placeDeps).execute(input);
    expect(placeResult.ok).toBe(true);
    expect(realPortfolioStore.getVersion(ACCOUNT_ID)).toBeGreaterThan(version);
    version = realPortfolioStore.getVersion(ACCOUNT_ID);
    expect(realPortfolioStore.get(ACCOUNT_ID)!.balance.reserved().value().toNumber()).toBeCloseTo(NOTIONAL.toNumber(), 6);

    const processFillUseCase = new ProcessFillUseCase({
      orderStateStore: orderRepo,
      portfolioService,
      ledgerService,
      orderRepo,
      processedFillRepo,
      keyedMutex,
      eventBus,
      orderedEventOutbox,
      submissions: orderSubmissionRepo,
      logger: LOGGER,
    });

    // Partial fill: 30 из 50 — Order → PARTIALLY_FILLED, ВТОРОЙ real save() под CAS.
    const firstFill = makeFill(ORDER_ID, { size: Quantity.of(new Decimal('30')), fillId: 'fill-cas-partial-1' });
    const firstFillResult = await processFillUseCase.execute(firstFill);
    expect(firstFillResult.ok).toBe(true);
    expect(realPortfolioStore.getVersion(ACCOUNT_ID)).toBeGreaterThan(version);
    version = realPortfolioStore.getVersion(ACCOUNT_ID);
    expect((await orderRepo.get(ORDER_ID))?.status).toBe('PARTIALLY_FILLED');

    // Второй fill: оставшиеся 20 — Order → FILLED, ТРЕТИЙ real save() под CAS
    // (если бы CAS был сломан несовместимостью версий — этот вызов вернул бы
    // VersionConflictError, и execute() вернул бы Err).
    const secondFill = makeFill(ORDER_ID, { size: Quantity.of(new Decimal('20')), fillId: 'fill-cas-partial-2' });
    const secondFillResult = await processFillUseCase.execute(secondFill);
    expect(secondFillResult.ok).toBe(true);
    expect(realPortfolioStore.getVersion(ACCOUNT_ID)).toBeGreaterThan(version);

    const finalOrder = await orderRepo.get(ORDER_ID);
    expect(finalOrder?.status).toBe('FILLED');

    const finalPortfolio = realPortfolioStore.get(ACCOUNT_ID)!;
    expect(finalPortfolio.balance.reserved().value().toNumber()).toBeCloseTo(0, 6);
    expect(finalPortfolio.balance.available().value().toNumber()).toBeCloseTo(
      new Decimal('1000').minus(NOTIONAL).toNumber(), 6,
    );
    expect(finalPortfolio.getPosition(INSTRUMENT_ID)?.quantity.value().toNumber()).toBeCloseTo(50, 6);
  });

  it('Place → partial Fill → Cancel remaining: journal consumed + released = исходная reservation, CAS работает на протяжении всего flow', async () => {
    const portfolio = makeInitialPortfolio();
    expect(realPortfolioStore.save(portfolio, 0).ok).toBe(true);

    const placeDeps: PlaceOrderDeps = {
      riskChecker: makePassRiskChecker(),
      orderRepo,
      portfolioService,
      keyedMutex,
      exchangeClient: makeExchangeClient(),
      orderStateStore: orderRepo,
      orderedEventOutbox,
      submissions: orderSubmissionRepo,
      clock: makeClock(),
      logger: LOGGER,
    };
    const input: PlaceOrderInput = {
      orderId: ORDER_ID,
      accountId: ACCOUNT_ID,
      asset: TOKEN_ASSET_ID,
      instrumentId: INSTRUMENT_ID,
      side: 'BUY',
      price: ORDER_PRICE,
      size: ORDER_SIZE,
      portfolio,
      openOrdersCount: 0,
    };
    const placeResult = await new PlaceOrderUseCase(placeDeps).execute(input);
    expect(placeResult.ok).toBe(true);

    const initialReservation = (await orderSubmissionRepo.get(ORDER_ID))?.reservation;
    expect(initialReservation?.status).toBe('HELD');
    const initialAmount = new Decimal(initialReservation!.initial);
    expect(initialAmount.toNumber()).toBeCloseTo(NOTIONAL.toNumber(), 6);

    // Partial fill: 30 из 50.
    const processFillUseCase = new ProcessFillUseCase({
      orderStateStore: orderRepo,
      portfolioService,
      ledgerService,
      orderRepo,
      processedFillRepo,
      keyedMutex,
      eventBus,
      orderedEventOutbox,
      submissions: orderSubmissionRepo,
      logger: LOGGER,
    });
    const partialFill = makeFill(ORDER_ID, { size: Quantity.of(new Decimal('30')), fillId: 'fill-cas-cancel-partial' });
    const partialFillResult = await processFillUseCase.execute(partialFill);
    expect(partialFillResult.ok).toBe(true);
    expect((await orderRepo.get(ORDER_ID))?.status).toBe('PARTIALLY_FILLED');

    // Cancel остатка (20 из 50 непокрыты) — под тем же реальным CAS Portfolio.
    const cancelDeps: CancelOrderDeps = {
      portfolioService,
      orderRepo,
      orderStateStore: orderRepo,
      keyedMutex,
      exchangeClient: makeExchangeClient(),
      orderedEventOutbox,
      submissions: orderSubmissionRepo,
      logger: LOGGER,
    };
    const cancelResult = await new CancelOrderUseCase(cancelDeps).execute({
      orderId: ORDER_ID, accountId: ACCOUNT_ID, reason: 'cancel remaining after partial fill',
    });
    expect(cancelResult.ok).toBe(true);
    expect((await orderRepo.get(ORDER_ID))?.status).toBe('CANCELED');

    // Journal: consumed (fill) + released (cancel) = исходная reservation, remaining = 0.
    const finalReservation = (await orderSubmissionRepo.get(ORDER_ID))?.reservation;
    expect(finalReservation?.status).toBe('SETTLED');
    expect(new Decimal(finalReservation!.remaining).toNumber()).toBeCloseTo(0, 6);
    const consumedPlusReleased = new Decimal(finalReservation!.consumed).plus(finalReservation!.released);
    expect(consumedPlusReleased.toNumber()).toBeCloseTo(initialAmount.toNumber(), 6);

    // Portfolio: reserved = 0 (ничего не осталось замороженным), CAS не сломался.
    const finalPortfolio = realPortfolioStore.get(ACCOUNT_ID)!;
    expect(finalPortfolio.balance.reserved().value().toNumber()).toBeCloseTo(0, 6);
    expect(finalPortfolio.getPosition(INSTRUMENT_ID)?.quantity.value().toNumber()).toBeCloseTo(30, 6);
  });

  // ── Race Fill vs Cancel: детерминированные сценарии (promise-защёлки) ─────

  /**
   * Оборачивает реальный `IKeyedMutex` так, что ПЕРВЫЙ вызов `runExclusive`
   * приостанавливается ВНУТРИ критической секции (держит lock) до явного
   * `releaseFirst()`. `entered` резолвится, когда первый вызов действительно
   * вошёл (держит lock) — с этого момента безопасно запускать второй
   * (конкурентный) вызов и проверять, что ОН заблокирован на том же ключе,
   * НЕ полагаясь на `setTimeout`-окно.
   */
  function makeControllableMutex(real: IKeyedMutex): {
    readonly mutex: IKeyedMutex;
    readonly entered: Promise<void>;
    readonly releaseFirst: () => void;
  } {
    let firstSeen = false;
    let resolveEntered!: () => void;
    const entered = new Promise<void>((resolve) => { resolveEntered = resolve; });
    let resolveRelease!: () => void;
    const release = new Promise<void>((resolve) => { resolveRelease = resolve; });
    const mutex: IKeyedMutex = {
      runExclusive: async <T>(keys: readonly string[], fn: () => Promise<T>): Promise<T> =>
        real.runExclusive(keys, async () => {
          if (!firstSeen) {
            firstSeen = true;
            resolveEntered();
            await release;
          }
          return fn();
        }),
    };
    return { mutex, entered, releaseFirst: () => resolveRelease() };
  }

  it('Race (детерминированный): Fill выигрывает — Cancel НИКОГДА не достигает venue, Order=FILLED, reservation=SETTLED, Portfolio изменён ровно один раз', async () => {
    const portfolio = makeInitialPortfolio();
    expect(realPortfolioStore.save(portfolio, 0).ok).toBe(true);

    const placeDeps: PlaceOrderDeps = {
      riskChecker: makePassRiskChecker(),
      orderRepo, portfolioService, keyedMutex,
      exchangeClient: makeExchangeClient(),
      orderStateStore: orderRepo, orderedEventOutbox, submissions: orderSubmissionRepo,
      clock: makeClock(), logger: LOGGER,
    };
    const placeResult = await new PlaceOrderUseCase(placeDeps).execute({
      orderId: ORDER_ID, accountId: ACCOUNT_ID, asset: TOKEN_ASSET_ID, instrumentId: INSTRUMENT_ID,
      side: 'BUY', price: ORDER_PRICE, size: ORDER_SIZE, portfolio, openOrdersCount: 0,
    });
    expect(placeResult.ok).toBe(true);

    const { mutex, entered, releaseFirst } = makeControllableMutex(keyedMutex);
    const applyFillSpy = jest.spyOn(portfolioService, 'applyFill');
    const releaseReservationSpy = jest.spyOn(portfolioService, 'releaseReservation');
    const cancelOrder = jest.fn(async () => Ok({ status: 'CANCELLED' as const }));
    const exchangeClient: IExchangeClient = { ...makeExchangeClient(), cancelOrder };

    const processFillUseCase = new ProcessFillUseCase({
      orderStateStore: orderRepo, portfolioService, ledgerService, orderRepo, processedFillRepo,
      keyedMutex: mutex, eventBus, orderedEventOutbox, submissions: orderSubmissionRepo, logger: LOGGER,
    });
    const cancelOrderUseCase = new CancelOrderUseCase({
      portfolioService, orderRepo, orderStateStore: orderRepo, keyedMutex: mutex,
      exchangeClient, orderedEventOutbox, submissions: orderSubmissionRepo, logger: LOGGER,
    });

    // Fill входит в mutex первым и приостанавливается там (управляемый gate).
    const fillId = 'fill-race-fill-wins';
    const fillPromise = processFillUseCase.execute(makeFill(ORDER_ID, { fillId }));
    await entered;

    // Cancel запускается, ПОКА Fill держит lock — обязан встать в очередь и
    // НЕ достигнуть venue (cancelOrder вызывается только внутри lock).
    const cancelPromise = cancelOrderUseCase.execute({ orderId: ORDER_ID, accountId: ACCOUNT_ID, reason: 'race: fill wins' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(cancelOrder).not.toHaveBeenCalled();

    releaseFirst(); // Fill продолжает и завершается; затем Cancel разблокируется.
    const [fillResult, cancelResult] = await Promise.all([fillPromise, cancelPromise]);

    expect(fillResult.ok).toBe(true);
    expect(cancelResult.ok).toBe(true);
    if (cancelResult.ok) expect(cancelResult.value.status).toBe('ALREADY_FILLED');
    // Cancel НИКОГДА не достиг venue — увидел terminal Order (FILLED) до контакта с exchangeClient.
    expect(cancelOrder).not.toHaveBeenCalled();

    const finalOrder = await orderRepo.get(ORDER_ID);
    expect(finalOrder?.status).toBe('FILLED');
    expect(await processedFillRepo.getStatus(asFillId(fillId)!)).toBe('APPLIED');
    expect((await orderSubmissionRepo.get(ORDER_ID))?.reservation.status).toBe('SETTLED');

    const finalPortfolio = realPortfolioStore.get(ACCOUNT_ID)!;
    expect(finalPortfolio.balance.reserved().value().toNumber()).toBeCloseTo(0, 6);
    expect(finalPortfolio.balance.available().value().toNumber()).toBeCloseTo(
      new Decimal('1000').minus(NOTIONAL).toNumber(), 6,
    );
    expect(finalPortfolio.getPosition(INSTRUMENT_ID)?.quantity.value().toNumber()).toBeCloseTo(50, 6);

    // Portfolio изменён РОВНО один раз (normal fill path); Cancel НИКОГДА не
    // освобождал резервацию повторно.
    expect(applyFillSpy).toHaveBeenCalledTimes(1);
    expect(releaseReservationSpy).not.toHaveBeenCalled();

    // Ledger записан один раз (POSITION_DELTA + CASH_DELTA — 2 баланса, не 4).
    expect(ledgerService.ledger.getAllBalances(ACCOUNT_ID).size).toBe(2);
  });

  it('Race (детерминированный): Cancel выигрывает — release выполнен один раз, delayed Fill идёт через direct-fill path, итоговый баланс без двойного release/debit', async () => {
    const portfolio = makeInitialPortfolio();
    expect(realPortfolioStore.save(portfolio, 0).ok).toBe(true);

    const placeDeps: PlaceOrderDeps = {
      riskChecker: makePassRiskChecker(),
      orderRepo, portfolioService, keyedMutex,
      exchangeClient: makeExchangeClient(),
      orderStateStore: orderRepo, orderedEventOutbox, submissions: orderSubmissionRepo,
      clock: makeClock(), logger: LOGGER,
    };
    const placeResult = await new PlaceOrderUseCase(placeDeps).execute({
      orderId: ORDER_ID, accountId: ACCOUNT_ID, asset: TOKEN_ASSET_ID, instrumentId: INSTRUMENT_ID,
      side: 'BUY', price: ORDER_PRICE, size: ORDER_SIZE, portfolio, openOrdersCount: 0,
    });
    expect(placeResult.ok).toBe(true);

    const { mutex, entered, releaseFirst } = makeControllableMutex(keyedMutex);
    const releaseReservationSpy = jest.spyOn(portfolioService, 'releaseReservation');
    const applyDirectFillSpy = jest.spyOn(portfolioService, 'applyDirectFill');
    const applyFillSpy = jest.spyOn(portfolioService, 'applyFill');

    const cancelOrderUseCase = new CancelOrderUseCase({
      portfolioService, orderRepo, orderStateStore: orderRepo, keyedMutex: mutex,
      exchangeClient: makeExchangeClient(), orderedEventOutbox, submissions: orderSubmissionRepo, logger: LOGGER,
    });
    const processFillUseCase = new ProcessFillUseCase({
      orderStateStore: orderRepo, portfolioService, ledgerService, orderRepo, processedFillRepo,
      keyedMutex: mutex, eventBus, orderedEventOutbox, submissions: orderSubmissionRepo, logger: LOGGER,
    });

    // Cancel входит в mutex первым и приостанавливается там.
    const cancelPromise = cancelOrderUseCase.execute({ orderId: ORDER_ID, accountId: ACCOUNT_ID, reason: 'race: cancel wins' });
    await entered;

    // Fill запускается, ПОКА Cancel держит lock — begin() (P1: внутри mutex)
    // не мог ещё выполниться, fillId остаётся неизвестным processedFillRepo.
    const fillId = 'fill-race-cancel-wins';
    const fillPromise = processFillUseCase.execute(makeFill(ORDER_ID, { fillId }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(await processedFillRepo.getStatus(asFillId(fillId)!)).toBeUndefined();

    releaseFirst(); // Cancel продолжает и завершается; затем Fill разблокируется.
    const [cancelResult, fillResult] = await Promise.all([cancelPromise, fillPromise]);

    expect(cancelResult.ok).toBe(true);
    if (cancelResult.ok) expect(cancelResult.value.status).toBe('CANCELLED');
    expect(fillResult.ok).toBe(true);

    // Order остаётся CANCELED — direct-fill path НЕ переписывает Order.
    const finalOrder = await orderRepo.get(ORDER_ID);
    expect(finalOrder?.status).toBe('CANCELED');
    expect(await processedFillRepo.getStatus(asFillId(fillId)!)).toBe('APPLIED');

    const finalReservation = (await orderSubmissionRepo.get(ORDER_ID))?.reservation;
    expect(finalReservation?.status).toBe('SETTLED');
    expect(new Decimal(finalReservation!.remaining).toNumber()).toBeCloseTo(0, 6);

    const finalPortfolio = realPortfolioStore.get(ACCOUNT_ID)!;
    expect(finalPortfolio.balance.reserved().value().toNumber()).toBeCloseTo(0, 6);
    // Итоговый available соответствует venue outcome: release вернул NOTIONAL,
    // затем direct-fill списал ровно NOTIONAL обратно — net идентичен normal fill.
    expect(finalPortfolio.balance.available().value().toNumber()).toBeCloseTo(
      new Decimal('1000').minus(NOTIONAL).toNumber(), 6,
    );
    expect(finalPortfolio.getPosition(INSTRUMENT_ID)?.quantity.value().toNumber()).toBeCloseTo(50, 6);

    // release выполнен РОВНО один раз (Cancel); direct-fill применён РОВНО один
    // раз (Fill); normal-fill path НЕ вызывался (Order уже terminal к моменту Fill).
    expect(releaseReservationSpy).toHaveBeenCalledTimes(1);
    expect(applyDirectFillSpy).toHaveBeenCalledTimes(1);
    expect(applyFillSpy).not.toHaveBeenCalled();

    // Ledger записан один раз (через direct-fill path).
    expect(ledgerService.ledger.getAllBalances(ACCOUNT_ID).size).toBe(2);
  });
});
