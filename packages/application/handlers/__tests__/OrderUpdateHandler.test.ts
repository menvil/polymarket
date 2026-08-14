import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { Ok, Err } from '@polymarket/result';
import { QueueOverflowError } from '@polymarket/errors/event-bus';
import { OrderUpdateHandler } from '../src/OrderUpdateHandler.js';
import type { VenueOrderUpdate } from '../src/OrderUpdateHandler.js';
import type { IEventBus } from '@polymarket/event-bus';
import type { ILogger } from '@polymarket/logger';
import type { IClock } from '@polymarket/time';
import type { AccountId, OrderId } from '@polymarket/ids';
import { unsafeRunId } from '@polymarket/ids';
import { MessageMetadataGenerator } from '@polymarket/messages';

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

function makeClock(ms = 1_700_000_000_000): IClock {
  return { now: jest.fn(() => new Date(ms)) } as unknown as IClock;
}

const ACCOUNT_ID = 'acc-001' as unknown as AccountId;
const ORDER_ID = 'order-001' as unknown as OrderId;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OrderUpdateHandler (thin adapter)', () => {
  let eventBus: IEventBus;
  let clock: IClock;
  let logger: ILogger;
  let handler: OrderUpdateHandler;

  beforeEach(() => {
    eventBus = makeEventBus();
    clock = makeClock();
    logger = makeLogger();
    handler = new OrderUpdateHandler(
      eventBus,
      new MessageMetadataGenerator({ clock, runId: unsafeRunId('testrun1') }),
      clock,
      ACCOUNT_ID,
      logger,
    );
  });

  it('публикует ORDER_UPDATE_RECEIVED при handle(ACCEPTED)', async () => {
    const update: VenueOrderUpdate = { type: 'ACCEPTED', orderId: ORDER_ID };
    await handler.handle(update);

    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ORDER_UPDATE_RECEIVED',
        payload: expect.objectContaining({
          update,
          accountId: ACCOUNT_ID,
        }),
        metadata: expect.objectContaining({ sequence: expect.any(Number) }),
      }),
    );
  });

  it('публикует ORDER_UPDATE_RECEIVED при handle(CANCELLED)', async () => {
    const update: VenueOrderUpdate = { type: 'CANCELLED', orderId: ORDER_ID, reason: 'strategy' };
    await handler.handle(update);

    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ORDER_UPDATE_RECEIVED',
        payload: expect.objectContaining({ update }),
      }),
    );
  });

  it('включает receivedAt в событие', async () => {
    const update: VenueOrderUpdate = { type: 'EXPIRED', orderId: ORDER_ID };
    await handler.handle(update);

    const published = (eventBus.publish as ReturnType<typeof jest.fn>).mock.calls[0][0] as {
      payload: Record<string, unknown>;
    };
    expect(published.payload['receivedAt']).toBeDefined();
  });

  it('eventBus.publish возвращает Err → error логируется, не выбрасывает', async () => {
    (eventBus.publish as ReturnType<typeof jest.fn>).mockResolvedValue(
      Err(new QueueOverflowError('bus down')),
    );
    const update: VenueOrderUpdate = { type: 'REJECTED', orderId: ORDER_ID, reason: 'bad price' };

    await expect(handler.handle(update)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to publish ORDER_UPDATE_RECEIVED',
      expect.objectContaining({ orderId: String(ORDER_ID), error: 'bus down' }),
    );
  });
});
