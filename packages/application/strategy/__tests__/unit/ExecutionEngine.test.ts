import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import Decimal from 'decimal.js';
import { Ok, Err } from '@polymarket/result';
import { asOrderId } from '@polymarket/ids';
import type { OrderId, AccountId, InstrumentId, AssetId } from '@polymarket/ids';
import { Price, Quantity } from '@polymarket/value-objects';
import type { Side } from '@polymarket/value-objects';
import { TradingError } from '@polymarket/errors';
import { ExecutionEngine } from '../../src/ExecutionEngine.js';
import type { ExecutionEngineDeps, ExecutionContext } from '../../src/ExecutionEngine.js';
import type { StrategyIntent } from '../../src/types/StrategyIntent.js';

// ── Constants ──────────────────────────────────────────────

const STRATEGY_ID = 'strategy-1';
const ACCOUNT_ID = 'venue:POLYMARKET:test' as unknown as AccountId;
const INSTRUMENT_ID = 'token-1' as unknown as InstrumentId;
const ASSET_ID = 'asset-1' as unknown as AssetId;

const ORDER_1 = asOrderId('order-1')!;
const ORDER_2 = asOrderId('order-2')!;
const ORDER_3 = asOrderId('order-3')!;

const BUY: Side = 'BUY';
const SELL: Side = 'SELL';

const PRICE_55 = Price.of(new Decimal('0.55'));
const PRICE_65 = Price.of(new Decimal('0.65'));
const SIZE_100 = Quantity.of(new Decimal('100'));

// ── Helpers ────────────────────────────────────────────────

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

function makePortfolio() {
  return {} as any; // Portfolio is only passed through to PlaceOrderUseCase
}

function makeOrder(id: OrderId) {
  return { id } as any;
}

function makeCatalog(minOrderSize?: Quantity, minOrderValue?: Quantity) {
  return {
    get: jest.fn().mockReturnValue(
      minOrderSize ? { minOrderSize, minOrderValue: minOrderValue ?? Quantity.of(new Decimal('1')) } : undefined,
    ),
    getByMarketId: jest.fn().mockReturnValue(undefined),
    getAll: jest.fn().mockReturnValue([]),
    register: jest.fn(),
    remove: jest.fn(),
    clear: jest.fn(),
  } as any;
}

function makeDeps(overrides: Partial<ExecutionEngineDeps> = {}): ExecutionEngineDeps {
  const fn = jest.fn as any;
  return {
    placeOrderUseCase: { execute: fn().mockResolvedValue(Ok(ORDER_1)) } as any,
    cancelOrderUseCase: { execute: fn().mockResolvedValue(Ok(undefined)) } as any,
    orderRepo: {
      getByStrategyId: fn().mockResolvedValue([]),
      countByStrategyId: fn().mockResolvedValue(0),
    } as any,
    portfolioStore: {
      get: fn().mockReturnValue(makePortfolio()),
    } as any,
    catalog: makeCatalog(),
    logger: makeLogger() as any,
    ...overrides,
  };
}

function makeCtx(): ExecutionContext {
  return {
    strategyId: STRATEGY_ID,
    accountId: ACCOUNT_ID,
    instrumentId: INSTRUMENT_ID,
    asset: ASSET_ID,
  };
}

// ── Tests ──────────────────────────────────────────────────

describe('ExecutionEngine', () => {
  let deps: ExecutionEngineDeps;
  let engine: ExecutionEngine;
  let ctx: ExecutionContext;

  beforeEach(() => {
    deps = makeDeps();
    engine = new ExecutionEngine(deps);
    ctx = makeCtx();
  });

  // ── Пустые intents ───────────────────────────────────

  describe('empty intents', () => {
    it('should return zero report for empty array', async () => {
      const report = await engine.execute(ctx, []);

      expect(report.placed).toBe(0);
      expect(report.cancelled).toBe(0);
      expect(report.skipped).toBe(0);
      expect(report.errors).toHaveLength(0);
    });
  });

  // ── PLACE ────────────────────────────────────────────

  describe('PLACE', () => {
    it('should call placeOrderUseCase for PLACE intent', async () => {
      const intents: StrategyIntent[] = [
        { type: 'PLACE', side: BUY, price: PRICE_55, size: SIZE_100 },
      ];

      const report = await engine.execute(ctx, intents);

      expect(report.placed).toBe(1);
      expect(report.errors).toHaveLength(0);
      expect(deps.placeOrderUseCase.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: ACCOUNT_ID,
          instrumentId: INSTRUMENT_ID,
          asset: ASSET_ID,
          side: BUY,
          price: PRICE_55,
          size: SIZE_100,
          strategyId: STRATEGY_ID,
        }),
      );
    });

    it('should execute multiple places sequentially', async () => {
      const callOrder: string[] = [];
      (deps.placeOrderUseCase as any).execute.mockImplementation(async (input: any) => {
        callOrder.push(input.side);
        return Ok(ORDER_1);
      });

      const intents: StrategyIntent[] = [
        { type: 'PLACE', side: BUY, price: PRICE_55, size: SIZE_100 },
        { type: 'PLACE', side: SELL, price: PRICE_65, size: SIZE_100 },
      ];

      const report = await engine.execute(ctx, intents);

      expect(report.placed).toBe(2);
      expect(callOrder).toEqual(['BUY', 'SELL']);
    });

    it('should report error when portfolio not found', async () => {
      (deps.portfolioStore as any).get.mockReturnValue(undefined);

      const intents: StrategyIntent[] = [
        { type: 'PLACE', side: BUY, price: PRICE_55, size: SIZE_100 },
      ];

      const report = await engine.execute(ctx, intents);

      expect(report.placed).toBe(0);
      expect(report.errors).toHaveLength(1);
      expect(deps.placeOrderUseCase.execute).not.toHaveBeenCalled();
    });

    it('should report error when placeOrderUseCase fails', async () => {
      (deps.placeOrderUseCase as any).execute.mockResolvedValue(
        Err(new TradingError('Risk violation')),
      );

      const intents: StrategyIntent[] = [
        { type: 'PLACE', side: BUY, price: PRICE_55, size: SIZE_100 },
      ];

      const report = await engine.execute(ctx, intents);

      expect(report.placed).toBe(0);
      expect(report.errors).toHaveLength(1);
    });
  });

  // ── CANCEL ───────────────────────────────────────────

  describe('CANCEL', () => {
    it('should call cancelOrderUseCase for CANCEL intent', async () => {
      const intents: StrategyIntent[] = [
        { type: 'CANCEL', orderId: ORDER_1 },
      ];

      const report = await engine.execute(ctx, intents);

      expect(report.cancelled).toBe(1);
      expect(report.errors).toHaveLength(0);
      expect(deps.cancelOrderUseCase.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          orderId: ORDER_1,
          accountId: ACCOUNT_ID,
        }),
      );
    });

    it('should execute multiple cancels in parallel', async () => {
      const intents: StrategyIntent[] = [
        { type: 'CANCEL', orderId: ORDER_1 },
        { type: 'CANCEL', orderId: ORDER_2 },
      ];

      const report = await engine.execute(ctx, intents);

      expect(report.cancelled).toBe(2);
      expect(deps.cancelOrderUseCase.execute).toHaveBeenCalledTimes(2);
    });

    it('should report error when cancel fails', async () => {
      (deps.cancelOrderUseCase as any).execute.mockResolvedValue(
        Err(new TradingError('Order not found')),
      );

      const intents: StrategyIntent[] = [
        { type: 'CANCEL', orderId: ORDER_1 },
      ];

      const report = await engine.execute(ctx, intents);

      expect(report.cancelled).toBe(0);
      expect(report.errors).toHaveLength(1);
    });
  });

  // ── CANCEL_ALL ───────────────────────────────────────

  describe('CANCEL_ALL', () => {
    it('should cancel all open orders from repo', async () => {
      (deps.orderRepo as any).getByStrategyId.mockResolvedValue([
        makeOrder(ORDER_1),
        makeOrder(ORDER_2),
        makeOrder(ORDER_3),
      ]);

      const intents: StrategyIntent[] = [{ type: 'CANCEL_ALL' }];

      const report = await engine.execute(ctx, intents);

      expect(report.cancelled).toBe(3);
      expect(deps.cancelOrderUseCase.execute).toHaveBeenCalledTimes(3);
    });

    it('should be no-op when no open orders', async () => {
      (deps.orderRepo as any).getByStrategyId.mockResolvedValue([]);

      const intents: StrategyIntent[] = [{ type: 'CANCEL_ALL' }];

      const report = await engine.execute(ctx, intents);

      expect(report.cancelled).toBe(0);
      expect(report.errors).toHaveLength(0);
    });
  });

  // ── Нормализация ─────────────────────────────────────

  describe('normalization', () => {
    it('should remove individual CANCELs when CANCEL_ALL present', async () => {
      (deps.orderRepo as any).getByStrategyId.mockResolvedValue([
        makeOrder(ORDER_1),
      ]);

      const intents: StrategyIntent[] = [
        { type: 'CANCEL_ALL' },
        { type: 'CANCEL', orderId: ORDER_1 },  // дубль — должен быть удалён
        { type: 'CANCEL', orderId: ORDER_2 },  // дубль — должен быть удалён
      ];

      const report = await engine.execute(ctx, intents);

      // Только 1 cancel (из CANCEL_ALL → getByStrategyId = [ORDER_1])
      expect(deps.cancelOrderUseCase.execute).toHaveBeenCalledTimes(1);
      expect(report.cancelled).toBe(1);
    });

    it('should dedupe CANCEL by orderId', async () => {
      const intents: StrategyIntent[] = [
        { type: 'CANCEL', orderId: ORDER_1 },
        { type: 'CANCEL', orderId: ORDER_1 },  // дубль
        { type: 'CANCEL', orderId: ORDER_2 },
      ];

      const report = await engine.execute(ctx, intents);

      // 2 unique cancels (ORDER_1, ORDER_2)
      expect(deps.cancelOrderUseCase.execute).toHaveBeenCalledTimes(2);
      expect(report.cancelled).toBe(2);
    });

    it('should dedupe PLACE by side:price — last wins', async () => {
      const size50 = Quantity.of(new Decimal('50'));
      const size200 = Quantity.of(new Decimal('200'));

      const intents: StrategyIntent[] = [
        { type: 'PLACE', side: BUY, price: PRICE_55, size: SIZE_100 },
        { type: 'PLACE', side: BUY, price: PRICE_55, size: size200 },  // same side:price — overwrites
        { type: 'PLACE', side: SELL, price: PRICE_65, size: size50 },
      ];

      const report = await engine.execute(ctx, intents);

      // 2 unique places: BUY@0.55 (size 200), SELL@0.65 (size 50)
      expect(report.placed).toBe(2);
      expect(deps.placeOrderUseCase.execute).toHaveBeenCalledTimes(2);

      // Verify the last BUY@0.55 won (size 200)
      const calls = (deps.placeOrderUseCase as any).execute.mock.calls;
      const buyCall = calls.find((c: any[]) => c[0].side === 'BUY') as any[];
      expect(buyCall[0].size).toBe(size200);
    });
  });

  // ── Порядок: cancels before places ───────────────────

  describe('execution order', () => {
    it('should execute cancels before places', async () => {
      const order: string[] = [];

      (deps.cancelOrderUseCase as any).execute.mockImplementation(async () => {
        order.push('cancel');
        return Ok(undefined);
      });
      (deps.placeOrderUseCase as any).execute.mockImplementation(async () => {
        order.push('place');
        return Ok(ORDER_1);
      });

      const intents: StrategyIntent[] = [
        { type: 'PLACE', side: BUY, price: PRICE_55, size: SIZE_100 },
        { type: 'CANCEL', orderId: ORDER_1 },
      ];

      await engine.execute(ctx, intents);

      expect(order[0]).toBe('cancel');
      expect(order[1]).toBe('place');
    });
  });

  // ── Смешанный сценарий ───────────────────────────────

  describe('mixed scenario', () => {
    it('should handle CANCEL_ALL + PLACE correctly', async () => {
      (deps.orderRepo as any).getByStrategyId.mockResolvedValue([
        makeOrder(ORDER_1),
        makeOrder(ORDER_2),
      ]);

      const intents: StrategyIntent[] = [
        { type: 'CANCEL_ALL' },
        { type: 'PLACE', side: BUY, price: PRICE_55, size: SIZE_100 },
        { type: 'PLACE', side: SELL, price: PRICE_65, size: SIZE_100 },
      ];

      const report = await engine.execute(ctx, intents);

      expect(report.cancelled).toBe(2);
      expect(report.placed).toBe(2);
      expect(report.errors).toHaveLength(0);
    });

    it('should continue placing after partial cancel failure', async () => {
      (deps.cancelOrderUseCase as any).execute
        .mockResolvedValueOnce(Err(new TradingError('Not found')))
        .mockResolvedValueOnce(Ok(undefined));

      const intents: StrategyIntent[] = [
        { type: 'CANCEL', orderId: ORDER_1 },
        { type: 'CANCEL', orderId: ORDER_2 },
        { type: 'PLACE', side: BUY, price: PRICE_55, size: SIZE_100 },
      ];

      const report = await engine.execute(ctx, intents);

      expect(report.cancelled).toBe(1);
      expect(report.placed).toBe(1);
      expect(report.errors).toHaveLength(1);
    });
  });

  // ── Клампирование minOrderSize ───────────────────────────

  describe('minOrderSize clamping', () => {
    it('should use intent size when >= minOrderSize', async () => {
      const minOrderSize = Quantity.of(new Decimal('5'));
      deps = makeDeps({ catalog: makeCatalog(minOrderSize) });
      engine = new ExecutionEngine(deps);

      const size10 = Quantity.of(new Decimal('10'));
      await engine.execute(ctx, [{ type: 'PLACE', side: BUY, price: PRICE_55, size: size10 }]);

      const call = (deps.placeOrderUseCase.execute as ReturnType<typeof jest.fn>).mock.calls[0][0] as any;
      expect(call.size.toNumber()).toBe(10);
    });

    it('should clamp size to minOrderSize when intent size < minOrderSize', async () => {
      const minOrderSize = Quantity.of(new Decimal('5'));
      deps = makeDeps({ catalog: makeCatalog(minOrderSize) });
      engine = new ExecutionEngine(deps);

      const size2 = Quantity.of(new Decimal('2'));
      await engine.execute(ctx, [{ type: 'PLACE', side: BUY, price: PRICE_55, size: size2 }]);

      const call = (deps.placeOrderUseCase.execute as ReturnType<typeof jest.fn>).mock.calls[0][0] as any;
      expect(call.size.toNumber()).toBe(5);
    });

    it('should log warn when clamping occurs', async () => {
      const minOrderSize = Quantity.of(new Decimal('5'));
      deps = makeDeps({ catalog: makeCatalog(minOrderSize) });
      engine = new ExecutionEngine(deps);
      const logger = deps.logger as ReturnType<typeof makeLogger>;

      const size2 = Quantity.of(new Decimal('2'));
      await engine.execute(ctx, [{ type: 'PLACE', side: BUY, price: PRICE_55, size: size2 }]);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('clamping'),
        expect.objectContaining({ requested: 2, effective: 5 }),
      );
    });

    it('should use intent size when catalog returns undefined (unknown instrument)', async () => {
      deps = makeDeps({ catalog: makeCatalog(undefined) });
      engine = new ExecutionEngine(deps);

      const size2 = Quantity.of(new Decimal('2'));
      await engine.execute(ctx, [{ type: 'PLACE', side: BUY, price: PRICE_55, size: size2 }]);

      const call = (deps.placeOrderUseCase.execute as ReturnType<typeof jest.fn>).mock.calls[0][0] as any;
      expect(call.size.toNumber()).toBe(2);
    });
  });

  // ── Skip по позиционному лимиту ─────────────────────────

  describe('minOrderValue skip (neededSize > remainingCapacity)', () => {
    it('should skip and count as skipped when neededSizeForMinValue > remainingPositionCapacity', async () => {
      // price=0.045, minOrderValue=$1 → neededSize=ceil(1/0.045)=23
      // maxPositionSize=20, currentPosition=0 → remaining=20 < 23 → skip
      const minOrderSize = Quantity.of(new Decimal('1'));
      const minOrderValue = Quantity.of(new Decimal('1'));
      const lowPrice = Price.of(new Decimal('0.045'));
      const maxPositionSize = new Decimal(20);

      const portfolio = {
        getPosition: jest.fn().mockReturnValue(undefined), // нет позиции
      };

      deps = makeDeps({
        catalog: makeCatalog(minOrderSize, minOrderValue),
        maxPositionSize,
        portfolioStore: { get: jest.fn().mockReturnValue(portfolio) } as any,
      });
      engine = new ExecutionEngine(deps);

      const report = await engine.execute(ctx, [
        { type: 'PLACE', side: BUY, price: lowPrice, size: Quantity.of(new Decimal('5')) },
      ]);

      expect(report.placed).toBe(0);
      expect(report.skipped).toBe(1);
      expect(report.errors).toHaveLength(0);
      expect(deps.placeOrderUseCase.execute).not.toHaveBeenCalled();
    });

    it('should not skip when neededSizeForMinValue <= remainingPositionCapacity', async () => {
      // price=0.10, minOrderValue=$1 → neededSize=ceil(1/0.10)=10
      // maxPositionSize=20, currentPosition=0 → remaining=20 >= 10 → clamp and place
      const minOrderSize = Quantity.of(new Decimal('1'));
      const minOrderValue = Quantity.of(new Decimal('1'));
      const price = Price.of(new Decimal('0.10'));
      const maxPositionSize = new Decimal(20);

      const portfolio = {
        getPosition: jest.fn().mockReturnValue(undefined),
      };

      deps = makeDeps({
        catalog: makeCatalog(minOrderSize, minOrderValue),
        maxPositionSize,
        portfolioStore: { get: jest.fn().mockReturnValue(portfolio) } as any,
      });
      engine = new ExecutionEngine(deps);

      const report = await engine.execute(ctx, [
        { type: 'PLACE', side: BUY, price, size: Quantity.of(new Decimal('5')) },
      ]);

      expect(report.placed).toBe(1);
      expect(report.skipped).toBe(0);
      expect(report.errors).toHaveLength(0);
    });
  });

  // ── Клампирование minOrderValue ──────────────────────────

  describe('minOrderValue clamping (BUY: price × size >= minOrderValue)', () => {
    it('should clamp size up when price × size < minOrderValue', async () => {
      // price=0.01, size=5 → value=$0.05 < $1 → minSize=ceil(1/0.01)=100
      const minOrderSize = Quantity.of(new Decimal('1'));
      const minOrderValue = Quantity.of(new Decimal('1'));
      const lowPrice = Price.of(new Decimal('0.01'));
      deps = makeDeps({ catalog: makeCatalog(minOrderSize, minOrderValue) });
      engine = new ExecutionEngine(deps);

      await engine.execute(ctx, [{ type: 'PLACE', side: BUY, price: lowPrice, size: Quantity.of(new Decimal('5')) }]);

      const call = (deps.placeOrderUseCase.execute as ReturnType<typeof jest.fn>).mock.calls[0][0] as any;
      expect(call.size.toNumber()).toBe(100); // ceil(1 / 0.01) = 100
    });

    it('should not clamp when price × size >= minOrderValue', async () => {
      // price=0.55, size=2 → value=$1.10 >= $1 → no clamp
      const minOrderSize = Quantity.of(new Decimal('1'));
      const minOrderValue = Quantity.of(new Decimal('1'));
      deps = makeDeps({ catalog: makeCatalog(minOrderSize, minOrderValue) });
      engine = new ExecutionEngine(deps);

      await engine.execute(ctx, [{ type: 'PLACE', side: BUY, price: PRICE_55, size: Quantity.of(new Decimal('2')) }]);

      const call = (deps.placeOrderUseCase.execute as ReturnType<typeof jest.fn>).mock.calls[0][0] as any;
      expect(call.size.toNumber()).toBe(2);
    });

    it('should not apply minOrderValue clamp to SELL orders', async () => {
      // SELL: стратегия продаёт токены, minOrderValue не применяется
      const minOrderSize = Quantity.of(new Decimal('1'));
      const minOrderValue = Quantity.of(new Decimal('1'));
      const lowPrice = Price.of(new Decimal('0.01'));
      deps = makeDeps({ catalog: makeCatalog(minOrderSize, minOrderValue) });
      engine = new ExecutionEngine(deps);

      await engine.execute(ctx, [{ type: 'PLACE', side: SELL, price: lowPrice, size: Quantity.of(new Decimal('5')) }]);

      const call = (deps.placeOrderUseCase.execute as ReturnType<typeof jest.fn>).mock.calls[0][0] as any;
      expect(call.size.toNumber()).toBe(5); // нет клампирования для SELL
    });
  });

  // ── SELL: позиция меньше minOrderSize ───────────────────

  describe('SELL skip when position < minOrderSize', () => {
    it('should skip SELL when position qty < minOrderSize', async () => {
      // positionQty=0.21, minOrderSize=5 → skip вместо клампирования к 5
      // (клампирование привело бы к «Insufficient token balance: available 0.21, required 5»)
      const minOrderSize = Quantity.of(new Decimal('5'));
      const portfolio = {
        getPosition: jest.fn().mockReturnValue({
          quantity: Quantity.of(new Decimal('0.21')),
        }),
      };
      deps = makeDeps({
        catalog: makeCatalog(minOrderSize),
        portfolioStore: { get: jest.fn().mockReturnValue(portfolio) } as any,
      });
      engine = new ExecutionEngine(deps);

      const report = await engine.execute(ctx, [
        { type: 'PLACE', side: SELL, price: PRICE_65, size: Quantity.of(new Decimal('0.21')) },
      ]);

      expect(report.skipped).toBe(1);
      expect(report.placed).toBe(0);
      expect(report.errors).toHaveLength(0);
      // placeOrderUseCase не вызывается
      expect((deps.placeOrderUseCase.execute as ReturnType<typeof jest.fn>).mock.calls).toHaveLength(0);
    });

    it('should clamp and place SELL when position qty >= minOrderSize', async () => {
      // positionQty=10, minOrderSize=5, intent.size=3 → клампирование к 5, размещение
      const minOrderSize = Quantity.of(new Decimal('5'));
      const portfolio = {
        getPosition: jest.fn().mockReturnValue({
          quantity: Quantity.of(new Decimal('10')),
        }),
      };
      deps = makeDeps({
        catalog: makeCatalog(minOrderSize),
        portfolioStore: { get: jest.fn().mockReturnValue(portfolio) } as any,
      });
      engine = new ExecutionEngine(deps);

      const report = await engine.execute(ctx, [
        { type: 'PLACE', side: SELL, price: PRICE_65, size: Quantity.of(new Decimal('3')) },
      ]);

      expect(report.placed).toBe(1);
      expect(report.skipped).toBe(0);
      const call = (deps.placeOrderUseCase.execute as ReturnType<typeof jest.fn>).mock.calls[0][0] as any;
      expect(call.size.toNumber()).toBe(5); // клампировано к minOrderSize
    });

    it('should not skip SELL when position qty exactly equals minOrderSize', async () => {
      // positionQty=5 === minOrderSize=5 → не skip (достаточно для клампирования)
      const minOrderSize = Quantity.of(new Decimal('5'));
      const portfolio = {
        getPosition: jest.fn().mockReturnValue({
          quantity: Quantity.of(new Decimal('5')),
        }),
      };
      deps = makeDeps({
        catalog: makeCatalog(minOrderSize),
        portfolioStore: { get: jest.fn().mockReturnValue(portfolio) } as any,
      });
      engine = new ExecutionEngine(deps);

      const report = await engine.execute(ctx, [
        { type: 'PLACE', side: SELL, price: PRICE_65, size: Quantity.of(new Decimal('3')) },
      ]);

      expect(report.placed).toBe(1);
      expect(report.skipped).toBe(0);
    });
  });
});
