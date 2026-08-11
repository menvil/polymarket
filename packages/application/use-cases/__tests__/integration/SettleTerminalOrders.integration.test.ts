/**
 * Интеграционные тесты TerminalSettlementPending + SettleTerminalOrdersUseCase (Шаг 5).
 *
 * @remarks
 * Обязательный сценарий: partial fill произошёл на venue → CANCELLED update
 * пришёл ПЕРВЫМ → available НЕ увеличился → delayed Fill применился против
 * held reservation → после reconciliation освобождён ТОЛЬКО остаток → block снят.
 * Плюс fail-closed ветки: trades API недоступен → pending остаётся; сбой
 * settlement → эскалация в manual block.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import Decimal from 'decimal.js';
import { Ok, Err } from '@polymarket/result';
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import type { IEventBus } from '@polymarket/event-bus';
import type {
  IExchangeClient,
  IPortfolioStore,
  IOrderedEventOutbox,
  VenueTradeSnapshot,
} from '@polymarket/ports';
import { ExchangeError } from '@polymarket/ports';
import type { AccountId, AssetId, FillId, InstrumentId, MarketId, OrderId } from '@polymarket/ids';
import type { IPosition } from '@polymarket/portfolio';
import { Portfolio, asPortfolioId } from '@polymarket/portfolio';
import type { Fill } from '@polymarket/fill';
import { Order } from '@polymarket/order';
import { Price, Quantity, Money } from '@polymarket/value-objects';
import { Balance } from '@polymarket/value-objects/balance';
import { UpdateOrderStatusUseCase } from '../../src/UpdateOrderStatusUseCase.js';
import { ProcessFillUseCase } from '../../src/ProcessFillUseCase.js';
import { SettleTerminalOrdersUseCase } from '../../src/SettleTerminalOrdersUseCase.js';
import { PortfolioService } from '../../src/services/PortfolioService.js';
import { LedgerService } from '../../src/services/LedgerService.js';
import { InMemoryOrderRepository } from '../../../../infrastructure/in-memory/src/InMemoryOrderRepository.js';
import { InMemoryOrderSubmissionRepository } from '../../../../infrastructure/in-memory/src/InMemoryOrderSubmissionRepository.js';
import { InMemoryOrderedEventOutbox } from '../../../../infrastructure/in-memory/src/InMemoryOrderedEventOutbox.js';
import { InMemoryProcessedFillRepository } from '../../../../infrastructure/in-memory/src/InMemoryProcessedFillRepository.js';
import { InMemoryKeyedMutex } from '../../../../infrastructure/in-memory/src/InMemoryKeyedMutex.js';
import { InMemoryPortfolioStore } from '../../../../infrastructure/in-memory/src/InMemoryPortfolioStore.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ACCOUNT_ID = 'acc-001' as unknown as AccountId;
const ASSET_ID = { type: 'POLYMARKET_CTF_TOKEN', tokenId: 'token-abc' } as unknown as AssetId;
const INSTRUMENT_ID = 'token-abc' as unknown as InstrumentId;
const ORDER_ID = 'order-1' as unknown as OrderId;
const CLIENT_ID = 'client-1' as unknown as OrderId;
const TRADE_FILL_ID = 'venue-fill-1' as unknown as FillId;

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
    publish: jest.fn<IEventBus['publish']>().mockResolvedValue(Ok(undefined)),
    publishAll: jest.fn<IEventBus['publishAll']>().mockResolvedValue(Ok(undefined)),
    publishOrThrow: jest.fn<IEventBus['publishOrThrow']>().mockResolvedValue(undefined),
    publishAllOrThrow: jest.fn<IEventBus['publishAllOrThrow']>().mockResolvedValue(undefined),
    subscribe: jest.fn<IEventBus['subscribe']>().mockReturnValue(() => {}),
  };
}

function makeOutbox(bus: IEventBus): IOrderedEventOutbox {
  return new InMemoryOrderedEventOutbox({
    publish: async (events) => {
      const result = await bus.publishAll(events as Parameters<IEventBus['publishAll']>[0]);
      if (!result.ok) throw result.error;
    },
    logger: makeLogger(),
  });
}

function makePortfolioMock(): Portfolio {
  const p: Portfolio = {
    accountId: ACCOUNT_ID,
    balance: {
      available: () => ({ value: () => new Decimal('10000') }),
      reserved: () => ({ value: () => new Decimal('65') }),
      total: () => ({ value: () => new Decimal('10065') }),
    },
    getPosition: (_id: InstrumentId) => undefined,
    getPositions: () => ([] as IPosition[]).values(),
    getPositionCount: () => 0,
    reserveForOrder: jest.fn<Portfolio['reserveForOrder']>(),
    releaseReservation: jest.fn<Portfolio['releaseReservation']>(),
    reserveTokensForOrder: jest.fn<Portfolio['reserveTokensForOrder']>(),
    releaseTokenReservation: jest.fn<Portfolio['releaseTokenReservation']>(),
    applyDebit: jest.fn<Portfolio['applyDebit']>(),
    applyCredit: jest.fn<Portfolio['applyCredit']>(),
    applyDirectDebit: jest.fn<Portfolio['applyDirectDebit']>(),
    upsertPosition: jest.fn<Portfolio['upsertPosition']>(),
    tokenReservations: new Map(),
  } as unknown as Portfolio;
  (p.releaseReservation as ReturnType<typeof jest.fn>).mockReturnValue(Ok(p));
  (p.releaseTokenReservation as ReturnType<typeof jest.fn>).mockReturnValue(Ok(p));
  (p.applyDebit as ReturnType<typeof jest.fn>).mockReturnValue(Ok(p));
  (p.applyCredit as ReturnType<typeof jest.fn>).mockReturnValue(Ok(p));
  (p.applyDirectDebit as ReturnType<typeof jest.fn>).mockReturnValue(Ok(p));
  (p.upsertPosition as ReturnType<typeof jest.fn>).mockReturnValue(p);
  return p;
}

function makePortfolioStore(portfolio: Portfolio): IPortfolioStore {
  return {
    get: jest.fn<IPortfolioStore['get']>().mockReturnValue(portfolio),
    save: jest.fn<IPortfolioStore['save']>().mockReturnValue(Ok(undefined)),
    getVersion: jest.fn<IPortfolioStore['getVersion']>().mockReturnValue(0),
  };
}

function makeOpenOrder(): Order {
  const result = Order.create({
    id: ORDER_ID,
    asset: ASSET_ID,
    side: 'BUY',
    price: Price.of(new Decimal('0.65')) as never,
    size: Quantity.of(new Decimal('100')) as never,
    timestamp: { value: () => new Decimal(1000), toNumber: () => 1000, toISO: () => '2024-01-01T00:00:00.000Z' } as never,
  });
  if (!result.ok) throw new Error('Failed to create Order');
  const accepted = result.value.accept();
  if (!accepted.ok) throw new Error('Failed to accept Order');
  accepted.value.pullEvents();
  return accepted.value;
}

function makeFill(id: string, size = '50'): Fill {
  return {
    id: id as unknown as FillId,
    orderId: ORDER_ID,
    accountId: ACCOUNT_ID,
    tokenId: ASSET_ID,
    settlementAssetId: 'USDC' as unknown as AssetId,
    price: Price.of(new Decimal('0.65')),
    size: Quantity.of(new Decimal(size)),
    side: 'BUY',
    timestamp: { value: () => new Decimal(1000), toNumber: () => 1000 } as never,
    fee: { amount: { value: () => new Decimal(0) }, asset: 'USDC' as unknown as AssetId, isZero: () => true } as never,
    hasFee: () => false,
  } as unknown as Fill;
}

function makeTradeSnapshot(size = '50', status: VenueTradeSnapshot['status'] = 'CONFIRMED'): VenueTradeSnapshot {
  return {
    fillId: TRADE_FILL_ID,
    orderId: ORDER_ID,
    accountId: ACCOUNT_ID,
    marketId: 'market-1' as unknown as MarketId,
    asset: ASSET_ID,
    side: 'BUY',
    price: Price.of(new Decimal('0.65')),
    size: Quantity.of(new Decimal(size)),
    fee: { amount: Quantity.of(new Decimal('0')), asset: 'USDC' } as never,
    executedAt: { toNumber: () => Date.now() } as never,
    status,
  } as unknown as VenueTradeSnapshot;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TerminalSettlementPending + SettleTerminalOrdersUseCase (Шаг 5)', () => {
  let logger: ILogger;
  let eventBus: IEventBus;
  let clock: IClock;
  let store: InMemoryOrderRepository;
  let submissions: InMemoryOrderSubmissionRepository;
  let processedFillRepo: InMemoryProcessedFillRepository;
  let portfolio: Portfolio;
  let portfolioService: PortfolioService;
  let ledgerService: LedgerService;
  let processFill: ProcessFillUseCase;
  /**
   * РЕАЛЬНЫЙ non-reentrant mutex, ОБЩИЙ для settle и ProcessFill — регрессия
   * на nested-lock deadlock: до two-phase фикса settle держал ключи и вызывал
   * fillProcessor, который ждал те же ключи (зависание навсегда).
   */
  let realMutex: InMemoryKeyedMutex;

  beforeEach(async () => {
    logger = makeLogger();
    eventBus = makeEventBus();
    clock = { now: jest.fn(() => new Date('2026-01-01T00:00:00.000Z')) };
    store = new InMemoryOrderRepository();
    submissions = new InMemoryOrderSubmissionRepository();
    processedFillRepo = new InMemoryProcessedFillRepository();
    portfolio = makePortfolioMock();
    portfolioService = new PortfolioService(makePortfolioStore(portfolio), logger);
    ledgerService = new LedgerService(makeLogger());
    jest.spyOn(ledgerService as unknown as { recordFill: (f: Fill) => void }, 'recordFill').mockReturnValue(undefined);
    realMutex = new InMemoryKeyedMutex();
    processFill = new ProcessFillUseCase({
      orderStateStore: store,
      portfolioService,
      ledgerService,
      orderRepo: store,
      processedFillRepo,
      keyedMutex: realMutex,
      eventBus,
      orderedEventOutbox: makeOutbox(eventBus),
      submissions,
      logger,
      clock,
    });

    // Seed: live Order + held journal 65 USDC (BUY 100 @ 0.65).
    const save = await store.save(makeOpenOrder(), 0);
    if (!save.ok) throw new Error('seed order save failed');
    await submissions.begin({
      clientOrderId: CLIENT_ID, accountId: ACCOUNT_ID, instrumentId: INSTRUMENT_ID,
      fingerprint: 'fp', side: 'BUY', orderPrice: '0.65', requestedSize: '100', now: new Date(),
    });
    await submissions.markReservationHeld(CLIENT_ID, '65', new Date());
    await submissions.markCommitted(CLIENT_ID, ORDER_ID, new Date());
  });

  function makeUpdate(): UpdateOrderStatusUseCase {
    return new UpdateOrderStatusUseCase({
      orderRepo: store,
      orderStateStore: store,
      portfolioService,
      keyedMutex: realMutex,
      orderedEventOutbox: makeOutbox(eventBus),
      submissions,
      logger,
      clock,
    });
  }

  function makeSettle(
    trades: readonly VenueTradeSnapshot[],
    opts: { tradesOk?: boolean; minSettleDelayMs?: number } = {},
  ): SettleTerminalOrdersUseCase {
    const exchangeClient: IExchangeClient = {
      submitOrder: jest.fn<IExchangeClient['submitOrder']>(),
      cancelOrder: jest.fn<IExchangeClient['cancelOrder']>(),
      getOpenOrders: jest.fn<IExchangeClient['getOpenOrders']>().mockResolvedValue(Ok([])),
      getTrades: (opts.tradesOk ?? true)
        ? jest.fn<IExchangeClient['getTrades']>().mockResolvedValue(Ok([...trades]))
        : jest.fn<IExchangeClient['getTrades']>().mockResolvedValue(Err(new ExchangeError('trades api down'))),
    };
    return new SettleTerminalOrdersUseCase({
      orderStateStore: store,
      submissions,
      portfolioService,
      exchangeClient,
      processedFillRepo,
      fillProcessor: processFill,
      // Конвертер использует те же мок-VO, что и fill-фикстура.
      tradeToFill: (trade) => Ok(makeFill(String(trade.fillId), trade.size.value().toString())),
      // ТОТ ЖЕ реальный mutex, что у ProcessFillUseCase — ловит nested-lock deadlock.
      keyedMutex: realMutex,
      clock,
      logger,
      // Grace period отключён по умолчанию в тестах (проверяется отдельным тестом).
      minSettleDelayMs: opts.minSettleDelayMs ?? 0,
    });
  }

  it('grace period: свежий pending (моложе minSettleDelayMs) НЕ settle-ится', async () => {
    await makeUpdate().execute({ update: { type: 'CANCELLED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });

    const settleResult = await makeSettle([], { minSettleDelayMs: 30_000 }).execute({ accountId: ACCOUNT_ID });

    expect(settleResult.ok).toBe(true);
    if (settleResult.ok) expect(settleResult.value).toMatchObject({ kept: 1, settled: 0 });
    expect(store.hasTerminalSettlementPendingForOrder(ORDER_ID)).toBe(true);
    expect(portfolio.releaseReservation).not.toHaveBeenCalled();
  });

  it('ОБЯЗАТЕЛЬНЫЙ: partial fill на venue → CANCELLED первым → available не завышен → delayed fill через held reservation → освобождён только остаток → block снят', async () => {
    // 1. CANCELLED update приходит РАНЬШЕ delayed fill.
    const updateResult = await makeUpdate().execute({
      update: { type: 'CANCELLED', orderId: ORDER_ID },
      accountId: ACCOUNT_ID,
    });
    expect(updateResult.ok).toBe(true);

    // 2. available НЕ увеличился: release не выполнялся, journal held целиком.
    expect(portfolio.releaseReservation).not.toHaveBeenCalled();
    expect((await submissions.get(CLIENT_ID))?.reservation).toMatchObject({ status: 'HELD', remaining: '65' });
    expect(store.hasTerminalSettlementPendingForOrder(ORDER_ID)).toBe(true);
    expect(store.hasUnsettledFills(INSTRUMENT_ID)).toBe(true);

    // 3. Settle-резолвер: venue сообщает partial trade 50 @ 0.65 (delayed fill).
    const settleResult = await makeSettle([makeTradeSnapshot('50')]).execute({ accountId: ACCOUNT_ID });
    expect(settleResult.ok).toBe(true);
    if (settleResult.ok) expect(settleResult.value).toMatchObject({ scanned: 1, settled: 1, kept: 0, escalated: 0 });

    // 4. Delayed fill применён ПРОТИВ held reservation (consume reserved 32.5,
    // НЕ direct debit из available).
    expect(portfolio.applyDebit).toHaveBeenCalledTimes(1);
    expect(portfolio.applyDirectDebit).not.toHaveBeenCalled();

    // 5. Освобождён ТОЛЬКО остаток: 65 − 32.5 = 32.5.
    expect(portfolio.releaseReservation).toHaveBeenCalledTimes(1);
    const releasedArg = (portfolio.releaseReservation as ReturnType<typeof jest.fn>).mock.calls[0]?.[0] as { value: () => Decimal } | Decimal;
    const releasedValue = releasedArg instanceof Decimal ? releasedArg : (releasedArg as { value: () => Decimal }).value();
    expect(releasedValue.toString()).toBe('32.5');
    const record = await submissions.get(CLIENT_ID);
    expect(record?.reservation).toMatchObject({
      status: 'SETTLED', remaining: '0', consumed: '32.5', released: '32.5',
    });

    // 6. Block снят.
    expect(store.hasTerminalSettlementPendingForOrder(ORDER_ID)).toBe(false);
    expect(store.hasUnsettledFills(INSTRUMENT_ID)).toBe(false);
  });

  it('P0: MATCHED (не CONFIRMED) trade → pending остаётся, НЕ применяется, НЕ release-ится (settlement необратим, ждём finality)', async () => {
    await makeUpdate().execute({ update: { type: 'CANCELLED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });

    const settleResult = await makeSettle([makeTradeSnapshot('50', 'MATCHED')]).execute({ accountId: ACCOUNT_ID });

    expect(settleResult.ok).toBe(true);
    if (settleResult.ok) expect(settleResult.value).toMatchObject({ scanned: 1, settled: 0, kept: 1 });
    expect(portfolio.applyDebit).not.toHaveBeenCalled();
    expect(portfolio.releaseReservation).not.toHaveBeenCalled();
    expect(store.hasTerminalSettlementPendingForOrder(ORDER_ID)).toBe(true);
    expect((await submissions.get(CLIENT_ID))?.reservation).toMatchObject({ status: 'HELD', remaining: '65' });
  });

  it('P0 regression: fill уже APPLIED локально (recovery-профиль ReconcileTrades), но venue ещё НЕ CONFIRMED → settlement всё равно kept, а не release по local-статусу', async () => {
    await makeUpdate().execute({ update: { type: 'CANCELLED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });
    // Симулируем: ReconcileTradesUseCase уже применил fill по 'recovery'
    // профилю (MATCHED достаточен там) — локально он уже APPLIED, хотя venue
    // ещё не подтвердил CONFIRMED finality.
    await processedFillRepo.begin(TRADE_FILL_ID, { workerId: 'w', now: new Date(), leaseMs: 60_000 });
    await processedFillRepo.markApplied(TRADE_FILL_ID);

    const settleResult = await makeSettle([makeTradeSnapshot('50', 'MATCHED')]).execute({ accountId: ACCOUNT_ID });

    expect(settleResult.ok).toBe(true);
    // БЕЗ реордеринга venue-finality-check settle бы увидел local APPLIED
    // ПЕРВЫМ и продолжил бы к release, несмотря на MATCHED (не CONFIRMED).
    if (settleResult.ok) expect(settleResult.value).toMatchObject({ scanned: 1, settled: 0, kept: 1 });
    expect(portfolio.releaseReservation).not.toHaveBeenCalled();
    expect(store.hasTerminalSettlementPendingForOrder(ORDER_ID)).toBe(true);
    expect((await submissions.get(CLIENT_ID))?.reservation).toMatchObject({ status: 'HELD', remaining: '65' });
  });

  it('P0: FAILED trade (не применён локально) исключается из settlement — остальной остаток release-ится нормально', async () => {
    await makeUpdate().execute({ update: { type: 'CANCELLED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });

    const settleResult = await makeSettle([makeTradeSnapshot('50', 'FAILED')]).execute({ accountId: ACCOUNT_ID });

    expect(settleResult.ok).toBe(true);
    if (settleResult.ok) expect(settleResult.value).toMatchObject({ scanned: 1, settled: 1, kept: 0, escalated: 0 });
    // FAILED trade не применяется (contributes 0) — весь held остаток (65) освобождён.
    expect(portfolio.applyDebit).not.toHaveBeenCalled();
    expect(portfolio.releaseReservation).toHaveBeenCalledTimes(1);
    const record = await submissions.get(CLIENT_ID);
    expect(record?.reservation).toMatchObject({ status: 'SETTLED', remaining: '0', released: '65' });
    expect(store.hasTerminalSettlementPendingForOrder(ORDER_ID)).toBe(false);
  });

  it('P0: FAILED trade, УЖЕ применённый локально (WS доставил раньше отката) → эскалация, pending снят в manual block', async () => {
    await makeUpdate().execute({ update: { type: 'CANCELLED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });
    // Локально fill уже APPLIED (например, WS MATCHED пришёл и был обработан
    // ДО того, как venue откатил trade в FAILED).
    await processedFillRepo.begin(TRADE_FILL_ID, { workerId: 'w', now: new Date(), leaseMs: 60_000 });
    await processedFillRepo.markApplied(TRADE_FILL_ID);

    const settleResult = await makeSettle([makeTradeSnapshot('50', 'FAILED')]).execute({ accountId: ACCOUNT_ID });

    expect(settleResult.ok).toBe(true);
    if (settleResult.ok) expect(settleResult.value).toMatchObject({ scanned: 1, settled: 0, escalated: 1 });
    expect(portfolio.releaseReservation).not.toHaveBeenCalled();
    expect(store.hasManualReconciliationBlockForOrder(ORDER_ID)).toBe(true);
  });

  it('P1: FAILED trade с local RECONCILIATION_REQUIRED → эскалация (unresolved partial commit, НЕ безопасно исключить)', async () => {
    await makeUpdate().execute({ update: { type: 'CANCELLED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });
    // Предыдущая попытка обработки этого fillId уже частично закоммитила
    // Order/Portfolio/Ledger/journal (см. FillCommitPhase) и застряла в
    // RECONCILIATION_REQUIRED — это НЕ «fill не применён».
    await processedFillRepo.begin(TRADE_FILL_ID, { workerId: 'w', now: new Date(), leaseMs: 60_000 });
    await processedFillRepo.markReconciliationRequired(TRADE_FILL_ID, 'partial commit');

    const settleResult = await makeSettle([makeTradeSnapshot('50', 'FAILED')]).execute({ accountId: ACCOUNT_ID });

    expect(settleResult.ok).toBe(true);
    if (settleResult.ok) expect(settleResult.value).toMatchObject({ scanned: 1, settled: 0, escalated: 1 });
    expect(portfolio.releaseReservation).not.toHaveBeenCalled();
    expect(store.hasManualReconciliationBlockForOrder(ORDER_ID)).toBe(true);
  });

  it('P1: FAILED trade с local PROCESSING → pending kept (конкурентный ProcessFillUseCase ещё может завершиться APPLIED — нельзя release-ить сейчас)', async () => {
    await makeUpdate().execute({ update: { type: 'CANCELLED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });
    // Конкурентный ProcessFillUseCase.execute() держит PROCESSING для этого
    // fillId (начал обработку, когда trade ещё был MATCHED, до отката в
    // FAILED) — begin() без mark* оставляет запись в PROCESSING.
    await processedFillRepo.begin(TRADE_FILL_ID, { workerId: 'other-worker', now: new Date(), leaseMs: 60_000 });

    const settleResult = await makeSettle([makeTradeSnapshot('50', 'FAILED')]).execute({ accountId: ACCOUNT_ID });

    expect(settleResult.ok).toBe(true);
    if (settleResult.ok) expect(settleResult.value).toMatchObject({ scanned: 1, settled: 0, kept: 1, escalated: 0 });
    // НЕ excluded-as-contributes-0 и НЕ released — остаётся pending до
    // следующего прогона, когда конкурентный процесс завершится.
    expect(portfolio.releaseReservation).not.toHaveBeenCalled();
    expect(store.hasTerminalSettlementPendingForOrder(ORDER_ID)).toBe(true);
    expect(store.hasManualReconciliationBlockForOrder(ORDER_ID)).toBe(false);
  });

  it('trades API недоступен → pending ОСТАЁТСЯ (timeout — не доказательство отсутствия fill)', async () => {
    await makeUpdate().execute({ update: { type: 'CANCELLED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });
    expect(store.hasTerminalSettlementPendingForOrder(ORDER_ID)).toBe(true);

    const settleResult = await makeSettle([], { tradesOk: false }).execute({ accountId: ACCOUNT_ID });

    expect(settleResult.ok).toBe(false);
    expect(store.hasTerminalSettlementPendingForOrder(ORDER_ID)).toBe(true);
    expect(portfolio.releaseReservation).not.toHaveBeenCalled();
    expect((await submissions.get(CLIENT_ID))?.reservation.status).toBe('HELD');
  });

  it('без trades (venue подтверждает отсутствие fills) → освобождён ВЕСЬ остаток, pending снят', async () => {
    await makeUpdate().execute({ update: { type: 'CANCELLED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });

    const settleResult = await makeSettle([]).execute({ accountId: ACCOUNT_ID });

    expect(settleResult.ok).toBe(true);
    if (settleResult.ok) expect(settleResult.value).toMatchObject({ settled: 1 });
    expect(portfolio.releaseReservation).toHaveBeenCalledTimes(1);
    const record = await submissions.get(CLIENT_ID);
    expect(record?.reservation).toMatchObject({ status: 'SETTLED', remaining: '0', released: '65' });
    expect(store.hasTerminalSettlementPendingForOrder(ORDER_ID)).toBe(false);
  });

  it('Portfolio release failure при settlement → эскалация в manual block, pending снят, journal RECONCILIATION_REQUIRED', async () => {
    await makeUpdate().execute({ update: { type: 'CANCELLED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });
    (portfolio.releaseReservation as ReturnType<typeof jest.fn>).mockReturnValue(
      Err(new (await import('@polymarket/errors')).TradingError('cannot unfreeze')),
    );

    const settleResult = await makeSettle([]).execute({ accountId: ACCOUNT_ID });

    expect(settleResult.ok).toBe(true);
    if (settleResult.ok) expect(settleResult.value).toMatchObject({ escalated: 1, settled: 0 });
    expect(store.hasManualReconciliationBlockForOrder(ORDER_ID)).toBe(true);
    expect(store.hasTerminalSettlementPendingForOrder(ORDER_ID)).toBe(false);
    expect((await submissions.get(CLIENT_ID))?.reservation.status).toBe('RECONCILIATION_REQUIRED');
    // Инструмент по-прежнему заблокирован (через manual block).
    expect(store.hasUnsettledFills(INSTRUMENT_ID)).toBe(true);
  });

  it('BUSY ≠ APPLIED: Ok от fillProcessor при незавершённой обработке НЕ считается применением — pending остаётся, release НЕ выполняется', async () => {
    await makeUpdate().execute({ update: { type: 'CANCELLED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });
    // Fill занят другим worker-ом: статус PROCESSING; ProcessFillUseCase в
    // таком случае возвращает Ok (BUSY no-op) БЕЗ применения.
    await processedFillRepo.begin(TRADE_FILL_ID);
    const busyProcessor = { execute: jest.fn().mockImplementation(async () => Ok(undefined)) };
    const settle = new SettleTerminalOrdersUseCase({
      orderStateStore: store,
      submissions,
      portfolioService,
      exchangeClient: {
        submitOrder: jest.fn(), cancelOrder: jest.fn(),
        getOpenOrders: jest.fn().mockImplementation(async () => Ok([])),
        getTrades: jest.fn().mockImplementation(async () => Ok([makeTradeSnapshot('50')])),
      } as unknown as IExchangeClient,
      processedFillRepo,
      fillProcessor: busyProcessor as never,
      tradeToFill: (trade) => Ok(makeFill(String(trade.fillId), trade.size.value().toString())),
      keyedMutex: realMutex,
      clock,
      logger,
      minSettleDelayMs: 0,
    });

    const settleResult = await settle.execute({ accountId: ACCOUNT_ID });

    expect(settleResult.ok).toBe(true);
    // Ok получен, но re-read показал PROCESSING → kept, НИКАКОГО release.
    if (settleResult.ok) expect(settleResult.value).toMatchObject({ kept: 1, settled: 0, escalated: 0 });
    expect(busyProcessor.execute).toHaveBeenCalledTimes(1);
    expect(portfolio.releaseReservation).not.toHaveBeenCalled();
    expect(store.hasTerminalSettlementPendingForOrder(ORDER_ID)).toBe(true);
  });

  it('pending чужого аккаунта НЕ виден settle-резолвером (scanned=0)', async () => {
    store.markTerminalSettlementPending({
      accountId: 'acc-OTHER' as unknown as AccountId,
      orderId: ORDER_ID,
      instrumentId: INSTRUMENT_ID,
      venueStatus: 'CANCELLED',
      receivedAt: new Date(0),
    });

    const settleResult = await makeSettle([]).execute({ accountId: ACCOUNT_ID });

    expect(settleResult.ok).toBe(true);
    if (settleResult.ok) expect(settleResult.value).toMatchObject({ scanned: 0 });
    expect(portfolio.releaseReservation).not.toHaveBeenCalled();
    expect(store.hasTerminalSettlementPendingForOrder(ORDER_ID)).toBe(true);
  });

  it('journal record чужого аккаунта → escalate (release в чужой Portfolio невозможен)', async () => {
    // Journal-запись под order-2 принадлежит ДРУГОМУ аккаунту.
    const ORDER_2 = 'order-2' as unknown as OrderId;
    const CLIENT_2 = 'client-2' as unknown as OrderId;
    await submissions.begin({
      clientOrderId: CLIENT_2, accountId: 'acc-OTHER' as unknown as AccountId, instrumentId: INSTRUMENT_ID,
      fingerprint: 'fp2', side: 'BUY', orderPrice: '0.65', requestedSize: '100', now: new Date(),
    });
    await submissions.markReservationHeld(CLIENT_2, '65', new Date());
    await submissions.markCommitted(CLIENT_2, ORDER_2, new Date());
    // Pending (ошибочно) числится за НАШИМ аккаунтом.
    store.markTerminalSettlementPending({
      accountId: ACCOUNT_ID,
      orderId: ORDER_2,
      instrumentId: INSTRUMENT_ID,
      venueStatus: 'CANCELLED',
      receivedAt: new Date(0),
    });

    const settleResult = await makeSettle([]).execute({ accountId: ACCOUNT_ID });

    expect(settleResult.ok).toBe(true);
    if (settleResult.ok) expect(settleResult.value).toMatchObject({ escalated: 1, settled: 0 });
    // Release НЕ выполнен, журнал чужого аккаунта не тронут, manual block поставлен.
    expect(portfolio.releaseReservation).not.toHaveBeenCalled();
    expect((await submissions.get(CLIENT_2))?.reservation.status).toBe('HELD');
    expect(store.hasManualReconciliationBlockForOrder(ORDER_2)).toBe(true);
  });

  it('delayed fill, который ещё не применился (processing failure) → pending остаётся, release НЕ выполняется', async () => {
    await makeUpdate().execute({ update: { type: 'CANCELLED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });
    // Fill processing падает (Portfolio applyDebit → Err) → settle держит pending.
    (portfolio.applyDebit as ReturnType<typeof jest.fn>).mockReturnValue(
      Err(new (await import('@polymarket/errors')).TradingError('portfolio busy')),
    );

    const settleResult = await makeSettle([makeTradeSnapshot('50')]).execute({ accountId: ACCOUNT_ID });

    expect(settleResult.ok).toBe(true);
    if (settleResult.ok) expect(settleResult.value).toMatchObject({ kept: 1, settled: 0 });
    expect(store.hasTerminalSettlementPendingForOrder(ORDER_ID)).toBe(true);
    expect(portfolio.releaseReservation).not.toHaveBeenCalled();
  });
});

// ── Stateful: реальный Portfolio (не мок с фиксированными значениями) ─────────

/**
 * @remarks
 * Основной describe выше проверяет "available не завышен" КОСВЕННО — через
 * отсутствие вызова `releaseReservation` на мок-Portfolio с фиксированными
 * `available=10000`/`reserved=65`, которые НЕ меняются от `applyDebit`/
 * `releaseReservation` (это jest.fn(), просто возвращающие `Ok`). Этот блок
 * использует РЕАЛЬНЫЙ `Portfolio` + `PortfolioService` + `InMemoryPortfolioStore`
 * — числа baseline/available/reserved проверяются напрямую на каждом шаге, а
 * не через факт вызова/невызова мок-метода.
 */
describe('TerminalSettlementPending + SettleTerminalOrdersUseCase — stateful (реальный Portfolio)', () => {
  let logger: ILogger;
  let eventBus: IEventBus;
  let clock: IClock;
  let store: InMemoryOrderRepository;
  let submissions: InMemoryOrderSubmissionRepository;
  let processedFillRepo: InMemoryProcessedFillRepository;
  let realPortfolioStore: InMemoryPortfolioStore;
  let portfolioService: PortfolioService;
  let ledgerService: LedgerService;
  let processFill: ProcessFillUseCase;
  let realMutex: InMemoryKeyedMutex;

  beforeEach(async () => {
    logger = makeLogger();
    eventBus = makeEventBus();
    clock = { now: jest.fn(() => new Date('2026-01-01T00:00:00.000Z')) };
    store = new InMemoryOrderRepository();
    submissions = new InMemoryOrderSubmissionRepository();
    processedFillRepo = new InMemoryProcessedFillRepository();
    realPortfolioStore = new InMemoryPortfolioStore();
    portfolioService = new PortfolioService(realPortfolioStore, logger);
    ledgerService = new LedgerService(makeLogger());
    jest.spyOn(ledgerService as unknown as { recordFill: (f: Fill) => void }, 'recordFill').mockReturnValue(undefined);
    realMutex = new InMemoryKeyedMutex();
    processFill = new ProcessFillUseCase({
      orderStateStore: store,
      portfolioService,
      ledgerService,
      orderRepo: store,
      processedFillRepo,
      keyedMutex: realMutex,
      eventBus,
      orderedEventOutbox: makeOutbox(eventBus),
      submissions,
      logger,
      clock,
    });

    // Seed: 1000 USDC available, 0 reserved — реальный Portfolio aggregate.
    const initialPortfolio = Portfolio.create({
      id: asPortfolioId('portfolio-settle-stateful')!,
      accountId: ACCOUNT_ID,
      balance: Balance.withZeroReserved(Money.of(new Decimal('1000'), 'USDC'), ACCOUNT_ID, 'POLYMARKET' as never),
    });
    if (!initialPortfolio.ok) throw new Error('Failed to create initial Portfolio');
    const saveResult = realPortfolioStore.save(initialPortfolio.value, 0);
    if (!saveResult.ok) throw new Error('Failed to save initial Portfolio');

    // Reserve 65 USDC под BUY 100 @ 0.65 (как PlaceOrderUseCase перед submit) —
    // available: 1000 → 935, reserved: 0 → 65.
    const reserveResult = portfolioService.reserveForOrder(ACCOUNT_ID, new Decimal('65'));
    if (!reserveResult.ok) throw new Error('Failed to reserve');

    // Seed: live Order + held journal 65 USDC (BUY 100 @ 0.65).
    const save = await store.save(makeOpenOrder(), 0);
    if (!save.ok) throw new Error('seed order save failed');
    await submissions.begin({
      clientOrderId: CLIENT_ID, accountId: ACCOUNT_ID, instrumentId: INSTRUMENT_ID,
      fingerprint: 'fp', side: 'BUY', orderPrice: '0.65', requestedSize: '100', now: new Date(),
    });
    await submissions.markReservationHeld(CLIENT_ID, '65', new Date());
    await submissions.markCommitted(CLIENT_ID, ORDER_ID, new Date());
  });

  function makeUpdate(): UpdateOrderStatusUseCase {
    return new UpdateOrderStatusUseCase({
      orderRepo: store,
      orderStateStore: store,
      portfolioService,
      keyedMutex: realMutex,
      orderedEventOutbox: makeOutbox(eventBus),
      submissions,
      logger,
      clock,
    });
  }

  function makeSettle(trades: readonly VenueTradeSnapshot[]): SettleTerminalOrdersUseCase {
    const exchangeClient: IExchangeClient = {
      submitOrder: jest.fn<IExchangeClient['submitOrder']>(),
      cancelOrder: jest.fn<IExchangeClient['cancelOrder']>(),
      getOpenOrders: jest.fn<IExchangeClient['getOpenOrders']>().mockResolvedValue(Ok([])),
      getTrades: jest.fn<IExchangeClient['getTrades']>().mockResolvedValue(Ok([...trades])),
    };
    return new SettleTerminalOrdersUseCase({
      orderStateStore: store,
      submissions,
      portfolioService,
      exchangeClient,
      processedFillRepo,
      fillProcessor: processFill,
      tradeToFill: (trade) => Ok(makeFill(String(trade.fillId), trade.size.value().toString())),
      keyedMutex: realMutex,
      clock,
      logger,
      minSettleDelayMs: 0,
    });
  }

  it('partial fill на venue → CANCELLED первым → delayed fill → settlement: точные available/reserved/position на каждом шаге', async () => {
    const balanceOf = (): { available: number; reserved: number } => {
      const p = realPortfolioStore.get(ACCOUNT_ID)!;
      return {
        available: p.balance.available().value().toNumber(),
        reserved: p.balance.reserved().value().toNumber(),
      };
    };

    // 1. До CANCELLED: available=935, reserved=65 (reserve уже выполнен в beforeEach).
    expect(balanceOf()).toEqual({ available: 935, reserved: 65 });

    // 2. CANCELLED приходит ПЕРВЫМ (до delayed fill) — held reservation НЕ
    //    освобождается немедленно (TerminalSettlementPending), баланс не меняется.
    const updateResult = await makeUpdate().execute({
      update: { type: 'CANCELLED', orderId: ORDER_ID },
      accountId: ACCOUNT_ID,
    });
    expect(updateResult.ok).toBe(true);
    expect(store.hasTerminalSettlementPendingForOrder(ORDER_ID)).toBe(true);
    expect(balanceOf()).toEqual({ available: 935, reserved: 65 });

    // 3. Settle-резолвер: venue сообщает partial trade 50 @ 0.65 (delayed fill).
    //    Fill применяется held-reservation path: available НЕ трогается, только
    //    reserved уменьшается на потреблённую часть (32.5).
    const settleResult = await makeSettle([makeTradeSnapshot('50')]).execute({ accountId: ACCOUNT_ID });
    expect(settleResult.ok).toBe(true);
    if (settleResult.ok) expect(settleResult.value).toMatchObject({ scanned: 1, settled: 1, kept: 0, escalated: 0 });

    // 4. После settlement: fill потреблён (reserved 65→32.5 held, затем remaining
    //    32.5 освобождён в available) → available=967.5, reserved=0, position=50.
    expect(balanceOf()).toEqual({ available: 967.5, reserved: 0 });
    const finalPortfolio = realPortfolioStore.get(ACCOUNT_ID)!;
    expect(finalPortfolio.getPosition(INSTRUMENT_ID)?.quantity.value().toNumber()).toBeCloseTo(50, 6);

    // 5. Journal: SETTLED, remaining=0; block снят.
    const record = await submissions.get(CLIENT_ID);
    expect(record?.reservation).toMatchObject({ status: 'SETTLED', remaining: '0', consumed: '32.5', released: '32.5' });
    expect(store.hasTerminalSettlementPendingForOrder(ORDER_ID)).toBe(false);
  });
});
