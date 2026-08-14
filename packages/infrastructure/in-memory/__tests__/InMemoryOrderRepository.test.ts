/**
 * Тесты для InMemoryOrderRepository — хранилища ордеров в памяти.
 *
 * @remarks
 * Проверяет все методы IOrderRepository:
 * - get/save (CAS)/getVersion
 * - deleteIfVersion/deleteIfState
 * - getByStrategyId
 * - countByStrategyId
 * - getAll
 * - Вспомогательные методы size/clear
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { InMemoryOrderRepository } from '../src/InMemoryOrderRepository.js';
import { Order } from '@polymarket/order';
import { Price, Quantity } from '@polymarket/value-objects';
import { Timestamp } from '@polymarket/timestamp';
import { asOrderId, asPolymarketCtfToken, asMarketId, unsafeStrategyId } from '@polymarket/ids';
import type { IMarketCatalog, InstrumentInfo } from '@polymarket/ports';
import { VersionConflictError, OrderStateConflictError } from '@polymarket/ports';
import Decimal from 'decimal.js';

/** Тестовый AssetId: POLYMARKET_CTF_TOKEN для токена '1' */
const TEST_ASSET = asPolymarketCtfToken('1')!;
/** Второй тестовый AssetId — для проверки фильтрации по инструменту */
const TEST_ASSET_2 = asPolymarketCtfToken('2')!;

/** Вспомогательная фабрика Order (status=PENDING) */
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
    strategyId: strategyId !== undefined ? unsafeStrategyId(strategyId) : undefined,
  });

  if (!result.ok) throw new Error(`Failed to create order: ${String(result.error)}`);
  return result.value;
}

/** Тот же ордер, но в терминальном статусе CANCELED (accept → cancel) */
function makeTerminalOrder(
  id: string,
  strategyId?: string,
  asset = TEST_ASSET,
): Order {
  const pending = makeOrder(id, strategyId, asset);
  const accepted = pending.accept();
  if (!accepted.ok) throw new Error(`Failed to accept order: ${String(accepted.error)}`);
  const cancelled = accepted.value.cancel();
  if (!cancelled.ok) throw new Error(`Failed to cancel order: ${String(cancelled.error)}`);
  return cancelled.value;
}

/** Сохраняет ордер и падает, если CAS вернул конфликт (helper для setup-кода) */
async function saveOrFail(repo: InMemoryOrderRepository, order: Order, expectedVersion = 0): Promise<void> {
  const result = await repo.save(order, expectedVersion);
  if (!result.ok) throw new Error(`Unexpected CAS conflict: ${result.error.message}`);
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

  // ── save (CAS) / get / getVersion ────────────────────────────────────────

  describe('save() CAS, get() и getVersion()', () => {
    it('сохраняет новый ордер с expectedVersion=0 → Ok, getVersion=1', async () => {
      const order = makeOrder('order-1');
      const result = await repo.save(order, 0);
      expect(result.ok).toBe(true);

      const found = await repo.get(order.id);
      expect(found).toBeDefined();
      expect(found?.id).toBe(order.id);
      expect(await repo.getVersion(order.id)).toBe(1);
    });

    it('возвращает undefined для несуществующего ордера и версию 0', async () => {
      const orderId = asOrderId('nonexistent-order')!;
      expect(await repo.get(orderId)).toBeUndefined();
      expect(await repo.getVersion(orderId)).toBe(0);
    });

    it('перезаписывает ордер при save с актуальной версией, версия растёт', async () => {
      const order = makeOrder('order-1', 'strategy-a');
      await saveOrFail(repo, order, 0);

      const order2 = makeOrder('order-1', 'strategy-b');
      const result = await repo.save(order2, 1);
      expect(result.ok).toBe(true);

      const found = await repo.get(order.id);
      expect(found?.strategyId).toBe('strategy-b');
      expect(await repo.getVersion(order.id)).toBe(2);
    });

    it('повторный save с тем же expectedVersion=0 → Err(VersionConflictError), ордер не изменяется', async () => {
      const order = makeOrder('order-1', 'strategy-a');
      await saveOrFail(repo, order, 0);

      const stale = makeOrder('order-1', 'strategy-b');
      const result = await repo.save(stale, 0);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(VersionConflictError);
        expect(result.error.expected).toBe(0);
        expect(result.error.actual).toBe(1);
      }

      // Хранимый ордер не перетёрт stale-копией
      const found = await repo.get(order.id);
      expect(found?.strategyId).toBe('strategy-a');
      expect(await repo.getVersion(order.id)).toBe(1);
    });

    it('save существующего ордера со stale-версией → Err, ордер не изменяется', async () => {
      const order = makeOrder('order-1', 'strategy-a');
      await saveOrFail(repo, order, 0);
      await saveOrFail(repo, makeOrder('order-1', 'strategy-b'), 1);

      const stale = makeOrder('order-1', 'strategy-c');
      const result = await repo.save(stale, 1); // актуальная версия уже 2
      expect(result.ok).toBe(false);

      const found = await repo.get(order.id);
      expect(found?.strategyId).toBe('strategy-b');
      expect(await repo.getVersion(order.id)).toBe(2);
    });
  });

  // ── getWithVersion (atomic snapshot) ──────────────────────────────────────

  describe('getWithVersion()', () => {
    it('возвращает undefined для несуществующего ордера', async () => {
      const snapshot = await repo.getWithVersion(asOrderId('nonexistent')!);
      expect(snapshot).toBeUndefined();
    });

    it('возвращает {order, version} согласованно с get()/getVersion()', async () => {
      const order = makeOrder('order-1', 'strategy-a');
      await saveOrFail(repo, order, 0);

      const snapshot = await repo.getWithVersion(order.id);
      expect(snapshot?.order.id).toBe(order.id);
      expect(snapshot?.version).toBe(await repo.getVersion(order.id));
      expect(snapshot?.version).toBe(1);
    });

    it('версия из snapshot валидна как expectedVersion для последующего CAS save', async () => {
      const order = makeOrder('order-1');
      await saveOrFail(repo, order, 0);

      const snapshot = await repo.getWithVersion(order.id);
      const updated = makeOrder('order-1', 'strategy-updated');
      const result = await repo.save(updated, snapshot!.version);
      expect(result.ok).toBe(true);
    });
  });

  // ── deleteIfVersion ───────────────────────────────────────────────────────

  describe('deleteIfVersion()', () => {
    it('удаляет ордер при совпадении версии → Ok(DELETED)', async () => {
      const order = makeOrder('order-del');
      await saveOrFail(repo, order, 0);

      const result = await repo.deleteIfVersion(order.id, 1);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.status).toBe('DELETED');
      expect(await repo.get(order.id)).toBeUndefined();
    });

    it('stale-версия → Err(VersionConflictError), ордер остаётся', async () => {
      const order = makeOrder('order-del');
      await saveOrFail(repo, order, 0);

      const result = await repo.deleteIfVersion(order.id, 0);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeInstanceOf(VersionConflictError);
      expect(await repo.get(order.id)).toBeDefined();
    });

    it('несуществующий ордер + expectedVersion=0 → Ok(NOT_FOUND)', async () => {
      const result = await repo.deleteIfVersion(asOrderId('nonexistent')!, 0);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.status).toBe('NOT_FOUND');
    });

    it('несуществующий ордер + expectedVersion=1 → Err(VersionConflictError)', async () => {
      const result = await repo.deleteIfVersion(asOrderId('nonexistent')!, 1);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeInstanceOf(VersionConflictError);
    });
  });

  // ── deleteIfState ─────────────────────────────────────────────────────────

  describe('deleteIfState()', () => {
    it('удаляет ордер в разрешённом статусе → Ok(DELETED)', async () => {
      const order = makeOrder('order-del'); // status=PENDING
      await saveOrFail(repo, order, 0);

      const result = await repo.deleteIfState(order.id, ['PENDING']);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.status).toBe('DELETED');
      expect(await repo.get(order.id)).toBeUndefined();
    });

    it('статус вне allowedStates → Err(OrderStateConflictError), ордер остаётся', async () => {
      const order = makeOrder('order-del'); // status=PENDING
      await saveOrFail(repo, order, 0);

      const result = await repo.deleteIfState(order.id, ['FILLED', 'CANCELED']);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(OrderStateConflictError);
        expect(result.error.actualState).toBe('PENDING');
        expect(result.error.expectedStates).toEqual(['FILLED', 'CANCELED']);
      }
      expect(await repo.get(order.id)).toBeDefined();
    });

    it('несуществующий ордер → Ok(NOT_FOUND) (идемпотентный no-op)', async () => {
      const result = await repo.deleteIfState(asOrderId('nonexistent')!, ['FILLED']);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.status).toBe('NOT_FOUND');
    });
  });

  // ── getByStrategyId ───────────────────────────────────────────────────────

  describe('getByStrategyId()', () => {
    it('возвращает ордера только указанной стратегии', async () => {
      const orderA1 = makeOrder('order-a1', 'strategy-a');
      const orderA2 = makeOrder('order-a2', 'strategy-a');
      const orderB1 = makeOrder('order-b1', 'strategy-b');

      await saveOrFail(repo, orderA1);
      await saveOrFail(repo, orderA2);
      await saveOrFail(repo, orderB1);

      const strategyAOrders = await repo.getByStrategyId(unsafeStrategyId('strategy-a'));
      expect(strategyAOrders).toHaveLength(2);
      expect(strategyAOrders.map((o) => o.id)).toContain(orderA1.id);
      expect(strategyAOrders.map((o) => o.id)).toContain(orderA2.id);
    });

    it('возвращает пустой массив если у стратегии нет ордеров', async () => {
      const order = makeOrder('order-1', 'strategy-a');
      await saveOrFail(repo, order);

      const result = await repo.getByStrategyId(unsafeStrategyId('strategy-z'));
      expect(result).toHaveLength(0);
    });

    it('возвращает пустой массив если хранилище пусто', async () => {
      const result = await repo.getByStrategyId(unsafeStrategyId('any-strategy'));
      expect(result).toHaveLength(0);
    });

    it('игнорирует ордера без strategyId', async () => {
      const orderNoStrategy = makeOrder('order-ns');  // без strategyId
      const orderWithStrategy = makeOrder('order-ws', 'strategy-a');

      await saveOrFail(repo, orderNoStrategy);
      await saveOrFail(repo, orderWithStrategy);

      const result = await repo.getByStrategyId(unsafeStrategyId('strategy-a'));
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(orderWithStrategy.id);
    });
  });

  // ── countByStrategyId ─────────────────────────────────────────────────────

  describe('countByStrategyId()', () => {
    it('считает ордера указанной стратегии', async () => {
      await saveOrFail(repo, makeOrder('order-a1', 'strategy-a'));
      await saveOrFail(repo, makeOrder('order-a2', 'strategy-a'));
      await saveOrFail(repo, makeOrder('order-b1', 'strategy-b'));

      const countA = await repo.countByStrategyId(unsafeStrategyId('strategy-a'));
      const countB = await repo.countByStrategyId(unsafeStrategyId('strategy-b'));

      expect(countA).toBe(2);
      expect(countB).toBe(1);
    });

    it('возвращает 0 для стратегии без ордеров', async () => {
      const count = await repo.countByStrategyId(unsafeStrategyId('nonexistent-strategy'));
      expect(count).toBe(0);
    });

    it('без strategyId возвращает общее количество ордеров', async () => {
      await saveOrFail(repo, makeOrder('order-1', 'strategy-a'));
      await saveOrFail(repo, makeOrder('order-2', 'strategy-b'));
      await saveOrFail(repo, makeOrder('order-3'));

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

      await saveOrFail(repo, order1);
      await saveOrFail(repo, order2);
      await saveOrFail(repo, order3);

      const all = await repo.getAll();
      expect(all).toHaveLength(3);
    });

    it('возвращает пустой массив если хранилище пусто', async () => {
      const all = await repo.getAll();
      expect(all).toHaveLength(0);
    });

    it('включает терминальные ордера, ещё не удалённые cleanup-путём', async () => {
      const open = makeOrder('order-open', 'strategy-a');
      const terminal = makeTerminalOrder('order-terminal', 'strategy-a');
      await saveOrFail(repo, open);
      await saveOrFail(repo, terminal);

      const all = await repo.getAll();
      expect(all.map((o) => o.id).sort()).toEqual([open.id, terminal.id].sort());
    });
  });

  // ── getByMarketId() ──────────────────────────────────────────────────────

  describe('getByMarketId()', () => {
    it('без marketCatalog — legacy-фолбэк на конвенцию strategyId == String(marketId)', async () => {
      const repoNoCatalog = new InMemoryOrderRepository();
      await saveOrFail(repoNoCatalog, makeOrder('order-1', 'market-1'));
      await saveOrFail(repoNoCatalog, makeOrder('order-2', 'other-strategy'));

      const found = await repoNoCatalog.getByMarketId(asMarketId('market-1')!);
      expect(found.map((o) => o.id)).toEqual([asOrderId('order-1')]);
    });

    it('с marketCatalog — фильтрует по реальному instrumentId, а НЕ по strategyId', async () => {
      const catalog = makeMarketCatalog('market-1', '1');
      const repoWithCatalog = new InMemoryOrderRepository(catalog);

      // strategyId НЕ равен marketId — старая конвенция дала бы 0 результатов
      const matching = makeOrder('order-1', 'some-unrelated-strategy', TEST_ASSET);
      const other = makeOrder('order-2', 'another-strategy', TEST_ASSET_2);
      await saveOrFail(repoWithCatalog, matching);
      await saveOrFail(repoWithCatalog, other);

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
      await saveOrFail(repoWithCatalog, yesOrder);
      await saveOrFail(repoWithCatalog, noOrder);
      await saveOrFail(repoWithCatalog, otherMarketOrder);

      const found = await repoWithCatalog.getByMarketId(asMarketId('market-1')!);
      expect(found.map((o) => o.id).sort()).toEqual([yesOrder.id, noOrder.id].sort());
    });

    it('с marketCatalog — возвращает пустой массив для неизвестного marketId', async () => {
      const catalog = makeMarketCatalog('market-1', '1');
      const repoWithCatalog = new InMemoryOrderRepository(catalog);
      await saveOrFail(repoWithCatalog, makeOrder('order-1', 'strategy-a', TEST_ASSET));

      const found = await repoWithCatalog.getByMarketId(asMarketId('unknown-market')!);
      expect(found).toHaveLength(0);
    });

    it('без marketCatalog — исключает терминальные ордера (симметрично getByStrategyId)', async () => {
      const repoNoCatalog = new InMemoryOrderRepository();
      const open = makeOrder('order-open', 'market-1');
      const terminal = makeTerminalOrder('order-terminal', 'market-1');
      await saveOrFail(repoNoCatalog, open);
      await saveOrFail(repoNoCatalog, terminal);

      const found = await repoNoCatalog.getByMarketId(asMarketId('market-1')!);
      expect(found.map((o) => o.id)).toEqual([open.id]);
    });

    it('с marketCatalog — исключает терминальные ордера (та же семантика «открытые»)', async () => {
      const catalog = makeMarketCatalog('market-1', '1');
      const repoWithCatalog = new InMemoryOrderRepository(catalog);

      const open = makeOrder('order-open', 'strategy-a', TEST_ASSET);
      const terminal = makeTerminalOrder('order-terminal', 'strategy-a', TEST_ASSET);
      await saveOrFail(repoWithCatalog, open);
      await saveOrFail(repoWithCatalog, terminal);

      const found = await repoWithCatalog.getByMarketId(asMarketId('market-1')!);
      expect(found.map((o) => o.id)).toEqual([open.id]);
    });
  });

  // ── saveSync (CAS bypass) ────────────────────────────────────────────────

  describe('saveSync()', () => {
    it('новый ордер → version=1', async () => {
      const order = makeOrder('order-sync');
      repo.saveSync(order);

      expect(await repo.getVersion(order.id)).toBe(1);
      expect(await repo.get(order.id)).toBe(order);
    });

    it('существующий ордер → версия инкрементируется', async () => {
      const order = makeOrder('order-sync', 'strategy-a');
      await saveOrFail(repo, order, 0);

      const updated = makeOrder('order-sync', 'strategy-b');
      repo.saveSync(updated);

      expect(await repo.getVersion(order.id)).toBe(2);
      expect((await repo.get(order.id))?.strategyId).toBe('strategy-b');
    });

    it('после saveSync конкурирующий CAS save со stale-версией конфликтует', async () => {
      const order = makeOrder('order-sync', 'strategy-a');
      await saveOrFail(repo, order, 0); // version=1

      repo.saveSync(makeOrder('order-sync', 'strategy-b')); // version=2

      const staleSave = await repo.save(makeOrder('order-sync', 'strategy-c'), 1);
      expect(staleSave.ok).toBe(false);
      expect((await repo.get(order.id))?.strategyId).toBe('strategy-b');
    });

    it('сохраняет поведение get/getAll/getByStrategyId', async () => {
      repo.saveSync(makeOrder('order-1', 'strategy-a'));
      repo.saveSync(makeOrder('order-2', 'strategy-a'));

      expect(await repo.getAll()).toHaveLength(2);
      expect(await repo.getByStrategyId(unsafeStrategyId('strategy-a'))).toHaveLength(2);
      expect(repo.getOrder(asOrderId('order-1')!)).toBeDefined();
    });
  });

  // ── size / clear ──────────────────────────────────────────────────────────

  describe('size и clear()', () => {
    it('size отражает актуальное количество ордеров', async () => {
      expect(repo.size).toBe(0);

      await saveOrFail(repo, makeOrder('order-1'));
      expect(repo.size).toBe(1);

      await saveOrFail(repo, makeOrder('order-2'));
      expect(repo.size).toBe(2);

      await repo.deleteIfVersion(asOrderId('order-1')!, 1);
      expect(repo.size).toBe(1);
    });

    it('clear() удаляет все ордера и сбрасывает версии', async () => {
      await saveOrFail(repo, makeOrder('order-1'));
      await saveOrFail(repo, makeOrder('order-2'));
      expect(repo.size).toBe(2);

      repo.clear();
      expect(repo.size).toBe(0);
      // Версии сброшены — новый save с expectedVersion=0 снова проходит
      expect(await repo.getVersion(asOrderId('order-1')!)).toBe(0);
      const result = await repo.save(makeOrder('order-1'), 0);
      expect(result.ok).toBe(true);
    });
  });
});
