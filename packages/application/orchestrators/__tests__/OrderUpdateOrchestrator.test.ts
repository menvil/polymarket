import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { MessageMetadataGenerator } from '@polymarket/messages';
import { unsafeRunId } from '@polymarket/ids';
import { OrderUpdateOrchestrator } from '../src/OrderUpdateOrchestrator.js';
import type { OrderUpdateOrchestratorDeps, IOrderStatusUpdater } from '../src/OrderUpdateOrchestrator.js';
import type { ILogger } from '@polymarket/logger';
import type { OrderUpdateReceivedEvent } from '@polymarket/application-events';
import type { IEventBus } from '@polymarket/event-bus';
import type { AccountId, OrderId } from '@polymarket/ids';
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

type EventHandler = (event: OrderUpdateReceivedEvent) => Promise<void>;

function makeEventBus(): IEventBus & { _trigger: (event: OrderUpdateReceivedEvent) => Promise<void> } {
  let handler: EventHandler | undefined;

  const bus = {
    publish: jest.fn<IEventBus['publish']>().mockResolvedValue(Ok(undefined)),
    publishAll: jest.fn<IEventBus['publishAll']>().mockResolvedValue(Ok(undefined)),
    subscribe: jest.fn<IEventBus['subscribe']>().mockImplementation(
      (type: string, h: (event: never) => Promise<void>) => {
        if (type === 'ORDER_UPDATE_RECEIVED') handler = h as EventHandler;
        return () => { handler = undefined; };
      },
    ) as IEventBus['subscribe'],
    _trigger: async (event: OrderUpdateReceivedEvent) => {
      if (handler) await handler(event);
    },
  };
  return bus;
}

function makeUpdateOrderStatus(ok = true): IOrderStatusUpdater {
  return {
    execute: jest.fn<IOrderStatusUpdater['execute']>().mockResolvedValue(
      ok ? Ok(undefined) : Err(new TradingError('Update failed') as never),
    ),
  } as unknown as IOrderStatusUpdater;
}

/** Детерминированный canonical-генератор metadata тестовых событий (M-003). */
const METADATA_GENERATOR = new MessageMetadataGenerator({
  clock: { now: () => new Date('2024-01-01T00:00:00.000Z') },
  runId: unsafeRunId('testrun1'),
});

function makeEvent(): OrderUpdateReceivedEvent {
  return {
    type: 'ORDER_UPDATE_RECEIVED',
    payload: {
      update: { type: 'ACCEPTED', orderId: 'order-1' as unknown as OrderId },
      accountId: 'acc-1' as unknown as AccountId,
      receivedAt: {} as Timestamp,
    },
    metadata: METADATA_GENERATOR.nextRoot(),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OrderUpdateOrchestrator', () => {
  let logger: ILogger;
  let eventBus: ReturnType<typeof makeEventBus>;
  let updateOrderStatus: IOrderStatusUpdater;
  let deps: OrderUpdateOrchestratorDeps;

  beforeEach(() => {
    logger = makeLogger();
    eventBus = makeEventBus();
    updateOrderStatus = makeUpdateOrderStatus(true);
    deps = { eventBus, updateOrderStatus, logger };
  });

  it('подписывается на ORDER_UPDATE_RECEIVED при register()', () => {
    const orch = new OrderUpdateOrchestrator(deps);
    orch.register();
    expect(eventBus.subscribe).toHaveBeenCalledWith('ORDER_UPDATE_RECEIVED', expect.any(Function));
  });

  it('вызывает updateOrderStatus.execute при получении ORDER_UPDATE_RECEIVED', async () => {
    const orch = new OrderUpdateOrchestrator(deps);
    orch.register();
    await eventBus._trigger(makeEvent());
    expect(updateOrderStatus.execute).toHaveBeenCalledWith({
      update: makeEvent().payload.update,
      accountId: makeEvent().payload.accountId,
    });
  });

  it('логирует error если updateOrderStatus вернул Err', async () => {
    updateOrderStatus = makeUpdateOrderStatus(false);
    const orch = new OrderUpdateOrchestrator({ ...deps, updateOrderStatus });
    orch.register();
    await eventBus._trigger(makeEvent());
    expect(logger.error).toHaveBeenCalledWith(
      'UpdateOrderStatusUseCase failed',
      expect.objectContaining({ updateType: 'ACCEPTED' }),
    );
  });

  it('не вызывает execute если не зарегистрирован', async () => {
    new OrderUpdateOrchestrator(deps);
    await eventBus._trigger(makeEvent());
    expect(updateOrderStatus.execute).not.toHaveBeenCalled();
  });

  it('повторный register() отписывается от предыдущей подписки', () => {
    const orch = new OrderUpdateOrchestrator(deps);
    orch.register();
    orch.register();
    expect(eventBus.subscribe).toHaveBeenCalledTimes(2);
  });

  it('логирует info при register()', () => {
    const orch = new OrderUpdateOrchestrator(deps);
    orch.register();
    expect(logger.info).toHaveBeenCalledWith('OrderUpdateOrchestrator registered');
  });
});
