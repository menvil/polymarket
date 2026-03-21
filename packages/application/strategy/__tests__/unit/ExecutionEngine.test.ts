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

      // Cancel выполняется первым
      expect(order[0]).toBe('cancel');
      // Place пропущен из-за post-cancel cooldown (20s safety window)
      expect(order).toHaveLength(1);
    });

    it('should allow place after post-cancel cooldown is cleared', async () => {
      // Сначала cancel — устанавливает cooldown
      await engine.execute(ctx, [{ type: 'CANCEL', orderId: ORDER_1 }]);

      // Симулируем получение fill — сбрасывает cooldown
      engine.clearPostCancelCooldown(INSTRUMENT_ID);

      // Теперь place должен пройти
      const report = await engine.execute(ctx, [
        { type: 'PLACE', side: BUY, price: PRICE_55, size: SIZE_100 },
      ]);

      expect(report.placed).toBe(1);
    });
  });

  // ── Смешанный сценарий ───────────────────────────────

  describe('mixed scenario', () => {
    it('should handle CANCEL_ALL + PLACE — places skipped by post-cancel cooldown', async () => {
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
      // Places пропущены из-за post-cancel cooldown (20s safety window).
      // Стратегия поставит ордера на следующем тике после получения fill.
      expect(report.skipped).toBe(2);
      expect(report.placed).toBe(0);
      expect(report.errors).toHaveLength(0);
    });

    it('should handle CANCEL_ALL + PLACE after cooldown cleared', async () => {
      (deps.orderRepo as any).getByStrategyId.mockResolvedValue([
        makeOrder(ORDER_1),
        makeOrder(ORDER_2),
      ]);

      // Cancel all
      await engine.execute(ctx, [{ type: 'CANCEL_ALL' }]);

      // Симулируем fill — сбрасывает cooldown
      engine.clearPostCancelCooldown(INSTRUMENT_ID);

      // Теперь place проходят
      const report = await engine.execute(ctx, [
        { type: 'PLACE', side: BUY, price: PRICE_55, size: SIZE_100 },
        { type: 'PLACE', side: SELL, price: PRICE_65, size: SIZE_100 },
      ]);

      expect(report.placed).toBe(2);
    });

    it('should continue placing after partial cancel failure (no successful cancel = no cooldown)', async () => {
      // Оба cancel-а фейлятся → cooldown НЕ устанавливается
      (deps.cancelOrderUseCase as any).execute
        .mockResolvedValueOnce(Err(new TradingError('Not found')))
        .mockResolvedValueOnce(Err(new TradingError('Not found')));

      const intents: StrategyIntent[] = [
        { type: 'CANCEL', orderId: ORDER_1 },
        { type: 'CANCEL', orderId: ORDER_2 },
        { type: 'PLACE', side: BUY, price: PRICE_55, size: SIZE_100 },
      ];

      const report = await engine.execute(ctx, intents);

      expect(report.cancelled).toBe(0);
      expect(report.placed).toBe(1);
      expect(report.errors).toHaveLength(2);
    });

    it('should skip place when at least one cancel succeeds (cooldown set)', async () => {
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
      // Place пропущен — cooldown от успешного cancel ORDER_2
      expect(report.skipped).toBe(1);
      expect(report.placed).toBe(0);
      expect(report.errors).toHaveLength(1);
    });
  });

  // ── Валидация minOrderSize (reject-only) ──────────────

  describe('minOrderSize validation (reject, no clamping)', () => {
    it('should pass through intent size when >= minOrderSize', async () => {
      const minOrderSize = Quantity.of(new Decimal('5'));
      deps = makeDeps({ catalog: makeCatalog(minOrderSize) });
      engine = new ExecutionEngine(deps);

      const size10 = Quantity.of(new Decimal('10'));
      await engine.execute(ctx, [{ type: 'PLACE', side: BUY, price: PRICE_55, size: size10 }]);

      const call = (deps.placeOrderUseCase.execute as ReturnType<typeof jest.fn>).mock.calls[0][0] as any;
      expect(call.size.toNumber()).toBe(10);
    });

    it('should reject (skip) when intent size < minOrderSize', async () => {
      const minOrderSize = Quantity.of(new Decimal('5'));
      deps = makeDeps({ catalog: makeCatalog(minOrderSize) });
      engine = new ExecutionEngine(deps);

      const size2 = Quantity.of(new Decimal('2'));
      const report = await engine.execute(ctx, [{ type: 'PLACE', side: BUY, price: PRICE_55, size: size2 }]);

      expect(report.skipped).toBe(1);
      expect(report.placed).toBe(0);
      expect(deps.placeOrderUseCase.execute).not.toHaveBeenCalled();
    });

    it('should log warn when rejecting for minOrderSize', async () => {
      const minOrderSize = Quantity.of(new Decimal('5'));
      deps = makeDeps({ catalog: makeCatalog(minOrderSize) });
      engine = new ExecutionEngine(deps);
      const logger = deps.logger as ReturnType<typeof makeLogger>;

      const size2 = Quantity.of(new Decimal('2'));
      await engine.execute(ctx, [{ type: 'PLACE', side: BUY, price: PRICE_55, size: size2 }]);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('size below minOrderSize'),
        expect.objectContaining({ size: 2, minOrderSize: 5 }),
      );
    });

    it('should pass through when catalog returns undefined (unknown instrument)', async () => {
      deps = makeDeps({ catalog: makeCatalog(undefined) });
      engine = new ExecutionEngine(deps);

      const size2 = Quantity.of(new Decimal('2'));
      await engine.execute(ctx, [{ type: 'PLACE', side: BUY, price: PRICE_55, size: size2 }]);

      const call = (deps.placeOrderUseCase.execute as ReturnType<typeof jest.fn>).mock.calls[0][0] as any;
      expect(call.size.toNumber()).toBe(2);
    });

    it('should allow SELL even when size < minOrderSize (Polymarket allows selling remainder)', async () => {
      const minOrderSize = Quantity.of(new Decimal('5'));
      deps = makeDeps({ catalog: makeCatalog(minOrderSize) });
      engine = new ExecutionEngine(deps);

      const size3 = Quantity.of(new Decimal('3'));
      const report = await engine.execute(ctx, [{ type: 'PLACE', side: SELL, price: PRICE_65, size: size3 }]);

      // SELL не блокируется по minOrderSize — Polymarket позволяет продать остаток
      // целиком даже если он меньше minOrderSize (после fee deduction и т.п.).
      expect(report.placed).toBe(1);
      expect(report.skipped).toBe(0);
    });

    it('should pass SELL when size >= minOrderSize', async () => {
      const minOrderSize = Quantity.of(new Decimal('5'));
      deps = makeDeps({ catalog: makeCatalog(minOrderSize) });
      engine = new ExecutionEngine(deps);

      const size5 = Quantity.of(new Decimal('5'));
      const report = await engine.execute(ctx, [{ type: 'PLACE', side: SELL, price: PRICE_65, size: size5 }]);

      expect(report.placed).toBe(1);
      expect(report.skipped).toBe(0);
    });
  });

  // ── Валидация minOrderValue (reject-only, BUY only) ───

  describe('minOrderValue validation (reject BUY, no clamping)', () => {
    it('should reject BUY when price × size < minOrderValue', async () => {
      // price=0.01, size=5 → value=$0.05 < $1 → reject
      const minOrderSize = Quantity.of(new Decimal('1'));
      const minOrderValue = Quantity.of(new Decimal('1'));
      const lowPrice = Price.of(new Decimal('0.01'));
      deps = makeDeps({ catalog: makeCatalog(minOrderSize, minOrderValue) });
      engine = new ExecutionEngine(deps);

      const report = await engine.execute(ctx, [
        { type: 'PLACE', side: BUY, price: lowPrice, size: Quantity.of(new Decimal('5')) },
      ]);

      expect(report.skipped).toBe(1);
      expect(report.placed).toBe(0);
      expect(deps.placeOrderUseCase.execute).not.toHaveBeenCalled();
    });

    it('should pass BUY when price × size >= minOrderValue', async () => {
      // price=0.55, size=2 → value=$1.10 >= $1 → pass
      const minOrderSize = Quantity.of(new Decimal('1'));
      const minOrderValue = Quantity.of(new Decimal('1'));
      deps = makeDeps({ catalog: makeCatalog(minOrderSize, minOrderValue) });
      engine = new ExecutionEngine(deps);

      const report = await engine.execute(ctx, [
        { type: 'PLACE', side: BUY, price: PRICE_55, size: Quantity.of(new Decimal('2')) },
      ]);

      expect(report.placed).toBe(1);
      expect(report.skipped).toBe(0);
    });

    it('should not apply minOrderValue check to SELL orders', async () => {
      // SELL: value=$0.05 < $1 but SELL is not subject to minOrderValue check
      const minOrderSize = Quantity.of(new Decimal('1'));
      const minOrderValue = Quantity.of(new Decimal('1'));
      const lowPrice = Price.of(new Decimal('0.01'));
      deps = makeDeps({ catalog: makeCatalog(minOrderSize, minOrderValue) });
      engine = new ExecutionEngine(deps);

      const report = await engine.execute(ctx, [
        { type: 'PLACE', side: SELL, price: lowPrice, size: Quantity.of(new Decimal('5')) },
      ]);

      expect(report.placed).toBe(1);
      expect(report.skipped).toBe(0);
    });

    it('should log warn when rejecting for minOrderValue', async () => {
      const minOrderSize = Quantity.of(new Decimal('1'));
      const minOrderValue = Quantity.of(new Decimal('1'));
      const lowPrice = Price.of(new Decimal('0.01'));
      deps = makeDeps({ catalog: makeCatalog(minOrderSize, minOrderValue) });
      engine = new ExecutionEngine(deps);
      const logger = deps.logger as ReturnType<typeof makeLogger>;

      await engine.execute(ctx, [
        { type: 'PLACE', side: BUY, price: lowPrice, size: Quantity.of(new Decimal('5')) },
      ]);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('order value below minOrderValue'),
        expect.objectContaining({ minOrderValue: 1 }),
      );
    });
  });

  // ── Exchange rejection cooldown ──────────────────────────

  describe('exchange rejection cooldown', () => {
    it('should return failed on first exchange rejection', async () => {
      (deps.placeOrderUseCase as any).execute.mockResolvedValue(
        Err(new TradingError('not enough balance/allowance')),
      );

      const report = await engine.execute(ctx, [
        { type: 'PLACE', side: SELL, price: PRICE_65, size: SIZE_100 },
      ]);

      expect(report.errors).toHaveLength(1);
      expect(report.placed).toBe(0);
      expect(deps.placeOrderUseCase.execute).toHaveBeenCalledTimes(1);
    });

    it('should skip second attempt immediately after rejection (cooldown active)', async () => {
      (deps.placeOrderUseCase as any).execute.mockResolvedValue(
        Err(new TradingError('not enough balance/allowance')),
      );

      // Первая попытка → rejection + cooldown установлен
      await engine.execute(ctx, [{ type: 'PLACE', side: SELL, price: PRICE_65, size: SIZE_100 }]);
      (deps.placeOrderUseCase.execute as ReturnType<typeof jest.fn>).mockClear();

      // Вторая попытка сразу → cooldown активен → skip
      const report = await engine.execute(ctx, [
        { type: 'PLACE', side: SELL, price: PRICE_65, size: SIZE_100 },
      ]);

      expect(report.skipped).toBe(1);
      expect(report.errors).toHaveLength(0);
      // Биржа НЕ вызывается в cooldown
      expect(deps.placeOrderUseCase.execute).not.toHaveBeenCalled();
    });

    it('should not apply cooldown to different side', async () => {
      (deps.placeOrderUseCase as any).execute
        .mockResolvedValueOnce(Err(new TradingError('not enough balance/allowance')))
        .mockResolvedValueOnce(Ok(ORDER_1));

      // SELL fails → cooldown для SELL
      await engine.execute(ctx, [{ type: 'PLACE', side: SELL, price: PRICE_65, size: SIZE_100 }]);

      // BUY для того же инструмента — cooldown не затрагивает BUY
      const report = await engine.execute(ctx, [
        { type: 'PLACE', side: BUY, price: PRICE_55, size: SIZE_100 },
      ]);

      expect(report.placed).toBe(1);
      expect(report.skipped).toBe(0);
    });
  });
});
