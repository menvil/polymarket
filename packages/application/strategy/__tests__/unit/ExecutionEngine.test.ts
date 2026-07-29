import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import Decimal from 'decimal.js';
import { Ok, Err } from '@polymarket/result';
import { asOrderId, asInstrumentId, asPolymarketCtfToken } from '@polymarket/ids';
import type { OrderId, AccountId, InstrumentId, AssetId } from '@polymarket/ids';
import { Money, Price, Quantity } from '@polymarket/value-objects';
import type { Side } from '@polymarket/value-objects';
import { TradingError } from '@polymarket/errors';
import { PlaceOrderFailureError } from '@polymarket/use-cases';
import { ExecutionEngine, LocalIntentRejectionError } from '../../src/ExecutionEngine.js';
import type { ExecutionEngineDeps, ExecutionContext } from '../../src/ExecutionEngine.js';
import { SequentialOrderIdGenerator } from '../../src/ports/OrderIdGenerator.js';
import type { StrategyIntent, PlaceIntent } from '../../src/types/StrategyIntent.js';

// ── Constants ──────────────────────────────────────────────

const STRATEGY_ID = 'strategy-1';
const OTHER_STRATEGY_ID = 'strategy-2';
const ACCOUNT_ID = 'venue:POLYMARKET:test' as unknown as AccountId;
const OTHER_ACCOUNT_ID = 'venue:POLYMARKET:other' as unknown as AccountId;

// Числовые CTF tokenId: assetIdToInstrumentId(asset) === instrument key.
const PRIMARY_TOKEN = '111';
const COMPLEMENTARY_TOKEN = '222';
const FOREIGN_TOKEN = '333';

const INSTRUMENT_ID = asInstrumentId(PRIMARY_TOKEN)!;
const COMP_INSTRUMENT_ID = asInstrumentId(COMPLEMENTARY_TOKEN)!;
const FOREIGN_INSTRUMENT_ID = asInstrumentId(FOREIGN_TOKEN)!;

const ASSET_ID: AssetId = asPolymarketCtfToken(PRIMARY_TOKEN)!;
const COMP_ASSET_ID: AssetId = asPolymarketCtfToken(COMPLEMENTARY_TOKEN)!;
const FOREIGN_ASSET_ID: AssetId = asPolymarketCtfToken(FOREIGN_TOKEN)!;

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

/** Ордер в repo: по умолчанию BUY нашей стратегии на PRIMARY инструменте. */
function makeOrder(id: OrderId, overrides: Partial<{
  strategyId: string | undefined;
  accountId: AccountId | undefined;
  side: Side;
  asset: AssetId;
}> = {}) {
  return {
    id,
    strategyId: 'strategyId' in overrides ? overrides.strategyId : STRATEGY_ID,
    accountId: 'accountId' in overrides ? overrides.accountId : undefined,
    side: overrides.side ?? 'BUY',
    asset: overrides.asset ?? ASSET_ID,
  } as any;
}

function makeInstrumentInfo(opts: Partial<{
  minOrderSize: Quantity;
  minOrderValue: Money;
  tickSize: Price;
}> = {}) {
  return {
    minOrderSize: opts.minOrderSize ?? Quantity.of(new Decimal('1')),
    minOrderValue: opts.minOrderValue ?? Money.of(new Decimal('1'), 'USDC'),
    tickSize: opts.tickSize ?? Price.of(new Decimal('0.01')),
  } as any;
}

/** Каталог: по умолчанию знает PRIMARY и COMPLEMENTARY инструменты. */
function makeCatalog(infoByInstrument: Record<string, any> = {
  [PRIMARY_TOKEN]: makeInstrumentInfo(),
  [COMPLEMENTARY_TOKEN]: makeInstrumentInfo(),
}) {
  return {
    get: jest.fn((id: InstrumentId) => infoByInstrument[String(id)]),
    getByMarketId: jest.fn().mockReturnValue(undefined),
    getAll: jest.fn().mockReturnValue([]),
    register: jest.fn(),
    remove: jest.fn(),
    clear: jest.fn(),
  } as any;
}

const fn = jest.fn as any;

function makeOrderRepo() {
  return {
    // Ownership lookup: по умолчанию любой orderId принадлежит нашей стратегии.
    get: fn().mockImplementation(async (id: OrderId) => makeOrder(id)),
    getByStrategyId: fn().mockResolvedValue([]),
    countByStrategyId: fn().mockResolvedValue(0),
  } as any;
}

function makeDeps(overrides: Partial<ExecutionEngineDeps> = {}): ExecutionEngineDeps {
  return {
    placeOrderUseCase: { execute: fn().mockResolvedValue(Ok(ORDER_1)) } as any,
    // CancelOrderUseCase возвращает типизированный CancelOrderOutcome:
    // ExecutionEngine засчитывает cancelled ТОЛЬКО для CANCELLED/ALREADY_CANCELLED.
    cancelOrderUseCase: { execute: fn().mockResolvedValue(Ok({ status: 'CANCELLED' })) } as any,
    orderRepo: makeOrderRepo(),
    portfolioStore: {
      get: fn().mockReturnValue(makePortfolio()),
    } as any,
    catalog: makeCatalog(),
    clock: { now: jest.fn().mockReturnValue(new Date(0)) } as any,
    orderIdGenerator: new SequentialOrderIdGenerator('test'),
    logger: makeLogger() as any,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    strategyId: STRATEGY_ID,
    accountId: ACCOUNT_ID,
    instrumentId: INSTRUMENT_ID,
    asset: ASSET_ID,
    allowedInstruments: new Set([PRIMARY_TOKEN, COMPLEMENTARY_TOKEN]),
    ...overrides,
  };
}

function place(overrides: Partial<{
  side: Side;
  price: Price;
  size: Quantity;
  postOnly: boolean;
}> = {}): PlaceIntent {
  return {
    type: 'PLACE',
    side: overrides.side ?? BUY,
    price: overrides.price ?? PRICE_55,
    size: overrides.size ?? SIZE_100,
    ...(overrides.postOnly !== undefined ? { postOnly: overrides.postOnly } : {}),
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
      expect(report.failed).toBe(0);
      expect(report.errors).toHaveLength(0);
      expect(report.outcomes).toHaveLength(0);
    });
  });

  // ── PLACE ────────────────────────────────────────────

  describe('PLACE', () => {
    it('should call placeOrderUseCase for PLACE intent', async () => {
      const report = await engine.execute(ctx, [place()]);

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

      const report = await engine.execute(ctx, [
        place({ side: BUY, price: PRICE_55 }),
        place({ side: SELL, price: PRICE_65 }),
      ]);

      expect(report.placed).toBe(2);
      expect(callOrder).toEqual(['BUY', 'SELL']);
    });

    it('should fail typed PORTFOLIO_UNAVAILABLE when portfolio not found', async () => {
      (deps.portfolioStore as any).get.mockReturnValue(undefined);

      const report = await engine.execute(ctx, [place()]);

      expect(report.placed).toBe(0);
      expect(report.failed).toBe(1);
      expect(report.errors).toHaveLength(1);
      expect(report.outcomes[0]).toMatchObject({ kind: 'FAILED', failureCode: 'PORTFOLIO_UNAVAILABLE' });
      expect(deps.placeOrderUseCase.execute).not.toHaveBeenCalled();
    });

    it('should preserve original error when placeOrderUseCase fails', async () => {
      const originalError = new TradingError('Risk violation');
      (deps.placeOrderUseCase as any).execute.mockResolvedValue(Err(originalError));

      const report = await engine.execute(ctx, [place()]);

      expect(report.placed).toBe(0);
      expect(report.failed).toBe(1);
      expect(report.errors).toHaveLength(1);
      // Исходная ошибка сохранена (НЕ заменена на synthetic new Error(...)).
      expect(report.errors[0].error).toBe(originalError);
      expect(report.outcomes.find((o) => o.kind === 'FAILED')?.error).toBe(originalError);
      expect(report.outcomes.find((o) => o.kind === 'FAILED')?.failureCode).toBe('OTHER');
    });

    it('should reject non-positive PLACE size before calling use case', async () => {
      const report = await engine.execute(ctx, [
        place({ side: SELL, price: PRICE_65, size: Quantity.ZERO }),
      ]);

      expect(report.placed).toBe(0);
      expect(report.skipped).toBe(1);
      expect(report.localRejected).toBe(1);
      expect(deps.placeOrderUseCase.execute).not.toHaveBeenCalled();
    });
  });

  // ── CANCEL + ownership ───────────────────────────────

  describe('CANCEL', () => {
    it('should call cancelOrderUseCase for owned CANCEL intent', async () => {
      const report = await engine.execute(ctx, [{ type: 'CANCEL', orderId: ORDER_1 }]);

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
      const report = await engine.execute(ctx, [
        { type: 'CANCEL', orderId: ORDER_1 },
        { type: 'CANCEL', orderId: ORDER_2 },
      ]);

      expect(report.cancelled).toBe(2);
      expect(deps.cancelOrderUseCase.execute).toHaveBeenCalledTimes(2);
    });

    it('should report error with original error when cancel use case fails', async () => {
      const originalError = new TradingError('Order not found');
      (deps.cancelOrderUseCase as any).execute.mockResolvedValue(Err(originalError));

      const report = await engine.execute(ctx, [{ type: 'CANCEL', orderId: ORDER_1 }]);

      expect(report.cancelled).toBe(0);
      expect(report.errors).toHaveLength(1);
      expect(report.errors[0].error).toBe(originalError);
    });

    it('ownership: CANCEL чужой стратегии → use case НЕ вызывается, FAILED, PLACE заблокирован', async () => {
      (deps.orderRepo as any).get.mockImplementation(async (id: OrderId) =>
        makeOrder(id, { strategyId: OTHER_STRATEGY_ID }),
      );

      const report = await engine.execute(ctx, [
        { type: 'CANCEL', orderId: ORDER_1 },
        place({ side: BUY }),
      ]);

      expect(deps.cancelOrderUseCase.execute).not.toHaveBeenCalled();
      expect(report.cancelled).toBe(0);
      expect(report.failed).toBe(1);
      expect(report.placed).toBe(0);
      expect(report.blockedByUnsafeCancel).toBe(1);
      const cancelOutcome = report.outcomes.find((o) => o.kind === 'CANCEL_FAILED');
      expect(cancelOutcome?.error).toBeInstanceOf(LocalIntentRejectionError);
      expect((cancelOutcome?.error as LocalIntentRejectionError).code).toBe('CANCEL_OWNERSHIP_MISMATCH');
      expect(deps.placeOrderUseCase.execute).not.toHaveBeenCalled();
    });

    it('ownership: CANCEL ордера другого account → отклонено без use case', async () => {
      (deps.orderRepo as any).get.mockImplementation(async (id: OrderId) =>
        makeOrder(id, { accountId: OTHER_ACCOUNT_ID }),
      );

      const report = await engine.execute(ctx, [{ type: 'CANCEL', orderId: ORDER_1 }]);

      expect(deps.cancelOrderUseCase.execute).not.toHaveBeenCalled();
      expect(report.cancelled).toBe(0);
      expect(report.failed).toBe(1);
      const outcome = report.outcomes.find((o) => o.kind === 'CANCEL_FAILED');
      expect((outcome?.error as LocalIntentRejectionError).code).toBe('CANCEL_OWNERSHIP_MISMATCH');
    });

    it('ownership: order не найден (owner unknown) → FAILED без use case', async () => {
      (deps.orderRepo as any).get.mockResolvedValue(undefined);

      const report = await engine.execute(ctx, [{ type: 'CANCEL', orderId: ORDER_1 }]);

      expect(deps.cancelOrderUseCase.execute).not.toHaveBeenCalled();
      expect(report.failed).toBe(1);
      const outcome = report.outcomes.find((o) => o.kind === 'CANCEL_FAILED');
      expect((outcome?.error as LocalIntentRejectionError).code).toBe('CANCEL_ORDER_NOT_FOUND');
    });

    it('ownership: совпадающий accountId на ордере → cancel разрешён', async () => {
      (deps.orderRepo as any).get.mockImplementation(async (id: OrderId) =>
        makeOrder(id, { accountId: ACCOUNT_ID }),
      );

      const report = await engine.execute(ctx, [{ type: 'CANCEL', orderId: ORDER_1 }]);

      expect(deps.cancelOrderUseCase.execute).toHaveBeenCalledTimes(1);
      expect(report.cancelled).toBe(1);
    });
  });

  // ── CANCEL_ALL ───────────────────────────────────────

  describe('CANCEL_ALL', () => {
    it('should cancel all open orders from repo (scoped by strategyId)', async () => {
      (deps.orderRepo as any).getByStrategyId.mockResolvedValue([
        makeOrder(ORDER_1),
        makeOrder(ORDER_2),
        makeOrder(ORDER_3),
      ]);

      const report = await engine.execute(ctx, [{ type: 'CANCEL_ALL' }]);

      expect(report.cancelled).toBe(3);
      expect(deps.orderRepo.getByStrategyId).toHaveBeenCalledWith(STRATEGY_ID);
      expect(deps.cancelOrderUseCase.execute).toHaveBeenCalledTimes(3);
    });

    it('should be no-op when no open orders', async () => {
      const report = await engine.execute(ctx, [{ type: 'CANCEL_ALL' }]);

      expect(report.cancelled).toBe(0);
      expect(report.errors).toHaveLength(0);
    });
  });

  // ── Нормализация / dedupe ────────────────────────────

  describe('normalization', () => {
    it('should remove individual CANCELs when CANCEL_ALL present', async () => {
      (deps.orderRepo as any).getByStrategyId.mockResolvedValue([makeOrder(ORDER_1)]);

      const report = await engine.execute(ctx, [
        { type: 'CANCEL_ALL' },
        { type: 'CANCEL', orderId: ORDER_1 },
        { type: 'CANCEL', orderId: ORDER_2 },
      ]);

      expect(deps.cancelOrderUseCase.execute).toHaveBeenCalledTimes(1);
      expect(report.cancelled).toBe(1);
    });

    it('should dedupe CANCEL by orderId', async () => {
      const report = await engine.execute(ctx, [
        { type: 'CANCEL', orderId: ORDER_1 },
        { type: 'CANCEL', orderId: ORDER_1 },
        { type: 'CANCEL', orderId: ORDER_2 },
      ]);

      expect(deps.cancelOrderUseCase.execute).toHaveBeenCalledTimes(2);
      expect(report.cancelled).toBe(2);
    });

    it('should dedupe identical PLACE (instrument+side+price+postOnly) — last wins', async () => {
      const size200 = Quantity.of(new Decimal('200'));

      const report = await engine.execute(ctx, [
        place({ side: BUY, price: PRICE_55, size: SIZE_100 }),
        place({ side: BUY, price: PRICE_55, size: size200 }),
        place({ side: SELL, price: PRICE_65, size: Quantity.of(new Decimal('50')) }),
      ]);

      expect(report.placed).toBe(2);
      expect(deps.placeOrderUseCase.execute).toHaveBeenCalledTimes(2);

      const calls = (deps.placeOrderUseCase as any).execute.mock.calls;
      const buyCall = calls.find((c: any[]) => c[0].side === 'BUY') as any[];
      expect(buyCall[0].size).toBe(size200);
    });

    it('BUY primary @0.55 и BUY complementary @0.55 НЕ схлопываются (оба исполняются)', async () => {
      const intents: StrategyIntent[] = [
        place({ side: BUY, price: PRICE_55 }),
        {
          type: 'PLACE',
          side: BUY,
          price: PRICE_55,
          size: SIZE_100,
          targetInstrumentId: COMP_INSTRUMENT_ID,
          targetAsset: COMP_ASSET_ID,
        },
      ];

      const report = await engine.execute(ctx, intents);

      expect(report.placed).toBe(2);
      const instruments = (deps.placeOrderUseCase as any).execute.mock.calls.map(
        (c: any[]) => String(c[0].instrumentId),
      );
      expect(instruments).toContain(PRIMARY_TOKEN);
      expect(instruments).toContain(COMPLEMENTARY_TOKEN);
    });

    it('postOnly=true и postOnly=false при одинаковой цене НЕ схлопываются', async () => {
      const report = await engine.execute(ctx, [
        place({ side: BUY, price: PRICE_55, postOnly: true }),
        place({ side: BUY, price: PRICE_55, postOnly: false }),
      ]);

      expect(report.placed).toBe(2);
      expect(deps.placeOrderUseCase.execute).toHaveBeenCalledTimes(2);
    });

  });

  // ── Target identity (атомарная пара) ─────────────────

  describe('target identity validation', () => {
    it('targetInstrumentId без targetAsset → typed failure, use case не вызывается', async () => {
      // Runtime-вход (например из JS) — обходим compile-time union через as.
      const intent = {
        type: 'PLACE',
        side: BUY,
        price: PRICE_55,
        size: SIZE_100,
        targetInstrumentId: COMP_INSTRUMENT_ID,
      } as unknown as PlaceIntent;

      const report = await engine.execute(ctx, [intent]);

      expect(report.placed).toBe(0);
      expect(report.localRejected).toBe(1);
      expect(deps.placeOrderUseCase.execute).not.toHaveBeenCalled();
      const outcome = report.outcomes.find((o) => o.kind === 'LOCAL_REJECTED');
      expect((outcome?.error as LocalIntentRejectionError).code).toBe('TARGET_PAIR_INCOMPLETE');
    });

    it('targetAsset без targetInstrumentId → typed failure', async () => {
      const intent = {
        type: 'PLACE',
        side: BUY,
        price: PRICE_55,
        size: SIZE_100,
        targetAsset: COMP_ASSET_ID,
      } as unknown as PlaceIntent;

      const report = await engine.execute(ctx, [intent]);

      expect(report.localRejected).toBe(1);
      expect(deps.placeOrderUseCase.execute).not.toHaveBeenCalled();
      const outcome = report.outcomes.find((o) => o.kind === 'LOCAL_REJECTED');
      expect((outcome?.error as LocalIntentRejectionError).code).toBe('TARGET_PAIR_INCOMPLETE');
    });

    it('asset не соответствует target instrument → typed failure', async () => {
      const intent: PlaceIntent = {
        type: 'PLACE',
        side: BUY,
        price: PRICE_55,
        size: SIZE_100,
        targetInstrumentId: COMP_INSTRUMENT_ID,
        targetAsset: ASSET_ID, // asset PRIMARY, instrument COMPLEMENTARY
      };

      const report = await engine.execute(ctx, [intent]);

      expect(report.localRejected).toBe(1);
      expect(deps.placeOrderUseCase.execute).not.toHaveBeenCalled();
      const outcome = report.outcomes.find((o) => o.kind === 'LOCAL_REJECTED');
      expect((outcome?.error as LocalIntentRejectionError).code).toBe('TARGET_ASSET_MISMATCH');
    });

    it('target instrument не разрешён registration → typed failure', async () => {
      const catalogWithForeign = makeCatalog({
        [PRIMARY_TOKEN]: makeInstrumentInfo(),
        [FOREIGN_TOKEN]: makeInstrumentInfo(),
      });
      deps = makeDeps({ catalog: catalogWithForeign });
      engine = new ExecutionEngine(deps);

      const intent: PlaceIntent = {
        type: 'PLACE',
        side: BUY,
        price: PRICE_55,
        size: SIZE_100,
        targetInstrumentId: FOREIGN_INSTRUMENT_ID,
        targetAsset: FOREIGN_ASSET_ID,
      };

      const report = await engine.execute(ctx, [intent]);

      expect(report.localRejected).toBe(1);
      expect(deps.placeOrderUseCase.execute).not.toHaveBeenCalled();
      const outcome = report.outcomes.find((o) => o.kind === 'LOCAL_REJECTED');
      expect((outcome?.error as LocalIntentRejectionError).code).toBe('TARGET_NOT_ALLOWED');
    });

    it('target instrument отсутствует в catalog → typed failure (fail-closed)', async () => {
      const catalogPrimaryOnly = makeCatalog({ [PRIMARY_TOKEN]: makeInstrumentInfo() });
      deps = makeDeps({ catalog: catalogPrimaryOnly });
      engine = new ExecutionEngine(deps);

      const intent: PlaceIntent = {
        type: 'PLACE',
        side: BUY,
        price: PRICE_55,
        size: SIZE_100,
        targetInstrumentId: COMP_INSTRUMENT_ID,
        targetAsset: COMP_ASSET_ID,
      };

      const report = await engine.execute(ctx, [intent]);

      expect(report.localRejected).toBe(1);
      expect(deps.placeOrderUseCase.execute).not.toHaveBeenCalled();
      const outcome = report.outcomes.find((o) => o.kind === 'LOCAL_REJECTED');
      expect((outcome?.error as LocalIntentRejectionError).code).toBe('TARGET_UNKNOWN_INSTRUMENT');
    });
  });

  // ── Cancel-replace safety (fail-closed) ──────────────

  describe('cancel-replace safety', () => {
    it('cancel → FAILED (Err): PLACE не вызывается', async () => {
      (deps.cancelOrderUseCase as any).execute.mockResolvedValue(Err(new TradingError('boom')));

      const report = await engine.execute(ctx, [
        { type: 'CANCEL', orderId: ORDER_1 },
        place({ side: BUY }),
      ]);

      expect(report.placed).toBe(0);
      expect(report.blockedByUnsafeCancel).toBe(1);
      expect(report.skipped).toBe(1);
      expect(deps.placeOrderUseCase.execute).not.toHaveBeenCalled();
    });

    it('cancel Promise rejected: PLACE не вызывается', async () => {
      (deps.cancelOrderUseCase as any).execute.mockRejectedValue(new Error('network down'));

      const report = await engine.execute(ctx, [
        { type: 'CANCEL', orderId: ORDER_1 },
        place({ side: BUY }),
      ]);

      expect(report.placed).toBe(0);
      expect(report.blockedByUnsafeCancel).toBe(1);
      expect(report.failed).toBe(1);
      expect(deps.placeOrderUseCase.execute).not.toHaveBeenCalled();
    });

    it('cancel → PENDING (FILL_PENDING): BUY и SELL оба заблокированы', async () => {
      (deps.cancelOrderUseCase as any).execute.mockResolvedValue(Ok({ status: 'FILL_PENDING' }));

      const report = await engine.execute(ctx, [
        { type: 'CANCEL', orderId: ORDER_1 },
        place({ side: BUY, price: PRICE_55 }),
        place({ side: SELL, price: PRICE_65 }),
      ]);

      expect(report.placed).toBe(0);
      expect(report.blockedByUnsafeCancel).toBe(2);
      expect(report.skipped).toBe(2);
      expect(deps.placeOrderUseCase.execute).not.toHaveBeenCalled();
      expect(report.errors).toHaveLength(0); // PENDING — не ошибка
    });

    it('RECONCILIATION_REQUIRED блокирует PLACE intents того же batch', async () => {
      (deps.cancelOrderUseCase as any).execute.mockResolvedValue(
        Ok({ status: 'RECONCILIATION_REQUIRED', reason: 'venue outcome unknown' }),
      );

      const report = await engine.execute(ctx, [
        { type: 'CANCEL', orderId: ORDER_1 },
        place({ side: SELL, price: PRICE_65 }),
      ]);

      expect(report.placed).toBe(0);
      expect(report.blockedByUnsafeCancel).toBe(1);
      expect(deps.placeOrderUseCase.execute).not.toHaveBeenCalled();
    });

    it('один FAILED cancel из нескольких блокирует ВСЕ PLACE (fail-closed)', async () => {
      (deps.cancelOrderUseCase as any).execute
        .mockResolvedValueOnce(Ok({ status: 'CANCELLED' }))
        .mockResolvedValueOnce(Err(new TradingError('Not found')));

      const report = await engine.execute(ctx, [
        { type: 'CANCEL', orderId: ORDER_1 },
        { type: 'CANCEL', orderId: ORDER_2 },
        place({ side: SELL, price: PRICE_65 }),
      ]);

      expect(report.cancelled).toBe(1);
      expect(report.placed).toBe(0);
      expect(report.blockedByUnsafeCancel).toBe(1);
      expect(deps.placeOrderUseCase.execute).not.toHaveBeenCalled();
    });

    it('cancel → CONFIRMED: SELL PLACE разрешён (BUY заблокирован только cooldown-ом)', async () => {
      const report = await engine.execute(ctx, [
        { type: 'CANCEL', orderId: ORDER_1 },
        place({ side: SELL, price: PRICE_65 }),
      ]);

      expect(report.cancelled).toBe(1);
      expect(report.placed).toBe(1);
      expect(report.blockedByUnsafeCancel).toBe(0);
    });

    it('cancel → TERMINAL_NOOP: PLACE разрешён', async () => {
      (deps.cancelOrderUseCase as any).execute.mockResolvedValue(
        Ok({ status: 'ALREADY_TERMINAL', orderStatus: 'REJECTED' }),
      );

      const report = await engine.execute(ctx, [
        { type: 'CANCEL', orderId: ORDER_1 },
        place({ side: BUY, price: PRICE_55 }),
      ]);

      expect(report.cancelled).toBe(0);
      expect(report.placed).toBe(1);
      expect(report.blockedByUnsafeCancel).toBe(0);
      expect(deps.placeOrderUseCase.execute).toHaveBeenCalledTimes(1);
    });

    it('ALREADY_FILLED → PENDING: не cancelled++, блокирует PLACE', async () => {
      (deps.cancelOrderUseCase as any).execute.mockResolvedValue(Ok({ status: 'ALREADY_FILLED' }));

      const report = await engine.execute(ctx, [
        { type: 'CANCEL', orderId: ORDER_1 },
        place({ side: BUY }),
      ]);

      expect(report.cancelled).toBe(0);
      expect(report.placed).toBe(0);
      expect(report.blockedByUnsafeCancel).toBe(1);
      expect(deps.placeOrderUseCase.execute).not.toHaveBeenCalled();
    });

    it('только CANCELLED/ALREADY_CANCELLED увеличивают cancelled', async () => {
      (deps.cancelOrderUseCase as any).execute
        .mockResolvedValueOnce(Ok({ status: 'CANCELLED' }))
        .mockResolvedValueOnce(Ok({ status: 'ALREADY_CANCELLED' }))
        .mockResolvedValueOnce(Ok({ status: 'FILL_PENDING' }))
        .mockResolvedValueOnce(Ok({ status: 'RECONCILIATION_REQUIRED', reason: 'x' }))
        .mockResolvedValueOnce(Err(new TradingError('Not found')));

      const report = await engine.execute(ctx, [
        { type: 'CANCEL', orderId: ORDER_1 },
        { type: 'CANCEL', orderId: ORDER_2 },
        { type: 'CANCEL', orderId: ORDER_3 },
        { type: 'CANCEL', orderId: asOrderId('order-4')! },
        { type: 'CANCEL', orderId: asOrderId('order-5')! },
      ]);

      expect(report.cancelled).toBe(2);
      expect(report.errors).toHaveLength(1);
    });

    it('PENDING cancel НЕ ставит post-cancel cooldown', async () => {
      (deps.cancelOrderUseCase as any).execute.mockResolvedValueOnce(Ok({ status: 'FILL_PENDING' }));

      await engine.execute(ctx, [{ type: 'CANCEL', orderId: ORDER_1 }]);

      // Второй цикл: BUY place — cooldown НЕ должен блокировать.
      const report = await engine.execute(ctx, [place({ side: BUY })]);
      expect(report.placed).toBe(1);
      expect(report.skipped).toBe(0);
    });
  });

  // ── Post-cancel cooldown (по фактическому Order) ─────

  describe('post-cancel cooldown', () => {
    it('cancel BUY → cooldown на инструменте ордера: следующий BUY skip, SELL проходит', async () => {
      const report1 = await engine.execute(ctx, [{ type: 'CANCEL', orderId: ORDER_1 }]);
      expect(report1.cancelled).toBe(1);

      const report2 = await engine.execute(ctx, [
        place({ side: BUY, price: PRICE_55 }),
        place({ side: SELL, price: PRICE_65 }),
      ]);

      expect(report2.skipped).toBe(1); // BUY в cooldown
      expect(report2.placed).toBe(1);  // SELL проходит
      expect((deps.placeOrderUseCase.execute as any).mock.calls[0][0].side).toBe(SELL);
    });

    it('отменён комплементарный BUY → cooldown на complementary, primary НЕ блокируется', async () => {
      (deps.orderRepo as any).get.mockImplementation(async (id: OrderId) =>
        makeOrder(id, { asset: COMP_ASSET_ID }),
      );

      await engine.execute(ctx, [{ type: 'CANCEL', orderId: ORDER_1 }]);

      // BUY на primary — проходит (cooldown стоит на complementary).
      const primaryReport = await engine.execute(ctx, [place({ side: BUY, price: PRICE_55 })]);
      expect(primaryReport.placed).toBe(1);

      // BUY на complementary — в cooldown.
      const compReport = await engine.execute(ctx, [{
        type: 'PLACE',
        side: BUY,
        price: PRICE_55,
        size: SIZE_100,
        targetInstrumentId: COMP_INSTRUMENT_ID,
        targetAsset: COMP_ASSET_ID,
      }]);
      expect(compReport.skipped).toBe(1);
      expect(compReport.placed).toBe(0);
    });

    it('отменён SELL → BUY post-cancel cooldown НЕ устанавливается', async () => {
      (deps.orderRepo as any).get.mockImplementation(async (id: OrderId) =>
        makeOrder(id, { side: 'SELL' }),
      );

      await engine.execute(ctx, [{ type: 'CANCEL', orderId: ORDER_1 }]);

      const report = await engine.execute(ctx, [place({ side: BUY, price: PRICE_55 })]);
      expect(report.placed).toBe(1);
      expect(report.skipped).toBe(0);
    });

    it('clearPostCancelCooldown (FILL_CONFIRMED) снимает cooldown', async () => {
      await engine.execute(ctx, [{ type: 'CANCEL', orderId: ORDER_1 }]);

      engine.clearPostCancelCooldown(INSTRUMENT_ID);

      const report = await engine.execute(ctx, [place({ side: BUY })]);
      expect(report.placed).toBe(1);
    });

    it('CANCEL_ALL + PLACE: BUY skip по cooldown, SELL проходит', async () => {
      (deps.orderRepo as any).getByStrategyId.mockResolvedValue([
        makeOrder(ORDER_1),
        makeOrder(ORDER_2),
      ]);

      const report = await engine.execute(ctx, [
        { type: 'CANCEL_ALL' },
        place({ side: BUY, price: PRICE_55 }),
        place({ side: SELL, price: PRICE_65 }),
      ]);

      expect(report.cancelled).toBe(2);
      expect(report.skipped).toBe(1);
      expect(report.placed).toBe(1);
      expect(report.errors).toHaveLength(0);
    });
  });

  // ── Constraints (reject-only) ────────────────────────

  describe('constraints validation (reject, no clamping)', () => {
    it('should pass through intent size when >= minOrderSize', async () => {
      deps = makeDeps({
        catalog: makeCatalog({
          [PRIMARY_TOKEN]: makeInstrumentInfo({ minOrderSize: Quantity.of(new Decimal('5')) }),
        }),
      });
      engine = new ExecutionEngine(deps);

      await engine.execute(ctx, [place({ side: BUY, size: Quantity.of(new Decimal('10')) })]);

      const call = (deps.placeOrderUseCase.execute as any).mock.calls[0][0] as any;
      expect(call.size.toNumber()).toBe(10);
    });

    it('should reject (local) when BUY size < minOrderSize', async () => {
      deps = makeDeps({
        catalog: makeCatalog({
          [PRIMARY_TOKEN]: makeInstrumentInfo({ minOrderSize: Quantity.of(new Decimal('5')) }),
        }),
      });
      engine = new ExecutionEngine(deps);

      const report = await engine.execute(ctx, [place({ side: BUY, size: Quantity.of(new Decimal('2')) })]);

      expect(report.skipped).toBe(1);
      expect(report.localRejected).toBe(1);
      expect(report.placed).toBe(0);
      expect(deps.placeOrderUseCase.execute).not.toHaveBeenCalled();
    });

    it('catalog entry отсутствует → PLACE fail-closed (venue не вызывается)', async () => {
      deps = makeDeps({ catalog: makeCatalog({}) });
      engine = new ExecutionEngine(deps);

      const report = await engine.execute(ctx, [place({ side: BUY, size: Quantity.of(new Decimal('2')) })]);

      expect(report.placed).toBe(0);
      expect(report.localRejected).toBe(1);
      expect(deps.placeOrderUseCase.execute).not.toHaveBeenCalled();
      const outcome = report.outcomes.find((o) => o.kind === 'LOCAL_REJECTED');
      expect((outcome?.error as LocalIntentRejectionError).code).toBe('CATALOG_ENTRY_MISSING');
    });

    it('price не кратна tickSize → local rejection, use case не вызывается', async () => {
      deps = makeDeps({
        catalog: makeCatalog({
          [PRIMARY_TOKEN]: makeInstrumentInfo({ tickSize: Price.of(new Decimal('0.1')) }),
        }),
      });
      engine = new ExecutionEngine(deps);

      const report = await engine.execute(ctx, [place({ side: BUY, price: PRICE_55 })]); // 0.55 % 0.1 ≠ 0

      expect(report.placed).toBe(0);
      expect(report.localRejected).toBe(1);
      expect(deps.placeOrderUseCase.execute).not.toHaveBeenCalled();
      const outcome = report.outcomes.find((o) => o.kind === 'LOCAL_REJECTED');
      expect((outcome?.error as LocalIntentRejectionError).code).toBe('TICK_SIZE_VIOLATION');
    });

    it('price кратна tickSize → проходит (Decimal-арифметика, не float %)', async () => {
      deps = makeDeps({
        catalog: makeCatalog({
          // 0.55 / 0.05 = 11 — кратно; float (0.55 % 0.05) дал бы погрешность.
          [PRIMARY_TOKEN]: makeInstrumentInfo({ tickSize: Price.of(new Decimal('0.05')) }),
        }),
      });
      engine = new ExecutionEngine(deps);

      const report = await engine.execute(ctx, [place({ side: BUY, price: PRICE_55 })]);

      expect(report.placed).toBe(1);
    });

    it('should allow SELL even when size < minOrderSize (sell remainder)', async () => {
      deps = makeDeps({
        catalog: makeCatalog({
          [PRIMARY_TOKEN]: makeInstrumentInfo({ minOrderSize: Quantity.of(new Decimal('5')) }),
        }),
      });
      engine = new ExecutionEngine(deps);

      const report = await engine.execute(ctx, [place({ side: SELL, price: PRICE_65, size: Quantity.of(new Decimal('3')) })]);

      expect(report.placed).toBe(1);
      expect(report.skipped).toBe(0);
    });

    it('should reject BUY when price × size < minOrderValue (Money)', async () => {
      deps = makeDeps({
        catalog: makeCatalog({
          [PRIMARY_TOKEN]: makeInstrumentInfo({ minOrderValue: Money.of(new Decimal('1'), 'USDC') }),
        }),
      });
      engine = new ExecutionEngine(deps);

      const report = await engine.execute(ctx, [
        place({ side: BUY, price: Price.of(new Decimal('0.01')), size: Quantity.of(new Decimal('5')) }),
      ]);

      expect(report.skipped).toBe(1);
      expect(report.localRejected).toBe(1);
      expect(deps.placeOrderUseCase.execute).not.toHaveBeenCalled();
    });

    it('should not apply minOrderValue check to SELL orders', async () => {
      const report = await engine.execute(ctx, [
        place({ side: SELL, price: Price.of(new Decimal('0.01')), size: Quantity.of(new Decimal('5')) }),
      ]);

      expect(report.placed).toBe(1);
      expect(report.skipped).toBe(0);
    });
  });

  // ── Exchange rejection cooldown ──────────────────────────

  describe('exchange rejection cooldown', () => {
    it('should return failed on first exchange rejection', async () => {
      (deps.placeOrderUseCase as any).execute.mockResolvedValue(
        Err(new TradingError('venue rejected')),
      );

      const report = await engine.execute(ctx, [place({ side: SELL, price: PRICE_65 })]);

      expect(report.errors).toHaveLength(1);
      expect(report.placed).toBe(0);
      expect(deps.placeOrderUseCase.execute).toHaveBeenCalledTimes(1);
    });

    it('should skip second BUY attempt immediately after rejection (cooldown active)', async () => {
      (deps.placeOrderUseCase as any).execute.mockResolvedValue(
        Err(new TradingError('venue rejected')),
      );

      await engine.execute(ctx, [place({ side: BUY, price: PRICE_55 })]);
      (deps.placeOrderUseCase.execute as any).mockClear();

      const report = await engine.execute(ctx, [place({ side: BUY, price: PRICE_55 })]);

      expect(report.skipped).toBe(1);
      expect(report.errors).toHaveLength(0);
      expect(deps.placeOrderUseCase.execute).not.toHaveBeenCalled();
    });

    it('should NOT apply cooldown to SELL (SL/TP exits must not be blocked)', async () => {
      (deps.placeOrderUseCase as any).execute.mockResolvedValue(
        Err(new TradingError('venue rejected')),
      );

      await engine.execute(ctx, [place({ side: SELL, price: PRICE_65 })]);
      (deps.placeOrderUseCase.execute as any).mockClear();

      const report = await engine.execute(ctx, [place({ side: SELL, price: PRICE_65 })]);

      expect(report.skipped).toBe(0);
      expect(report.errors).toHaveLength(1);
      expect(deps.placeOrderUseCase.execute).toHaveBeenCalledTimes(1);
    });

    it('should not apply cooldown to different side', async () => {
      (deps.placeOrderUseCase as any).execute
        .mockResolvedValueOnce(Err(new TradingError('venue rejected')))
        .mockResolvedValueOnce(Ok(ORDER_1));

      await engine.execute(ctx, [place({ side: SELL, price: PRICE_65 })]);

      const report = await engine.execute(ctx, [place({ side: BUY, price: PRICE_55 })]);

      expect(report.placed).toBe(1);
      expect(report.skipped).toBe(0);
    });
  });

  // ── Typed failure codes ──────────────────────────────

  describe('typed failure codes', () => {
    it('POST_ONLY_WOULD_TAKE (typed) + postOnly → benign skipped', async () => {
      (deps.placeOrderUseCase as any).execute.mockResolvedValue(
        Err(new PlaceOrderFailureError('POST_ONLY_WOULD_TAKE', 'Exchange rejected order: post only')),
      );

      const report = await engine.execute(ctx, [place({ side: BUY, postOnly: true })]);

      expect(report.skipped).toBe(1);
      expect(report.errors).toHaveLength(0);
      expect(engine.stats.benignPostOnlyRejects).toBe(1);
    });

    it('обычная ошибка с текстом "defer"/"marketable" НЕ классифицируется как benign', async () => {
      const err = new TradingError('order deferred: marketable post-only would execute immediately');
      (deps.placeOrderUseCase as any).execute.mockResolvedValue(Err(err));

      const report = await engine.execute(ctx, [place({ side: BUY, postOnly: true })]);

      // Текст похож на post-only reject, но typed-кода нет → это FAILED, не skip.
      expect(report.skipped).toBe(0);
      expect(report.failed).toBe(1);
      expect(report.errors[0].error).toBe(err);
      expect(engine.stats.benignPostOnlyRejects).toBe(0);
    });

    it('POST_ONLY_WOULD_TAKE без postOnly=true в intent → НЕ benign', async () => {
      (deps.placeOrderUseCase as any).execute.mockResolvedValue(
        Err(new PlaceOrderFailureError('POST_ONLY_WOULD_TAKE', 'post only reject')),
      );

      const report = await engine.execute(ctx, [place({ side: BUY })]);

      expect(report.failed).toBe(1);
      expect(engine.stats.benignPostOnlyRejects).toBe(0);
    });
  });

  // ── SELL dust retry (typed metadata only) ────────────

  describe('SELL dust retry', () => {
    const balanceMetadata = {
      onChainBalanceMicro: new Decimal('99500000'),  // 99.5 tokens
      orderAmountMicro: new Decimal('100000000'),    // 100 tokens (deficit 0.5%)
    };

    it('DEFINITELY_REJECTED + INSUFFICIENT_TOKEN_BALANCE + typed metadata → ровно один retry', async () => {
      (deps.placeOrderUseCase as any).execute
        .mockResolvedValueOnce(Err(new PlaceOrderFailureError(
          'INSUFFICIENT_TOKEN_BALANCE',
          'Exchange rejected order: not enough balance',
          { balance: balanceMetadata },
        )))
        .mockResolvedValueOnce(Ok(ORDER_2));

      const report = await engine.execute(ctx, [place({ side: SELL, price: PRICE_65 })]);

      expect(report.placed).toBe(1);
      expect(deps.placeOrderUseCase.execute).toHaveBeenCalledTimes(2);
      expect(engine.stats.sellDustRetryCount).toBe(1);
      const retryCall = (deps.placeOrderUseCase.execute as any).mock.calls[1][0] as any;
      expect(retryCall.size.toNumber()).toBe(99.5);
    });

    it('retry максимум один: повторный typed reject → failed без второго retry', async () => {
      (deps.placeOrderUseCase as any).execute.mockResolvedValue(
        Err(new PlaceOrderFailureError(
          'INSUFFICIENT_TOKEN_BALANCE',
          'not enough balance',
          { balance: balanceMetadata },
        )),
      );

      const report = await engine.execute(ctx, [place({ side: SELL, price: PRICE_65 })]);

      expect(report.failed).toBe(1);
      expect(deps.placeOrderUseCase.execute).toHaveBeenCalledTimes(2); // 1 исходный + 1 retry
    });

    it('SUBMISSION_OUTCOME_UNKNOWN + текст похожий на balance rejection → retry НЕ выполняется', async () => {
      (deps.placeOrderUseCase as any).execute.mockResolvedValue(
        Err(new PlaceOrderFailureError(
          'SUBMISSION_OUTCOME_UNKNOWN',
          'transport error: not enough balance / allowance -> balance: 99500000, order amount: 100000000',
        )),
      );

      const report = await engine.execute(ctx, [place({ side: SELL, price: PRICE_65 })]);

      expect(report.failed).toBe(1);
      expect(deps.placeOrderUseCase.execute).toHaveBeenCalledTimes(1);
      expect(engine.stats.sellDustRetryCount).toBe(0);
    });

    it('INSUFFICIENT_TOKEN_BALANCE БЕЗ typed metadata → retry НЕ выполняется', async () => {
      (deps.placeOrderUseCase as any).execute.mockResolvedValue(
        Err(new PlaceOrderFailureError(
          'INSUFFICIENT_TOKEN_BALANCE',
          'not enough balance / allowance -> balance: 99500000, order amount: 100000000',
        )),
      );

      const report = await engine.execute(ctx, [place({ side: SELL, price: PRICE_65 })]);

      expect(report.failed).toBe(1);
      expect(deps.placeOrderUseCase.execute).toHaveBeenCalledTimes(1);
      expect(engine.stats.sellDustRetryCount).toBe(0);
    });

    it('дефицит > 1% → retry НЕ выполняется', async () => {
      (deps.placeOrderUseCase as any).execute.mockResolvedValue(
        Err(new PlaceOrderFailureError(
          'INSUFFICIENT_TOKEN_BALANCE',
          'not enough balance',
          {
            balance: {
              onChainBalanceMicro: new Decimal('90000000'),  // 90 tokens
              orderAmountMicro: new Decimal('100000000'),    // deficit 10%
            },
          },
        )),
      );

      const report = await engine.execute(ctx, [place({ side: SELL, price: PRICE_65 })]);

      expect(report.failed).toBe(1);
      expect(deps.placeOrderUseCase.execute).toHaveBeenCalledTimes(1);
      expect(engine.stats.sellDustRetryCount).toBe(0);
    });
  });

  // ── Determinism (order IDs) ──────────────────────────

  describe('deterministic order IDs', () => {
    it('одинаковый replay дважды → одинаковая последовательность order IDs', async () => {
      const runOnce = async (): Promise<string[]> => {
        const localDeps = makeDeps({ orderIdGenerator: new SequentialOrderIdGenerator('replay') });
        const localEngine = new ExecutionEngine(localDeps);
        await localEngine.execute(makeCtx(), [
          place({ side: BUY, price: PRICE_55 }),
          place({ side: SELL, price: PRICE_65 }),
        ]);
        return (localDeps.placeOrderUseCase.execute as any).mock.calls.map(
          (c: any[]) => String(c[0].orderId),
        );
      };

      const ids1 = await runOnce();
      const ids2 = await runOnce();

      expect(ids1).toEqual(['replay-1', 'replay-2']);
      expect(ids2).toEqual(ids1);
    });
  });
});
