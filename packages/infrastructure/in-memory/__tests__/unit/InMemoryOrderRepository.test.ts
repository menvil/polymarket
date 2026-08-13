import { describe, it, expect, beforeEach } from '@jest/globals';
import Decimal from 'decimal.js';
import { asOrderId, asFillId } from '@polymarket/ids';
import { pendingMatchFillId } from '@polymarket/ports';
import type { InstrumentId } from '@polymarket/ids';
import { AssetIdHelpers } from '@polymarket/ids';
import { Price, Quantity } from '@polymarket/value-objects';
import { TimestampService } from '@polymarket/value-objects';
import { Order } from '@polymarket/order';
import { InMemoryOrderRepository } from '../../src/InMemoryOrderRepository.js';

// ── Helpers ────────────────────────────────────────────────

const ASSET_1 = AssetIdHelpers.USDC; // Используем USDC как AssetId для простоты
const INSTRUMENT_2 = 'token-NO' as unknown as InstrumentId;

function createOrder(opts: {
  id: string;
  strategyId?: string;
  asset?: any;
}): Order {
  const timestamp = TimestampService.create(1000);
  if (!timestamp.ok) throw new Error('Failed to create timestamp');

  const result = Order.create({
    id: asOrderId(opts.id)!,
    asset: opts.asset ?? ASSET_1,
    side: 'BUY',
    price: Price.of(new Decimal('0.55')),
    size: Quantity.of(new Decimal('100')),
    timestamp: timestamp.value,
    strategyId: opts.strategyId,
  });
  if (!result.ok) throw new Error(`Failed to create order: ${result.error.message}`);
  return result.value;
}

// ── Tests ──────────────────────────────────────────────────

describe('InMemoryOrderRepository', () => {
  let repo: InMemoryOrderRepository;

  beforeEach(() => {
    repo = new InMemoryOrderRepository();
  });

  // ── IOrderRepository (async) ────────────────────────────

  describe('IOrderRepository (async)', () => {
    it('should save and get order', async () => {
      const order = createOrder({ id: 'order-1' });
      await repo.save(order, 0);

      const found = await repo.get(order.id);
      expect(found).toBe(order);
    });

    it('should return undefined for unknown order', async () => {
      expect(await repo.get(asOrderId('unknown')!)).toBeUndefined();
    });

    it('should delete order via deleteIfVersion', async () => {
      const order = createOrder({ id: 'order-1' });
      await repo.save(order, 0);
      const result = await repo.deleteIfVersion(order.id, 1);

      expect(result.ok).toBe(true);
      expect(await repo.get(order.id)).toBeUndefined();
    });

    it('should getByStrategyId', async () => {
      const order1 = createOrder({ id: 'order-1', strategyId: 'strat-1' });
      const order2 = createOrder({ id: 'order-2', strategyId: 'strat-1' });
      const order3 = createOrder({ id: 'order-3', strategyId: 'strat-2' });
      await repo.save(order1, 0);
      await repo.save(order2, 0);
      await repo.save(order3, 0);

      const strat1Orders = await repo.getByStrategyId('strat-1');
      expect(strat1Orders).toHaveLength(2);
    });

    it('should countByStrategyId', async () => {
      const order1 = createOrder({ id: 'order-1', strategyId: 'strat-1' });
      const order2 = createOrder({ id: 'order-2', strategyId: 'strat-1' });
      await repo.save(order1, 0);
      await repo.save(order2, 0);

      expect(await repo.countByStrategyId('strat-1')).toBe(2);
      expect(await repo.countByStrategyId('strat-2')).toBe(0);
      expect(await repo.countByStrategyId()).toBe(2);
    });

    it('should getAll', async () => {
      await repo.save(createOrder({ id: 'order-1' }), 0);
      await repo.save(createOrder({ id: 'order-2' }), 0);

      const all = await repo.getAll();
      expect(all).toHaveLength(2);
    });
  });

  // ── IOrderStateStore (sync) ─────────────────────────────

  describe('IOrderStateStore (sync)', () => {
    it('should getOpenOrders sync', async () => {
      const order1 = createOrder({ id: 'order-1', strategyId: 'strat-1' });
      const order2 = createOrder({ id: 'order-2', strategyId: 'strat-1' });
      const order3 = createOrder({ id: 'order-3', strategyId: 'strat-2' });
      await repo.save(order1, 0);
      await repo.save(order2, 0);
      await repo.save(order3, 0);

      // Sync call — no await
      const orders = repo.getOpenOrders('strat-1');
      expect(orders).toHaveLength(2);
      expect(orders).toContain(order1);
      expect(orders).toContain(order2);
    });

    it('should return empty array for unknown strategy', () => {
      const orders = repo.getOpenOrders('unknown');
      expect(orders).toHaveLength(0);
    });

    it('should getOpenOrdersByInstrument — фильтрация по strategyId и asset', async () => {
      // Используем AssetIdHelpers.USDC как asset (= instrumentId для теста)
      const order1 = createOrder({ id: 'order-1', strategyId: 'strat-1', asset: ASSET_1 });
      const order2 = createOrder({ id: 'order-2', strategyId: 'strat-1', asset: ASSET_1 });
      const order3 = createOrder({ id: 'order-3', strategyId: 'strat-2', asset: ASSET_1 });
      await repo.save(order1, 0);
      await repo.save(order2, 0);
      await repo.save(order3, 0);

      // getOpenOrdersByInstrument фильтрует по String(order.asset) === String(instrumentId)
      const instrumentId = String(ASSET_1) as unknown as InstrumentId;
      const orders = repo.getOpenOrdersByInstrument('strat-1', instrumentId);
      expect(orders).toHaveLength(2);
    });

    it('should getOpenOrdersByInstrument — фильтрация по инструменту', async () => {
      // order1 на одном asset, order2 на другом
      const order1 = createOrder({ id: 'order-1', strategyId: 'strat-1', asset: ASSET_1 });
      await repo.save(order1, 0);

      // InstrumentId не совпадает с asset order1
      const orders = repo.getOpenOrdersByInstrument('strat-1', INSTRUMENT_2);
      expect(orders).toHaveLength(0);
    });

    it('should getOrder sync', async () => {
      const order = createOrder({ id: 'order-1' });
      await repo.save(order, 0);

      // Sync call
      const found = repo.getOrder(order.id);
      expect(found).toBe(order);
    });

    it('should return undefined for unknown orderId', () => {
      expect(repo.getOrder(asOrderId('unknown')!)).toBeUndefined();
    });
  });

  // ── fillId-based matched tracking ───────────────────────

  describe('markOrderFillMatched / clearOrderFillMatched / hasMatchedFills (fillId-scoped)', () => {
    const ORDER_ID = asOrderId('order-1')!;
    const FILL_1 = asFillId('fill-1')!;
    const FILL_2 = asFillId('fill-2')!;
    const UNKNOWN_FILL = asFillId('fill-unknown')!;

    it('два partial fills одного ордера: clear первого не снимает matched второго', () => {
      repo.markOrderFillMatched(ORDER_ID, FILL_1);
      repo.markOrderFillMatched(ORDER_ID, FILL_2);
      expect(repo.hasMatchedFills(ORDER_ID)).toBe(true);
      expect([...repo.getMatchedFillIds(ORDER_ID)].sort()).toEqual([FILL_1, FILL_2].sort());

      repo.clearOrderFillMatched(ORDER_ID, FILL_1);

      // FILL_1 снят, но FILL_2 остаётся matched — ордер всё ещё "matched" в целом.
      expect(repo.hasMatchedFills(ORDER_ID)).toBe(true);
      expect(repo.getMatchedFillIds(ORDER_ID)).toEqual([FILL_2]);

      repo.clearOrderFillMatched(ORDER_ID, FILL_2);
      expect(repo.hasMatchedFills(ORDER_ID)).toBe(false);
    });

    it('повторная пометка ТЕМ ЖЕ fillId идемпотентна (дублирующееся MATCHED-событие)', () => {
      repo.markOrderFillMatched(ORDER_ID, FILL_1);
      repo.markOrderFillMatched(ORDER_ID, FILL_1); // дубликат
      expect(repo.getMatchedFillIds(ORDER_ID)).toEqual([FILL_1]);

      // Один clear полностью снимает — счётчик не «застревает» на 2.
      repo.clearOrderFillMatched(ORDER_ID, FILL_1);
      expect(repo.hasMatchedFills(ORDER_ID)).toBe(false);
    });

    it('clear по неизвестному fillId — no-op, не открывает cancel преждевременно', () => {
      repo.markOrderFillMatched(ORDER_ID, FILL_1);
      repo.clearOrderFillMatched(ORDER_ID, UNKNOWN_FILL);

      // Реальный matched fill (FILL_1) остаётся нетронутым.
      expect(repo.hasMatchedFills(ORDER_ID)).toBe(true);
      expect(repo.getMatchedFillIds(ORDER_ID)).toEqual([FILL_1]);
    });

    it('clear по неизвестному orderId — no-op, не бросает исключение', () => {
      expect(() => repo.clearOrderFillMatched(asOrderId('never-marked')!, FILL_1)).not.toThrow();
    });
  });

  // ── fillId-based in-flight tracking ──────────────────────

  describe('markInFlightFill / clearInFlightFill / hasInFlightFills (fillId-scoped)', () => {
    const ORDER_ID = asOrderId('order-1')!;
    const INSTRUMENT_A = 'instrument-a' as unknown as InstrumentId;
    const FILL_1 = asFillId('fill-1')!;
    const FILL_2 = asFillId('fill-2')!;
    const UNKNOWN_FILL = asFillId('fill-unknown')!;

    it('duplicate MATCHED событие (тот же fillId) не ломает in-flight tracking', () => {
      repo.markInFlightFill({ instrumentId: INSTRUMENT_A, fillId: FILL_1, orderId: ORDER_ID, status: 'MATCHED' });
      repo.markInFlightFill({ instrumentId: INSTRUMENT_A, fillId: FILL_1, orderId: ORDER_ID, status: 'MATCHED' }); // дубликат WS-события
      expect(repo.hasInFlightFills(INSTRUMENT_A)).toBe(true);
      expect(repo.getInFlightFills(INSTRUMENT_A)).toHaveLength(1);

      // Один clear полностью снимает — не нужно два clear на дублированный mark.
      repo.clearInFlightFill(FILL_1);
      expect(repo.hasInFlightFills(INSTRUMENT_A)).toBe(false);
    });

    it('markInFlightFill сохраняет status; getInFlightFills возвращает записи со status', () => {
      repo.markInFlightFill({ instrumentId: INSTRUMENT_A, fillId: FILL_1, orderId: ORDER_ID, status: 'MATCHED' });
      repo.markInFlightFill({ instrumentId: INSTRUMENT_A, fillId: FILL_2, orderId: ORDER_ID, status: 'MINED' });

      const fills = repo.getInFlightFills(INSTRUMENT_A);
      expect(fills).toHaveLength(2);
      expect(fills.find((f) => f.fillId === FILL_1)?.status).toBe('MATCHED');
      expect(fills.find((f) => f.fillId === FILL_2)?.status).toBe('MINED');
    });

    it('duplicate mark того же fillId обновляет status на новый input.status (MATCHED → MINED)', () => {
      repo.markInFlightFill({ instrumentId: INSTRUMENT_A, fillId: FILL_1, orderId: ORDER_ID, status: 'MATCHED' });
      repo.markInFlightFill({ instrumentId: INSTRUMENT_A, fillId: FILL_1, orderId: ORDER_ID, status: 'MINED' });

      const fills = repo.getInFlightFills(INSTRUMENT_A);
      expect(fills).toHaveLength(1); // дубля нет
      expect(fills[0]?.status).toBe('MINED');
    });

    it('updateInFlightFillStatus обновляет status существующей записи (включая терминальный)', () => {
      repo.markInFlightFill({ instrumentId: INSTRUMENT_A, fillId: FILL_1, orderId: ORDER_ID, status: 'MATCHED' });

      repo.updateInFlightFillStatus(FILL_1, 'CONFIRMED');

      const fills = repo.getInFlightFills(INSTRUMENT_A);
      expect(fills).toHaveLength(1); // запись НЕ снята — снятие остаётся за clearInFlightFill
      expect(fills[0]?.status).toBe('CONFIRMED');
    });

    it('updateInFlightFillStatus для неизвестного fillId — no-op, не бросает', () => {
      expect(() => repo.updateInFlightFillStatus(UNKNOWN_FILL, 'FAILED')).not.toThrow();
      expect(repo.getInFlightFills(INSTRUMENT_A)).toHaveLength(0);
    });

    it('два разных in-flight fill на одном инструменте: clear одного не затрагивает другой', () => {
      repo.markInFlightFill({ instrumentId: INSTRUMENT_A, fillId: FILL_1, orderId: ORDER_ID, status: 'MATCHED' });
      repo.markInFlightFill({ instrumentId: INSTRUMENT_A, fillId: FILL_2, orderId: ORDER_ID, status: 'MATCHED' });
      expect(repo.getInFlightFills(INSTRUMENT_A)).toHaveLength(2);

      repo.clearInFlightFill(FILL_1);

      expect(repo.hasInFlightFills(INSTRUMENT_A)).toBe(true);
      const remaining = repo.getInFlightFills(INSTRUMENT_A);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.fillId).toBe(FILL_2);
    });

    it('clear по неизвестному fillId — no-op, не открывает cancel преждевременно', () => {
      repo.markInFlightFill({ instrumentId: INSTRUMENT_A, fillId: FILL_1, orderId: ORDER_ID, status: 'MATCHED' });
      repo.clearInFlightFill(UNKNOWN_FILL);

      // Реальный in-flight fill (FILL_1) остаётся нетронутым.
      expect(repo.hasInFlightFills(INSTRUMENT_A)).toBe(true);
      expect(repo.getInFlightFills(INSTRUMENT_A)).toHaveLength(1);
    });

    it('clear по неизвестному fillId вообще (никогда не помечался) не бросает исключение', () => {
      expect(() => repo.clearInFlightFill(UNKNOWN_FILL)).not.toThrow();
    });
  });

  // ── Fill processing blocks (Stage 6) ─────────────────────
  describe('fill processing blocks + hasUnsettledFills', () => {
    const ORDER_ID = asOrderId('order-1')!;
    const INSTRUMENT_A = 'instrument-a' as unknown as InstrumentId;
    const FILL_1 = asFillId('fill-1')!;
    const FILL_2 = asFillId('fill-2')!;

    it('markFillProcessing → PROCESSING; hasFillProcessingBlocks true', () => {
      repo.markFillProcessing({ fillId: FILL_1, orderId: ORDER_ID, instrumentId: INSTRUMENT_A });
      expect(repo.hasFillProcessingBlocks(INSTRUMENT_A)).toBe(true);
      expect(repo.getFillProcessingBlocks(INSTRUMENT_A)[0]).toMatchObject({ fillId: FILL_1, status: 'PROCESSING' });
    });

    it('updateFillProcessingStatus меняет статус, НЕ снимает блок', () => {
      repo.markFillProcessing({ fillId: FILL_1, orderId: ORDER_ID, instrumentId: INSTRUMENT_A });
      repo.updateFillProcessingStatus(FILL_1, 'RECONCILIATION_REQUIRED');
      expect(repo.hasFillProcessingBlocks(INSTRUMENT_A)).toBe(true);
      expect(repo.getFillProcessingBlocks(INSTRUMENT_A)[0]?.status).toBe('RECONCILIATION_REQUIRED');
    });

    it('clearFillProcessing снимает блок', () => {
      repo.markFillProcessing({ fillId: FILL_1, orderId: ORDER_ID, instrumentId: INSTRUMENT_A });
      repo.clearFillProcessing(FILL_1);
      expect(repo.hasFillProcessingBlocks(INSTRUMENT_A)).toBe(false);
    });

    it('clear одного блока не затрагивает другой', () => {
      repo.markFillProcessing({ fillId: FILL_1, orderId: ORDER_ID, instrumentId: INSTRUMENT_A });
      repo.markFillProcessing({ fillId: FILL_2, orderId: ORDER_ID, instrumentId: INSTRUMENT_A });
      repo.clearFillProcessing(FILL_1);
      const blocks = repo.getFillProcessingBlocks(INSTRUMENT_A);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.fillId).toBe(FILL_2);
    });

    it('update/clear по неизвестному fillId — no-op, не бросает', () => {
      expect(() => repo.updateFillProcessingStatus(FILL_1, 'FAILED_RETRYABLE')).not.toThrow();
      expect(() => repo.clearFillProcessing(FILL_1)).not.toThrow();
    });

    it('hasUnsettledFills = venue in-flight ЛИБО processing-блок', () => {
      // Ни того, ни другого.
      expect(repo.hasUnsettledFills(INSTRUMENT_A)).toBe(false);
      // Только processing-блок.
      repo.markFillProcessing({ fillId: FILL_1, orderId: ORDER_ID, instrumentId: INSTRUMENT_A });
      expect(repo.hasUnsettledFills(INSTRUMENT_A)).toBe(true);
      repo.clearFillProcessing(FILL_1);
      expect(repo.hasUnsettledFills(INSTRUMENT_A)).toBe(false);
      // Только venue in-flight.
      repo.markInFlightFill({ instrumentId: INSTRUMENT_A, fillId: FILL_2, orderId: ORDER_ID, status: 'MATCHED' });
      expect(repo.hasUnsettledFills(INSTRUMENT_A)).toBe(true);
    });

    it('RECONCILIATION_REQUIRED блок держит hasUnsettledFills true (блокирует новую активность)', () => {
      repo.markFillProcessing({ fillId: FILL_1, orderId: ORDER_ID, instrumentId: INSTRUMENT_A });
      repo.updateFillProcessingStatus(FILL_1, 'RECONCILIATION_REQUIRED');
      expect(repo.hasUnsettledFills(INSTRUMENT_A)).toBe(true);
    });

    it('clear() очищает processing-блоки', () => {
      repo.markFillProcessing({ fillId: FILL_1, orderId: ORDER_ID, instrumentId: INSTRUMENT_A });
      repo.clear();
      expect(repo.hasFillProcessingBlocks(INSTRUMENT_A)).toBe(false);
    });
  });

  // ── Утилиты ─────────────────────────────────────────────

  describe('utilities', () => {
    it('should report size', async () => {
      expect(repo.size).toBe(0);
      await repo.save(createOrder({ id: 'order-1' }), 0);
      expect(repo.size).toBe(1);
    });

    it('should clear all orders', async () => {
      await repo.save(createOrder({ id: 'order-1' }), 0);
      await repo.save(createOrder({ id: 'order-2' }), 0);
      repo.clear();
      expect(repo.size).toBe(0);
      expect(repo.getOpenOrders('strat-1')).toHaveLength(0);
    });

    it('clear() сбрасывает также matched fills и in-flight fills индексы', () => {
      const orderId = asOrderId('order-1')!;
      const fillId = asFillId('fill-1')!;
      const instrumentId = 'instrument-a' as unknown as InstrumentId;

      repo.markOrderFillMatched(orderId, fillId);
      repo.markInFlightFill({ instrumentId, fillId, orderId, status: 'MATCHED' });
      expect(repo.hasMatchedFills(orderId)).toBe(true);
      expect(repo.hasInFlightFills(instrumentId)).toBe(true);

      repo.clear();

      expect(repo.hasMatchedFills(orderId)).toBe(false);
      expect(repo.hasInFlightFills(instrumentId)).toBe(false);
      expect(repo.getMatchedFillIds(orderId)).toHaveLength(0);
      expect(repo.getInFlightFills(instrumentId)).toHaveLength(0);
    });
  });

  // ── Contract: placeholder cleanup при clearOrderFillMatched ──
  describe('placeholder cleanup contract (clearOrderFillMatched)', () => {
    const ORDER_ID = asOrderId('order-ph')!;
    const REAL_FILL_1 = asFillId('real-fill-1')!;
    const REAL_FILL_2 = asFillId('real-fill-2')!;

    it('EXACT-ID: clear реального fill НЕ трогает placeholder и другой partial fill; явный clear placeholder снимает только его', () => {
      // 1. Placeholder (uncertain cancel / submit FILLED без fillId).
      const placeholder = pendingMatchFillId(ORDER_ID);
      repo.markOrderFillMatched(ORDER_ID, placeholder);
      // 2. Два реальных matched fill ID (partial fills).
      repo.markOrderFillMatched(ORDER_ID, REAL_FILL_1);
      repo.markOrderFillMatched(ORDER_ID, REAL_FILL_2);
      expect(repo.getMatchedFillIds(ORDER_ID)).toHaveLength(3);

      // 3. Обработан первый Fill: снимается ТОЛЬКО его fillId (никакой
      // скрытой семантики — placeholder снимает вызывающий код явно).
      repo.clearOrderFillMatched(ORDER_ID, REAL_FILL_1);
      let remaining = repo.getMatchedFillIds(ORDER_ID).map(String);
      expect(remaining).not.toContain(String(REAL_FILL_1));
      expect(remaining).toContain(String(placeholder));
      expect(remaining).toContain(String(REAL_FILL_2));

      // 4. Явный clear placeholder (как делает ProcessFillUseCase) снимает
      // только placeholder; второй partial fill сохраняется.
      repo.clearOrderFillMatched(ORDER_ID, placeholder);
      remaining = repo.getMatchedFillIds(ORDER_ID).map(String);
      expect(remaining).not.toContain(String(placeholder));
      expect(remaining).toContain(String(REAL_FILL_2));
      expect(repo.hasMatchedFills(ORDER_ID)).toBe(true);

      // 5. После второго Fill matched-состояния не остаётся.
      repo.clearOrderFillMatched(ORDER_ID, REAL_FILL_2);
      expect(repo.hasMatchedFills(ORDER_ID)).toBe(false);
      expect(repo.getMatchedFillIds(ORDER_ID)).toHaveLength(0);
    });
  });

  // ── Manual reconciliation blocks (P0) ────────────────────
  describe('manual reconciliation blocks', () => {
    const ORDER_ID = asOrderId('order-1')!;
    const ORDER_2 = asOrderId('order-2')!;
    const INSTRUMENT_A = 'instrument-a' as unknown as InstrumentId;
    const INSTRUMENT_B = 'instrument-b' as unknown as InstrumentId;

    it('markManualReconciliationBlock → блок виден по order и по instrument, участвует в hasUnsettledFills', () => {
      repo.markManualReconciliationBlock({ orderId: ORDER_ID, instrumentId: INSTRUMENT_A, reason: 'journal desync' });
      expect(repo.hasManualReconciliationBlockForOrder(ORDER_ID)).toBe(true);
      expect(repo.hasManualReconciliationBlocks(INSTRUMENT_A)).toBe(true);
      expect(repo.hasManualReconciliationBlocks(INSTRUMENT_B)).toBe(false);
      expect(repo.hasUnsettledFills(INSTRUMENT_A)).toBe(true);
      expect(repo.getManualReconciliationBlocks(INSTRUMENT_A)).toEqual([
        { orderId: ORDER_ID, instrumentId: INSTRUMENT_A, reason: 'journal desync' },
      ]);
    });

    it('идемпотентен по orderId (повторная пометка обновляет reason, не дублирует)', () => {
      repo.markManualReconciliationBlock({ orderId: ORDER_ID, instrumentId: INSTRUMENT_A, reason: 'first' });
      repo.markManualReconciliationBlock({ orderId: ORDER_ID, instrumentId: INSTRUMENT_A, reason: 'second' });
      const blocks = repo.getManualReconciliationBlocks(INSTRUMENT_A);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].reason).toBe('second');
    });

    it('clearManualReconciliationBlock снимает ТОЛЬКО указанный orderId', () => {
      repo.markManualReconciliationBlock({ orderId: ORDER_ID, instrumentId: INSTRUMENT_A, reason: 'a' });
      repo.markManualReconciliationBlock({ orderId: ORDER_2, instrumentId: INSTRUMENT_A, reason: 'b' });
      repo.clearManualReconciliationBlock(ORDER_ID);
      expect(repo.hasManualReconciliationBlockForOrder(ORDER_ID)).toBe(false);
      expect(repo.hasManualReconciliationBlockForOrder(ORDER_2)).toBe(true);
      expect(repo.hasUnsettledFills(INSTRUMENT_A)).toBe(true);
    });

    it('clearInFlightFill/clearFillProcessing НЕ снимают manual block (отдельная ось)', () => {
      const fillId = asFillId('fill-x')!;
      repo.markManualReconciliationBlock({ orderId: ORDER_ID, instrumentId: INSTRUMENT_A, reason: 'desync' });
      repo.markInFlightFill({ instrumentId: INSTRUMENT_A, fillId, orderId: ORDER_ID, status: 'MATCHED' });
      repo.clearInFlightFill(fillId);
      repo.clearFillProcessing(fillId);
      expect(repo.hasManualReconciliationBlockForOrder(ORDER_ID)).toBe(true);
      expect(repo.hasUnsettledFills(INSTRUMENT_A)).toBe(true);
    });

    it('clear() очищает manual blocks', () => {
      repo.markManualReconciliationBlock({ orderId: ORDER_ID, instrumentId: INSTRUMENT_A, reason: 'x' });
      repo.clear();
      expect(repo.hasManualReconciliationBlockForOrder(ORDER_ID)).toBe(false);
      expect(repo.hasUnsettledFills(INSTRUMENT_A)).toBe(false);
    });
  });
});
