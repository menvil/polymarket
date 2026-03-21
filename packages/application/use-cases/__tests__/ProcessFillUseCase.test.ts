import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ProcessFillUseCase } from '../src/ProcessFillUseCase.js';
import { PortfolioService } from '../src/services/PortfolioService.js';
import { LedgerService } from '../src/services/LedgerService.js';
import type { ProcessFillDeps } from '../src/ProcessFillUseCase.js';
import type { ILogger } from '@polymarket/logger';
import type { IEventBus } from '@polymarket/event-bus';
import type { IOrderRepository, IPortfolioStore, IProcessedFillRepository, IOrderStateStore } from '@polymarket/ports';
import type { Portfolio, IPosition } from '@polymarket/portfolio';
import type { AccountId, AssetId, FillId, InstrumentId, OrderId, VenueId, MarketId } from '@polymarket/ids';
import type { Fill, FillParams } from '@polymarket/fill';
import { Price, Quantity } from '@polymarket/value-objects';
import { Ok } from '@polymarket/result';
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

function makePrice(val: string): Price {
  return Price.of(new Decimal(val));
}

function makeQty(val: string): Quantity {
  return Quantity.of(new Decimal(val));
}

const ACCOUNT_ID = 'acc-001' as unknown as AccountId;
// AssetId как структурный объект для корректной работы assetIdToString
const ASSET_ID = { type: 'POLYMARKET_CTF_TOKEN', tokenId: 'token-abc' } as unknown as AssetId;
const ORDER_ID = 'order-1' as unknown as OrderId;
const FILL_ID = 'fill-1' as unknown as FillId;
const VENUE_ID = 'POLYMARKET' as unknown as VenueId;
const MARKET_ID = 'market-1' as unknown as MarketId;

/** Создаёт мок Fill для тестов */
function makeFill(overrides: Partial<FillParams> = {}): Fill {
  return {
    id: FILL_ID,
    orderId: ORDER_ID,
    accountId: ACCOUNT_ID,
    venueId: VENUE_ID,
    marketId: MARKET_ID,
    tokenId: ASSET_ID,
    settlementAssetId: 'USDC' as unknown as AssetId,
    price: makePrice('0.65'),
    size: makeQty('50'),
    side: 'BUY',
    timestamp: { value: () => new Decimal(1000), toNumber: () => 1000 } as never,
    fee: { amount: { value: () => new Decimal(0) }, asset: 'USDC' as unknown as AssetId, isZero: () => true } as never,
    hasFee: () => false,
    getSignedQuantity: () => ({ asset: ASSET_ID, amount: new Decimal('50') }),
    getCashFlow: () => ({ asset: 'USDC' as unknown as AssetId, amount: new Decimal('-32.5') }),
    getFeeFlow: () => ({ asset: 'USDC' as unknown as AssetId, amount: new Decimal(0) }),
    getNetCashFlow: () => ({ asset: 'USDC' as unknown as AssetId, amount: new Decimal('-32.5') }),
    getNotional: () => ({ asset: 'USDC' as unknown as AssetId, amount: new Decimal('32.5') }),
    ...overrides,
  } as unknown as Fill;
}

function makeOrderOpen(): Order {
  const result = Order.create({
    id: ORDER_ID,
    asset: ASSET_ID,
    side: 'BUY',
    price: makePrice('0.65') as never,
    size: makeQty('100') as never,
    timestamp: { value: () => new Decimal(1000), toNumber: () => 1000, toISO: () => '2024-01-01T00:00:00.000Z' } as never,
  });
  if (!result.ok) throw new Error('Failed to create Order');
  const accepted = result.value.accept();
  if (!accepted.ok) throw new Error('Failed to accept Order');
  accepted.value.pullEvents(); // clear events
  return accepted.value;
}

function makePortfolioMock(): Portfolio {
  const p: Portfolio = {
    accountId: ACCOUNT_ID,
    balance: {
      available: () => ({ value: () => new Decimal('10000') }),
      reserved: () => ({ value: () => new Decimal(0) }),
      total: () => ({ value: () => new Decimal('10000') }),
    },
    version: 0,
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

  // mock вернёт сам себя при applyDebit (side effect: позиция обновилась)
  (p.applyDebit as ReturnType<typeof jest.fn>).mockReturnValue(Ok(p));
  (p.applyCredit as ReturnType<typeof jest.fn>).mockReturnValue(Ok(p));
  (p.applyDirectDebit as ReturnType<typeof jest.fn>).mockReturnValue(Ok(p));
  (p.upsertPosition as ReturnType<typeof jest.fn>).mockReturnValue(p);
  (p.reserveTokensForOrder as ReturnType<typeof jest.fn>).mockReturnValue(Ok(p));
  (p.releaseTokenReservation as ReturnType<typeof jest.fn>).mockReturnValue(Ok(p));
  return p;
}

function makePortfolioStore(portfolio?: Portfolio): IPortfolioStore {
  const p = portfolio ?? makePortfolioMock();
  return {
    get: jest.fn<IPortfolioStore['get']>().mockReturnValue(p),
    save: jest.fn<IPortfolioStore['save']>().mockReturnValue(Ok(undefined)),
  };
}

function makeOrderRepo(order?: Order): IOrderRepository {
  return {
    get: jest.fn().mockImplementation(() => Promise.resolve(order)) as unknown as IOrderRepository['get'],
    save: jest.fn().mockImplementation(() => Promise.resolve()) as unknown as IOrderRepository['save'],
    delete: jest.fn().mockImplementation(() => Promise.resolve()) as unknown as IOrderRepository['delete'],
    getByStrategyId: jest.fn().mockImplementation(() => Promise.resolve([])) as unknown as IOrderRepository['getByStrategyId'],
    countByStrategyId: jest.fn().mockImplementation(() => Promise.resolve(0)) as unknown as IOrderRepository['countByStrategyId'],
    getAll: jest.fn().mockImplementation(() => Promise.resolve([])) as unknown as IOrderRepository['getAll'],
    getByMarketId: jest.fn().mockImplementation(() => Promise.resolve([])) as unknown as IOrderRepository['getByMarketId'],
  };
}

function makeOrderStateStore(order?: Order): IOrderStateStore {
  return {
    getOrder: jest.fn<IOrderStateStore['getOrder']>().mockReturnValue(order),
    saveSync: jest.fn<IOrderStateStore['saveSync']>(),
    getOpenOrders: jest.fn<IOrderStateStore['getOpenOrders']>().mockReturnValue([]),
    getOpenOrdersByInstrument: jest.fn<IOrderStateStore['getOpenOrdersByInstrument']>().mockReturnValue([]),
    markMatchedOnExchange: jest.fn<IOrderStateStore['markMatchedOnExchange']>(),
    clearMatchedOnExchange: jest.fn<IOrderStateStore['clearMatchedOnExchange']>(),
    isMatchedOnExchange: jest.fn<IOrderStateStore['isMatchedOnExchange']>().mockReturnValue(false),
    markInFlightFill: jest.fn<IOrderStateStore['markInFlightFill']>(),
    hasInFlightFills: jest.fn<IOrderStateStore['hasInFlightFills']>().mockReturnValue(false),
    clearInFlightFills: jest.fn<IOrderStateStore['clearInFlightFills']>(),
  };
}

function makeProcessedFillRepo(isNew = true): IProcessedFillRepository {
  return {
    markIfNotExists: jest.fn<IProcessedFillRepository['markIfNotExists']>().mockResolvedValue(isNew),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ProcessFillUseCase', () => {
  let logger: ILogger;
  let eventBus: IEventBus;
  let orderRepo: IOrderRepository;
  let orderStateStore: IOrderStateStore;
  let portfolioStore: IPortfolioStore;
  let processedFillRepo: IProcessedFillRepository;
  let deps: ProcessFillDeps;

  beforeEach(() => {
    logger = makeLogger();
    eventBus = makeEventBus();
    const order = makeOrderOpen();
    orderRepo = makeOrderRepo(order);
    orderStateStore = makeOrderStateStore(order);
    portfolioStore = makePortfolioStore();
    processedFillRepo = makeProcessedFillRepo(true);

    const portfolioService = new PortfolioService(portfolioStore, logger);
    const ledgerService = new LedgerService(logger);

    deps = {
      orderStateStore,
      portfolioService,
      ledgerService,
      orderRepo,
      processedFillRepo,
      eventBus,
      logger,
    };
  });

  // ── Успешный сценарий ─────────────────────────────────────────────────────

  it('возвращает Ok(void) при успешной обработке fill', async () => {
    const useCase = new ProcessFillUseCase(deps);
    const result = await useCase.execute(makeFill());
    expect(result.ok).toBe(true);
  });

  it('обновляет ордер в хранилище (saveSync)', async () => {
    const useCase = new ProcessFillUseCase(deps);
    await useCase.execute(makeFill());
    expect(orderStateStore.saveSync).toHaveBeenCalled();
  });

  it('публикует события', async () => {
    const useCase = new ProcessFillUseCase(deps);
    await useCase.execute(makeFill());
    expect(eventBus.publishAll).toHaveBeenCalled();
  });

  it('логирует info при успешной обработке', async () => {
    const useCase = new ProcessFillUseCase(deps);
    await useCase.execute(makeFill());
    expect(logger.info).toHaveBeenCalledWith('Fill processed successfully', expect.any(Object));
  });

  it('снимает флаг isMatchedOnExchange после обработки fill', async () => {
    const useCase = new ProcessFillUseCase(deps);
    await useCase.execute(makeFill());
    expect(orderStateStore.clearMatchedOnExchange).toHaveBeenCalledWith(ORDER_ID);
  });

  // ── Idempotency ──────────────────────────────────────────────────────────

  it('возвращает Ok(void) при дублирующемся fill (idempotency)', async () => {
    processedFillRepo = makeProcessedFillRepo(false); // fill уже обработан
    const useCase = new ProcessFillUseCase({ ...deps, processedFillRepo });
    const result = await useCase.execute(makeFill());
    expect(result.ok).toBe(true);
  });

  it('не обновляет ордер при дублирующемся fill', async () => {
    processedFillRepo = makeProcessedFillRepo(false);
    const useCase = new ProcessFillUseCase({ ...deps, processedFillRepo });
    await useCase.execute(makeFill());
    expect(orderRepo.save).not.toHaveBeenCalled();
  });

  // ── Order не найден ───────────────────────────────────────────────────────

  it('возвращает Ok если ордер не найден (только ledger)', async () => {
    // Ордер не найден — fill записывается в ledger, portfolio корректируется reconciler'ом
    orderRepo = makeOrderRepo(undefined);
    const directOrderStateStore = makeOrderStateStore(undefined);
    const useCase = new ProcessFillUseCase({ ...deps, orderStateStore: directOrderStateStore, orderRepo });
    const result = await useCase.execute(makeFill());
    expect(result.ok).toBe(true);
  });

  it('снимает флаг isMatchedOnExchange в direct fill path (ордер не найден)', async () => {
    orderRepo = makeOrderRepo(undefined);
    const directOrderStateStore = makeOrderStateStore(undefined);
    const useCase = new ProcessFillUseCase({ ...deps, orderStateStore: directOrderStateStore, orderRepo });
    await useCase.execute(makeFill());
    expect(directOrderStateStore.clearMatchedOnExchange).toHaveBeenCalledWith(ORDER_ID);
  });

  // ── Portfolio не найден ───────────────────────────────────────────────────

  it('возвращает Err если portfolio не найден', async () => {
    const emptyStore: IPortfolioStore = {
      get: jest.fn<IPortfolioStore['get']>().mockReturnValue(undefined),
      save: jest.fn<IPortfolioStore['save']>().mockReturnValue(Ok(undefined)),
    };
    const portfolioService = new PortfolioService(emptyStore, logger);
    const useCase = new ProcessFillUseCase({ ...deps, portfolioService });
    const result = await useCase.execute(makeFill());
    expect(result.ok).toBe(false);
  });

  // ── SELL fill ─────────────────────────────────────────────────────────────

  it('обрабатывает SELL fill корректно', async () => {
    const sellFill = makeFill({ side: 'SELL' } as never);
    const sellOrder = (() => {
      const r = Order.create({
        id: ORDER_ID,
        asset: ASSET_ID,
        side: 'SELL',
        price: makePrice('0.65') as never,
        size: makeQty('100') as never,
        timestamp: { value: () => new Decimal(1000), toNumber: () => 1000, toISO: () => '2024-01-01T00:00:00.000Z' } as never,
      });
      if (!r.ok) throw new Error('Cannot create Order');
      const accepted = r.value.accept();
      if (!accepted.ok) throw new Error('Cannot accept Order');
      accepted.value.pullEvents();
      return accepted.value;
    })();

    // Для SELL необходима существующая позиция в Portfolio
    const sellPortfolioMock: Portfolio = {
      ...makePortfolioMock(),
      getPosition: jest.fn<Portfolio['getPosition']>().mockReturnValue({
        instrumentId: ASSET_ID as unknown as InstrumentId,
        quantity: makeQty('100'),
        averageEntryPrice: makePrice('0.65'),
        side: 'LONG',
        isClosed: () => false,
      } as never),
    } as unknown as Portfolio;
    (sellPortfolioMock.applyCredit as ReturnType<typeof jest.fn>).mockReturnValue(Ok(sellPortfolioMock));
    (sellPortfolioMock.upsertPosition as ReturnType<typeof jest.fn>).mockReturnValue(sellPortfolioMock);
    const sellPortfolioStore = makePortfolioStore(sellPortfolioMock);
    const sellPortfolioService = new PortfolioService(sellPortfolioStore, logger);

    orderRepo = makeOrderRepo(sellOrder);
    const useCase = new ProcessFillUseCase({ ...deps, orderStateStore: makeOrderStateStore(sellOrder), orderRepo, portfolioService: sellPortfolioService });
    const result = await useCase.execute(sellFill);
    expect(result.ok).toBe(true);
  });
});
