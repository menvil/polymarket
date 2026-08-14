import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { MessageMetadataGenerator } from '@polymarket/messages';
import { unsafeRunId } from '@polymarket/ids';
import { FillOrchestrator } from '../src/FillOrchestrator.js';
import type { FillOrchestratorDeps } from '../src/FillOrchestrator.js';
import type { ILogger } from '@polymarket/logger';
import type { FillReceivedEvent, FillFailedEvent } from '@polymarket/application-events';
import type { IEventBus } from '@polymarket/event-bus';
import type { IOrderStateStore, IFillReverter, IFillProcessor, IProcessedFillRepository } from '@polymarket/ports';
import type { Timestamp } from '@polymarket/value-objects';
import { Ok, Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';

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

function makeEventBus(): IEventBus & {
  _triggerFillReceived: (event: FillReceivedEvent) => Promise<void>;
  _triggerFillFailed: (event: FillFailedEvent) => Promise<void>;
} {
  let fillHandler: ((event: FillReceivedEvent) => Promise<void>) | undefined;
  let fillFailedHandler: ((event: FillFailedEvent) => Promise<void>) | undefined;

  const bus = {
    publish: jest.fn<IEventBus['publish']>().mockResolvedValue(Ok(undefined)),
    publishAll: jest.fn<IEventBus['publishAll']>().mockResolvedValue(Ok(undefined)),
    subscribe: jest.fn<IEventBus['subscribe']>().mockImplementation(
      (type: string, handler: (event: any) => Promise<void>) => {
        if (type === 'FILL_RECEIVED') {
          fillHandler = handler;
        } else if (type === 'FILL_FAILED') {
          fillFailedHandler = handler;
        }
        return () => {
          fillHandler = undefined;
          fillFailedHandler = undefined;
        };
      }
    ) as IEventBus['subscribe'],
    _triggerFillReceived: async (event: FillReceivedEvent) => {
      if (fillHandler) await fillHandler(event);
    },
    _triggerFillFailed: async (event: FillFailedEvent) => {
      if (fillFailedHandler) await fillFailedHandler(event);
    },
  };

  return bus;
}

function makeProcessFillUseCase(ok = true): IFillProcessor {
  return {
    execute: jest.fn<IFillProcessor['execute']>().mockResolvedValue(
      ok ? Ok(undefined) : Err(new TradingError('Fill processing failed') as never)
    ),
  } as unknown as IFillProcessor;
}

function makeOrderStateStore(): IOrderStateStore {
  return {
    getOrder: jest.fn().mockReturnValue(undefined),
    clearOrderFillMatched: jest.fn(),
    markOrderFillMatched: jest.fn(),
    hasMatchedFills: jest.fn().mockReturnValue(false),
    getMatchedFillIds: jest.fn().mockReturnValue([]),
    getOpenOrdersByInstrument: jest.fn().mockReturnValue([]),
    hasInFlightFills: jest.fn().mockReturnValue(false),
    markInFlightFill: jest.fn(),
    clearInFlightFill: jest.fn(),
    getInFlightFills: jest.fn().mockReturnValue([]),
  } as unknown as IOrderStateStore;
}

function makeFillReverter(): IFillReverter {
  return {
    reverseFill: jest.fn().mockReturnValue(Ok(undefined)),
  } as unknown as IFillReverter;
}

function makeProcessedFillRepo(): IProcessedFillRepository {
  return {
    begin: jest.fn<IProcessedFillRepository['begin']>().mockResolvedValue({ outcome: 'ACQUIRED', isRetry: false }),
    markApplied: jest.fn<IProcessedFillRepository['markApplied']>().mockResolvedValue(undefined),
    markFailed: jest.fn<IProcessedFillRepository['markFailed']>().mockResolvedValue(undefined),
    markReverted: jest.fn<IProcessedFillRepository['markReverted']>().mockResolvedValue(undefined),
    markReconciliationRequired: jest.fn<IProcessedFillRepository['markReconciliationRequired']>().mockResolvedValue(undefined),
    getStatus: jest.fn<IProcessedFillRepository['getStatus']>().mockResolvedValue(undefined),
  };
}

/** Детерминированный canonical-генератор metadata тестовых событий (M-003). */
const METADATA_GENERATOR = new MessageMetadataGenerator({
  clock: { now: () => new Date('2024-01-01T00:00:00.000Z') },
  runId: unsafeRunId('testrun1'),
});

function makeFillEvent(): FillReceivedEvent {
  return {
    type: 'FILL_RECEIVED',
    payload: {
      fill: { id: 'fill-1' } as never,
      receivedAt: {} as Timestamp,
    },
    metadata: METADATA_GENERATOR.nextRoot(),
  };
}

const TEST_TOKEN_ID = { type: 'POLYMARKET_CTF_TOKEN', tokenId: '888' } as never;

function makeCachedFill(id: string, orderId: string, tokenId: unknown = TEST_TOKEN_ID): never {
  return { id, orderId, side: 'BUY', tokenId } as never;
}

function makeFillFailedEvent(fills?: readonly unknown[]): FillFailedEvent {
  return {
    type: 'FILL_FAILED',
    payload: {
      fillId: 'fill-1' as never,
      orderId: 'order-1' as never,
      receivedAt: {} as Timestamp,
      fills: fills as never,
    },
    metadata: METADATA_GENERATOR.nextRoot(),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FillOrchestrator', () => {
  let logger: ILogger;
  let eventBus: ReturnType<typeof makeEventBus>;
  let processFill: IFillProcessor;
  let processedFillRepo: IProcessedFillRepository;
  let deps: FillOrchestratorDeps;

  beforeEach(() => {
    logger = makeLogger();
    eventBus = makeEventBus();
    processFill = makeProcessFillUseCase(true);
    processedFillRepo = makeProcessedFillRepo();
    deps = {
      eventBus,
      processFill,
      logger,
      orderStateStore: makeOrderStateStore(),
      portfolioService: makeFillReverter(),
      processedFillRepo,
    };
  });

  it('подписывается на FILL_RECEIVED и FILL_FAILED при register()', () => {
    const orchestrator = new FillOrchestrator(deps);
    orchestrator.register();
    expect(eventBus.subscribe).toHaveBeenCalledWith('FILL_RECEIVED', expect.any(Function));
    expect(eventBus.subscribe).toHaveBeenCalledWith('FILL_FAILED', expect.any(Function));
  });

  it('вызывает ProcessFillUseCase.execute при получении FILL_RECEIVED', async () => {
    const orchestrator = new FillOrchestrator(deps);
    orchestrator.register();
    const event = makeFillEvent();
    await eventBus._triggerFillReceived(event);
    expect(processFill.execute).toHaveBeenCalledWith(event.payload.fill, event.metadata);
  });

  it('логирует error если ProcessFillUseCase вернул Err', async () => {
    processFill = makeProcessFillUseCase(false);
    const orchestrator = new FillOrchestrator({ ...deps, processFill });
    orchestrator.register();
    await eventBus._triggerFillReceived(makeFillEvent());
    expect(logger.error).toHaveBeenCalledWith(
      'ProcessFillUseCase failed',
      expect.objectContaining({ fillId: 'fill-1' }),
    );
  });

  it('не вызывает execute если не зарегистрирован', async () => {
    new FillOrchestrator(deps);
    // Не вызываем register()
    await eventBus._triggerFillReceived(makeFillEvent());
    expect(processFill.execute).not.toHaveBeenCalled();
  });

  it('повторный register() отписывается от предыдущей подписки', () => {
    const orchestrator = new FillOrchestrator(deps);
    orchestrator.register();
    orchestrator.register();
    // subscribe вызвался 4 раза: 2 события (FILL_RECEIVED + FILL_FAILED) × 2 register
    expect(eventBus.subscribe).toHaveBeenCalledTimes(4);
  });

  it('логирует info при register()', () => {
    const orchestrator = new FillOrchestrator(deps);
    orchestrator.register();
    expect(logger.info).toHaveBeenCalledWith('FillOrchestrator registered');
  });

  describe('FILL_FAILED', () => {
    it('откатывает и очищает fillId-scoped флаги, когда fill откачен успешно', async () => {
      const orchestrator = new FillOrchestrator(deps);
      orchestrator.register();
      await eventBus._triggerFillFailed(
        makeFillFailedEvent([makeCachedFill('fill-1', 'order-1')]),
      );
      expect(deps.orderStateStore.clearOrderFillMatched).toHaveBeenCalledWith('order-1', 'fill-1');
      expect(deps.orderStateStore.clearInFlightFill).toHaveBeenCalledWith('fill-1');
      expect(processedFillRepo.markReverted).toHaveBeenCalledWith('fill-1');
    });

    it('НЕ откатывает и НЕ чистит флаги, если fills отсутствуют (rollback невозможен)', async () => {
      const orchestrator = new FillOrchestrator(deps);
      orchestrator.register();
      await eventBus._triggerFillFailed(makeFillFailedEvent(undefined));
      expect(deps.portfolioService.reverseFill).not.toHaveBeenCalled();
      expect(deps.orderStateStore.clearOrderFillMatched).not.toHaveBeenCalled();
      expect(deps.orderStateStore.clearInFlightFill).not.toHaveBeenCalled();
      expect(processedFillRepo.markReverted).not.toHaveBeenCalled();
    });

    it('партиальный rollback: откаченный fill очищается, неоткаченный — остаётся matched/in-flight', async () => {
      const portfolioService = {
        reverseFill: jest
          .fn()
          .mockReturnValueOnce(Ok(undefined)) // fill-1 — успех
          .mockReturnValueOnce(Err(new TradingError('revert failed') as never)), // fill-2 — провал
      } as unknown as IFillReverter;
      const orchestrator = new FillOrchestrator({ ...deps, portfolioService });
      orchestrator.register();
      await eventBus._triggerFillFailed(
        makeFillFailedEvent([
          makeCachedFill('fill-1', 'order-1'),
          makeCachedFill('fill-2', 'order-1'),
        ]),
      );
      // fill-1 (успешный revert) — флаги сняты
      expect(deps.orderStateStore.clearOrderFillMatched).toHaveBeenCalledWith('order-1', 'fill-1');
      expect(deps.orderStateStore.clearInFlightFill).toHaveBeenCalledWith('fill-1');
      expect(processedFillRepo.markReverted).toHaveBeenCalledWith('fill-1');
      // fill-2 (провалившийся revert) — флаги НЕ сняты
      expect(deps.orderStateStore.clearOrderFillMatched).not.toHaveBeenCalledWith('order-1', 'fill-2');
      expect(deps.orderStateStore.clearInFlightFill).not.toHaveBeenCalledWith('fill-2');
      expect(processedFillRepo.markReverted).not.toHaveBeenCalledWith('fill-2');
      expect(logger.error).toHaveBeenCalledWith(
        'Portfolio rollback incomplete for some fills — manual reconciliation required',
        expect.objectContaining({ reversedCount: 1, totalCount: 2 }),
      );
    });

    it('НЕ откатывает флаги для fill, если reverseFill бросает исключение', async () => {
      const portfolioService = {
        reverseFill: jest.fn().mockImplementation(() => {
          throw new Error('boom');
        }),
      } as unknown as IFillReverter;
      const orchestrator = new FillOrchestrator({ ...deps, portfolioService });
      orchestrator.register();
      await eventBus._triggerFillFailed(
        makeFillFailedEvent([makeCachedFill('fill-1', 'order-1')]),
      );
      expect(deps.orderStateStore.clearOrderFillMatched).not.toHaveBeenCalled();
      expect(deps.orderStateStore.clearInFlightFill).not.toHaveBeenCalled();
      expect(processedFillRepo.markReverted).not.toHaveBeenCalled();
    });

    it('НЕ откатывает флаги, если cached fills есть, но ни один не соответствует event.orderId', async () => {
      const orchestrator = new FillOrchestrator(deps);
      orchestrator.register();
      await eventBus._triggerFillFailed(
        makeFillFailedEvent([makeCachedFill('fill-a', 'order-other')]),
      );
      expect(deps.portfolioService.reverseFill).not.toHaveBeenCalled();
      expect(deps.orderStateStore.clearOrderFillMatched).not.toHaveBeenCalled();
      expect(deps.orderStateStore.clearInFlightFill).not.toHaveBeenCalled();
    });

    it('откатывает fill даже с невалидным/пустым tokenId (instrumentId больше не требуется для отката)', async () => {
      // fillId-scoped tracking больше не зависит от вывода instrumentId —
      // clearOrderFillMatched/clearInFlightFill идентифицируют запись по fillId.
      const orchestrator = new FillOrchestrator(deps);
      orchestrator.register();
      const invalidTokenId = { type: 'POLYMARKET_CTF_TOKEN', tokenId: '' } as never;
      await eventBus._triggerFillFailed(
        makeFillFailedEvent([makeCachedFill('fill-1', 'order-1', invalidTokenId)]),
      );
      expect(deps.portfolioService.reverseFill).toHaveBeenCalledTimes(1);
      expect(deps.orderStateStore.clearOrderFillMatched).toHaveBeenCalledWith('order-1', 'fill-1');
      expect(deps.orderStateStore.clearInFlightFill).toHaveBeenCalledWith('fill-1');
    });

    it('дедуплицирует fills по fill.id — reverseFill вызывается один раз на дубликат', async () => {
      const orchestrator = new FillOrchestrator(deps);
      orchestrator.register();
      const fill = makeCachedFill('fill-1', 'order-1');
      await eventBus._triggerFillFailed(makeFillFailedEvent([fill, fill]));
      expect(deps.portfolioService.reverseFill).toHaveBeenCalledTimes(1);
      expect(deps.orderStateStore.clearOrderFillMatched).toHaveBeenCalledTimes(1);
      expect(deps.orderStateStore.clearInFlightFill).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        'Duplicate rollback fills collapsed by fillId',
        expect.objectContaining({ orderId: 'order-1', matchingCount: 2, dedupedCount: 1 }),
      );
    });

    it('откатывает и чистит КАЖДЫЙ fill НЕЗАВИСИМО (partial fills одного ордера)', async () => {
      const orchestrator = new FillOrchestrator(deps);
      orchestrator.register();
      // Два РАЗНЫХ fill (разные fillId) для одного ордера/инструмента — например,
      // partial fills одного ордера, каждый ранее отмечен отдельно.
      await eventBus._triggerFillFailed(
        makeFillFailedEvent([
          makeCachedFill('fill-a', 'order-1'),
          makeCachedFill('fill-b', 'order-1'),
        ]),
      );
      expect(deps.portfolioService.reverseFill).toHaveBeenCalledTimes(2);
      expect(deps.orderStateStore.clearOrderFillMatched).toHaveBeenCalledWith('order-1', 'fill-a');
      expect(deps.orderStateStore.clearOrderFillMatched).toHaveBeenCalledWith('order-1', 'fill-b');
      expect(deps.orderStateStore.clearInFlightFill).toHaveBeenCalledWith('fill-a');
      expect(deps.orderStateStore.clearInFlightFill).toHaveBeenCalledWith('fill-b');
    });

    it('откатывает fills разных инструментов независимо (больше не блокируется preflight-проверкой)', async () => {
      const orchestrator = new FillOrchestrator(deps);
      orchestrator.register();
      const TEST_TOKEN_ID_2 = { type: 'POLYMARKET_CTF_TOKEN', tokenId: '999' } as never;
      await eventBus._triggerFillFailed(
        makeFillFailedEvent([
          makeCachedFill('fill-1', 'order-1', TEST_TOKEN_ID),
          makeCachedFill('fill-2', 'order-1', TEST_TOKEN_ID_2),
        ]),
      );
      expect(deps.portfolioService.reverseFill).toHaveBeenCalledTimes(2);
      expect(deps.orderStateStore.clearOrderFillMatched).toHaveBeenCalledWith('order-1', 'fill-1');
      expect(deps.orderStateStore.clearOrderFillMatched).toHaveBeenCalledWith('order-1', 'fill-2');
    });

    it('логирует и не роняет subscription loop, если orderStateStore бросает при cleanup', async () => {
      const orderStateStore = {
        ...makeOrderStateStore(),
        clearOrderFillMatched: jest.fn().mockImplementation(() => {
          throw new Error('store unavailable');
        }),
      } as unknown as IOrderStateStore;
      const orchestrator = new FillOrchestrator({ ...deps, orderStateStore });
      orchestrator.register();

      await expect(
        eventBus._triggerFillFailed(makeFillFailedEvent([makeCachedFill('fill-1', 'order-1')])),
      ).resolves.not.toThrow();

      expect(logger.error).toHaveBeenCalledWith(
        'Unexpected error handling failed fill — rollback/cleanup state unknown, manual reconciliation required',
        expect.objectContaining({ orderId: 'order-1' }),
      );
    });

    it('логирует error, если clearInFlightFill бросает после успешного отката', async () => {
      const orderStateStore = {
        ...makeOrderStateStore(),
        clearInFlightFill: jest.fn().mockImplementation(() => {
          throw new Error('store unavailable');
        }),
      } as unknown as IOrderStateStore;
      const orchestrator = new FillOrchestrator({ ...deps, orderStateStore });
      orchestrator.register();

      await eventBus._triggerFillFailed(
        makeFillFailedEvent([makeCachedFill('fill-1', 'order-1')]),
      );

      // reverseFill и clearOrderFillMatched успели выполниться до броска исключения
      expect(deps.portfolioService.reverseFill).toHaveBeenCalledTimes(1);
      expect(orderStateStore.clearOrderFillMatched).toHaveBeenCalledWith('order-1', 'fill-1');
      expect(logger.error).toHaveBeenCalledWith(
        'Unexpected error handling failed fill — rollback/cleanup state unknown, manual reconciliation required',
        expect.objectContaining({ orderId: 'order-1' }),
      );
    });

    it('фильтрует fills по event.orderId — не откатывает fills других maker-ордеров', async () => {
      const portfolioService = {
        reverseFill: jest.fn().mockReturnValue(Ok(undefined)),
      } as unknown as IFillReverter;
      const orchestrator = new FillOrchestrator({ ...deps, portfolioService });
      orchestrator.register();

      // Один trade с несколькими maker orders — FillEventHandler публикует
      // FILL_FAILED на каждый order, но передаёт ОДИН и тот же cachedFills массив.
      const sharedFills = [
        makeCachedFill('fill-a', 'order-1'),
        makeCachedFill('fill-b', 'order-2'),
      ];

      await eventBus._triggerFillFailed({
        type: 'FILL_FAILED',
        payload: {
          fillId: 'fe-1' as never,
          orderId: 'order-1' as never,
          receivedAt: {} as Timestamp,
          fills: sharedFills as never,
        },
        metadata: METADATA_GENERATOR.nextRoot(),
      });
      await eventBus._triggerFillFailed({
        type: 'FILL_FAILED',
        payload: {
          fillId: 'fe-2' as never,
          orderId: 'order-2' as never,
          receivedAt: {} as Timestamp,
          fills: sharedFills as never,
        },
        metadata: METADATA_GENERATOR.nextRoot(),
      });

      // Каждый fill должен быть реверснут ровно один раз — не дважды.
      expect(portfolioService.reverseFill).toHaveBeenCalledTimes(2);
      expect(portfolioService.reverseFill).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'fill-a', orderId: 'order-1' }),
      );
      expect(portfolioService.reverseFill).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'fill-b', orderId: 'order-2' }),
      );
    });
  });
});
