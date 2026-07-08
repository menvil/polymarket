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
 * - `TestPortfolioStore` (без CAS)
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
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
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
import type { IPortfolioStore, IExchangeClient, ExchangeError, VersionConflictError } from '@polymarket/ports';
import type { IOrderRiskChecker } from '@polymarket/risk';
import type { IClock } from '@polymarket/time';
import Decimal from 'decimal.js';

import { InMemoryOrderRepository } from '../../../../infrastructure/in-memory/src/InMemoryOrderRepository.js';
import { InMemoryProcessedFillRepository } from '../../../../infrastructure/in-memory/src/InMemoryProcessedFillRepository.js';
import { InMemoryKeyedMutex } from '../../../../infrastructure/in-memory/src/InMemoryKeyedMutex.js';

// ── TestPortfolioStore ────────────────────────────────────────────────────────

/**
 * Упрощённое хранилище Portfolio без CAS (см. Phase 1 объяснение).
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
    updateParams: () => {},
  };
}

/**
 * Создаёт mock IExchangeClient.
 *
 * @param submitResult - Результат submitOrder (по умолчанию Ok(ORDER_ID))
 */
function makeExchangeClient(
  submitResult: Result<import('@polymarket/ports').SubmitOrderResult, ExchangeError> = Ok({
    orderId: ORDER_ID,
    immediatelyMatched: false,
    effectiveSize: ORDER_SIZE,
  }),
): IExchangeClient {
  return {
    submitOrder: () => Promise.resolve(submitResult),
    cancelOrder: () => Promise.resolve(Ok(undefined)),
    getOpenOrders: () => Promise.resolve(Ok([])),
    getTrades: () => Promise.resolve(Ok([])),
  };
}

/**
 * Создаёт Fill для существующего ордера.
 */
function makeFill(orderId: OrderId = ORDER_ID): Fill {
  return unwrap(Fill.create({
    id: asFillId('fill-trading-flow-001')!,
    orderId,
    accountId: ACCOUNT_ID,
    venueId: VENUE_ID,
    marketId: MARKET_ID,
    tokenId: TOKEN_ASSET_ID,
    settlementAssetId: AssetIdHelpers.USDC,
    price: ORDER_PRICE,
    size: ORDER_SIZE,
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

  beforeEach(() => {
    orderRepo = new InMemoryOrderRepository();
    processedFillRepo = new InMemoryProcessedFillRepository();
    keyedMutex = new InMemoryKeyedMutex();
    portfolioStore = new TestPortfolioStore();
    eventBus = new EventBus(LOGGER);
    portfolioService = new PortfolioService(portfolioStore, LOGGER);
    ledgerService = new LedgerService(LOGGER);
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
      exchangeClient: makeExchangeClient(),
      orderStateStore: orderRepo,
      eventBus,
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

    const exchangeError = new (class extends Error {
      message = 'Exchange connectivity error';
    })() as unknown as ExchangeError;

    const placeDeps: PlaceOrderDeps = {
      riskChecker: makePassRiskChecker(),
      orderRepo,
      portfolioService,
      exchangeClient: makeExchangeClient(Err(exchangeError)),
      orderStateStore: orderRepo,
      eventBus,
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
      exchangeClient: makeExchangeClient(),
      orderStateStore: orderRepo,
      eventBus,
      clock: makeClock(),
      logger: LOGGER,
    };

    const cancelDeps: CancelOrderDeps = {
      portfolioService,
      orderRepo,
      orderStateStore: orderRepo,
      keyedMutex,
      exchangeClient: makeExchangeClient(),
      eventBus,
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

  // ── Конкурентность: ProcessFillUseCase и CancelOrderUseCase сериализуются ──

  it('concurrent ProcessFillUseCase.execute() и CancelOrderUseCase.execute() для одного ордера не пересекаются (реальный InMemoryKeyedMutex)', async () => {
    // Arrange: размещаем ордер обычным путём
    const portfolio = makeInitialPortfolio();
    portfolioStore.save(portfolio, 0);

    const placeDeps: PlaceOrderDeps = {
      riskChecker: makePassRiskChecker(),
      orderRepo,
      portfolioService,
      exchangeClient: makeExchangeClient(),
      orderStateStore: orderRepo,
      eventBus,
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

    // Инструментируем РЕАЛЬНЫЙ InMemoryKeyedMutex — считаем максимум одновременных
    // "владений" ключом. Если сериализация сломана, concurrent-счётчик превысит 1.
    let active = 0;
    let maxActive = 0;
    const originalRunExclusive = keyedMutex.runExclusive.bind(keyedMutex);
    const instrumentedMutex = {
      runExclusive: async <T>(keys: readonly string[], fn: () => Promise<T>): Promise<T> =>
        originalRunExclusive(keys, async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          try {
            // Искусственная задержка внутри критической секции — увеличивает
            // окно, в котором конкурентный вызов мог бы вклиниться, если бы
            // сериализация не работала.
            await new Promise((resolve) => setTimeout(resolve, 5));
            return await fn();
          } finally {
            active--;
          }
        }),
    };

    const processFillUseCase = new ProcessFillUseCase({
      orderStateStore: orderRepo,
      portfolioService,
      ledgerService,
      orderRepo,
      processedFillRepo,
      keyedMutex: instrumentedMutex,
      eventBus,
      logger: LOGGER,
    });
    const cancelOrderUseCase = new CancelOrderUseCase({
      portfolioService,
      orderRepo,
      orderStateStore: orderRepo,
      keyedMutex: instrumentedMutex,
      exchangeClient: makeExchangeClient(),
      eventBus,
      logger: LOGGER,
    });

    // Act: запускаем fill и cancel КОНКУРЕНТНО для одного и того же orderId
    const [fillResult, cancelResult] = await Promise.all([
      processFillUseCase.execute(makeFill()),
      cancelOrderUseCase.execute({ orderId: ORDER_ID, accountId: ACCOUNT_ID, reason: 'race test' }),
    ]);

    // Assert: оба вызова завершились без исключений (успех или контролируемый skip)
    expect(fillResult.ok).toBe(true);
    expect(cancelResult.ok).toBe(true);

    // Assert: критическая секция никогда не выполнялась параллельно
    expect(maxActive).toBe(1);

    // Assert: итоговое состояние ордера согласовано — либо FILLED (fill выиграл
    // гонку, cancel увидел terminal/matched и стал no-op), либо CANCELED (cancel
    // выиграл, fill применился как direct-fill на уже terminal ордер) — но НЕ
    // повреждённое промежуточное состояние.
    const finalOrder = await orderRepo.get(ORDER_ID);
    expect(['FILLED', 'CANCELED']).toContain(finalOrder?.status);
  });
});
