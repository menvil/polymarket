import { describe, it, expect, beforeEach } from '@jest/globals';
import Decimal from 'decimal.js';
import { asOrderId } from '@polymarket/ids';
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
      await repo.save(order);

      const found = await repo.get(order.id);
      expect(found).toBe(order);
    });

    it('should return undefined for unknown order', async () => {
      expect(await repo.get(asOrderId('unknown')!)).toBeUndefined();
    });

    it('should delete order', async () => {
      const order = createOrder({ id: 'order-1' });
      await repo.save(order);
      await repo.delete(order.id);

      expect(await repo.get(order.id)).toBeUndefined();
    });

    it('should getByStrategyId', async () => {
      const order1 = createOrder({ id: 'order-1', strategyId: 'strat-1' });
      const order2 = createOrder({ id: 'order-2', strategyId: 'strat-1' });
      const order3 = createOrder({ id: 'order-3', strategyId: 'strat-2' });
      await repo.save(order1);
      await repo.save(order2);
      await repo.save(order3);

      const strat1Orders = await repo.getByStrategyId('strat-1');
      expect(strat1Orders).toHaveLength(2);
    });

    it('should countByStrategyId', async () => {
      const order1 = createOrder({ id: 'order-1', strategyId: 'strat-1' });
      const order2 = createOrder({ id: 'order-2', strategyId: 'strat-1' });
      await repo.save(order1);
      await repo.save(order2);

      expect(await repo.countByStrategyId('strat-1')).toBe(2);
      expect(await repo.countByStrategyId('strat-2')).toBe(0);
      expect(await repo.countByStrategyId()).toBe(2);
    });

    it('should getAll', async () => {
      await repo.save(createOrder({ id: 'order-1' }));
      await repo.save(createOrder({ id: 'order-2' }));

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
      await repo.save(order1);
      await repo.save(order2);
      await repo.save(order3);

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
      await repo.save(order1);
      await repo.save(order2);
      await repo.save(order3);

      // getOpenOrdersByInstrument фильтрует по String(order.asset) === String(instrumentId)
      const instrumentId = String(ASSET_1) as unknown as InstrumentId;
      const orders = repo.getOpenOrdersByInstrument('strat-1', instrumentId);
      expect(orders).toHaveLength(2);
    });

    it('should getOpenOrdersByInstrument — фильтрация по инструменту', async () => {
      // order1 на одном asset, order2 на другом
      const order1 = createOrder({ id: 'order-1', strategyId: 'strat-1', asset: ASSET_1 });
      await repo.save(order1);

      // InstrumentId не совпадает с asset order1
      const orders = repo.getOpenOrdersByInstrument('strat-1', INSTRUMENT_2);
      expect(orders).toHaveLength(0);
    });

    it('should getOrder sync', async () => {
      const order = createOrder({ id: 'order-1' });
      await repo.save(order);

      // Sync call
      const found = repo.getOrder(order.id);
      expect(found).toBe(order);
    });

    it('should return undefined for unknown orderId', () => {
      expect(repo.getOrder(asOrderId('unknown')!)).toBeUndefined();
    });
  });

  // ── Утилиты ─────────────────────────────────────────────

  describe('utilities', () => {
    it('should report size', async () => {
      expect(repo.size).toBe(0);
      await repo.save(createOrder({ id: 'order-1' }));
      expect(repo.size).toBe(1);
    });

    it('should clear all orders', async () => {
      await repo.save(createOrder({ id: 'order-1' }));
      await repo.save(createOrder({ id: 'order-2' }));
      repo.clear();
      expect(repo.size).toBe(0);
      expect(repo.getOpenOrders('strat-1')).toHaveLength(0);
    });
  });
});
