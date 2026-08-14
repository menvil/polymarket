import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { MessageMetadataGenerator } from '@polymarket/messages';
import { unsafeRunId as unsafeRunIdM003 } from '@polymarket/ids';
import { UpdateOrderStatusUseCase } from '../src/UpdateOrderStatusUseCase.js';
import { PortfolioService } from '../src/services/PortfolioService.js';
import type { UpdateOrderStatusDeps } from '../src/UpdateOrderStatusUseCase.js';
import type { ILogger } from '@polymarket/logger';
import type { IEventBus } from '@polymarket/event-bus';
import type {
  IOrderRepository,
  IPortfolioStore,
  IOrderStateStore,
  IKeyedMutex,
  IReconciliationIssueRepository,
  IOrderedEventOutbox,
} from '@polymarket/ports';
import { VersionConflictError } from '@polymarket/ports';
import { InMemoryOrderedEventOutbox } from '../../../infrastructure/in-memory/src/InMemoryOrderedEventOutbox.js';
import { InMemoryOrderSubmissionRepository } from '../../../infrastructure/in-memory/src/InMemoryOrderSubmissionRepository.js';
import type { Portfolio, IPosition } from '@polymarket/portfolio';
import type { AccountId, OrderId } from '@polymarket/ids';
import { asPolymarketCtfToken, accountIdToString } from '@polymarket/ids';
import { Price, Quantity } from '@polymarket/value-objects';
import { Ok, Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';
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
    publish: jest.fn<IEventBus['publish']>().mockResolvedValue(Ok(undefined)),
    publishAll: jest.fn<IEventBus['publishAll']>().mockResolvedValue(Ok(undefined)),
    subscribe: jest.fn<IEventBus['subscribe']>().mockReturnValue(() => {}),
  };
}

/** Реальный ordered outbox → публикует в eventBus на flush (assertions на publishAll живут). */
function makeOutbox(
  eventBus: IEventBus,
  reconciliationIssues?: IReconciliationIssueRepository,
): IOrderedEventOutbox {
  return new InMemoryOrderedEventOutbox({
    publish: async (events) => {
      const result = await eventBus.publishAll(events as Parameters<IEventBus['publishAll']>[0]);
      if (!result.ok) throw result.error;
    },
    logger: makeLogger(),
    reconciliationIssues,
  });
}

// Fake keyed mutex — сразу выполняет callback (single-thread тест).
function makeKeyedMutex(): IKeyedMutex {
  return {
    runExclusive: jest.fn(<T>(_keys: readonly string[], fn: () => Promise<T>) => fn()) as unknown as IKeyedMutex['runExclusive'],
  };
}

const ACCOUNT_ID = 'acc-001' as unknown as AccountId;
// Структурный AssetId (CTF token) — use case вызывает assetIdToInstrumentId(order.asset)
const ASSET_ID = asPolymarketCtfToken('123')!;
const ORDER_ID = 'order-1' as unknown as OrderId;
const MOCK_TIMESTAMP = { value: () => new Decimal(1000), toNumber: () => 1000, toISO: () => '' } as never;

function makeOpenOrder(id: OrderId = ORDER_ID, side: 'BUY' | 'SELL' = 'BUY'): Order {
  const result = Order.create({
    id,
    asset: ASSET_ID,
    side,
    price: Price.of(new Decimal('0.65')) as never,
    size: Quantity.of(new Decimal('100')) as never,
    timestamp: MOCK_TIMESTAMP,
  });
  if (!result.ok) throw result.error;
  const accepted = result.value.accept();
  if (!accepted.ok) throw accepted.error;
  accepted.value.pullEvents(() => makeMetadataGenerator().nextRoot());
  return accepted.value;
}

function makeOrderRepo(order: Order | undefined): IOrderRepository {
  return {
    get: jest.fn<IOrderRepository['get']>().mockResolvedValue(order),
    getVersion: jest.fn<IOrderRepository['getVersion']>().mockResolvedValue(order ? 1 : 0),
    getWithVersion: jest.fn<IOrderRepository['getWithVersion']>().mockResolvedValue(
      order ? { order, version: 1 } : undefined,
    ),
    save: jest.fn<IOrderRepository['save']>().mockResolvedValue(Ok(undefined)),
    deleteIfVersion: jest.fn<IOrderRepository['deleteIfVersion']>().mockResolvedValue(Ok({ status: 'DELETED' })),
    deleteIfState: jest.fn<IOrderRepository['deleteIfState']>().mockResolvedValue(Ok({ status: 'DELETED' })),
    getAll: jest.fn<IOrderRepository['getAll']>().mockResolvedValue([]),
    clear: jest.fn(),
  } as unknown as IOrderRepository;
}

function makeOrderStateStore(storedOrder?: Order): IOrderStateStore {
  return {
    getOrder: jest.fn().mockReturnValue(storedOrder),
    hasMatchedFills: jest.fn().mockReturnValue(false),
    markOrderFillMatched: jest.fn(),
    clearOrderFillMatched: jest.fn(),
    getMatchedFillIds: jest.fn().mockReturnValue([]),
    getOpenOrdersByInstrument: jest.fn().mockReturnValue([]),
    hasInFlightFills: jest.fn().mockReturnValue(false),
    clearInFlightFill: jest.fn(),
    markInFlightFill: jest.fn(),
    getInFlightFills: jest.fn().mockReturnValue([]),
    markManualReconciliationBlock: jest.fn(),
    clearManualReconciliationBlock: jest.fn(),
    hasManualReconciliationBlockForOrder: jest.fn().mockReturnValue(false),
    hasManualReconciliationBlocks: jest.fn().mockReturnValue(false),
    getManualReconciliationBlocks: jest.fn().mockReturnValue([]),
    markTerminalSettlementPending: jest.fn(),
    clearTerminalSettlementPending: jest.fn(),
    hasTerminalSettlementPendingForOrder: jest.fn().mockReturnValue(false),
    hasTerminalSettlementPending: jest.fn().mockReturnValue(false),
    getTerminalSettlementPending: jest.fn().mockReturnValue([]),
  } as unknown as IOrderStateStore;
}

function makePortfolioStore(): IPortfolioStore {
  const portfolio = {
    accountId: ACCOUNT_ID,
    balance: {
      reserved: new Decimal(0),
      available: new Decimal(1000),
    },
    positions: new Map() as ReadonlyMap<string, IPosition>,
    version: 0,
  } as unknown as Portfolio;
  // Release теперь вызывается после успешного CAS save (см. UpdateOrderStatusUseCase шаг 5)
  (portfolio as { releaseReservation?: unknown }).releaseReservation =
    jest.fn().mockReturnValue(Ok(portfolio));
  (portfolio as { releaseTokenReservation?: unknown }).releaseTokenReservation =
    jest.fn().mockReturnValue(Ok(portfolio));

  return {
    get: jest.fn<IPortfolioStore['get']>().mockReturnValue(portfolio),
    save: jest.fn<IPortfolioStore['save']>().mockReturnValue(Ok(undefined)),
    getVersion: jest.fn<IPortfolioStore['getVersion']>().mockReturnValue(0),
  };
}

function makeReconciliationIssueRepo(): IReconciliationIssueRepository {
  return {
    add: jest.fn<IReconciliationIssueRepository['add']>().mockResolvedValue(undefined),
    listOpen: jest.fn<IReconciliationIssueRepository['listOpen']>().mockResolvedValue([]),
    get: jest.fn<IReconciliationIssueRepository['get']>().mockResolvedValue(undefined),
    markResolved: jest.fn<IReconciliationIssueRepository['markResolved']>().mockResolvedValue(undefined),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────


/** Детерминированный canonical-генератор metadata для тестовых deps (M-003). */
function makeMetadataGenerator(): MessageMetadataGenerator {
  return new MessageMetadataGenerator({
    clock: { now: () => new Date('2024-01-01T00:00:00.000Z') },
    runId: unsafeRunIdM003('testrun1'),
  });
}

describe('UpdateOrderStatusUseCase', () => {
  let logger: ILogger;
  let eventBus: IEventBus;
  let portfolioStore: IPortfolioStore;
  let orderRepo: IOrderRepository;
  let orderStateStore: IOrderStateStore;
  let portfolioService: PortfolioService;
  let orderedEventOutbox: IOrderedEventOutbox;
  let submissions: InMemoryOrderSubmissionRepository;
  let deps: UpdateOrderStatusDeps;

  beforeEach(() => {
    logger = makeLogger();
    eventBus = makeEventBus();
    portfolioStore = makePortfolioStore();
    portfolioService = new PortfolioService(portfolioStore, logger);
    orderedEventOutbox = makeOutbox(eventBus);
    submissions = new InMemoryOrderSubmissionRepository();
  });

  it('возвращает Ok(void) если ордер не найден (не крашит)', async () => {
    orderRepo = makeOrderRepo(undefined);
    orderStateStore = makeOrderStateStore();
    deps = { metadataGenerator: makeMetadataGenerator(), orderRepo, orderStateStore, portfolioService, keyedMutex: makeKeyedMutex(), orderedEventOutbox, submissions, logger };
    const useCase = new UpdateOrderStatusUseCase(deps);
    const result = await useCase.execute({ update: { type: 'ACCEPTED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });
    expect(result.ok).toBe(true);
  });

  // ── Venue update до локального save Order ───────────────────────────────────

  describe('venue update без локального order', () => {
    // Теперь ВСЕ типы update (включая ACCEPTED) создают reconciliation issue:
    // ACCEPTED без локального Order — это тоже desync (venue принял ордер, а
    // локальной записи нет), а не benign race.
    for (const updateType of ['ACCEPTED', 'CANCELLED', 'REJECTED', 'EXPIRED'] as const) {
      it(`${updateType} без локального order → VENUE_LOCAL_ORDER_DESYNC issue, Ok`, async () => {
        orderRepo = makeOrderRepo(undefined);
        orderStateStore = makeOrderStateStore();
        const reconciliationIssues = makeReconciliationIssueRepo();
        deps = {
          metadataGenerator: makeMetadataGenerator(),
          orderRepo, orderStateStore, portfolioService,
          keyedMutex: makeKeyedMutex(), orderedEventOutbox, submissions, logger, reconciliationIssues,
        };
        const useCase = new UpdateOrderStatusUseCase(deps);

        const update = updateType === 'REJECTED'
          ? ({ type: 'REJECTED', orderId: ORDER_ID, reason: 'bad price' } as const)
          : ({ type: updateType, orderId: ORDER_ID } as const);
        const result = await useCase.execute({ update, accountId: ACCOUNT_ID });

        // Update handler не должен бесконечно retry-ить — Ok.
        expect(result.ok).toBe(true);
        expect(reconciliationIssues.add).toHaveBeenCalledTimes(1);
        const issue = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls[0]?.[0] as {
          id: string; type: string; reason: string; orderId: unknown; accountId: unknown;
          context?: Record<string, unknown>;
        };
        expect(issue.id).toBe(
          `reconciliation:order-update:${String(ORDER_ID)}:update-without-local-order:${updateType}`,
        );
        expect(issue.type).toBe('VENUE_LOCAL_ORDER_DESYNC');
        expect(issue.reason).toContain(`VENUE_ORDER_UPDATE_WITHOUT_LOCAL_ORDER:${updateType}`);
        expect(issue.orderId).toBe(ORDER_ID);
        expect(issue.accountId).toBe(ACCOUNT_ID);
        expect(issue.context).toMatchObject({
          stage: 'venue-update-order-not-found-under-lock',
          updateType,
        });
      });
    }

    it('update выполняется через keyedMutex с namespaced ключами [account, order]', async () => {
      orderRepo = makeOrderRepo(makeOpenOrder());
      orderStateStore = makeOrderStateStore(makeOpenOrder());
      const keyedMutex = makeKeyedMutex();
      deps = { metadataGenerator: makeMetadataGenerator(), orderRepo, orderStateStore, portfolioService, keyedMutex, orderedEventOutbox, submissions, logger };
      const useCase = new UpdateOrderStatusUseCase(deps);

      await useCase.execute({ update: { type: 'CANCELLED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });

      const keys = (keyedMutex.runExclusive as ReturnType<typeof jest.fn>).mock.calls[0]?.[0] as string[];
      // order-ключ в namespaced-форме `order:<id>`.
      expect(keys).toContain(`order:${String(ORDER_ID)}`);
      // account-ключ в namespaced-форме `account:<accountIdToString>` — обязан
      // пересекаться с PlaceOrderUseCase lock-набором (тот тоже namespace-ит).
      expect(keys).toContain(`account:${accountIdToString(ACCOUNT_ID)}`);
    });
  });

  it('ACCEPTED → сохраняет Order и публикует события', async () => {
    // Order уже OPEN — нужен PENDING order для ACCEPTED
    const pendingResult = Order.create({
      id: ORDER_ID,
      asset: ASSET_ID,
      side: 'BUY',
      price: Price.of(new Decimal('0.65')) as never,
      size: Quantity.of(new Decimal('100')) as never,
      timestamp: MOCK_TIMESTAMP,
    });
    if (!pendingResult.ok) throw pendingResult.error;
    const pendingOrder = pendingResult.value;
    pendingOrder.pullEvents(() => makeMetadataGenerator().nextRoot());

    orderRepo = makeOrderRepo(pendingOrder);
    orderStateStore = makeOrderStateStore(pendingOrder);
    deps = { metadataGenerator: makeMetadataGenerator(), orderRepo, orderStateStore, portfolioService, keyedMutex: makeKeyedMutex(), orderedEventOutbox, submissions, logger };
    const useCase = new UpdateOrderStatusUseCase(deps);
    const result = await useCase.execute({ update: { type: 'ACCEPTED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });

    expect(result.ok).toBe(true);
    expect(orderRepo.save).toHaveBeenCalled();
    expect(eventBus.publishAll).toHaveBeenCalled();
  });

  it('CANCELLED на OPEN ордере → Ok(void), save вызван', async () => {
    const order = makeOpenOrder();
    orderRepo = makeOrderRepo(order);
    orderStateStore = makeOrderStateStore(order);
    deps = { metadataGenerator: makeMetadataGenerator(), orderRepo, orderStateStore, portfolioService, keyedMutex: makeKeyedMutex(), orderedEventOutbox, submissions, logger };
    const useCase = new UpdateOrderStatusUseCase(deps);
    const result = await useCase.execute({ update: { type: 'CANCELLED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });

    expect(result.ok).toBe(true);
    expect(orderRepo.save).toHaveBeenCalled();
  });

  it('сбой publishAll на flush ПОСЛЕ успешного CAS save и release — Ok(undefined), не Err (committed update не retryable)', async () => {
    const order = makeOpenOrder();
    orderRepo = makeOrderRepo(order);
    orderStateStore = makeOrderStateStore(order);
    // Сбой публикации теперь проглатывается outbox на flush (ПОСЛЕ lock).
    const failingBus = makeEventBus();
    (failingBus.publishAll as ReturnType<typeof jest.fn>).mockRejectedValue(new Error('bus down') as never);
    const reconciliationIssues = makeReconciliationIssueRepo();
    deps = {
      metadataGenerator: makeMetadataGenerator(),
      orderRepo, orderStateStore, portfolioService, keyedMutex: makeKeyedMutex(),
      orderedEventOutbox: makeOutbox(failingBus, reconciliationIssues), submissions, logger,
    };
    const useCase = new UpdateOrderStatusUseCase(deps);

    const result = await useCase.execute({ update: { type: 'CANCELLED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });

    // Коммит уже состоялся: CAS save выполнен, release для CANCELLED выполнен —
    // потеря уведомления не откатывает их.
    expect(result.ok).toBe(true);
    expect(orderRepo.save).toHaveBeenCalled();
    expect(portfolioStore.save).toHaveBeenCalled();
    expect(failingBus.publishAll).toHaveBeenCalled();
    // Outbox создал EVENT_PUBLISH_FAILED issue.
    const issue = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls
      .map((c) => c[0] as { type: string })
      .find((i) => i.type === 'EVENT_PUBLISH_FAILED');
    expect(issue).toBeDefined();
  });

  it('REJECTED на PENDING ордере → Ok(void), save вызван И резервация освобождена', async () => {
    // Venue отклонил уже сохранённый локальный ордер — live-ордера нет,
    // без release резервация осталась бы замороженной навсегда.
    const pendingResult = Order.create({
      id: ORDER_ID,
      asset: ASSET_ID,
      side: 'BUY',
      price: Price.of(new Decimal('0.65')) as never,
      size: Quantity.of(new Decimal('100')) as never,
      timestamp: MOCK_TIMESTAMP,
    });
    if (!pendingResult.ok) throw pendingResult.error;
    const pendingOrder = pendingResult.value;
    pendingOrder.pullEvents(() => makeMetadataGenerator().nextRoot());

    orderRepo = makeOrderRepo(pendingOrder);
    orderStateStore = makeOrderStateStore(pendingOrder);
    deps = { metadataGenerator: makeMetadataGenerator(), orderRepo, orderStateStore, portfolioService, keyedMutex: makeKeyedMutex(), orderedEventOutbox, submissions, logger };
    const useCase = new UpdateOrderStatusUseCase(deps);

    const result = await useCase.execute({
      update: { type: 'REJECTED', orderId: ORDER_ID, reason: 'insufficient funds' },
      accountId: ACCOUNT_ID,
    });

    expect(result.ok).toBe(true);
    expect(orderRepo.save).toHaveBeenCalled();
    const portfolio = (portfolioStore.get as jest.Mock)(ACCOUNT_ID) as Portfolio;
    expect(portfolio.releaseReservation).toHaveBeenCalledTimes(1);
  });

  // ── Шаг 5: терминальный update с held journal → settlement DEFERRED ─────────
  it('CANCELLED с held journal → резервация НЕ освобождается, ставится TerminalSettlementPending (delayed-fill race guard)', async () => {
    const order = makeOpenOrder();
    orderRepo = makeOrderRepo(order);
    orderStateStore = makeOrderStateStore(order);
    // Seed held reservation под venueOrderId=ORDER_ID.
    const CLIENT = 'client-1' as unknown as OrderId;
    await submissions.begin({
      clientOrderId: CLIENT, accountId: ACCOUNT_ID, instrumentId: '123' as never,
      fingerprint: 'fp', side: 'BUY', orderPrice: '0.65', requestedSize: '100', now: new Date(),
    });
    await submissions.markReservationHeld(CLIENT, '65', new Date());
    await submissions.markVenueAccepted(CLIENT, ORDER_ID, new Date());

    deps = { metadataGenerator: makeMetadataGenerator(), orderRepo, orderStateStore, portfolioService, keyedMutex: makeKeyedMutex(), orderedEventOutbox, submissions, logger };
    const useCase = new UpdateOrderStatusUseCase(deps);
    const result = await useCase.execute({ update: { type: 'CANCELLED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });

    expect(result.ok).toBe(true);
    // Капитал НЕ освобождён (partial fill мог произойти на venue раньше update):
    // available не должен завыситься до разрешения delayed-fill окна.
    const portfolio = (portfolioStore.get as jest.Mock)(ACCOUNT_ID) as Portfolio;
    expect(portfolio.releaseReservation).not.toHaveBeenCalled();
    const record = await submissions.get(CLIENT);
    expect(record?.reservation).toMatchObject({ remaining: '65', status: 'HELD' });
    // Поставлен авто-разрешаемый settlement pending (блокирует Place/strategy,
    // но не ProcessFill); pending cancel marker НЕ снят.
    expect(orderStateStore.markTerminalSettlementPending).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER_ID, venueStatus: 'CANCELLED' }),
    );
    expect(orderStateStore.clearInFlightFill).not.toHaveBeenCalled();
  });

  it('сбой release после committed venue update → Ok, ORDER_PORTFOLIO_DESYNC issue создана', async () => {
    const order = makeOpenOrder();
    orderRepo = makeOrderRepo(order);
    orderStateStore = makeOrderStateStore(order);
    // Пустой portfolio store → releaseOrderReservation вернёт Err('Portfolio not found').
    const emptyPortfolioStore: IPortfolioStore = {
      get: jest.fn<IPortfolioStore['get']>().mockReturnValue(undefined),
      save: jest.fn<IPortfolioStore['save']>().mockReturnValue(Ok(undefined)),
      getVersion: jest.fn<IPortfolioStore['getVersion']>().mockReturnValue(0),
    };
    const failingPortfolioService = new PortfolioService(emptyPortfolioStore, logger);
    const reconciliationIssues = makeReconciliationIssueRepo();
    deps = {
      metadataGenerator: makeMetadataGenerator(),
      orderRepo,
      orderStateStore,
      portfolioService: failingPortfolioService,
      keyedMutex: makeKeyedMutex(),
      orderedEventOutbox,
      submissions,
      logger,
      reconciliationIssues,
    };
    const useCase = new UpdateOrderStatusUseCase(deps);

    const result = await useCase.execute({ update: { type: 'CANCELLED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });

    // Update уже committed (CAS save) — сбой release НЕ делает его retryable Err.
    expect(result.ok).toBe(true);
    expect(orderRepo.save).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('VENUE_UPDATE_RESERVATION_RELEASE_FAILED'),
      expect.objectContaining({ orderId: String(ORDER_ID), updateType: 'CANCELLED' }),
    );
    expect(reconciliationIssues.add).toHaveBeenCalledTimes(1);
    const issue = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls[0]?.[0] as {
      id: string;
      type: string;
      reason: string;
      context?: Record<string, unknown>;
    };
    expect(issue.id).toBe(`reconciliation:order-update:${String(ORDER_ID)}:reservation-release-failed`);
    expect(issue.type).toBe('ORDER_PORTFOLIO_DESYNC');
    expect(issue.reason).toContain('VENUE_UPDATE_RESERVATION_RELEASE_FAILED');
    expect(issue.context).toMatchObject({
      stage: 'venue-update-release-reservation-after-order-save',
      updateType: 'CANCELLED',
    });
    // События всё равно публикуются — update committed.
    expect(eventBus.publishAll).toHaveBeenCalled();
  });

  it('CANCELLED на уже CANCELED ордере → Ok(void), idempotent (save не вызван)', async () => {
    const order = makeOpenOrder();
    const cancelResult = order.cancel();
    if (!cancelResult.ok) throw cancelResult.error;
    const cancelledOrder = cancelResult.value;
    cancelledOrder.pullEvents(() => makeMetadataGenerator().nextRoot());

    orderRepo = makeOrderRepo(cancelledOrder);
    orderStateStore = makeOrderStateStore(cancelledOrder);
    deps = { metadataGenerator: makeMetadataGenerator(), orderRepo, orderStateStore, portfolioService, keyedMutex: makeKeyedMutex(), orderedEventOutbox, submissions, logger };
    const useCase = new UpdateOrderStatusUseCase(deps);
    const result = await useCase.execute({ update: { type: 'CANCELLED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });

    expect(result.ok).toBe(true);
    expect(orderRepo.save).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringMatching(/duplicate/i),
      expect.any(Object),
    );
  });

  it('ACCEPTED на терминальном ордере → Ok(void), логирует warn (cancel/fill race)', async () => {
    const order = makeOpenOrder();
    const cancelResult = order.cancel();
    if (!cancelResult.ok) throw cancelResult.error;
    const cancelledOrder = cancelResult.value;
    cancelledOrder.pullEvents(() => makeMetadataGenerator().nextRoot());

    orderRepo = makeOrderRepo(cancelledOrder);
    orderStateStore = makeOrderStateStore(cancelledOrder);
    deps = { metadataGenerator: makeMetadataGenerator(), orderRepo, orderStateStore, portfolioService, keyedMutex: makeKeyedMutex(), orderedEventOutbox, submissions, logger };
    const useCase = new UpdateOrderStatusUseCase(deps);
    const result = await useCase.execute({ update: { type: 'ACCEPTED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });

    expect(result.ok).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/already terminal/i),
      expect.any(Object),
    );
    expect(orderRepo.save).not.toHaveBeenCalled();
  });

  it('CAS conflict + latest несовместим (не терминален, не целевой статус) → Err, release/publish не вызваны', async () => {
    const order = makeOpenOrder();
    orderRepo = {
      ...makeOrderRepo(order),
      save: jest.fn<IOrderRepository['save']>().mockResolvedValue(
        Err(new VersionConflictError(String(ORDER_ID), 1, 2)),
      ),
      // reread возвращает всё тот же OPEN ордер — конфликт «неразрешим» здесь
      get: jest.fn<IOrderRepository['get']>().mockResolvedValue(order),
    } as unknown as IOrderRepository;
    orderStateStore = makeOrderStateStore(order);
    deps = { metadataGenerator: makeMetadataGenerator(), orderRepo, orderStateStore, portfolioService, keyedMutex: makeKeyedMutex(), orderedEventOutbox, submissions, logger };
    const useCase = new UpdateOrderStatusUseCase(deps);
    const result = await useCase.execute({ update: { type: 'CANCELLED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(TradingError);
    }
    expect(eventBus.publishAll).not.toHaveBeenCalled();
    const portfolio = (portfolioStore.get as jest.Mock)(ACCOUNT_ID) as Portfolio;
    expect(portfolio.releaseReservation).not.toHaveBeenCalled();
  });

  it('CAS conflict (concurrent fill): reread терминальный ордер → Ok, release/publish не вызваны', async () => {
    const order = makeOpenOrder();
    // Simulate: fill применился (saveSync) между чтением версии и CAS save → FILLED в repo
    const filledOrder = { ...order, status: 'FILLED', isTerminal: true } as unknown as Order;
    orderRepo = {
      ...makeOrderRepo(order), // getWithVersion (шаг 1) снимает snapshot ДО конфликта
      save: jest.fn<IOrderRepository['save']>().mockResolvedValue(
        Err(new VersionConflictError(String(ORDER_ID), 1, 2)),
      ),
      get: jest.fn<IOrderRepository['get']>().mockResolvedValue(filledOrder), // reread после конфликта
    } as unknown as IOrderRepository;
    orderStateStore = makeOrderStateStore(filledOrder);
    deps = { metadataGenerator: makeMetadataGenerator(), orderRepo, orderStateStore, portfolioService, keyedMutex: makeKeyedMutex(), orderedEventOutbox, submissions, logger };
    const useCase = new UpdateOrderStatusUseCase(deps);
    const result = await useCase.execute({ update: { type: 'CANCELLED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });

    expect(result.ok).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/version conflict/i),
      expect.any(Object),
    );
    expect(eventBus.publishAll).not.toHaveBeenCalled();
    const portfolio = (portfolioStore.get as jest.Mock)(ACCOUNT_ID) as Portfolio;
    expect(portfolio.releaseReservation).not.toHaveBeenCalled();
  });

  it('CAS conflict: latest уже в целевом статусе (дубль-событие) → Ok no-op', async () => {
    const order = makeOpenOrder();
    const cancelResult = order.cancel();
    if (!cancelResult.ok) throw cancelResult.error;
    const cancelledLatest = cancelResult.value;
    cancelledLatest.pullEvents(() => makeMetadataGenerator().nextRoot());

    const openOrder = makeOpenOrder();
    orderRepo = {
      ...makeOrderRepo(openOrder), // getWithVersion (шаг 1) снимает snapshot ДО конфликта
      save: jest.fn<IOrderRepository['save']>().mockResolvedValue(
        Err(new VersionConflictError(String(ORDER_ID), 1, 2)),
      ),
      get: jest.fn<IOrderRepository['get']>().mockResolvedValue(cancelledLatest), // reread: уже CANCELED
    } as unknown as IOrderRepository;
    orderStateStore = makeOrderStateStore(cancelledLatest);
    deps = { metadataGenerator: makeMetadataGenerator(), orderRepo, orderStateStore, portfolioService, keyedMutex: makeKeyedMutex(), orderedEventOutbox, submissions, logger };
    const useCase = new UpdateOrderStatusUseCase(deps);
    const result = await useCase.execute({ update: { type: 'CANCELLED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });

    expect(result.ok).toBe(true);
    expect(eventBus.publishAll).not.toHaveBeenCalled();
  });

  // ── Этап 6: terminal update × journal/Portfolio sync ─────────────────────────

  describe('terminal update sync (Этап 6)', () => {
    const CLIENT_ID = 'client-1' as unknown as OrderId;

    /** Seed журнала: held BUY-резервация под venueOrderId=ORDER_ID. */
    async function seedHeldJournal(initial = '65'): Promise<void> {
      await submissions.begin({
        clientOrderId: CLIENT_ID,
        accountId: ACCOUNT_ID,
        instrumentId: '123' as unknown as never,
        fingerprint: 'fp',
        side: 'BUY',
        orderPrice: '0.65',
        requestedSize: '100',
        now: new Date(),
      });
      await submissions.markReservationHeld(CLIENT_ID, initial, new Date());
      await submissions.markVenueAccepted(CLIENT_ID, ORDER_ID, new Date());
    }

    function getPortfolio(): Portfolio {
      return (portfolioStore.get as ReturnType<typeof jest.fn>)() as Portfolio;
    }

    it('terminal update БЕЗ local Order, но с held execution: settlement DEFERRED (pending), капитал НЕ освобождён, фиктивный Order не создан', async () => {
      await seedHeldJournal();
      orderRepo = makeOrderRepo(undefined);
      orderStateStore = makeOrderStateStore();
      deps = { metadataGenerator: makeMetadataGenerator(), orderRepo, orderStateStore, portfolioService, keyedMutex: makeKeyedMutex(), orderedEventOutbox, submissions, logger };
      const useCase = new UpdateOrderStatusUseCase(deps);

      const result = await useCase.execute({ update: { type: 'CANCELLED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });

      expect(result.ok).toBe(true);
      // Шаг 5: капитал НЕ освобождается автоматически (delayed-fill race) —
      // release выполнит SettleTerminalOrdersUseCase по authoritative venue trades.
      const portfolio = getPortfolio();
      expect(portfolio.releaseReservation).not.toHaveBeenCalled();
      const record = await submissions.get(CLIENT_ID);
      expect(record?.reservation).toMatchObject({ status: 'HELD', remaining: '65' });
      // Поставлен settlement pending; фиктивный Order не создаётся.
      expect(orderStateStore.markTerminalSettlementPending).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: ORDER_ID, venueStatus: 'CANCELLED' }),
      );
      expect(orderRepo.save).not.toHaveBeenCalled();
      // Pending cancel marker НЕ снят (снимет settle-резолвер).
      expect(orderStateStore.clearInFlightFill).not.toHaveBeenCalled();
    });

    it('terminal update без Order + held execution: Portfolio НЕ трогается вовсе (release перенесён в settle-резолвер)', async () => {
      await seedHeldJournal();
      orderRepo = makeOrderRepo(undefined);
      orderStateStore = makeOrderStateStore();
      deps = { metadataGenerator: makeMetadataGenerator(), orderRepo, orderStateStore, portfolioService, keyedMutex: makeKeyedMutex(), orderedEventOutbox, submissions, logger };
      const useCase = new UpdateOrderStatusUseCase(deps);

      const result = await useCase.execute({ update: { type: 'CANCELLED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });

      expect(result.ok).toBe(true);
      const portfolio = getPortfolio();
      expect(portfolio.releaseReservation).not.toHaveBeenCalled();
      expect(portfolio.releaseTokenReservation).not.toHaveBeenCalled();
      const record = await submissions.get(CLIENT_ID);
      expect(record?.reservation.status).toBe('HELD'); // journal не тронут
      expect(orderStateStore.markTerminalSettlementPending).toHaveBeenCalled();
    });

    it('normal terminal update с held journal: DEFERRED — Portfolio не трогается, journal остаётся HELD', async () => {
      // Local Order есть; журнал held под тем же venueOrderId.
      await seedHeldJournal();
      const order = makeOpenOrder();
      orderRepo = makeOrderRepo(order);
      orderStateStore = makeOrderStateStore(order);
      deps = { metadataGenerator: makeMetadataGenerator(), orderRepo, orderStateStore, portfolioService, keyedMutex: makeKeyedMutex(), orderedEventOutbox, submissions, logger };
      const useCase = new UpdateOrderStatusUseCase(deps);

      const result = await useCase.execute({ update: { type: 'CANCELLED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });

      expect(result.ok).toBe(true);
      const portfolio = getPortfolio();
      expect(portfolio.releaseReservation).not.toHaveBeenCalled();
      const record = await submissions.get(CLIENT_ID);
      expect(record?.reservation).toMatchObject({ status: 'HELD', remaining: '65' });
      expect(orderStateStore.markTerminalSettlementPending).toHaveBeenCalled();
    });

    it('normal terminal update БЕЗ journal-резервации (legacy): release + очистка uncertain-cancel placeholder', async () => {
      // Журнал пуст (нет записи под venueOrderId) — legacy немедленный release.
      const order = makeOpenOrder();
      orderRepo = makeOrderRepo(order);
      orderStateStore = makeOrderStateStore(order);
      deps = { metadataGenerator: makeMetadataGenerator(), orderRepo, orderStateStore, portfolioService, keyedMutex: makeKeyedMutex(), orderedEventOutbox, submissions, logger };
      const useCase = new UpdateOrderStatusUseCase(deps);

      const result = await useCase.execute({ update: { type: 'CANCELLED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });

      expect(result.ok).toBe(true);
      const portfolio = getPortfolio();
      expect(portfolio.releaseReservation).toHaveBeenCalledTimes(1);
      // Placeholder снят (clearOrderFillMatched + clearInFlightFill по pending id).
      expect(orderStateStore.clearOrderFillMatched).toHaveBeenCalled();
      expect(orderStateStore.clearInFlightFill).toHaveBeenCalled();
      expect(orderStateStore.markTerminalSettlementPending).not.toHaveBeenCalled();
    });

    it('normal terminal update с held journal: journal transitions НЕ вызываются (settlement отложен целиком)', async () => {
      const order = makeOpenOrder();
      orderRepo = makeOrderRepo(order);
      orderStateStore = makeOrderStateStore(order);
      // Стаб журнала: запись held; applyReservationTransition НЕ должен вызываться.
      const { emptyReservation } = await import('@polymarket/ports');
      const heldRecord = {
        clientOrderId: CLIENT_ID,
        venueOrderId: ORDER_ID,
        status: 'COMMITTED',
        accountId: ACCOUNT_ID,
        instrumentId: '123' as unknown as never,
        attempt: 1,
        fingerprint: 'fp',
        side: 'BUY',
        orderPrice: '0.65',
        requestedSize: '100',
        reservation: { ...emptyReservation('USDC'), initial: '65', remaining: '65', status: 'HELD' },
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const trackingSubmissions = {
        findByVenueOrderId: jest.fn().mockImplementation(async () => heldRecord),
        applyReservationTransition: jest.fn(),
      } as unknown as UpdateOrderStatusDeps['submissions'];
      deps = { metadataGenerator: makeMetadataGenerator(), orderRepo, orderStateStore, portfolioService, keyedMutex: makeKeyedMutex(), orderedEventOutbox, submissions: trackingSubmissions, logger };
      const useCase = new UpdateOrderStatusUseCase(deps);

      const result = await useCase.execute({ update: { type: 'CANCELLED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });

      expect(result.ok).toBe(true);
      expect(trackingSubmissions.applyReservationTransition).not.toHaveBeenCalled();
      expect(orderStateStore.markTerminalSettlementPending).toHaveBeenCalled();
      expect(orderStateStore.clearInFlightFill).not.toHaveBeenCalled();
    });

    it('outbox enqueue Err создаёт EVENT_PUBLISH_FAILED issue, update остаётся committed (Ok)', async () => {
      const order = makeOpenOrder();
      orderRepo = makeOrderRepo(order);
      orderStateStore = makeOrderStateStore(order);
      const { OutboxEnqueueError } = await import('@polymarket/ports');
      const failingOutbox = {
        enqueue: jest.fn().mockImplementation(async () => Err(new OutboxEnqueueError('queue full'))),
        flush: jest.fn().mockImplementation(async () => undefined),
      } as unknown as IOrderedEventOutbox;
      const reconciliationIssues = makeReconciliationIssueRepo();
      deps = { metadataGenerator: makeMetadataGenerator(), orderRepo, orderStateStore, portfolioService, keyedMutex: makeKeyedMutex(), orderedEventOutbox: failingOutbox, submissions, reconciliationIssues, logger };
      const useCase = new UpdateOrderStatusUseCase(deps);

      const result = await useCase.execute({ update: { type: 'CANCELLED', orderId: ORDER_ID }, accountId: ACCOUNT_ID });

      expect(result.ok).toBe(true);
      expect(orderRepo.save).toHaveBeenCalled();
      const issue = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls
        .map((c) => c[0] as { type: string; reason: string })
        .find((i) => i.type === 'EVENT_PUBLISH_FAILED');
      expect(issue).toBeDefined();
      expect(issue!.reason).toContain('queue full');
    });

    it('terminal update без Order: execution чужого аккаунта → release НЕ выполняется, issue', async () => {
      await seedHeldJournal();
      orderRepo = makeOrderRepo(undefined);
      orderStateStore = makeOrderStateStore();
      const reconciliationIssues = makeReconciliationIssueRepo();
      deps = { metadataGenerator: makeMetadataGenerator(), orderRepo, orderStateStore, portfolioService, keyedMutex: makeKeyedMutex(), orderedEventOutbox, submissions, reconciliationIssues, logger };
      const useCase = new UpdateOrderStatusUseCase(deps);

      const result = await useCase.execute({
        update: { type: 'CANCELLED', orderId: ORDER_ID },
        accountId: 'acc-OTHER' as unknown as AccountId,
      });

      expect(result.ok).toBe(true);
      const portfolio = getPortfolio();
      expect(portfolio.releaseReservation).not.toHaveBeenCalled();
      const record = await submissions.get(CLIENT_ID);
      expect(record?.reservation.status).toBe('HELD'); // не тронута
      const issue = (reconciliationIssues.add as ReturnType<typeof jest.fn>).mock.calls
        .map((c) => c[0] as { id: string })
        .find((i) => i.id.endsWith(':execution-account-mismatch'));
      expect(issue).toBeDefined();
    });
  });
});
