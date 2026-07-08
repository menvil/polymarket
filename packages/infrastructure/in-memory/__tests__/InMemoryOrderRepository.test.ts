/**
 * Тесты для InMemoryOrderRepository — хранилища ордеров в памяти.
 *
 * @remarks
 * Проверяет все методы IOrderRepository:
 * - get/save/delete
 * - getByStrategyId
 * - countByStrategyId
 * - getAll
 * - Вспомогательные методы size/clear
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { InMemoryOrderRepository } from '../src/InMemoryOrderRepository.js';
import { Order } from '@polymarket/order';
import { Price, Quantity, Timestamp } from '@polymarket/value-objects';
import { asOrderId, asPolymarketCtfToken, asMarketId } from '@polymarket/ids';
import type { IMarketCatalog, InstrumentInfo } from '@polymarket/ports';
import Decimal from 'decimal.js';

/** Тестовый AssetId: POLYMARKET_CTF_TOKEN для токена '1' */
const TEST_ASSET = asPolymarketCtfToken('1')!;
/** Второй тестовый AssetId — для проверки фильтрации по инструменту */
const TEST_ASSET_2 = asPolymarketCtfToken('2')!;

/** Вспомогательная фабрика Order */
function makeOrder(
  id: string,
  strategyId?: string,
  asset = TEST_ASSET,
): Order {
  const orderId = asOrderId(id);
  if (!orderId) throw new Error(`Invalid orderId: ${id}`);

  const result = Order.create({
    id: orderId,
    asset,
    side: 'BUY',
    price: Price.of(new Decimal('0.65')),
    size: Quantity.of(new Decimal('100')),
    timestamp: Timestamp.now(),
    strategyId,
  });

  if (!result.ok) throw new Error(`Failed to create order: ${String(result.error)}`);
  return result.value;
}

/** Мок IMarketCatalog, резолвящий один marketId → один instrumentId */
function makeMarketCatalog(marketIdStr: string, instrumentId: string): IMarketCatalog {
  return makeMarketCatalogMulti(marketIdStr, [instrumentId]);
}

/** Мок IMarketCatalog, резолвящий один marketId → НЕСКОЛЬКО instrumentId (бинарный рынок YES/NO) */
function makeMarketCatalogMulti(marketIdStr: string, instrumentIds: string[]): IMarketCatalog {
  const marketId = asMarketId(marketIdStr)!;
  const infos = instrumentIds.map((instrumentId) => ({ instrumentId, marketId }) as unknown as InstrumentInfo);
  return {
    get: jest.fn().mockReturnValue(undefined),
    getByMarketId: jest.fn().mockImplementation((mid: unknown) => (mid === marketId ? infos[0] : undefined)),
    getAllByMarketId: jest.fn().mockImplementation((mid: unknown) => (mid === marketId ? infos : [])),
    getAll: jest.fn().mockReturnValue([]),
    register: jest.fn(),
    remove: jest.fn(),
    clear: jest.fn(),
  } as unknown as IMarketCatalog;
}

describe('InMemoryOrderRepository', () => {
  let repo: InMemoryOrderRepository;

  beforeEach(() => {
    repo = new InMemoryOrderRepository();
  });

  // ── save / get ──────────────────────────────────────────────────────────

  describe('save() и get()', () => {
    it('сохраняет и возвращает ордер по ID', async () => {
      const order = makeOrder('order-1');
      await repo.save(order);

      const found = await repo.get(order.id);
      expect(found).toBeDefined();
      expect(found?.id).toBe(order.id);
    });

    it('возвращает undefined для несуществующего ордера', async () => {
      const orderId = asOrderId('nonexistent-order')!;
      const found = await repo.get(orderId);
      expect(found).toBeUndefined();
    });

    it('перезаписывает ордер при повторном save с тем же ID', async () => {
      const order = makeOrder('order-1', 'strategy-a');
      await repo.save(order);

      const order2 = makeOrder('order-1', 'strategy-b');
      await repo.save(order2);

      const found = await repo.get(order.id);
      expect(found?.strategyId).toBe('strategy-b');
    });
  });

  // ── delete ───────────────────────────────────────────────────────────────

  describe('delete()', () => {
    it('удаляет ордер из хранилища', async () => {
      const order = makeOrder('order-del');
      await repo.save(order);
      expect(await repo.get(order.id)).toBeDefined();

      await repo.delete(order.id);
      expect(await repo.get(order.id)).toBeUndefined();
    });

    it('безопасен при удалении несуществующего ордера', async () => {
      const orderId = asOrderId('nonexistent')!;
      await expect(repo.delete(orderId)).resolves.toBeUndefined();
    });
  });

  // ── getByStrategyId ───────────────────────────────────────────────────────

  describe('getByStrategyId()', () => {
    it('возвращает ордера только указанной стратегии', async () => {
      const orderA1 = makeOrder('order-a1', 'strategy-a');
      const orderA2 = makeOrder('order-a2', 'strategy-a');
      const orderB1 = makeOrder('order-b1', 'strategy-b');

      await repo.save(orderA1);
      await repo.save(orderA2);
      await repo.save(orderB1);

      const strategyAOrders = await repo.getByStrategyId('strategy-a');
      expect(strategyAOrders).toHaveLength(2);
      expect(strategyAOrders.map((o) => o.id)).toContain(orderA1.id);
      expect(strategyAOrders.map((o) => o.id)).toContain(orderA2.id);
    });

    it('возвращает пустой массив если у стратегии нет ордеров', async () => {
      const order = makeOrder('order-1', 'strategy-a');
      await repo.save(order);

      const result = await repo.getByStrategyId('strategy-z');
      expect(result).toHaveLength(0);
    });

    it('возвращает пустой массив если хранилище пусто', async () => {
      const result = await repo.getByStrategyId('any-strategy');
      expect(result).toHaveLength(0);
    });

    it('игнорирует ордера без strategyId', async () => {
      const orderNoStrategy = makeOrder('order-ns');  // без strategyId
      const orderWithStrategy = makeOrder('order-ws', 'strategy-a');

      await repo.save(orderNoStrategy);
      await repo.save(orderWithStrategy);

      const result = await repo.getByStrategyId('strategy-a');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(orderWithStrategy.id);
    });
  });

  // ── countByStrategyId ─────────────────────────────────────────────────────

  describe('countByStrategyId()', () => {
    it('считает ордера указанной стратегии', async () => {
      await repo.save(makeOrder('order-a1', 'strategy-a'));
      await repo.save(makeOrder('order-a2', 'strategy-a'));
      await repo.save(makeOrder('order-b1', 'strategy-b'));

      const countA = await repo.countByStrategyId('strategy-a');
      const countB = await repo.countByStrategyId('strategy-b');

      expect(countA).toBe(2);
      expect(countB).toBe(1);
    });

    it('возвращает 0 для стратегии без ордеров', async () => {
      const count = await repo.countByStrategyId('nonexistent-strategy');
      expect(count).toBe(0);
    });

    it('без strategyId возвращает общее количество ордеров', async () => {
      await repo.save(makeOrder('order-1', 'strategy-a'));
      await repo.save(makeOrder('order-2', 'strategy-b'));
      await repo.save(makeOrder('order-3'));

      const total = await repo.countByStrategyId();
      expect(total).toBe(3);
    });

    it('возвращает 0 если хранилище пусто (без аргумента)', async () => {
      const total = await repo.countByStrategyId();
      expect(total).toBe(0);
    });
  });

  // ── getAll ────────────────────────────────────────────────────────────────

  describe('getAll()', () => {
    it('возвращает все ордера из хранилища', async () => {
      const order1 = makeOrder('order-1', 'strategy-a');
      const order2 = makeOrder('order-2', 'strategy-b');
      const order3 = makeOrder('order-3');

      await repo.save(order1);
      await repo.save(order2);
      await repo.save(order3);

      const all = await repo.getAll();
      expect(all).toHaveLength(3);
    });

    it('возвращает пустой массив если хранилище пусто', async () => {
      const all = await repo.getAll();
      expect(all).toHaveLength(0);
    });
  });

  // ── getByMarketId() ──────────────────────────────────────────────────────

  describe('getByMarketId()', () => {
    it('без marketCatalog — legacy-фолбэк на конвенцию strategyId == String(marketId)', async () => {
      const repoNoCatalog = new InMemoryOrderRepository();
      await repoNoCatalog.save(makeOrder('order-1', 'market-1'));
      await repoNoCatalog.save(makeOrder('order-2', 'other-strategy'));

      const found = await repoNoCatalog.getByMarketId(asMarketId('market-1')!);
      expect(found.map((o) => o.id)).toEqual([asOrderId('order-1')]);
    });

    it('с marketCatalog — фильтрует по реальному instrumentId, а НЕ по strategyId', async () => {
      const catalog = makeMarketCatalog('market-1', '1');
      const repoWithCatalog = new InMemoryOrderRepository(catalog);

      // strategyId НЕ равен marketId — старая конвенция дала бы 0 результатов
      const matching = makeOrder('order-1', 'some-unrelated-strategy', TEST_ASSET);
      const other = makeOrder('order-2', 'another-strategy', TEST_ASSET_2);
      await repoWithCatalog.save(matching);
      await repoWithCatalog.save(other);

      const found = await repoWithCatalog.getByMarketId(asMarketId('market-1')!);
      expect(found.map((o) => o.id)).toEqual([matching.id]);
    });

    it('с marketCatalog — возвращает ордера ОБОИХ outcome-токенов бинарного рынка (YES + NO)', async () => {
      // Регрессия: getByMarketId() каталога вернул бы только ОДИН instrumentId и
      // молча пропустил бы ордера второго outcome-токена. getAllByMarketId() ловит оба.
      const catalog = makeMarketCatalogMulti('market-1', ['1', '2']);
      const repoWithCatalog = new InMemoryOrderRepository(catalog);

      const yesOrder = makeOrder('order-yes', 'strategy-a', TEST_ASSET);
      const noOrder = makeOrder('order-no', 'strategy-a', TEST_ASSET_2);
      const otherMarketOrder = makeOrder('order-other', 'strategy-a', {
        type: 'POLYMARKET_CTF_TOKEN',
        tokenId: '999',
      } as never);
      await repoWithCatalog.save(yesOrder);
      await repoWithCatalog.save(noOrder);
      await repoWithCatalog.save(otherMarketOrder);

      const found = await repoWithCatalog.getByMarketId(asMarketId('market-1')!);
      expect(found.map((o) => o.id).sort()).toEqual([yesOrder.id, noOrder.id].sort());
    });

    it('с marketCatalog — возвращает пустой массив для неизвестного marketId', async () => {
      const catalog = makeMarketCatalog('market-1', '1');
      const repoWithCatalog = new InMemoryOrderRepository(catalog);
      await repoWithCatalog.save(makeOrder('order-1', 'strategy-a', TEST_ASSET));

      const found = await repoWithCatalog.getByMarketId(asMarketId('unknown-market')!);
      expect(found).toHaveLength(0);
    });
  });

  // ── size / clear ──────────────────────────────────────────────────────────

  describe('size и clear()', () => {
    it('size отражает актуальное количество ордеров', async () => {
      expect(repo.size).toBe(0);

      await repo.save(makeOrder('order-1'));
      expect(repo.size).toBe(1);

      await repo.save(makeOrder('order-2'));
      expect(repo.size).toBe(2);

      await repo.delete(asOrderId('order-1')!);
      expect(repo.size).toBe(1);
    });

    it('clear() удаляет все ордера', async () => {
      await repo.save(makeOrder('order-1'));
      await repo.save(makeOrder('order-2'));
      expect(repo.size).toBe(2);

      repo.clear();
      expect(repo.size).toBe(0);
    });
  });
});
