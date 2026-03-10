import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { parseAccountId, asOrderId } from '@polymarket/ids';
import { OrderReconciler } from '../../src/OrderReconciler.js';
import type { IVenueOrderProvider } from '../../src/IVenueOrderProvider.js';
import type { IOrderRepository } from '@polymarket/ports';
import type { OrderUpdateHandler } from '@polymarket/handlers';
import type { ILogger } from '@polymarket/logger';
import type { Order } from '@polymarket/order';
import type { OrderId } from '@polymarket/ids';

// ── Вспомогательные фикстуры ─────────────────────────────────────────────────

const accountId = parseAccountId('venue:POLYMARKET:test-user')!;

function makeLogger(): ILogger {
  return {
    child: jest.fn().mockReturnThis() as unknown as ILogger['child'],
    trace:  jest.fn() as unknown as ILogger['trace'],
    debug:  jest.fn() as unknown as ILogger['debug'],
    info:   jest.fn() as unknown as ILogger['info'],
    warn:   jest.fn() as unknown as ILogger['warn'],
    error:  jest.fn() as unknown as ILogger['error'],
  } as unknown as ILogger;
}

function makeOrder(orderId: OrderId): Order {
  return { id: orderId } as unknown as Order;
}

function makeOrderRepo(orders: readonly Order[]): IOrderRepository {
  return {
    get:              jest.fn<() => Promise<Order | undefined>>(),
    save:             jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    delete:           jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    getByStrategyId:  jest.fn<() => Promise<readonly Order[]>>().mockResolvedValue([]),
    countByStrategyId: jest.fn<() => Promise<number>>().mockResolvedValue(0),
    getAll:           jest.fn<() => Promise<readonly Order[]>>().mockResolvedValue(orders),
  } as unknown as IOrderRepository;
}

function makeVenueProvider(orderIds: readonly string[]): IVenueOrderProvider {
  return {
    getOpenOrderIds: jest.fn<() => Promise<readonly string[]>>().mockResolvedValue(orderIds),
  };
}

function makeOrderUpdateHandler(): OrderUpdateHandler {
  return {
    handle: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } as unknown as OrderUpdateHandler;
}

// ── Тесты ────────────────────────────────────────────────────────────────────

describe('OrderReconciler', () => {
  let logger: ILogger;

  beforeEach(() => {
    logger = makeLogger();
  });

  describe('reconcile()', () => {
    it('завершает без действий если локальных ордеров нет', async () => {
      const orderRepo = makeOrderRepo([]);
      const venueProvider = makeVenueProvider([]);
      const handler = makeOrderUpdateHandler();

      const reconciler = new OrderReconciler({
        venueOrderProvider: venueProvider,
        orderRepo,
        orderUpdateHandler: handler,
        logger,
      });
      await reconciler.reconcile(accountId);

      expect(venueProvider.getOpenOrderIds).not.toHaveBeenCalled();
      expect(handler.handle).not.toHaveBeenCalled();
    });

    it('не отменяет ордера, присутствующие на venue', async () => {
      const orderId = asOrderId('order-abc')!;
      const orderRepo = makeOrderRepo([makeOrder(orderId)]);
      const venueProvider = makeVenueProvider(['order-abc']);
      const handler = makeOrderUpdateHandler();

      const reconciler = new OrderReconciler({
        venueOrderProvider: venueProvider,
        orderRepo,
        orderUpdateHandler: handler,
        logger,
      });
      await reconciler.reconcile(accountId);

      expect(handler.handle).not.toHaveBeenCalled();
    });

    it('отменяет ордера, отсутствующие на venue', async () => {
      const orderId = asOrderId('order-gone')!;
      const orderRepo = makeOrderRepo([makeOrder(orderId)]);
      const venueProvider = makeVenueProvider([]); // пустой — ордера нет на venue
      const handler = makeOrderUpdateHandler();

      const reconciler = new OrderReconciler({
        venueOrderProvider: venueProvider,
        orderRepo,
        orderUpdateHandler: handler,
        logger,
      });
      await reconciler.reconcile(accountId);

      expect(handler.handle).toHaveBeenCalledTimes(1);
      expect(handler.handle).toHaveBeenCalledWith({
        type: 'CANCELLED',
        orderId: orderId,
        reason: expect.stringContaining('Reconciliation'),
      });
    });

    it('корректно обрабатывает смешанный список: часть на venue, часть нет', async () => {
      const idPresent = asOrderId('order-present')!;
      const idGone    = asOrderId('order-gone')!;
      const orderRepo = makeOrderRepo([makeOrder(idPresent), makeOrder(idGone)]);
      const venueProvider = makeVenueProvider(['order-present']);
      const handler = makeOrderUpdateHandler();

      const reconciler = new OrderReconciler({
        venueOrderProvider: venueProvider,
        orderRepo,
        orderUpdateHandler: handler,
        logger,
      });
      await reconciler.reconcile(accountId);

      expect(handler.handle).toHaveBeenCalledTimes(1);
      expect(handler.handle).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'CANCELLED', orderId: idGone }),
      );
    });

    it('логирует error и пропускает reconciliation при ошибке venueProvider', async () => {
      const orderId = asOrderId('order-xyz')!;
      const orderRepo = makeOrderRepo([makeOrder(orderId)]);
      const venueProvider: IVenueOrderProvider = {
        getOpenOrderIds: jest.fn<() => Promise<readonly string[]>>().mockRejectedValue(new Error('Network error')),
      };
      const handler = makeOrderUpdateHandler();

      const reconciler = new OrderReconciler({
        venueOrderProvider: venueProvider,
        orderRepo,
        orderUpdateHandler: handler,
        logger,
      });
      await expect(reconciler.reconcile(accountId)).resolves.toBeUndefined();

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to fetch open orders'),
        expect.any(Object),
      );
      expect(handler.handle).not.toHaveBeenCalled();
    });

    it('логирует итоговую статистику reconciliation', async () => {
      const idPresent = asOrderId('order-p')!;
      const idGone    = asOrderId('order-g')!;
      const orderRepo = makeOrderRepo([makeOrder(idPresent), makeOrder(idGone)]);
      const venueProvider = makeVenueProvider(['order-p']);
      const handler = makeOrderUpdateHandler();

      const reconciler = new OrderReconciler({
        venueOrderProvider: venueProvider,
        orderRepo,
        orderUpdateHandler: handler,
        logger,
      });
      await reconciler.reconcile(accountId);

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('completed'),
        expect.objectContaining({ total: 2, active: 1, cancelled: 1 }),
      );
    });

    it('идемпотентен: повторный вызов при пустом репо безопасен', async () => {
      const orderRepo = makeOrderRepo([]);
      const venueProvider = makeVenueProvider([]);
      const handler = makeOrderUpdateHandler();

      const reconciler = new OrderReconciler({
        venueOrderProvider: venueProvider,
        orderRepo,
        orderUpdateHandler: handler,
        logger,
      });

      await reconciler.reconcile(accountId);
      await reconciler.reconcile(accountId);

      expect(handler.handle).not.toHaveBeenCalled();
    });
  });
});
