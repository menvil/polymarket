import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { OrderUpdateHandler } from '../src/OrderUpdateHandler.js';
import type { VenueOrderUpdate } from '../src/OrderUpdateHandler.js';
import type { IEventBus } from '@polymarket/event-bus';
import type { ILogger } from '@polymarket/logger';
import type { IOrderRepository } from '@polymarket/ports';
import type { OrderId } from '@polymarket/ids';
import type { Order } from '@polymarket/order';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeLogger(): ILogger {
  return {
    trace: jest.fn() as ILogger['trace'],
    debug: jest.fn() as ILogger['debug'],
    info: jest.fn() as ILogger['info'],
    warn: jest.fn() as ILogger['warn'],
    error: jest.fn() as ILogger['error'],
    fatal: jest.fn() as ILogger['fatal'],
    child: jest.fn() as ILogger['child'],
  };
}

function makeEventBus(): IEventBus {
  return {
    publish: jest.fn<IEventBus['publish']>().mockResolvedValue(undefined),
    publishAll: jest.fn<IEventBus['publishAll']>().mockResolvedValue(undefined),
    subscribe: jest.fn() as IEventBus['subscribe'],
  };
}

const ORDER_ID = 'order-001' as unknown as OrderId;

/**
 * Создаёт mock Order с заданным результатом для указанного метода.
 */
function makeOrderWithResult(
  method: 'accept' | 'reject' | 'cancel' | 'expire',
  ok: boolean,
  events: unknown[] = [],
): Order {
  const updatedOrder = {
    pullEvents: jest.fn<() => readonly unknown[]>().mockReturnValue(events),
    accept: jest.fn(),
    reject: jest.fn(),
    cancel: jest.fn(),
    expire: jest.fn(),
  } as unknown as Order;

  const result = ok
    ? { ok: true as const, value: updatedOrder }
    : { ok: false as const, error: new Error('Invalid transition') };

  (updatedOrder[method] as ReturnType<typeof jest.fn>).mockReturnValue(result);

  return {
    accept: jest.fn<Order['accept']>().mockReturnValue(result as ReturnType<Order['accept']>),
    reject: jest.fn<Order['reject']>().mockReturnValue(result as ReturnType<Order['reject']>),
    cancel: jest.fn<Order['cancel']>().mockReturnValue(result as ReturnType<Order['cancel']>),
    expire: jest.fn<Order['expire']>().mockReturnValue(result as ReturnType<Order['expire']>),
    pullEvents: jest.fn<() => readonly unknown[]>().mockReturnValue([]),
  } as unknown as Order;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OrderUpdateHandler', () => {
  let orders: IOrderRepository;
  let eventBus: IEventBus;
  let logger: ILogger;
  let handler: OrderUpdateHandler;

  beforeEach(() => {
    orders = {
      get: jest.fn().mockImplementation(() => Promise.resolve(undefined)) as unknown as IOrderRepository['get'],
      save: jest.fn().mockImplementation(() => Promise.resolve()) as unknown as IOrderRepository['save'],
      delete: jest.fn().mockImplementation(() => Promise.resolve()) as unknown as IOrderRepository['delete'],
      getByStrategyId: jest.fn().mockImplementation(() => Promise.resolve([])) as unknown as IOrderRepository['getByStrategyId'],
      countByStrategyId: jest.fn().mockImplementation(() => Promise.resolve(0)) as unknown as IOrderRepository['countByStrategyId'],
      getAll: jest.fn().mockImplementation(() => Promise.resolve([])) as unknown as IOrderRepository['getAll'],
    };
    eventBus = makeEventBus();
    logger = makeLogger();
    handler = new OrderUpdateHandler(orders, eventBus, logger);
  });

  // ── Ордер не найден ──────────────────────────────────────────────────────

  it('логирует warn и не публикует если ордер не найден', async () => {
    const update: VenueOrderUpdate = { type: 'ACCEPTED', orderId: ORDER_ID };
    await handler.handle(update);

    expect(logger.warn).toHaveBeenCalledWith(
      'Order not found for venue update',
      expect.objectContaining({ updateType: 'ACCEPTED' }),
    );
    expect(eventBus.publishAll).not.toHaveBeenCalled();
    expect(orders.save).not.toHaveBeenCalled();
  });

  // ── ACCEPTED ─────────────────────────────────────────────────────────────

  it('вызывает order.accept() и сохраняет ордер при ACCEPTED', async () => {
    const order = makeOrderWithResult('accept', true);
    (orders.get as ReturnType<typeof jest.fn>).mockResolvedValue(order);

    await handler.handle({ type: 'ACCEPTED', orderId: ORDER_ID });

    expect(order.accept).toHaveBeenCalledTimes(1);
    expect(orders.save).toHaveBeenCalledTimes(1);
  });

  // ── REJECTED ─────────────────────────────────────────────────────────────

  it('вызывает order.reject(reason) при REJECTED', async () => {
    const order = makeOrderWithResult('reject', true);
    (orders.get as ReturnType<typeof jest.fn>).mockResolvedValue(order);

    await handler.handle({ type: 'REJECTED', orderId: ORDER_ID, reason: 'price out of range' });

    expect(order.reject).toHaveBeenCalledWith('price out of range');
  });

  // ── CANCELLED ────────────────────────────────────────────────────────────

  it('вызывает order.cancel(reason) при CANCELLED с reason', async () => {
    const order = makeOrderWithResult('cancel', true);
    (orders.get as ReturnType<typeof jest.fn>).mockResolvedValue(order);

    await handler.handle({ type: 'CANCELLED', orderId: ORDER_ID, reason: 'user request' });

    expect(order.cancel).toHaveBeenCalledWith('user request');
  });

  it('вызывает order.cancel(undefined) при CANCELLED без reason', async () => {
    const order = makeOrderWithResult('cancel', true);
    (orders.get as ReturnType<typeof jest.fn>).mockResolvedValue(order);

    await handler.handle({ type: 'CANCELLED', orderId: ORDER_ID });

    expect(order.cancel).toHaveBeenCalledWith(undefined);
  });

  // ── EXPIRED ──────────────────────────────────────────────────────────────

  it('вызывает order.expire() при EXPIRED', async () => {
    const order = makeOrderWithResult('expire', true);
    (orders.get as ReturnType<typeof jest.fn>).mockResolvedValue(order);

    await handler.handle({ type: 'EXPIRED', orderId: ORDER_ID });

    expect(order.expire).toHaveBeenCalledTimes(1);
  });

  // ── Ошибка перехода ──────────────────────────────────────────────────────

  it('логирует error и не сохраняет если Order вернул error', async () => {
    const order = makeOrderWithResult('accept', false);
    (orders.get as ReturnType<typeof jest.fn>).mockResolvedValue(order);

    await handler.handle({ type: 'ACCEPTED', orderId: ORDER_ID });

    expect(logger.error).toHaveBeenCalledWith(
      'Failed to apply order update',
      expect.objectContaining({ updateType: 'ACCEPTED' }),
    );
    expect(orders.save).not.toHaveBeenCalled();
    expect(eventBus.publishAll).not.toHaveBeenCalled();
  });

  // ── Публикация Domain Events ─────────────────────────────────────────────

  it('публикует OrderEvent[] из pullEvents() после успешного перехода', async () => {
    const fakeEvent = { type: 'ORDER_ACCEPTED' as const, orderId: ORDER_ID };
    const updatedOrder = {
      pullEvents: jest.fn<() => readonly unknown[]>().mockReturnValue([fakeEvent]),
    } as unknown as Order;

    const order = {
      accept: jest.fn<Order['accept']>().mockReturnValue({
        ok: true,
        value: updatedOrder,
      } as ReturnType<Order['accept']>),
      reject: jest.fn() as Order['reject'],
      cancel: jest.fn() as Order['cancel'],
      expire: jest.fn() as Order['expire'],
      pullEvents: jest.fn<() => readonly unknown[]>().mockReturnValue([]),
    } as unknown as Order;

    (orders.get as ReturnType<typeof jest.fn>).mockResolvedValue(order);

    await handler.handle({ type: 'ACCEPTED', orderId: ORDER_ID });

    expect(eventBus.publishAll).toHaveBeenCalledWith([fakeEvent]);
  });

  it('НЕ вызывает publishAll если pullEvents() вернул []', async () => {
    const order = makeOrderWithResult('accept', true, []);
    (orders.get as ReturnType<typeof jest.fn>).mockResolvedValue(order);

    await handler.handle({ type: 'ACCEPTED', orderId: ORDER_ID });

    expect(eventBus.publishAll).not.toHaveBeenCalled();
  });

  it('логирует info после успешного обновления', async () => {
    const order = makeOrderWithResult('expire', true);
    (orders.get as ReturnType<typeof jest.fn>).mockResolvedValue(order);

    await handler.handle({ type: 'EXPIRED', orderId: ORDER_ID });

    expect(logger.info).toHaveBeenCalledWith(
      'Order update applied',
      expect.objectContaining({ updateType: 'EXPIRED' }),
    );
  });
});
