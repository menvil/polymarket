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
  IKeyedMutex,
  IPortfolioStore,
  IOrderedEventOutbox,
  VenueTradeSnapshot,
} from '@polymarket/ports';
import { ExchangeError } from '@polymarket/ports';
import type { AccountId, AssetId, FillId, InstrumentId, MarketId, OrderId } from '@polymarket/ids';
import type { Portfolio, IPosition } from '@polymarket/portfolio';
import type { Fill } from '@polymarket/fill';
import { Order } from '@polymarket/order';
import { Price, Quantity } from '@polymarket/value-objects';
import { UpdateOrderStatusUseCase } from '../../src/UpdateOrderStatusUseCase.js';
import { ProcessFillUseCase } from '../../src/ProcessFillUseCase.js';
import { SettleTerminalOrdersUseCase } from '../../src/SettleTerminalOrdersUseCase.js';
import { PortfolioService } from '../../src/services/PortfolioService.js';
import { LedgerService } from '../../src/services/LedgerService.js';
import { InMemoryOrderRepository } from '../../../../infrastructure/in-memory/src/InMemoryOrderRepository.js';
import { InMemoryOrderSubmissionRepository } from '../../../../infrastructure/in-memory/src/InMemoryOrderSubmissionRepository.js';
import { InMemoryOrderedEventOutbox } from '../../../../infrastructure/in-memory/src/InMemoryOrderedEventOutbox.js';
import { InMemoryProcessedFillRepository } from '../../../../infrastructure/in-memory/src/InMemoryProcessedFillRepository.js';

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
    publish: jest.fn<IEventBus['publish']>().mockResolvedValue(undefined),
    publishAll: jest.fn<IEventBus['publishAll']>().mockResolvedValue(undefined),
    subscribe: jest.fn<IEventBus['subscribe']>().mockReturnValue(() => {}),
  };
}

function makeOutbox(bus: IEventBus): IOrderedEventOutbox {
  return new InMemoryOrderedEventOutbox({
    publish: (events) => bus.publishAll(events as Parameters<IEventBus['publishAll']>[0]),
    logger: makeLogger(),
  });
}

function makeKeyedMutex(): IKeyedMutex {
  return {
    runExclusive: jest.fn(<T>(_keys: readonly string[], fn: () => Promise<T>) => fn()) as unknown as IKeyedMutex['runExclusive'],
  };
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

function makeTradeSnapshot(size = '50'): VenueTradeSnapshot {
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
    status: 'CONFIRMED',
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
    processFill = new ProcessFillUseCase({
      orderStateStore: store,
      portfolioService,
      ledgerService,
      orderRepo: store,
      processedFillRepo,
      keyedMutex: makeKeyedMutex(),
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
      keyedMutex: makeKeyedMutex(),
      orderedEventOutbox: makeOutbox(eventBus),
      submissions,
      logger,
      clock,
    });
  }

  function makeSettle(
    trades: readonly VenueTradeSnapshot[],
    opts: { tradesOk?: boolean } = {},
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
      keyedMutex: makeKeyedMutex(),
      clock,
      logger,
    });
  }

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
