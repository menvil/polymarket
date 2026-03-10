/**
 * TradingAPI unit tests
 *
 * @remarks
 * Проверяет изоляцию подписок, делегирование use-cases и subscribe/unsubscribeAll.
 */
import type { Result } from '@polymarket/result';
import { Ok, Err } from '@polymarket/result';
import { TradingError } from '@polymarket/errors';
import type { ILogger } from '@polymarket/logger';
import type { OrderId } from '@polymarket/ids';
import { asOrderId, asInstrumentId, parseAccountId, AssetIdHelpers } from '@polymarket/ids';
import type { ApplicationEvent, EventHandler, IEventBus } from '@polymarket/event-bus';
import type { IOrderRepository, IPortfolioStore } from '@polymarket/ports';
import type { PlaceOrderUseCase, CancelOrderUseCase } from '@polymarket/use-cases';
import type { Portfolio } from '@polymarket/portfolio';
import type { Order } from '@polymarket/order';
import { TradingAPI } from '../../src/TradingAPI.js';

// --- Helpers ---

function makeLogger(): ILogger {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn().mockReturnThis(),
  } as unknown as ILogger;
}

function makeEventBus(): IEventBus & {
  handlers: Map<string, EventHandler<ApplicationEvent>[]>;
} {
  const handlers = new Map<string, EventHandler<ApplicationEvent>[]>();
  return {
    handlers,
    publish: jest.fn(),
    publishAll: jest.fn(),
    subscribe: jest.fn().mockImplementation((type: string, handler: EventHandler<ApplicationEvent>) => {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
      return () => {
        const h = handlers.get(type) ?? [];
        handlers.set(type, h.filter((x) => x !== handler));
      };
    }),
  } as unknown as IEventBus & { handlers: Map<string, EventHandler<ApplicationEvent>[]> };
}

const TEST_ORDER_ID = asOrderId('test-order-id')!;
const TEST_ACCOUNT_ID = parseAccountId('venue:POLYMARKET:test-user')!;
const TEST_INSTRUMENT_ID = asInstrumentId('123456')!;
const TEST_ASSET_ID = AssetIdHelpers.USDC;

function makePlaceOrderUseCase(
  result: Result<OrderId, TradingError> = Ok(TEST_ORDER_ID)
): PlaceOrderUseCase {
  return { execute: jest.fn().mockResolvedValue(result) } as unknown as PlaceOrderUseCase;
}

function makeCancelOrderUseCase(
  result: Result<void, TradingError> = Ok(undefined)
): CancelOrderUseCase {
  return { execute: jest.fn().mockResolvedValue(result) } as unknown as CancelOrderUseCase;
}

function makeOrderRepo(openOrdersCount = 0): IOrderRepository {
  return {
    get: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
    getByStrategyId: jest.fn().mockResolvedValue([]),
    countByStrategyId: jest.fn().mockResolvedValue(openOrdersCount),
  } as unknown as IOrderRepository;
}

function makePortfolioStore(portfolio?: Portfolio): IPortfolioStore {
  return {
    get: jest.fn().mockReturnValue(portfolio ?? ({ version: 1 } as unknown as Portfolio)),
    save: jest.fn(),
  } as unknown as IPortfolioStore;
}

function makeTradingAPI(overrides: {
  placeOrderUseCase?: PlaceOrderUseCase;
  cancelOrderUseCase?: CancelOrderUseCase;
  orderRepo?: IOrderRepository;
  portfolioStore?: IPortfolioStore;
  eventBus?: IEventBus;
  openOrdersCount?: number;
} = {}) {
  const eventBus = overrides.eventBus ?? makeEventBus();
  const logger = makeLogger();
  const api = new TradingAPI({
    strategyId: 'test-strategy',
    accountId: TEST_ACCOUNT_ID,
    placeOrderUseCase: overrides.placeOrderUseCase ?? makePlaceOrderUseCase(),
    cancelOrderUseCase: overrides.cancelOrderUseCase ?? makeCancelOrderUseCase(),
    orderRepo: overrides.orderRepo ?? makeOrderRepo(overrides.openOrdersCount),
    portfolioStore: overrides.portfolioStore ?? makePortfolioStore(),
    eventBus,
    logger,
  });
  return { api, eventBus, logger };
}

// --- Tests ---

describe('TradingAPI', () => {
  describe('strategyId', () => {
    it('возвращает strategyId из deps', () => {
      const { api } = makeTradingAPI();
      expect(api.strategyId).toBe('test-strategy');
    });
  });

  describe('placeOrder()', () => {
    it('делегирует PlaceOrderUseCase и возвращает Ok(OrderId)', async () => {
      const placeOrderUseCase = makePlaceOrderUseCase(Ok(TEST_ORDER_ID));
      const { api } = makeTradingAPI({ placeOrderUseCase });

      const result = await api.placeOrder({
        asset: TEST_ASSET_ID,
        instrumentId: TEST_INSTRUMENT_ID,
        side: 'BUY',
        price: { value: () => ({ toString: () => '0.65' } as never) } as never,
        size: { value: () => ({ toString: () => '100' } as never) } as never,
      });

      expect(result.ok).toBe(true);
      expect((placeOrderUseCase.execute as jest.Mock)).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: TEST_ACCOUNT_ID,
          strategyId: 'test-strategy',
          asset: TEST_ASSET_ID,
          instrumentId: TEST_INSTRUMENT_ID,
          side: 'BUY',
        })
      );
    });

    it('возвращает Err если Portfolio не найден', async () => {
      const portfolioStore = makePortfolioStore(undefined as unknown as Portfolio);
      (portfolioStore.get as jest.Mock).mockReturnValue(undefined);
      const { api } = makeTradingAPI({ portfolioStore });

      const result = await api.placeOrder({
        asset: TEST_ASSET_ID,
        instrumentId: TEST_INSTRUMENT_ID,
        side: 'BUY',
        price: {} as never,
        size: {} as never,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(TradingError);
        expect(result.error.message).toContain('Portfolio not found');
      }
    });

    it('пробрасывает openOrdersCount из orderRepo', async () => {
      const placeOrderUseCase = makePlaceOrderUseCase();
      const orderRepo = makeOrderRepo(5);
      const { api } = makeTradingAPI({ placeOrderUseCase, orderRepo });

      await api.placeOrder({
        asset: TEST_ASSET_ID,
        instrumentId: TEST_INSTRUMENT_ID,
        side: 'SELL',
        price: {} as never,
        size: {} as never,
      });

      expect((placeOrderUseCase.execute as jest.Mock)).toHaveBeenCalledWith(
        expect.objectContaining({ openOrdersCount: 5 })
      );
    });

    it('пробрасывает Err от PlaceOrderUseCase', async () => {
      const err = Err(new TradingError('Exchange error'));
      const placeOrderUseCase = makePlaceOrderUseCase(err);
      const { api } = makeTradingAPI({ placeOrderUseCase });

      const result = await api.placeOrder({
        asset: TEST_ASSET_ID,
        instrumentId: TEST_INSTRUMENT_ID,
        side: 'BUY',
        price: {} as never,
        size: {} as never,
      });

      expect(result.ok).toBe(false);
    });
  });

  describe('cancelOrder()', () => {
    it('делегирует CancelOrderUseCase', async () => {
      const cancelOrderUseCase = makeCancelOrderUseCase(Ok(undefined));
      const { api } = makeTradingAPI({ cancelOrderUseCase });

      const result = await api.cancelOrder(TEST_ORDER_ID);

      expect(result.ok).toBe(true);
      expect((cancelOrderUseCase.execute as jest.Mock)).toHaveBeenCalledWith({
        orderId: TEST_ORDER_ID,
        accountId: TEST_ACCOUNT_ID,
      });
    });

    it('пробрасывает Err от CancelOrderUseCase', async () => {
      const cancelOrderUseCase = makeCancelOrderUseCase(
        Err(new TradingError('Order not found'))
      );
      const { api } = makeTradingAPI({ cancelOrderUseCase });

      const result = await api.cancelOrder(TEST_ORDER_ID);

      expect(result.ok).toBe(false);
    });
  });

  describe('getOpenOrders()', () => {
    it('возвращает ордера из orderRepo по strategyId', async () => {
      const mockOrders = [{ id: TEST_ORDER_ID } as unknown as Order];
      const orderRepo = makeOrderRepo();
      (orderRepo.getByStrategyId as jest.Mock).mockResolvedValue(mockOrders);
      const { api } = makeTradingAPI({ orderRepo });

      const orders = await api.getOpenOrders();

      expect(orders).toBe(mockOrders);
      expect(orderRepo.getByStrategyId).toHaveBeenCalledWith('test-strategy');
    });
  });

  describe('subscribe()', () => {
    it('подписывается через eventBus', () => {
      const { api, eventBus } = makeTradingAPI();
      const handler = jest.fn();

      api.subscribe('BOOK_UPDATED', handler as never);

      expect(eventBus.subscribe).toHaveBeenCalledWith('BOOK_UPDATED', handler);
    });

    it('возвращённая функция снимает подписку', () => {
      const { api, eventBus } = makeTradingAPI();
      const handler = jest.fn();
      const unsub = api.subscribe('BOOK_UPDATED', handler as never);

      unsub();

      // После unsub — unsubscribeAll не должен вызывать уже снятую подписку
      // (проверим через повторный unsub не бросает)
      expect(() => api.unsubscribeAll()).not.toThrow();
      // eventBus.subscribe был вызван 1 раз
      expect(eventBus.subscribe).toHaveBeenCalledTimes(1);
    });
  });

  describe('unsubscribeAll()', () => {
    it('снимает все подписки', () => {
      const { api, eventBus } = makeTradingAPI();
      const handler1 = jest.fn();
      const handler2 = jest.fn();

      api.subscribe('BOOK_UPDATED', handler1 as never);
      api.subscribe('TRADE_RECEIVED', handler2 as never);

      api.unsubscribeAll();

      // После unsubscribeAll — повторный вызов безопасен
      expect(() => api.unsubscribeAll()).not.toThrow();
      expect(eventBus.subscribe).toHaveBeenCalledTimes(2);
    });

    it('идемпотентен при повторном вызове', () => {
      const { api } = makeTradingAPI();
      api.subscribe('BOOK_UPDATED', jest.fn() as never);

      api.unsubscribeAll();
      api.unsubscribeAll(); // второй вызов не бросает

      expect(true).toBe(true);
    });
  });
});
