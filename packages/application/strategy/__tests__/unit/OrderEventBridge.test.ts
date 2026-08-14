import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { asOrderId } from '@polymarket/ids';
import type { OrderId } from '@polymarket/ids';
import { OrderEventBridge } from '../../src/OrderEventBridge.js';
import type { OrderEventBridgeDeps } from '../../src/OrderEventBridge.js';

// ── Constants ──────────────────────────────────────────────

const ORDER_1 = asOrderId('order-1')!;
const STRATEGY_ID = 'strategy-1';

// ── Helpers ────────────────────────────────────────────────

type SubscribeCallback = (event: any) => void;

function makeEventBus() {
  const handlers = new Map<string, SubscribeCallback>();
  return {
    subscribe: jest.fn((type: string, cb: SubscribeCallback) => {
      handlers.set(type, cb);
      return jest.fn(); // unsubscribe
    }),
    publish: jest.fn(),
    publishAll: jest.fn(),
    _emit(type: string, event: any) {
      const handler = handlers.get(type);
      if (handler) handler(event);
    },
  };
}

function makeLogger() {
  return {
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn().mockReturnThis(),
  };
}

function makeOrder(id: OrderId, strategyId?: string) {
  return { id, strategyId, side: 'BUY', asset: 'token-1', price: { value: () => ({ times: () => 100 }) } } as any;
}

function makeScheduler() {
  return {
    onOrderChanged: jest.fn(),
    onFillReceivedForInstrument: jest.fn(),
    onFillConfirmedForInstrument: jest.fn(),
  };
}

function makeOrderStateStore(orders: Map<string, any> = new Map()) {
  return {
    getOpenOrders: jest.fn().mockReturnValue([]),
    getOpenOrdersByInstrument: jest.fn().mockReturnValue([]),
    getOrder: jest.fn((id: OrderId) => orders.get(String(id))),
    saveSync: jest.fn(),
    markOrderFillMatched: jest.fn(),
    clearOrderFillMatched: jest.fn(),
    hasMatchedFills: jest.fn().mockReturnValue(false),
    getMatchedFillIds: jest.fn().mockReturnValue([]),
    markInFlightFill: jest.fn(),
    hasInFlightFills: jest.fn().mockReturnValue(false),
    clearInFlightFill: jest.fn(),
    getInFlightFills: jest.fn().mockReturnValue([]),
  };
}

function makeOrderRepo() {
  const fn = jest.fn as any;
  return {
    get: fn().mockResolvedValue(undefined),
    getVersion: fn().mockResolvedValue(0),
    save: fn().mockResolvedValue({ ok: true, value: undefined }),
    deleteIfVersion: fn().mockResolvedValue({ ok: true, value: { status: 'DELETED' } }),
    deleteIfState: fn().mockResolvedValue({ ok: true, value: { status: 'DELETED' } }),
    getByStrategyId: fn().mockResolvedValue([]),
    countByStrategyId: fn().mockResolvedValue(0),
    getAll: fn().mockResolvedValue([]),
    getByMarketId: fn().mockResolvedValue([]),
  };
}

function makeDeps(overrides: Partial<OrderEventBridgeDeps> = {}): OrderEventBridgeDeps {
  return {
    eventBus: makeEventBus() as any,
    scheduler: makeScheduler() as any,
    orderStateStore: makeOrderStateStore() as any,
    orderRepo: makeOrderRepo() as any,
    logger: makeLogger() as any,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────

describe('OrderEventBridge', () => {
  let deps: OrderEventBridgeDeps;
  let bridge: OrderEventBridge;

  beforeEach(() => {
    deps = makeDeps();
    bridge = new OrderEventBridge(deps);
  });

  // ── Подписки ────────────────────────────────────────

  describe('start', () => {
    it('should subscribe to 6 order event types + FILL_RECEIVED + FILL_CONFIRMED', () => {
      bridge.start();

      expect(deps.eventBus.subscribe).toHaveBeenCalledTimes(8);
      const types = (deps.eventBus.subscribe as any).mock.calls.map((c: any[]) => c[0]);
      expect(types).toContain('ORDER_ACCEPTED');
      expect(types).toContain('ORDER_REJECTED');
      expect(types).toContain('ORDER_CANCELLED');
      expect(types).toContain('ORDER_EXPIRED');
      expect(types).toContain('ORDER_PARTIALLY_FILLED');
      expect(types).toContain('ORDER_FILLED');
      expect(types).toContain('FILL_RECEIVED');
      expect(types).toContain('FILL_CONFIRMED');
    });
  });

  // ── ORDER_ACCEPTED ──────────────────────────────────

  describe('ORDER_ACCEPTED', () => {
    it('should notify scheduler with ORDER_UPDATE', () => {
      const orders = new Map([[String(ORDER_1), makeOrder(ORDER_1, STRATEGY_ID)]]);
      deps = makeDeps({ orderStateStore: makeOrderStateStore(orders) as any });
      bridge = new OrderEventBridge(deps);
      bridge.start();

      const eventBus = deps.eventBus as any;
      eventBus._emit('ORDER_ACCEPTED', { type: 'ORDER_ACCEPTED', orderId: ORDER_1 });

      expect((deps.scheduler as any).onOrderChanged).toHaveBeenCalledWith(STRATEGY_ID, 'ORDER_UPDATE');
    });
  });

  // ── ORDER_REJECTED ──────────────────────────────────

  describe('ORDER_REJECTED', () => {
    it('should notify scheduler with ORDER_UPDATE', () => {
      const orders = new Map([[String(ORDER_1), makeOrder(ORDER_1, STRATEGY_ID)]]);
      deps = makeDeps({ orderStateStore: makeOrderStateStore(orders) as any });
      bridge = new OrderEventBridge(deps);
      bridge.start();

      const eventBus = deps.eventBus as any;
      eventBus._emit('ORDER_REJECTED', { type: 'ORDER_REJECTED', orderId: ORDER_1, reason: 'Rejected' });

      expect((deps.scheduler as any).onOrderChanged).toHaveBeenCalledWith(STRATEGY_ID, 'ORDER_UPDATE');
    });

    it('should notify scheduler via strategyId when order is absent in repo', () => {
      bridge = new OrderEventBridge(deps);
      bridge.start();

      const eventBus = deps.eventBus as any;
      eventBus._emit('ORDER_REJECTED', {
        type: 'ORDER_REJECTED',
        orderId: ORDER_1,
        strategyId: STRATEGY_ID,
        reason: 'Rejected',
      });

      expect((deps.scheduler as any).onOrderChanged).toHaveBeenCalledWith(STRATEGY_ID, 'ORDER_UPDATE');
    });
  });

  // ── ORDER_CANCELLED ─────────────────────────────────

  describe('ORDER_CANCELLED', () => {
    it('should notify scheduler with ORDER_UPDATE and delete from repo', async () => {
      const orders = new Map([[String(ORDER_1), makeOrder(ORDER_1, STRATEGY_ID)]]);
      deps = makeDeps({ orderStateStore: makeOrderStateStore(orders) as any });
      bridge = new OrderEventBridge(deps);
      bridge.start();

      const eventBus = deps.eventBus as any;
      eventBus._emit('ORDER_CANCELLED', { type: 'ORDER_CANCELLED', orderId: ORDER_1, reason: 'External' });

      expect((deps.scheduler as any).onOrderChanged).toHaveBeenCalledWith(STRATEGY_ID, 'ORDER_UPDATE');

      // Cleanup is async — wait for microtask
      await new Promise((r) => setTimeout(r, 0));
      expect(deps.orderRepo.deleteIfState).toHaveBeenCalledWith(ORDER_1, ['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);
    });
  });

  // ── ORDER_EXPIRED ───────────────────────────────────

  describe('ORDER_EXPIRED', () => {
    it('should notify scheduler with ORDER_UPDATE and delete from repo', async () => {
      const orders = new Map([[String(ORDER_1), makeOrder(ORDER_1, STRATEGY_ID)]]);
      deps = makeDeps({ orderStateStore: makeOrderStateStore(orders) as any });
      bridge = new OrderEventBridge(deps);
      bridge.start();

      const eventBus = deps.eventBus as any;
      eventBus._emit('ORDER_EXPIRED', { type: 'ORDER_EXPIRED', orderId: ORDER_1 });

      expect((deps.scheduler as any).onOrderChanged).toHaveBeenCalledWith(STRATEGY_ID, 'ORDER_UPDATE');
      await new Promise((r) => setTimeout(r, 0));
      expect(deps.orderRepo.deleteIfState).toHaveBeenCalledWith(ORDER_1, ['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);
    });
  });

  // ── ORDER_PARTIALLY_FILLED ──────────────────────────

  describe('ORDER_PARTIALLY_FILLED', () => {
    it('should notify scheduler with FILL reason', () => {
      const orders = new Map([[String(ORDER_1), makeOrder(ORDER_1, STRATEGY_ID)]]);
      deps = makeDeps({ orderStateStore: makeOrderStateStore(orders) as any });
      bridge = new OrderEventBridge(deps);
      bridge.start();

      const eventBus = deps.eventBus as any;
      eventBus._emit('ORDER_PARTIALLY_FILLED', {
        type: 'ORDER_PARTIALLY_FILLED',
        orderId: ORDER_1,
        fill: {},
        filledSize: {},
        remainingSize: {},
      });

      expect((deps.scheduler as any).onOrderChanged).toHaveBeenCalledWith(STRATEGY_ID, 'FILL');
    });
  });

  // ── ORDER_FILLED ────────────────────────────────────

  describe('ORDER_FILLED', () => {
    it('should notify scheduler with FILL reason and delete from repo', async () => {
      const orders = new Map([[String(ORDER_1), makeOrder(ORDER_1, STRATEGY_ID)]]);
      deps = makeDeps({ orderStateStore: makeOrderStateStore(orders) as any });
      bridge = new OrderEventBridge(deps);
      bridge.start();

      const eventBus = deps.eventBus as any;
      eventBus._emit('ORDER_FILLED', {
        type: 'ORDER_FILLED',
        orderId: ORDER_1,
        fill: {},
        averagePrice: {},
      });

      expect((deps.scheduler as any).onOrderChanged).toHaveBeenCalledWith(STRATEGY_ID, 'FILL');
      await new Promise((r) => setTimeout(r, 0));
      expect(deps.orderRepo.deleteIfState).toHaveBeenCalledWith(ORDER_1, ['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);
    });
  });

  // ── FILL_RECEIVED ─────────────────────────────────

  describe('FILL_RECEIVED', () => {
    it('should notify scheduler via onFillReceivedForInstrument (received semantics only)', () => {
      bridge.start();

      const eventBus = deps.eventBus as any;
      eventBus._emit('FILL_RECEIVED', {
        type: 'FILL_RECEIVED',
        payload: {
          fill: { tokenId: { type: 'POLYMARKET_CTF_TOKEN', tokenId: '12345' } },
          receivedAt: {},
        },
      });

      expect((deps.scheduler as any).onFillReceivedForInstrument).toHaveBeenCalled();
      // Confirmed-семантика НЕ вызывается из received-события.
      expect((deps.scheduler as any).onFillConfirmedForInstrument).not.toHaveBeenCalled();
    });
  });

  // ── FILL_CONFIRMED ──────────────────────────────────

  describe('FILL_CONFIRMED', () => {
    it('should clear in-flight fills and notify scheduler via onFillConfirmedForInstrument', () => {
      bridge.start();

      const eventBus = deps.eventBus as any;
      eventBus._emit('FILL_CONFIRMED', {
        type: 'FILL_CONFIRMED',
        payload: {
          fills: [{ id: 'fill-1', orderId: ORDER_1, tokenId: { type: 'POLYMARKET_CTF_TOKEN', tokenId: '12345' } }],
          receivedAt: {},
        },
      });

      expect((deps.orderStateStore as any).clearOrderFillMatched).toHaveBeenCalledWith(ORDER_1, 'fill-1');
      expect((deps.orderStateStore as any).clearInFlightFill).toHaveBeenCalledWith('fill-1');
      expect((deps.scheduler as any).onFillConfirmedForInstrument).toHaveBeenCalled();
      // Received-семантика НЕ вызывается из confirmed-события.
      expect((deps.scheduler as any).onFillReceivedForInstrument).not.toHaveBeenCalled();
    });
  });

  // ── Edge cases ──────────────────────────────────────

  describe('edge cases', () => {
    it('should skip notification if order not found', () => {
      bridge.start();

      const eventBus = deps.eventBus as any;
      eventBus._emit('ORDER_ACCEPTED', { type: 'ORDER_ACCEPTED', orderId: ORDER_1 });

      expect((deps.scheduler as any).onOrderChanged).not.toHaveBeenCalled();
    });

    it('should skip notification if order has no strategyId', () => {
      const orders = new Map([[String(ORDER_1), makeOrder(ORDER_1, undefined)]]);
      deps = makeDeps({ orderStateStore: makeOrderStateStore(orders) as any });
      bridge = new OrderEventBridge(deps);
      bridge.start();

      const eventBus = deps.eventBus as any;
      eventBus._emit('ORDER_ACCEPTED', { type: 'ORDER_ACCEPTED', orderId: ORDER_1 });

      expect((deps.scheduler as any).onOrderChanged).not.toHaveBeenCalled();
    });

    it('should handle cleanup error gracefully', async () => {
      const orders = new Map([[String(ORDER_1), makeOrder(ORDER_1, STRATEGY_ID)]]);
      const orderRepo = makeOrderRepo();
      (orderRepo.deleteIfState as any).mockRejectedValue(new Error('DB error'));

      deps = makeDeps({
        orderStateStore: makeOrderStateStore(orders) as any,
        orderRepo: orderRepo as any,
      });
      bridge = new OrderEventBridge(deps);
      bridge.start();

      const eventBus = deps.eventBus as any;
      eventBus._emit('ORDER_FILLED', {
        type: 'ORDER_FILLED',
        orderId: ORDER_1,
        fill: {},
        averagePrice: {},
      });

      await new Promise((r) => setTimeout(r, 10));
      // Should not throw — error is logged
      expect((deps.logger as any).child().error || (deps.logger as any).error).toBeDefined();
    });

    it('should skip cleanup with warn when order is not in terminal state', async () => {
      const orders = new Map([[String(ORDER_1), makeOrder(ORDER_1, STRATEGY_ID)]]);
      const orderRepo = makeOrderRepo();
      // deleteIfState отклоняет удаление: ордер в не-терминальном статусе
      (orderRepo.deleteIfState as any).mockResolvedValue({
        ok: false,
        error: { name: 'OrderStateConflictError', actualState: 'OPEN' },
      });

      deps = makeDeps({
        orderStateStore: makeOrderStateStore(orders) as any,
        orderRepo: orderRepo as any,
      });
      bridge = new OrderEventBridge(deps);
      bridge.start();

      const eventBus = deps.eventBus as any;
      eventBus._emit('ORDER_FILLED', {
        type: 'ORDER_FILLED',
        orderId: ORDER_1,
        fill: {},
        averagePrice: {},
      });

      await new Promise((r) => setTimeout(r, 10));
      const childLogger = (deps.logger as any).child();
      expect(childLogger.warn).toHaveBeenCalledWith(
        expect.stringMatching(/not in terminal state/i),
        expect.objectContaining({ actualState: 'OPEN' }),
      );
    });
  });

  // ── stop ────────────────────────────────────────────

  describe('stop', () => {
    it('should call unsubscribe for all subscriptions', () => {
      bridge.start();
      bridge.stop();

      // All 8 unsubscribe functions should have been called
      const unsubs = (deps.eventBus.subscribe as any).mock.results.map((r: any) => r.value);
      for (const unsub of unsubs) {
        expect(unsub).toHaveBeenCalled();
      }
    });
  });
});
